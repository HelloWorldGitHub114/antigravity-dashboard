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

export interface ProcessCandidate {
  ProcessId: number;
  CommandLine?: string;
  Ports?: number[] | number;
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
 * Pair the latest listening port in `log` with a unique standalone process owning that port and CSRF token.
 */
export function serverFromDiscovery(
  log: string,
  processes: ProcessCandidate | readonly ProcessCandidate[],
): ServerEndpoint {
  const list = Array.isArray(processes) ? processes : [processes];
  const rows = list.filter((p) => /--standalone\b/.test(p?.CommandLine || ''));
  if (!rows.length) throw new Error('未找到 Antigravity 桌面后台');
  const logPorts = [...log.matchAll(PORT_LOG_GLOBAL)].reverse().map((m) => Number(m[1]));
  let matchedRow: ProcessCandidate | null = null;
  let port: number | null = null;
  for (const candidate of logPorts) {
    const owners = rows.filter((r) => [r.Ports].flat().map(Number).includes(candidate));
    if (owners.length === 1) {
      matchedRow = owners[0];
      port = candidate;
      break;
    }
  }
  if (!matchedRow || port === null) throw new Error('等待 Antigravity 本地接口启动');
  const csrf = matchedRow.CommandLine?.match(/--csrf_token(?:=|\s+)"?([^\s"]+)/)?.[1];
  if (!csrf) throw new Error('当前版本未提供可用的本地检测凭据');
  return { port, csrf, pid: matchedRow.ProcessId };
}
