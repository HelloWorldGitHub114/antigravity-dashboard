import { open, readFile, stat } from 'node:fs/promises';

export interface ServerEndpoint {
  port: number;
  csrf: string;
  pid: number;
  [key: string]: unknown;
}

export interface ServerSource {
  file: string;
  size: number;
  mtimeMs: number;
}

export type DiscoveryEnv = Readonly<Record<string, string | undefined>>;
export type CredentialSource = 'cli' | 'env';

export interface LoopbackLsAddress {
  host: '127.0.0.1' | 'localhost' | '[::1]';
  port: number;
}

export interface EnvCredentials {
  host: '127.0.0.1' | 'localhost' | '[::1]';
  port: number;
  csrf: string;
}

export interface DiscoveredServerEndpoint {
  server: ServerEndpoint;
  source: CredentialSource;
}

export interface ProcessCandidate {
  ProcessId: number;
  CommandLine?: string;
  Ports?: number[] | number;
}

export const NO_LOCAL_CREDENTIALS_CODE = 'NO_LOCAL_CREDENTIALS';
export const NO_LOCAL_CREDENTIALS_MESSAGE = '当前版本未提供可用的本地检测凭据';

export interface LocalCredentialsUnavailableError extends Error {
  code: typeof NO_LOCAL_CREDENTIALS_CODE;
  pid: number;
  port: number;
}

export function createNoLocalCredentialsError(pid: number, port: number): LocalCredentialsUnavailableError {
  return Object.assign(new Error(NO_LOCAL_CREDENTIALS_MESSAGE), {
    code: NO_LOCAL_CREDENTIALS_CODE as typeof NO_LOCAL_CREDENTIALS_CODE,
    pid,
    port,
  });
}

export function isNoLocalCredentialsError(error: unknown): error is LocalCredentialsUnavailableError {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; message?: unknown };
  return e.code === NO_LOCAL_CREDENTIALS_CODE || e.message === NO_LOCAL_CREDENTIALS_MESSAGE;
}

export const PORT_LOG_LINE = /listening on random port at (\d+) for HTTP(?:\s|$)/;
export const PORT_LOG_GLOBAL = /listening on random port at (\d+) for HTTP(?:\s|$)/g;
const LOG_TAIL_BYTES = 256 * 1024;

/**
 * Check whether `pid` currently corresponds to a live OS process.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null | undefined)?.code === 'EPERM';
  }
}

/**
 * Read a bounded UTF-8 slice `[start, end)` from `file`.
 */
export async function readFileSlice(file: string, start: number, end: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const length = Math.max(0, end - start);
    if (!length) return '';
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return buffer.toString('utf8', 0, offset);
  } finally {
    await handle.close();
  }
}

/**
 * Read the tail (or full file if needed) of the host language server log along with file stats.
 */
export async function readLogWithStats(file: string): Promise<{ text: string; size: number; mtimeMs: number }> {
  const info = await stat(file);
  if (info.size <= LOG_TAIL_BYTES) {
    return { text: await readFile(file, 'utf8'), size: info.size, mtimeMs: info.mtimeMs };
  }
  const tail = await readFileSlice(file, info.size - LOG_TAIL_BYTES, info.size);
  if (PORT_LOG_LINE.test(tail)) {
    return { text: tail, size: info.size, mtimeMs: info.mtimeMs };
  }
  return { text: await readFile(file, 'utf8'), size: info.size, mtimeMs: info.mtimeMs };
}

/**
 * Parse `ANTIGRAVITY_LS_ADDRESS` (`host:port` or `http://host:port`), rejecting non-loopback hosts and invalid ports.
 */
export function parseLoopbackLsAddress(raw: unknown): LoopbackLsAddress | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) && !/^http:\/\//i.test(trimmed)) {
    return null;
  }
  const candidate = /^http:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const match = candidate.match(/^http:\/\/(\[[^\]]+\]|[^/:?#\s@]+):(\d+)\/?$/i);
  if (!match) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    return null;
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { host, port };
}

/**
 * Extract validated loopback address and CSRF token from managed child process environment variables.
 */
export function parseEnvCredentials(env: DiscoveryEnv = process.env): EnvCredentials | null {
  if (!env || typeof env !== 'object') return null;
  const addr = parseLoopbackLsAddress(env.ANTIGRAVITY_LS_ADDRESS);
  if (!addr) return null;
  const rawToken = env.ANTIGRAVITY_CSRF_TOKEN;
  const csrf = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!csrf || /[\r\n\0]/.test(csrf)) return null;
  return { host: addr.host, port: addr.port, csrf };
}

function extractCliCsrfToken(commandLine?: string): string | null {
  return commandLine?.match(/--csrf_token(?:=|\s+)"?([^\s"]+)/)?.[1] ?? null;
}

function findPortOwners(rows: readonly ProcessCandidate[], port: number): ProcessCandidate[] {
  return rows.filter((r) => [r.Ports].flat().map(Number).includes(port));
}

/**
 * Pair the listening port in `log` (or validated `env` port) with a unique standalone process owning that port and CSRF token.
 */
export function discoverServerEndpoint(
  log: string,
  processes: ProcessCandidate | readonly ProcessCandidate[],
  env: DiscoveryEnv = process.env,
): DiscoveredServerEndpoint {
  const list = Array.isArray(processes) ? processes : [processes];
  const rows = list.filter((p) => /--standalone\b/.test(p?.CommandLine || ''));
  if (!rows.length) throw new Error('未找到 Antigravity 桌面后台');
  const logPorts = [...log.matchAll(PORT_LOG_GLOBAL)].reverse().map((m) => Number(m[1]));
  let matchedRow: ProcessCandidate | null = null;
  let port: number | null = null;
  for (const candidate of logPorts) {
    const owners = findPortOwners(rows, candidate);
    if (owners.length === 1) {
      matchedRow = owners[0];
      port = candidate;
      break;
    }
  }
  const envCreds = parseEnvCredentials(env);
  if (matchedRow && port !== null) {
    const cliCsrf = extractCliCsrfToken(matchedRow.CommandLine);
    if (cliCsrf) {
      return { server: { port, csrf: cliCsrf, pid: matchedRow.ProcessId }, source: 'cli' };
    }
    if (envCreds && envCreds.port === port) {
      return { server: { port, csrf: envCreds.csrf, pid: matchedRow.ProcessId }, source: 'env' };
    }
    throw createNoLocalCredentialsError(matchedRow.ProcessId, port);
  }
  if (envCreds) {
    const owners = findPortOwners(rows, envCreds.port);
    if (owners.length === 1) {
      const owner = owners[0];
      const cliCsrf = extractCliCsrfToken(owner.CommandLine);
      if (cliCsrf) {
        return { server: { port: envCreds.port, csrf: cliCsrf, pid: owner.ProcessId }, source: 'cli' };
      }
      return { server: { port: envCreds.port, csrf: envCreds.csrf, pid: owner.ProcessId }, source: 'env' };
    }
  }
  throw new Error('等待 Antigravity 本地接口启动');
}

/**
 * Pair the latest listening port in `log` with a unique standalone process owning that port and CSRF token.
 */
export function serverFromDiscovery(
  log: string,
  processes: ProcessCandidate | readonly ProcessCandidate[],
  env: DiscoveryEnv = process.env,
): ServerEndpoint {
  return discoverServerEndpoint(log, processes, env).server;
}
