import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installedAgentExecutable, platformPaths } from '../platform/paths.ts';
import { atomicWriteFile } from '../shared/atomic-fs.ts';

export interface SidecarResponseInstance { body?: unknown; }

export interface SidecarAppInstance {
  api(path: string, handler: (data: any) => unknown, method?: string): unknown;
  page(path: string, handler: () => unknown): unknown;
  run(): unknown;
  close?: () => Promise<void> | void;
}

export interface SidecarSdkModule {
  Response: new (body?: unknown, options?: Record<string, unknown>) => SidecarResponseInstance;
  SidecarApp: new () => SidecarAppInstance;
}

export interface SdkValidationResult {
  loopback: true;
  binding: 'literal' | 'constant';
}

export interface ExtractedSdkResources {
  sdk: string;
  preload: string;
}

export interface LoadBundledSdkOptions {
  executable?: string;
  directory?: string;
}

interface SdkToken {
  kind: 'word' | 'string' | 'template' | 'punct';
  text: string;
  escaped?: boolean;
}

interface SdkManifest {
  stamp: string;
  sdk: string;
  preload: string;
}

const POLICY = 'sdk-loopback-v2';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const sdkLoads = new Map<string, Promise<SidecarSdkModule>>();
const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | null | undefined)?.code;

/**
 * Load `sidecar_sdk` via ESM import, CJS `NODE_PATH` fallback, or bundled extraction.
 */
export async function loadSidecarSdk(): Promise<SidecarSdkModule> {
  try {
    return (await import('sidecar_sdk' as string)) as SidecarSdkModule;
  } catch (error) {
    if (errorCode(error) !== 'ERR_MODULE_NOT_FOUND') throw error;
    // Windows builds can supply the SDK through NODE_PATH while the ESM
    // resolver is absent. CommonJS resolution honors that path; import the
    // resolved file as ESM without changing any application files.
    try {
      const file = createRequire(import.meta.url).resolve('sidecar_sdk');
      return (await import(pathToFileURL(file).href)) as SidecarSdkModule;
    } catch (resolveError) {
      if (errorCode(resolveError) !== 'MODULE_NOT_FOUND') throw resolveError;
      return loadBundledSdk();
    }
  }
}

// A small lexical reader for the installed SDK's binding expression. This is
// not a general JavaScript security sandbox: executable resources must still
// originate from the installed host. Comments/string decoys do not count as
// network bindings; unfamiliar expressions are rejected for explicit review.
function sdkTokens(source: string): SdkToken[] {
  const tokens: SdkToken[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error('SDK 资源校验失败');
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let text = '';
      let escaped = false;
      let closed = false;
      i++;
      while (i < source.length) {
        const ch = source[i++];
        if (ch === quote) { closed = true; break; }
        if (ch === '\\') {
          escaped = true;
          if (i >= source.length) break;
          text += ch + source[i++];
        } else {
          text += ch;
        }
      }
      if (!closed) throw new Error('SDK 资源校验失败');
      tokens.push({ kind: quote === '`' ? 'template' : 'string', text, escaped });
      continue;
    }
    const word = source.slice(i).match(/^[A-Za-z_$][\w$]*/);
    if (word) {
      tokens.push({ kind: 'word', text: word[0] });
      i += word[0].length;
      continue;
    }
    tokens.push({ kind: 'punct', text: c });
    i++;
  }
  return tokens;
}

/**
 * Verify exported classes and strict `127.0.0.1` loopback binding in extracted SDK code.
 */
export function validateSdkResources(sdk: string, preload: string): SdkValidationResult {
  if (typeof sdk !== 'string' || typeof preload !== 'string' || !preload.includes('window.sidecar =')) {
    throw new Error('SDK 资源校验失败');
  }
  const tokens = sdkTokens(sdk);
  const text = (index: number): string | undefined => tokens[index]?.text;
  for (const name of ['Response', 'SidecarApp']) {
    const found = tokens.some(
      (t, i) => t.kind === 'word' && t.text === 'export' && text(i + 1) === 'class' && text(i + 2) === name,
    );
    if (!found) throw new Error('SDK 资源校验失败');
  }

  const bindings: Array<'literal' | 'constant'> = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== 'word' || text(i) !== 'listen' || text(i - 1) !== '.' || text(i + 1) !== '(') continue;
    const args: SdkToken[][] = [];
    let current: SdkToken[] = [];
    let depth = 0;
    let end = false;
    for (let j = i + 2; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.kind === 'punct' && t.text === ')' && depth === 0) { args.push(current); end = true; break; }
      if (t.kind === 'punct' && t.text === ',' && depth === 0) { args.push(current); current = []; continue; }
      if (t.kind === 'punct' && '([{'.includes(t.text)) depth++;
      if (t.kind === 'punct' && ')]}'.includes(t.text)) depth--;
      if (depth < 0) throw new Error('SDK 资源校验失败');
      current.push(t);
    }
    if (!end || args.length < 2 || args[1].length !== 1) throw new Error('SDK 本地监听地址无法确认');

    const host = args[1][0];
    if (host.kind === 'string' && !host.escaped && host.text === '127.0.0.1') {
      bindings.push('literal');
      continue;
    }
    if (host.kind !== 'word') throw new Error('SDK 本地监听地址无法确认');

    const declarations: number[] = [];
    for (let k = 0; k < tokens.length; k++) {
      const kw = text(k);
      if (text(k + 1) === host.text && (kw === 'const' || kw === 'let' || kw === 'var')) declarations.push(k);
    }
    const k = declarations[0];
    const literal = tokens[k + 3];
    // Accept one immutable constant, not a mutable alias or an expression.
    if (
      declarations.length !== 1 || text(k) !== 'const' || text(k + 2) !== '=' ||
      literal?.kind !== 'string' || literal.escaped || literal.text !== '127.0.0.1' || text(k + 4) !== ';'
    ) {
      throw new Error('SDK 本地监听地址无法确认');
    }
    const mutated = tokens.some(
      (t, j) =>
        t.kind === 'word' && t.text === host.text && j !== k + 1 &&
        (text(j + 1) === '=' || (text(j + 1) === '+' && text(j + 2) === '+') || (text(j + 1) === '-' && text(j + 2) === '-')),
    );
    if (mutated) throw new Error('SDK 本地监听地址无法确认');
    bindings.push('constant');
  }
  if (bindings.length !== 1) throw new Error('SDK 本地监听地址无法确认');
  return { loopback: true, binding: bindings[0] };
}

