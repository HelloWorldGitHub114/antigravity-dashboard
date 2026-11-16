import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const IDE_WORKBENCH_PATH_RE = /\/out\/vs\/code\/electron-browser\/workbench\/workbench\.html$/;

const DEFAULT_PORT_FILE_MAX_BYTES = 1024;
const DEFAULT_JSON_MAX_BYTES = 1048576;
const DEFAULT_HTTP_TIMEOUT_MS = 2000;

/**
 * Target mode used to validate CDP `/json/list` entries.
 */
export type DevToolsTargetMode = 'desktop' | 'ide';

/**
 * Minimal CDP target entry returned by `/json/list`.
 */
export interface DevToolsTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  id?: string;
  title?: string;
  [key: string]: unknown;
}

/**
 * Options for reading `DevToolsActivePort` from a host profile directory.
 */
export interface ReadDevToolsPortOptions {
  maxBytes?: number;
  fileErrorMessage?: string;
  portErrorMessage?: string;
}

/**
 * Options for retrieving `/json/list` over loopback HTTP.
 */
export interface FetchDevToolsTargetsOptions {
  path?: string;
  timeoutMs?: number;
  maxBytes?: number;
  unavailableErrorMessage?: string;
  responseErrorMessage?: string;
  timeoutErrorMessage?: string;
  tooLargeErrorMessage?: string;
}

/**
 * Options for `discoverDevToolsTargets`.
 */
export interface DiscoverDevToolsTargetsOptions
  extends ReadDevToolsPortOptions,
    FetchDevToolsTargetsOptions {
  mode?: DevToolsTargetMode;
  filter?: (target: DevToolsTarget, port: number) => boolean;
}

/**
 * Result returned by `discoverDevToolsTargets`.
 */
export interface DevToolsDiscoveryResult {
  port: number;
  targets: DevToolsTarget[];
}

/**
 * Checks whether a parsed URL hostname is a permitted loopback address.
 */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/**
 * Checks whether a target entry is valid for either desktop or IDE renderer attachment.
 */
export function isValidDevToolsTarget(
  target: DevToolsTarget | null | undefined,
  port: number,
  mode: DevToolsTargetMode = 'desktop',
): boolean {
  if (!target || typeof target.url !== 'string' || typeof target.webSocketDebuggerUrl !== 'string') {
    return false;
  }
  try {
    const page = new URL(target.url);
    const ws = new URL(target.webSocketDebuggerUrl);
    const validWs =
      ws.protocol === 'ws:' && isLoopbackHost(ws.hostname) && Number(ws.port) === port;
    if (target.type !== 'page' || !validWs) return false;

    if (mode === 'ide') {
      return (
        page.protocol === 'vscode-file:' &&
        page.hostname === 'vscode-app' &&
        IDE_WORKBENCH_PATH_RE.test(page.pathname)
      );
    }

    return ['http:', 'https:'].includes(page.protocol) && isLoopbackHost(page.hostname);
  } catch {
    return false;
  }
}

/**
 * Reads and validates the DevTools debugging port from `<profile>/DevToolsActivePort`.
 */
export async function readDevToolsPort(
  profile: string,
  options: ReadDevToolsPortOptions = {},
): Promise<number> {
  const maxBytes = options.maxBytes ?? DEFAULT_PORT_FILE_MAX_BYTES;
  const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
  if (text.length > maxBytes) {
    throw new Error(options.fileErrorMessage ?? 'Invalid renderer discovery file');
  }
  const port = Number(text.split(/\r?\n/)[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(options.portErrorMessage ?? 'Invalid renderer port');
  }
  return port;
}

/**
 * Fetches and parses the DevTools `/json/list` payload from `127.0.0.1:<port>`.
 */
export function fetchDevToolsTargets(
  port: number,
  options: FetchDevToolsTargetsOptions = {},
): Promise<DevToolsTarget[]> {
  const path = options.path ?? '/json/list';
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_JSON_MAX_BYTES;
  const unavailableError = options.unavailableErrorMessage ?? 'Renderer discovery unavailable';
  const responseError = options.responseErrorMessage ?? 'Invalid renderer discovery response';
  const timeoutError = options.timeoutErrorMessage ?? 'Renderer discovery timeout';
  const tooLargeError = options.tooLargeErrorMessage ?? 'Discovery response too large';

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: DevToolsTarget[]) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value ?? []);
    };
    const abort = (error: Error) => {
      finish(error);
      if (!req.destroyed) req.destroy(error);
    };

    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('error', (error: Error) => finish(error));
      res.on('data', (chunk: string) => {
        if (settled) return;
        body += chunk;
        if (body.length > maxBytes) abort(new Error(tooLargeError));
      });
      res.on('end', () => {
        if (settled) return;
        try {
          if (res.statusCode !== 200) throw new Error(unavailableError);
          const parsed: unknown = JSON.parse(body);
          if (!Array.isArray(parsed)) throw new Error(responseError);
          finish(null, parsed as DevToolsTarget[]);
        } catch (error) {
          finish(error);
        }
      });
    });

    req.on('error', (error: Error) => finish(error));
    req.setTimeout(timeoutMs, () => abort(new Error(timeoutError)));
    req.end();
  });
}

/**
 * Discovers and filters loopback DevTools page targets for a desktop or IDE profile.
 */
export async function discoverDevToolsTargets(
  profile: string,
  options: DiscoverDevToolsTargetsOptions = {},
): Promise<DevToolsDiscoveryResult> {
  const mode = options.mode ?? 'desktop';
  const port = await readDevToolsPort(profile, options);
  const rawTargets = await fetchDevToolsTargets(port, options);
  const predicate =
    options.filter ?? ((target: DevToolsTarget, p: number) => isValidDevToolsTarget(target, p, mode));
  return {
    port,
    targets: rawTargets.filter((target) => predicate(target, port)),
  };
}
