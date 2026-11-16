import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { linuxPorts, parseLsof, parseNetstat, type CommandRunner } from '../telemetry/discovery.ts';

export interface IdeProcessRow {
  ProcessId: number;
  ParentProcessId: number;
  Name?: string;
  CommandLine?: string;
}

export interface IdeSelectedServer extends IdeProcessRow {
  rootPid: number;
}

export interface DiscoveredIdeProcess extends IdeSelectedServer {
  Ports: number[];
}

export interface DiscoverIdeProcessesOptions {
  platform?: string;
  run?: CommandRunner;
  uid?: number;
  linuxPort?: (pid: number) => Promise<number[]>;
}

export interface DiscoverIdeLogOptions {
  read?: (file: string, encoding: BufferEncoding) => Promise<string>;
  list?: (dir: string) => Promise<string[]>;
}

const exec = promisify(execFile) as unknown as CommandRunner;

/**
 * Returns whether a process row represents an IDE main `language_server` (excluding LSP-only children).
 */
export const ideServer = (row: Partial<IdeProcessRow>): boolean =>
  /^language_server_(?:windows|linux|macos)_(?:x64|arm|arm64)(?:\.exe)?$/i.test(row.Name || '') &&
  /(?:^|\s)--subclient_type(?:=|\s+)"?ide(?:"|\s|$)/.test(row.CommandLine || '') &&
  !/(?:^|\s)--enable_lsp(?:\s|=|$)/.test(row.CommandLine || '');

/**
 * Returns whether a process row represents the root Antigravity IDE browser process.
 */
export const ideRoot = (row: Partial<IdeProcessRow>): boolean =>
  /^(?:Antigravity IDE(?:\.exe)?|antigravity-ide)$/i.test(row.Name || '') &&
  !/(?:^|[\s"])--(?:type|utility-sub-type)(?:[=\s"]|$)/i.test(row.CommandLine || '');

/**
 * Binds the unique IDE root owning `debugPort` to its single main language server child.
 */
export function selectIdeServer(
  rows: readonly IdeProcessRow[],
  portOwners: Map<number, Set<number> | readonly number[] | number>,
  debugPort: number,
): IdeSelectedServer {
  if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) {
    throw new Error('Invalid IDE renderer port');
  }
  const value = portOwners.get(debugPort);
  const pids = new Set<number>(
    value instanceof Set || Array.isArray(value) ? value : value === undefined ? [] : [value as number],
  );
  const roots = rows.filter((r) => pids.has(r.ProcessId) && ideRoot(r));
  if (!roots.length) throw new Error('IDE renderer port does not belong to Antigravity IDE');
  if (roots.length !== 1) throw new Error('Multiple Antigravity IDE instances own the renderer port');
  const root = roots[0];
  const candidates = rows.filter((r) => ideServer(r) && r.ParentProcessId === root.ProcessId);
  if (candidates.length !== 1) throw new Error('Waiting for the IDE main language server');
  return { ...candidates[0], rootPid: root.ProcessId };
}

/**
 * Discovers running Antigravity IDE processes, resolves listening ports, and selects the matching language server.
 */
export async function discoverIdeProcesses(
  debugPort: number,
  {
    platform = process.platform,
    run = exec,
    uid = (process as NodeJS.Process & { getuid?: () => number }).getuid?.(),
    linuxPort = linuxPorts,
  }: DiscoverIdeProcessesOptions = {},
): Promise<DiscoveredIdeProcess> {
  let rows: IdeProcessRow[];
  let ports: Map<number, number[]>;

  if (platform === 'win32') {
    const script =
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(Antigravity IDE|language_server_windows_(x64|arm|arm64))\\.exe$' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 2097152,
    });
    const parsed: unknown = r.stdout.trim() ? JSON.parse(r.stdout.replace(/^\uFEFF/, '')) : [];
    rows = (Array.isArray(parsed) ? parsed : [parsed]) as IdeProcessRow[];
    const netstat = await run('netstat.exe', ['-ano', '-p', 'tcp'], {
      windowsHide: true,
      timeout: 4000,
      maxBuffer: 4194304,
    });
    ports = parseNetstat(netstat.stdout);
  } else {
    const { stdout } = await run('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,uid=,args='], {
      timeout: 8000,
      maxBuffer: 4194304,
    });
    rows = stdout.split(/\r?\n/).flatMap((line): IdeProcessRow[] => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!m || Number(m[3]) !== uid) return [];
      const command = m[4];
      let name: string | undefined;
      if (/(?:^|\/)Antigravity IDE(?:\s|$)/.test(command)) name = 'Antigravity IDE';
      else if (/(?:^|\/)antigravity-ide(?:\s|$)/.test(command)) name = 'antigravity-ide';
      else name = command.match(/(?:^|\/)(language_server_(?:macos|linux)_(?:x64|arm|arm64))(?:\s|$)/)?.[1];
      return name
        ? [{ ProcessId: Number(m[1]), ParentProcessId: Number(m[2]), Name: name, CommandLine: command }]
        : [];
    });
    if (!rows.length) throw new Error('Waiting for Antigravity IDE processes');

    if (platform === 'darwin') {
      const { stdout: lsofOut } = await run(
        '/usr/sbin/lsof',
        ['-nP', '-a', '-p', rows.map((r) => r.ProcessId).join(','), '-iTCP', '-sTCP:LISTEN', '-Fpn'],
        { timeout: 8000, maxBuffer: 2097152 },
      ).catch((e: unknown) => {
        if ((e as { code?: unknown } | null)?.code === 1) return { stdout: '' };
        throw e;
      });
      ports = parseLsof(lsofOut);
    } else if (platform === 'linux') {
      ports = new Map(
        await Promise.all(
          rows.map(async (r) => [r.ProcessId, await linuxPort(r.ProcessId).catch(() => [] as number[])] as const),
        ),
      );
    } else {
      throw new Error('Unsupported IDE platform');
    }
  }

  const owners = new Map<number, Set<number>>();
  // /proc and lsof may report the same inherited socket for the root, its
  // language server and Electron helpers. Keep all owners; never let process
  // iteration order replace the root or resolve a multi-instance ambiguity.
  for (const [pid, values] of ports) {
    for (const port of values) {
      let set = owners.get(port);
      if (!set) {
        set = new Set<number>();
        owners.set(port, set);
      }
      set.add(pid);
    }
  }

  const selected = selectIdeServer(rows, owners, debugPort);
  return { ...selected, Ports: ports.get(selected.ProcessId) || [] };
}

/**
 * Finds the active IDE HTTP language-server port in recent session logs that matches `ports`.
 */
export async function discoverIdeLog(
  profile: string,
  ports: readonly number[],
  { read = readFile, list = readdir }: DiscoverIdeLogOptions = {},
): Promise<number> {
  const names = (await list(join(profile, 'logs')))
    .filter((n) => /^\d{8}T\d{6}$/.test(n))
    .sort()
    .reverse();

  for (const name of names.slice(0, 8)) {
    let log: string;
    try {
      log = await read(join(profile, 'logs', name, 'ls-main.log'), 'utf8');
    } catch {
      continue;
    }
    const port = [...log.matchAll(/listening on random port at (\d+) for HTTP(?:\s|$)/g)]
      .reverse()
      .map((m) => Number(m[1]))
      .find((p) => ports.includes(p));
    if (port) return port;
  }

  throw new Error('Waiting for the IDE local API port');
}
