import { execFile } from 'node:child_process';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export interface DiscoveredProcessRow {
  ProcessId: number;
  CommandLine: string;
}

export interface DiscoveredProcess extends DiscoveredProcessRow {
  Ports: number[];
}

export interface ProcNetEntry {
  inode: string;
  port: number;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: { windowsHide?: boolean; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr?: string }>;

export interface DiscoverProcessesOptions {
  platform?: string;
  run?: CommandRunner;
  uid?: number;
  proc?: string;
}

export interface LinuxPortsOptions {
  proc?: string;
}

interface RawWinProcessRow {
  ProcessId?: unknown;
  CommandLine?: unknown;
}

interface RawNetTcpItem {
  OwningProcess?: unknown;
  LocalPort?: unknown;
}

const exec = promisify(execFile) as unknown as CommandRunner;
const LANGUAGE_SERVER_RE =
  /(?:^|[\/\\])language_server(?:_(?:linux|macos|darwin)(?:_(?:x64|arm64))?)?(?:\.exe)?(?:\s|$)/;

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Parse macOS `ps` output into standalone `language_server` process rows for `uid`.
 */
export function parsePs(text: string, uid: number | undefined): DiscoveredProcessRow[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[2]) !== uid || !LANGUAGE_SERVER_RE.test(match[3]) || !/--standalone\b/.test(match[3])) {
      return [];
    }
    return [{ ProcessId: Number(match[1]), CommandLine: match[3] }];
  });
}

/**
 * Parse machine-readable `lsof -Fpn` output into a map of PID to listening ports.
 */
export function parseLsof(text: string): Map<number, number[]> {
  // Machine-readable fields: p (PID), n (socket name). Never parse human columns.
  let pid: number | null = null;
  const ports = new Map<number, number[]>();
  for (const line of text.split(/\r?\n/)) {
    if (/^p\d+$/.test(line)) {
      pid = Number(line.slice(1));
      if (!ports.has(pid)) ports.set(pid, []);
    }
    const port = line[0] === 'n' ? line.match(/:(\d+)(?:\s|$)/)?.[1] : undefined;
    if (pid && port) ports.get(pid)!.push(Number(port));
  }
  return ports;
}

/**
 * Parse `/proc/<pid>/net/tcp{,6}` rows into listening socket inode-to-port mappings.
 */
export function parseProcNet(text: string): ProcNetEntry[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== '0A' || !/^\d+$/.test(fields[9] || '')) return [];
    const hex = fields[1]?.split(':')[1];
    const port = /^[0-9A-F]{4}$/i.test(hex || '') ? parseInt(hex!, 16) : 0;
    return port > 0 ? [{ inode: fields[9], port }] : [];
  });
}

/**
 * Parse Windows `netstat -ano -p tcp` output into a map of PID to listening ports.
 */
export function parseNetstat(text: string): Map<number, number[]> {
  const ports = new Map<number, Set<number>>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\S+)\s+\S+\s+(?:LISTENING|LISTEN|侦听|监听)\s+(\d+)\s*$/i);
    if (!match) continue;
    const port = Number(match[1].match(/:(\d+)$/)?.[1]);
    const pid = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(pid) || pid < 1) {
      continue;
    }
    let set = ports.get(pid);
    if (!set) {
      set = new Set();
      ports.set(pid, set);
    }
    set.add(port);
  }
  return new Map([...ports].map(([pid, values]) => [pid, [...values]]));
}

/**
 * Resolve listening TCP ports for a Linux process via `/proc/<pid>/fd` and `/proc/<pid>/net/tcp{,6}`.
 */
export async function linuxPorts(pid: number | string, { proc = '/proc' }: LinuxPortsOptions = {}): Promise<number[]> {
  const pidDir = join(proc, String(pid));
  const fdDir = join(pidDir, 'fd');
  const [fds, netTables] = await Promise.all([
    readdir(fdDir),
    Promise.all(['tcp', 'tcp6'].map(async (name) => {
      try {
        return parseProcNet(await readFile(join(pidDir, 'net', name), 'utf8'));
      } catch {
        return []; // IPv6 may be disabled.
      }
    })),
  ]);
  const links = await mapLimit(fds, 32, async (fd) => {
    try {
      return await readlink(join(fdDir, fd));
    } catch {
      return ''; // Closed FD.
    }
  });
  const inodes = new Set<string>();
  for (const link of links) {
    const m = link.match(/^socket:\[(\d+)\]$/);
    if (m) inodes.add(m[1]);
  }
  const ports = new Set<number>();
  for (const rows of netTables) {
    for (const row of rows) {
      if (inodes.has(row.inode)) ports.add(row.port);
    }
  }
  return [...ports];
}