/**
 * Extract and validate embedded SDK + preload scripts from the host `language_server` binary.
 */
export function extractBundledSdk(binary: Buffer): ExtractedSdkResources {
  if (!Buffer.isBuffer(binary)) {
    throw new Error('此版本的 Sidecar SDK 格式不兼容；请更新 SDK 适配器');
  }
  const buf = binary as Buffer & {
    lastIndexOf(value: string | number | Uint8Array, byteOffset?: number, encoding?: BufferEncoding): number;
  };
  const marker = buf.indexOf('export class SidecarApp');
  const start = buf.lastIndexOf("import { execFileSync } from 'node:child_process';", marker);
  const tail = 'return provided === this.#token;\n  }\n}\n';
  const tailIndex = buf.indexOf(tail, marker);
  const preloadMarker = buf.indexOf('window.sidecar =');
  const preloadStart = buf.lastIndexOf('(function() {', preloadMarker);
  const preloadTail = '\n})();';
  const preloadEnd = buf.indexOf(preloadTail, preloadMarker);
  if (
    marker < 0 || start < 0 || marker - start > 12000 ||
    tailIndex < marker || tailIndex - marker > 24000 ||
    preloadStart < 0 || preloadEnd < preloadMarker || preloadEnd - preloadStart > 24000
  ) {
    throw new Error('此版本的 Sidecar SDK 格式不兼容；请更新 SDK 适配器');
  }
  const sdk = buf.subarray(start, tailIndex + Buffer.byteLength(tail)).toString('utf8');
  const preload = buf.subarray(preloadStart, preloadEnd + Buffer.byteLength(preloadTail)).toString('utf8');
  validateSdkResources(sdk, preload);
  return { sdk, preload };
}

/**
 * Load and cache the host-bundled Sidecar SDK, coalescing concurrent extractions.
 */
export function loadBundledSdk({
  executable = installedAgentExecutable(),
  directory = join(platformPaths().data, 'sdk'),
}: LoadBundledSdkOptions = {}): Promise<SidecarSdkModule> {
  const key = JSON.stringify([executable, directory]);
  const cached = sdkLoads.get(key);
  if (cached) return cached;
  const pending = loadBundledNow(executable, directory).finally(() => {
    if (sdkLoads.get(key) === pending) sdkLoads.delete(key);
  });
  sdkLoads.set(key, pending);
  return pending;
}

async function loadBundledNow(exe: string, directory: string): Promise<SidecarSdkModule> {
  // 2.19.1 contains the official SDK resources in language_server.exe, but some
  // Windows installations omit its ESM resolver. Recover those same installed
  // resources into private runtime storage. No SDK is downloaded or redistributed.
  const info = await stat(exe);
  const stamp = `${POLICY}:${exe}:${info.size}:${info.mtimeMs}`;
  const root = join(directory, hash(stamp));
  let resources: ExtractedSdkResources | null = null;
  try {
    const [sdk, preload, manifest] = await Promise.all([
      readFile(join(root, 'index.mjs'), 'utf8'),
      readFile(join(root, 'preload.js'), 'utf8'),
      readFile(join(root, 'manifest.json'), 'utf8'),
    ]);
    const saved = JSON.parse(manifest) as Partial<SdkManifest>;
    if (saved.stamp === stamp && saved.sdk === hash(sdk) && saved.preload === hash(preload)) {
      validateSdkResources(sdk, preload);
      resources = { sdk, preload };
    }
  } catch { /* Missing or corrupted cache generation; re-extract from the host binary. */ }

  if (!resources) {
    resources = extractBundledSdk(await readFile(exe));
    await mkdir(root, { recursive: true });
    await atomicWriteFile(join(root, 'index.mjs'), resources.sdk, { ensureDir: false });
    await atomicWriteFile(join(root, 'preload.js'), resources.preload, { ensureDir: false });
    await atomicWriteFile(
      join(root, 'manifest.json'),
      `${JSON.stringify({ stamp, sdk: hash(resources.sdk), preload: hash(resources.preload) })}\n`,
      { ensureDir: false },
    );
  }

  const result = (await import(
    `${pathToFileURL(join(root, 'index.mjs')).href}?v=${hash(resources.sdk + resources.preload)}`
  )) as Partial<SidecarSdkModule>;
  const proto = result.SidecarApp?.prototype as Record<string, unknown> | undefined;
  if (
    typeof result.SidecarApp !== 'function' ||
    typeof result.Response !== 'function' ||
    ['api', 'page', 'run'].some((name) => typeof proto?.[name] !== 'function')
  ) {
    throw new Error('SDK 导出接口不兼容');
  }
  return result as SidecarSdkModule;
}
