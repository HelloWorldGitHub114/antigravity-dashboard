import { execFileSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CLI_INSTALL_NAME, CLI_RUNTIME_FILES } from '../platform/manifest.ts';
import {
  assertRegularTree,
  findExecutableOnPath,
  isReparseOrSymlink,
  readJsonObjectSync,
  writeJsonObjectSync,
} from './fs-helpers.ts';

export interface CliInstallPaths {
  base: string;
  settings: string;
  runtimeRoot: string;
  backup: string;
}

interface CliInstallState {
  name?: string;
  schema?: number;
  previousPresent?: boolean;
  previous?: unknown;
  commands?: string[];
  command?: string;
}

interface CliSettingsConfig {
  statusLine?: {
    type?: string;
    command?: string;
    enabled?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Resolves CLI adapter storage paths under `home`.
 */
export function cliLifecyclePaths(home: string): CliInstallPaths {
  const base = join(home, '.gemini', 'antigravity-cli');
  return {
    base,
    settings: join(base, 'settings.json'),
    runtimeRoot: join(base, 'antigrative-dashboard'),
    backup: join(base, '.antigrative-dashboard-install.json'),
  };
}

function verifyCliRoot(root: string): void {
  if (isReparseOrSymlink(root)) {
    throw new Error('CLI installation paths must not contain symlinks or junctions.');
  }
  if (!existsSync(root)) return;
  const meta = readJsonObjectSync<{ name?: string }>(join(root, 'installation.json'));
  if (meta.name !== CLI_INSTALL_NAME) {
    throw new Error('CLI destination is not our installation; refusing to overwrite it.');
  }
  assertRegularTree(root);
}

function withCliLock<T>(base: string, fn: () => T): T {
  if (isReparseOrSymlink(base)) {
    throw new Error('CLI installation paths must not contain symlinks or junctions.');
  }
  mkdirSync(base, { recursive: true });
  const lock = join(base, '.antigrative-dashboard.lock');
  let fd: number;
  try {
    fd = openSync(lock, 'wx', 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
    if (code === 'EEXIST') {
      throw new Error(
        'Another CLI lifecycle operation is active. If a prior operation crashed, inspect and remove .antigrative-dashboard.lock before retrying.',
      );
    }
    throw error;
  }
  try {
    closeSync(fd);
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // Ignore cleanup error if lock already removed.
    }
  }
}

function posixShellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/**
 * Formats the shell invocation registered in `~/.gemini/antigravity-cli/settings.json`.
 */
export function buildCliStatusCommand(
  nodeExec: string,
  scriptPath: string,
  language?: string,
  platform: string = process.platform,
): string {
  const values = [String(nodeExec), String(scriptPath)];
  if (language && language !== 'en' && language !== 'zh-CN') {
    throw new Error('Language must be en or zh-CN.');
  }
  if (platform === 'win32') {
    if (values.some((v) => /[\r\n\0]/.test(v))) {
      throw new Error('Node/home path contains unsupported control characters.');
    }
    const literal = (v: string) => `'${v.replaceAll("'", "''")}'`;
    let invocation = ` & ${values.map(literal).join(' ')}`;
    if (language) invocation += ` --language ${language}`;
    const script =
      '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);' +
      `${invocation}; exit $LASTEXITCODE`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  }
  let result = values.map(posixShellQuote).join(' ');
  if (language) result += ` --language ${language}`;
  return result;
}

/**
 * Locates Node.js 20+ on PATH or validates an explicit executable path.
 */
export function resolveNodeExecutable(nodeCandidate?: string): string {
  const found = findExecutableOnPath(nodeCandidate || 'node');
  if (!found) {
    throw new Error('Node.js 20+ is required on PATH, or pass --node /absolute/path/to/node.');
  }
  let output: string;
  try {
    output = execFileSync(found, ['--version'], { encoding: 'utf8', windowsHide: true });
  } catch {
    throw new Error('The specified executable did not report a Node.js version.');
  }
  const major = Number.parseInt(output.trim().replace(/^v/, '').split('.')[0] || '', 10);
  if (!Number.isFinite(major)) {
    throw new Error('The specified executable did not report a Node.js version.');
  }
  if (major < 20) {
    throw new Error('Node.js 20+ is required.');
  }
  return found;
}

function ownsCliStatusLine(current: CliSettingsConfig['statusLine'], state: CliInstallState): boolean {
  if (state.name !== CLI_INSTALL_NAME || state.schema !== 1) return false;
  if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
  if (current.type !== 'command' || typeof current.command !== 'string') return false;
  const knownCommands = Array.isArray(state.commands)
    ? state.commands
    : state.command
      ? [state.command]
      : [];
  return knownCommands.includes(current.command);
}

function readBytesIfExists(filePath: string): Buffer | null {
  return existsSync(filePath) ? readFileSync(filePath) : null;
}

/**
 * Installs the standalone Antigravity CLI statusLine adapter.
 */
export function installCli(
  sourceRoot: string,
  home: string,
  nodeCandidate?: string,
  language?: string,
): void {
  const nodeExec = resolveNodeExecutable(nodeCandidate);
  const { base, settings, runtimeRoot, backup } = cliLifecyclePaths(home);
  const installedCommand = buildCliStatusCommand(
    nodeExec,
    join(runtimeRoot, 'cli', 'statusline.mjs'),
    language,
  );

  withCliLock(base, () => {
    if (isReparseOrSymlink(settings) || isReparseOrSymlink(backup)) {
      throw new Error('CLI installation paths must not contain symlinks or junctions.');
    }
    verifyCliRoot(runtimeRoot);
    const before = readBytesIfExists(settings);
    const config = readJsonObjectSync<CliSettingsConfig>(settings);
    let state = readJsonObjectSync<CliInstallState>(backup);
    const current = config.statusLine;

    if (existsSync(runtimeRoot) && (state.name !== CLI_INSTALL_NAME || state.schema !== 1)) {
      throw new Error('CLI recovery record is missing or invalid; refusing to overwrite the installation.');
    }
    const owned = ownsCliStatusLine(current, state);
    if (!owned) {
      state = {
        name: CLI_INSTALL_NAME,
        schema: 1,
        previousPresent: Object.hasOwn(config, 'statusLine'),
        previous: current,
      };
    } else if (state.name !== CLI_INSTALL_NAME || state.schema !== 1) {
      throw new Error('CLI recovery record has an incompatible shape.');
    }

    const prevCmds = owned && current?.command ? [current.command] : [];
    state.commands = [...new Set([...prevCmds, installedCommand])];
    state.command = installedCommand;
    writeJsonObjectSync(backup, state, 0o600);

    mkdirSync(runtimeRoot, { recursive: true });
    writeJsonObjectSync(join(runtimeRoot, 'installation.json'), { name: CLI_INSTALL_NAME, schema: 1 });
    for (const rel of CLI_RUNTIME_FILES) {
      const target = join(runtimeRoot, rel);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(sourceRoot, rel), target);
    }

    const afterCopy = readBytesIfExists(settings);
    if ((before === null && afterCopy !== null) || (before !== null && (afterCopy === null || !before.equals(afterCopy)))) {
      throw new Error('CLI settings changed during installation; retry without overwriting concurrent edits.');
    }

    config.statusLine = {
      ...(owned && current ? current : {}),
      type: 'command',
      command: installedCommand,
      enabled: true,
    };
    writeJsonObjectSync(settings, config, 0o600);
  });

  console.log(`CLI status line installed: ${runtimeRoot}`);
  console.log('Reopen agy to load it. Desktop installation and statistics are unchanged.');
}

/**
 * Uninstalls the standalone CLI adapter and restores any prior user `statusLine`.
 */
export function uninstallCli(home: string): void {
  const { base, settings, runtimeRoot, backup } = cliLifecyclePaths(home);
  if (!existsSync(runtimeRoot) && !existsSync(backup)) {
    console.log('CLI status line is not installed.');
    return;
  }

  withCliLock(base, () => {
    if (isReparseOrSymlink(settings) || isReparseOrSymlink(backup)) {
      throw new Error('CLI installation paths must not contain symlinks or junctions.');
    }
    verifyCliRoot(runtimeRoot);
    const before = readBytesIfExists(settings);
    const state = readJsonObjectSync<CliInstallState>(backup);
    const config = readJsonObjectSync<CliSettingsConfig>(settings);

    if (state.name !== CLI_INSTALL_NAME || state.schema !== 1) {
      throw new Error('Missing or invalid CLI recovery record; refusing to remove runtime.');
    }

    const current = config.statusLine;
    if (ownsCliStatusLine(current, state)) {
      if (state.previousPresent) {
        config.statusLine = state.previous as CliSettingsConfig['statusLine'];
      } else {
        delete config.statusLine;
      }
      const afterRead = readBytesIfExists(settings);
      if ((before === null && afterRead !== null) || (before !== null && (afterRead === null || !before.equals(afterRead)))) {
        throw new Error('CLI settings changed during uninstall; retry without overwriting concurrent edits.');
      }
      writeJsonObjectSync(settings, config, 0o600);
    }

    if (existsSync(runtimeRoot)) {
      const resolved = resolve(runtimeRoot);
      if (dirname(resolved) !== resolve(base) || resolved !== resolve(join(base, 'antigrative-dashboard'))) {
        throw new Error('CLI removal target is outside its expected directory.');
      }
      rmSync(resolved, { recursive: true, force: true });
    }
    rmSync(backup, { force: true });
  });

  console.log('CLI adapter removed; prior statusLine restored if still owned. Reopen agy.');
}

/**
 * Reports CLI statusLine adapter installation and configuration state.
 */
export function statusCli(home: string): Record<string, unknown> {
  const { settings, runtimeRoot, backup } = cliLifecyclePaths(home);
  const state = readJsonObjectSync<CliInstallState>(backup);
  const config = readJsonObjectSync<CliSettingsConfig>(settings);
  const current = config.statusLine;
  const configured = ownsCliStatusLine(current, state);
  const payload = {
    installed: existsSync(join(runtimeRoot, 'cli', 'statusline.mjs')),
    configured,
    enabled: configured && current?.enabled !== false,
    directory: runtimeRoot,
    settings,
  };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}