async function discoverWin32Processes(run: CommandRunner): Promise<DiscoveredProcess[]> {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | Where-Object { $_.CommandLine -match '(?:^|\\s)--standalone(?:\\s|=|$)' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 8000,
    maxBuffer: 1048576,
  });
  const parsed: unknown = stdout.trim() ? JSON.parse(stdout.replace(/^\uFEFF/, '')) : [];
  const rawList: RawWinProcessRow[] = Array.isArray(parsed)
    ? (parsed as RawWinProcessRow[])
    : [parsed as RawWinProcessRow];
  const rows: DiscoveredProcessRow[] = rawList.flatMap((row) => {
    const pid = row?.ProcessId;
    const cmd = row?.CommandLine;
    if (
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof cmd !== 'string' ||
      !/(?:^|\s)--standalone(?:\s|=|$)/.test(cmd)
    ) {
      return [];
    }
    return [{ ProcessId: pid, CommandLine: cmd }];
  });
  if (!rows.length) return [];

  // One native socket-table snapshot for all candidates, rather than a costly
  // Get-NetTCPConnection/CIM query for every language_server.exe process.
  const { stdout: sockets } = await run('netstat.exe', ['-ano', '-p', 'tcp'], {
    windowsHide: true,
    timeout: 4000,
    maxBuffer: 4194304,
  }).catch(() => ({ stdout: '' }));
  const ports = parseNetstat(sockets);
  const missing = rows.filter((row) => !ports.get(row.ProcessId)?.length).map((row) => row.ProcessId);
  if (missing.length) {
    // One asynchronous fallback for all missing candidates, never a shell
    // per process or an unverified log-only port paired with a credential.
    const fallbackScript = `$pulsePids = @(${missing.join(',')}); Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $pulsePids -contains $_.OwningProcess } | Select-Object OwningProcess,LocalPort | ConvertTo-Json -Compress`;
    try {
      const { stdout: psOut } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', fallbackScript], {
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 1048576,
      });
      const value: unknown = psOut.trim() ? JSON.parse(psOut.replace(/^\uFEFF/, '')) : [];
      const items: RawNetTcpItem[] = Array.isArray(value) ? (value as RawNetTcpItem[]) : [value as RawNetTcpItem];
      for (const item of items) {
        const pid = Number(item?.OwningProcess);
        const port = Number(item?.LocalPort);
        if (!missing.includes(pid) || !Number.isInteger(port) || port < 1 || port > 65535) continue;
        let list = ports.get(pid);
        if (!list) {
          list = [];
          ports.set(pid, list);
        }
        if (!list.includes(port)) list.push(port);
      }
    } catch {
      // Keep discovery waiting safely if both socket sources fail.
    }
  }
  return rows.map((row) => ({ ...row, Ports: ports.get(row.ProcessId) || [] }));
}

/**
 * Discover running standalone `language_server` processes and their listening TCP ports.
 */
export async function discoverProcesses({
  platform = process.platform,
  run = exec,
  uid = (process as NodeJS.Process & { getuid?: () => number }).getuid?.(),
  proc = '/proc',
}: DiscoverProcessesOptions = {}): Promise<DiscoveredProcess[]> {
  if (platform === 'win32') return discoverWin32Processes(run);
  if (platform === 'darwin') {
    const { stdout } = await run('/bin/ps', ['-ww', '-axo', 'pid=,uid=,args='], {
      timeout: 8000,
      maxBuffer: 4194304,
    });
    const rows = parsePs(stdout, uid);
    if (!rows.length) return [];
    const { stdout: sockets } = await run(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-p', rows.map((r) => r.ProcessId).join(','), '-iTCP', '-sTCP:LISTEN', '-Fpn'],
      { timeout: 8000, maxBuffer: 1048576 },
    ).catch((error: unknown) => {
      if ((error as { code?: unknown } | null)?.code === 1) {
        return { stdout: String((error as { stdout?: unknown }).stdout || '') };
      }
      throw error;
    });
    const ports = parseLsof(sockets);
    return rows.map((row) => ({ ...row, Ports: ports.get(row.ProcessId) || [] }));
  }
  if (platform === 'linux') {
    const pids = (await readdir(proc)).filter((p) => /^\d+$/.test(p));
    const found = await mapLimit(pids, 16, async (pid): Promise<DiscoveredProcess | null> => {
      try {
        const status = await readFile(join(proc, pid, 'status'), 'utf8');
        if (Number(status.match(/^Uid:\s+(\d+)/m)?.[1]) !== uid) return null;
        const command = (await readFile(join(proc, pid, 'cmdline'), 'utf8')).split('\0').filter(Boolean).join(' ');
        if (!LANGUAGE_SERVER_RE.test(command) || !/--standalone\b/.test(command)) return null;
        return { ProcessId: Number(pid), CommandLine: command, Ports: await linuxPorts(pid, { proc }) };
      } catch {
        // Processes can exit during discovery; inaccessible processes are not candidates.
        return null;
      }
    });
    return found.filter((item): item is DiscoveredProcess => item !== null);
  }
  throw new Error('Supported platforms: Windows, Linux, macOS');
}
