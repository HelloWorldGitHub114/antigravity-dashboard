import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { appAsarCandidates, platformPaths, type PlatformPathOptions } from '../platform/paths.ts';
import { readJsonObjectSync, writeJsonObjectSync } from './fs-helpers.ts';

export const DEBUG_PORT_FLAG = '--remote-debugging-port=0';
export const DEBUG_ADDR_FLAG = '--remote-debugging-address=127.0.0.1';
export const DEBUG_LAUNCH_FLAGS = [DEBUG_PORT_FLAG, DEBUG_ADDR_FLAG] as const;

const WIN_DASHBOARD_SHORTCUT_NAME = 'Antigravity (Dashboard).lnk';
const MAC_DASHBOARD_LAUNCHER_NAME = 'Antigravity (Dashboard).command';

export interface DebugLaunchState {
  schema: 1;
  enabled: boolean;
  patchedShortcuts: string[];
  createdFiles: string[];
  desktopBackup?: { path: string; existed: boolean; content: string | null } | null;
}

export interface DebugLaunchOutcome {
  enabled: boolean;
  configured: boolean;
  platform: string;
  patchedTargets: string[];
  createdTargets: string[];
  removedTargets: string[];
  launcherPath: string | null;
  exeFound: boolean;
  message: string;
}

export interface ShortcutEntry {
  path: string;
  targetPath: string;
  arguments: string;
}

export interface WindowsShortcutDriver {
  readShortcuts(paths: string[]): ShortcutEntry[];
  writeShortcuts(updates: Array<{ path: string; targetPath?: string; arguments: string }>): void;
}

export interface DebugLaunchOptions extends PlatformPathOptions {
  appPath?: string;
  windowsDriver?: WindowsShortcutDriver;
}

function debugStateFile(options: PlatformPathOptions): string {
  return join(dirname(platformPaths(options).settings), 'debug-launch-state.json');
}

function readDebugState(file: string): DebugLaunchState {
  const raw = readJsonObjectSync<Partial<DebugLaunchState>>(file);
  return {
    schema: 1,
    enabled: raw.enabled === true,
    patchedShortcuts: Array.isArray(raw.patchedShortcuts)
      ? raw.patchedShortcuts.filter((v): v is string => typeof v === 'string')
      : [],
    createdFiles: Array.isArray(raw.createdFiles)
      ? raw.createdFiles.filter((v): v is string => typeof v === 'string')
      : [],
    desktopBackup: raw.desktopBackup && typeof raw.desktopBackup === 'object' ? raw.desktopBackup : null,
  };
}

function writeDebugState(file: string, state: DebugLaunchState): void {
  writeJsonObjectSync(file, state);
}

/**
 * Splits a Windows/POSIX argument string into tokens while preserving quoted segments.
 */
export function tokenizeArgs(raw: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if ((ch === '"' || ch === "'") && quote === null) {
      quote = ch;
      cur += ch;
    } else if (ch === quote) {
      quote = null;
      cur += ch;
    } else if (/\s/.test(ch) && quote === null) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

export function hasDebugFlags(rawArgs: string): boolean {
  const tokens = tokenizeArgs(rawArgs);
  return tokens.some((tok) => tok === '--remote-debugging-port' || tok.startsWith('--remote-debugging-port='));
}

export function appendDebugFlags(rawArgs: string): { next: string; changed: boolean } {
  const tokens = tokenizeArgs(rawArgs);
  const hasPort = tokens.some((tok) => tok === '--remote-debugging-port' || tok.startsWith('--remote-debugging-port='));
  const hasAddr = tokens.some(
    (tok) => tok === '--remote-debugging-address' || tok.startsWith('--remote-debugging-address='),
  );
  const nextTokens = [...tokens];
  if (!hasPort) nextTokens.push(DEBUG_PORT_FLAG);
  if (!hasAddr) nextTokens.push(DEBUG_ADDR_FLAG);
  return {
    next: nextTokens.join(' '),
    changed: !hasPort || !hasAddr,
  };
}

export function stripDebugFlags(rawArgs: string): { next: string; changed: boolean } {
  const tokens = tokenizeArgs(rawArgs);
  const kept: string[] = [];
  let changed = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok === DEBUG_PORT_FLAG || tok === DEBUG_ADDR_FLAG) {
      changed = true;
      continue;
    }
    if (
      (tok === '--remote-debugging-port' && tokens[i + 1] === '0') ||
      (tok === '--remote-debugging-address' && tokens[i + 1] === '127.0.0.1')
    ) {
      changed = true;
      i += 1;
      continue;
    }
    kept.push(tok);
  }
  return { next: kept.join(' '), changed };
}

/**
 * Reads the host application's `package.json` version directly from `app.asar` header/entry.
 */
export function resolveHostAppVersion(appAsarPath: string): string | null {
  if (!appAsarPath || !existsSync(appAsarPath)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(appAsarPath, 'r');
    const head = Buffer.alloc(16);
    if (readSync(fd, head, 0, 16, 0) < 16) return null;
    const size1 = head.readUInt32LE(4);
    const headerLen = head.readUInt32LE(12);
    if (headerLen <= 0 || headerLen > 16 * 1024 * 1024) return null;
    const headerBuf = Buffer.alloc(headerLen);
    if (readSync(fd, headerBuf, 0, headerLen, 16) < headerLen) return null;
    const header = JSON.parse(headerBuf.toString('utf8')) as {
      files?: Record<string, { offset?: string; size?: number }>;
    };
    const pkgEntry = header.files?.['package.json'];
    if (!pkgEntry || pkgEntry.offset === undefined || typeof pkgEntry.size !== 'number' || pkgEntry.size > 1048576) {
      return null;
    }
    const pkgBuf = Buffer.alloc(pkgEntry.size);
    const pkgOffset = 8 + size1 + Number(pkgEntry.offset);
    if (readSync(fd, pkgBuf, 0, pkgEntry.size, pkgOffset) < pkgEntry.size) return null;
    const pkg = JSON.parse(pkgBuf.toString('utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

export function resolveDesktopExecutable(options: DebugLaunchOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const candidates = options.appPath ? [resolve(options.appPath)] : appAsarCandidates(options);
  for (const asarPath of candidates) {
    if (!existsSync(asarPath)) continue;
    if (platform === 'win32') {
      const exe = join(dirname(dirname(asarPath)), 'Antigravity.exe');
      if (existsSync(exe)) return exe;
    } else if (platform === 'darwin') {
      const appBundle = dirname(dirname(dirname(asarPath)));
      if (appBundle.endsWith('.app') && existsSync(appBundle)) return appBundle;
    } else {
      const rootDir = dirname(dirname(asarPath));
      for (const name of ['antigravity', 'Antigravity']) {
        const bin = join(rootDir, name);
        if (existsSync(bin)) return bin;
      }
    }
  }
  if (platform === 'darwin') {
    for (const appBundle of ['/Applications/Antigravity.app', join(home, 'Applications', 'Antigravity.app')]) {
      if (existsSync(appBundle)) return appBundle;
    }
  }
  if (platform === 'linux') {
    for (const bin of ['/usr/bin/antigravity', '/opt/Antigravity/antigravity', '/opt/antigravity/antigravity']) {
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

function collectLnkFiles(dir: string, maxDepth: number, out: Set<string>, depth = 0): void {
  if (depth > maxDepth || !existsSync(dir)) return;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        collectLnkFiles(full, maxDepth, out, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk')) {
        out.add(full);
      }
    }
  } catch {
    // Ignore inaccessible folders.
  }
}

function findWindowsShortcutCandidates(options: DebugLaunchOptions): {
  desktopDir: string;
  shortcuts: string[];
} {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
  const desktopDir = join(home, 'Desktop');
  const found = new Set<string>();
  collectLnkFiles(desktopDir, 2, found);
  const oneDriveDesktop = join(home, 'OneDrive', 'Desktop');
  if (existsSync(oneDriveDesktop)) collectLnkFiles(oneDriveDesktop, 2, found);
  collectLnkFiles(join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), 3, found);
  return { desktopDir, shortcuts: [...found].sort() };
}

function defaultWindowsDriver(): WindowsShortcutDriver {
  const runPs = (script: string, payload: unknown): string =>
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
      },
    );

  return {
    readShortcuts(paths) {
      if (paths.length === 0) return [];
      const script = [
        '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json',
        '$sh = New-Object -ComObject WScript.Shell',
        '$out = @()',
        'foreach ($p in $paths) {',
        '  if (Test-Path -LiteralPath $p) {',
        '    try {',
        '      $sc = $sh.CreateShortcut($p)',
        '      $out += [PSCustomObject]@{ path = $p; targetPath = [string]$sc.TargetPath; arguments = [string]$sc.Arguments }',
        '    } catch {}',
        '  }',
        '}',
        '$out | ConvertTo-Json -Compress',
      ].join('\n');
      const raw = runPs(script, paths).trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw) as ShortcutEntry | ShortcutEntry[];
      return Array.isArray(parsed) ? parsed : [parsed];
    },
    writeShortcuts(updates) {
      if (updates.length === 0) return;
      const script = [
        '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$items = [Console]::In.ReadToEnd() | ConvertFrom-Json',
        '$sh = New-Object -ComObject WScript.Shell',
        'foreach ($item in $items) {',
        '  $sc = $sh.CreateShortcut($item.path)',
        '  if ($item.targetPath) { $sc.TargetPath = [string]$item.targetPath }',
        '  $sc.Arguments = [string]$item.arguments',
        '  $sc.Save()',
        '}',
      ].join('\n');
      runPs(script, updates);
    },
  };
}

function isDirectAntigravityShortcut(entry: ShortcutEntry): boolean {
  const fileLower = basename(entry.path).toLowerCase();
  if (fileLower.includes('uninstall') || fileLower.includes('卸载')) return false;
  return basename(entry.targetPath || '').toLowerCase() === 'antigravity.exe';
}

function injectFlagsIntoDesktopExec(line: string): string {
  if (!line.startsWith('Exec=')) return line;
  const rawCmd = line.slice(5);
  if (hasDebugFlags(rawCmd)) return line;
  const placeholderRe = /(\s+%[uUfFiIcCk])+\s*$/;
  const match = rawCmd.match(placeholderRe);
  if (match && match.index !== undefined) {
    return `Exec=${rawCmd.slice(0, match.index)} ${DEBUG_PORT_FLAG} ${DEBUG_ADDR_FLAG}${match[0]}`;
  }
  return `Exec=${rawCmd.trimEnd()} ${DEBUG_PORT_FLAG} ${DEBUG_ADDR_FLAG}`;
}

function stripFlagsFromDesktopExec(line: string): string {
  if (!line.startsWith('Exec=')) return line;
  const { next } = stripDebugFlags(line.slice(5));
  return `Exec=${next}`;
}

export function getDebugLaunchStatus(options: DebugLaunchOptions = {}): {
  enabled: boolean;
  configured: boolean;
  platform: string;
  launcherPath: string | null;
  exeFound: boolean;
} {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const state = readDebugState(debugStateFile(options));
  const exe = resolveDesktopExecutable(options);
  let launcherPath: string | null = null;
  let configured = state.enabled;

  if (platform === 'darwin') {
    const cmdPath = join(home, 'Desktop', MAC_DASHBOARD_LAUNCHER_NAME);
    if (existsSync(cmdPath)) {
      launcherPath = cmdPath;
      configured = true;
    }
  } else if (platform === 'linux') {
    const dataHome = (options.env ?? process.env).XDG_DATA_HOME || join(home, '.local', 'share');
    const desktopFile = join(dataHome, 'applications', 'antigravity.desktop');
    if (existsSync(desktopFile)) {
      launcherPath = desktopFile;
      try {
        configured = readFileSync(desktopFile, 'utf8').includes('--remote-debugging-port');
      } catch {
        // Keep state fallback.
      }
    }
  } else if (state.createdFiles.length > 0) {
    const first = state.createdFiles.find((p) => existsSync(p));
    launcherPath = first ?? null;
  }

  return {
    enabled: state.enabled,
    configured,
    platform,
    launcherPath,
    exeFound: Boolean(exe),
  };
}

/**
 * Applies or reverts Method 1 (OS shortcut / desktop entry / macOS launcher script)
 * to launch Antigravity with `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1`.
 */
export function applyDebugLaunch(enabled: boolean, options: DebugLaunchOptions = {}): DebugLaunchOutcome {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const statePath = debugStateFile(options);
  const state = readDebugState(statePath);
  const exe = resolveDesktopExecutable(options);
  const patchedTargets: string[] = [];
  const createdTargets: string[] = [];
  const removedTargets: string[] = [];
  let launcherPath: string | null = null;

  if (platform === 'win32') {
    const driver = options.windowsDriver ?? defaultWindowsDriver();
    const { desktopDir, shortcuts } = findWindowsShortcutCandidates(options);
    const allPaths = [...new Set([...shortcuts, ...state.patchedShortcuts, ...state.createdFiles])];
    const entries = driver.readShortcuts(allPaths);
    const updates: Array<{ path: string; targetPath?: string; arguments: string }> = [];

    if (enabled) {
      const matching = entries.filter(isDirectAntigravityShortcut);
      for (const entry of matching) {
        const { next, changed } = appendDebugFlags(entry.arguments || '');
        if (changed) updates.push({ path: entry.path, arguments: next });
        patchedTargets.push(entry.path);
      }
      if (matching.length === 0 && exe) {
        mkdirSync(desktopDir, { recursive: true });
        const created = join(desktopDir, WIN_DASHBOARD_SHORTCUT_NAME);
        updates.push({
          path: created,
          targetPath: exe,
          arguments: `${DEBUG_PORT_FLAG} ${DEBUG_ADDR_FLAG}`,
        });
        createdTargets.push(created);
        launcherPath = created;
      }
      driver.writeShortcuts(updates);
      writeDebugState(statePath, {
        schema: 1,
        enabled: true,
        patchedShortcuts: [...new Set([...state.patchedShortcuts, ...patchedTargets])],
        createdFiles: [...new Set([...state.createdFiles, ...createdTargets])],
        desktopBackup: state.desktopBackup ?? null,
      });
    } else {
      for (const entry of entries) {
        if (state.createdFiles.includes(entry.path)) continue;
        if (!isDirectAntigravityShortcut(entry)) continue;
        const { next, changed } = stripDebugFlags(entry.arguments || '');
        if (changed) {
          updates.push({ path: entry.path, arguments: next });
          patchedTargets.push(entry.path);
        }
      }
      driver.writeShortcuts(updates);
      for (const created of state.createdFiles) {
        if (existsSync(created)) {
          rmSync(created, { force: true });
          removedTargets.push(created);
        }
      }
      writeDebugState(statePath, {
        schema: 1,
        enabled: false,
        patchedShortcuts: [],
        createdFiles: [],
        desktopBackup: null,
      });
    }
  } else if (platform === 'linux') {
    const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share');
    const appsDir = join(dataHome, 'applications');
    const userDesktop = join(appsDir, 'antigravity.desktop');
    const systemCandidates = [
      '/usr/share/applications/antigravity.desktop',
      '/usr/local/share/applications/antigravity.desktop',
    ];
    if (enabled) {
      let sourceContent: string | null = null;
      let backup = state.desktopBackup ?? null;
      if (existsSync(userDesktop)) {
        sourceContent = readFileSync(userDesktop, 'utf8');
        if (!backup) backup = { path: userDesktop, existed: true, content: sourceContent };
      } else {
        const sysFile = systemCandidates.find((p) => existsSync(p));
        if (sysFile) sourceContent = readFileSync(sysFile, 'utf8');
        if (!backup) backup = { path: userDesktop, existed: false, content: null };
      }
      if (!sourceContent && exe) {
        sourceContent = [
          '[Desktop Entry]',
          'Type=Application',
          'Name=Antigravity',
          `Exec="${exe}" %U`,
          'Terminal=false',
          'Categories=Development;',
          '',
        ].join('\n');
      }
      if (sourceContent) {
        const updated = sourceContent.split(/\r?\n/).map(injectFlagsIntoDesktopExec).join('\n');
        mkdirSync(appsDir, { recursive: true });
        writeFileSync(userDesktop, updated, 'utf8');
        launcherPath = userDesktop;
        if (backup.existed) patchedTargets.push(userDesktop);
        else createdTargets.push(userDesktop);
      }
      writeDebugState(statePath, {
        schema: 1,
        enabled: true,
        patchedShortcuts: patchedTargets,
        createdFiles: createdTargets,
        desktopBackup: backup,
      });
    } else {
      const backup = state.desktopBackup;
      if (backup && backup.path === userDesktop) {
        if (backup.existed && backup.content !== null) {
          writeFileSync(userDesktop, backup.content, 'utf8');
          patchedTargets.push(userDesktop);
        } else if (!backup.existed && existsSync(userDesktop)) {
          rmSync(userDesktop, { force: true });
          removedTargets.push(userDesktop);
        }
      } else if (existsSync(userDesktop)) {
        const stripped = readFileSync(userDesktop, 'utf8')
          .split(/\r?\n/)
          .map(stripFlagsFromDesktopExec)
          .join('\n');
        writeFileSync(userDesktop, stripped, 'utf8');
        patchedTargets.push(userDesktop);
      }
      writeDebugState(statePath, {
        schema: 1,
        enabled: false,
        patchedShortcuts: [],
        createdFiles: [],
        desktopBackup: null,
      });
    }
  } else if (platform === 'darwin') {
    const cmdPath = join(home, 'Desktop', MAC_DASHBOARD_LAUNCHER_NAME);
    if (enabled) {
      const appTarget = exe || '/Applications/Antigravity.app';
      mkdirSync(dirname(cmdPath), { recursive: true });
      const script = [
        '#!/bin/sh',
        `exec open -na ${JSON.stringify(appTarget)} --args ${DEBUG_PORT_FLAG} ${DEBUG_ADDR_FLAG} "$@"`,
        '',
      ].join('\n');
      writeFileSync(cmdPath, script, 'utf8');
      try {
        chmodSync(cmdPath, 0o755);
      } catch {
        // Best-effort chmod.
      }
      createdTargets.push(cmdPath);
      launcherPath = cmdPath;
      writeDebugState(statePath, {
        schema: 1,
        enabled: true,
        patchedShortcuts: [],
        createdFiles: [cmdPath],
        desktopBackup: null,
      });
    } else {
      for (const created of [...new Set([...state.createdFiles, cmdPath])]) {
        if (existsSync(created)) {
          rmSync(created, { force: true });
          removedTargets.push(created);
        }
      }
      writeDebugState(statePath, {
        schema: 1,
        enabled: false,
        patchedShortcuts: [],
        createdFiles: [],
        desktopBackup: null,
      });
    }
  }

  const configured = enabled && (patchedTargets.length > 0 || createdTargets.length > 0 || existsSync(launcherPath ?? ''));
  return {
    enabled,
    configured,
    platform,
    patchedTargets,
    createdTargets,
    removedTargets,
    launcherPath,
    exeFound: Boolean(exe),
    message: enabled
      ? configured
        ? 'Debug launch flags configured; fully quit and reopen Antigravity to take effect.'
        : 'Debug launch preference saved, but no Antigravity executable or shortcut was found.'
      : 'Debug launch flags removed from managed shortcuts.',
  };
}

/**
 * Launches the desktop Antigravity app with loopback CDP debugging switches enabled.
 */
export function launchDesktopWithDebug(options: DebugLaunchOptions = {}): ChildProcess {
  const platform = options.platform ?? process.platform;
  const exe = resolveDesktopExecutable(options);
  if (!exe) {
    throw new Error('Antigravity desktop application executable was not found.');
  }
  const env = { ...process.env, ...options.env };
  delete env.ELECTRON_RUN_AS_NODE;

  if (platform === 'darwin') {
    const child = spawn('open', ['-na', exe, '--args', ...DEBUG_LAUNCH_FLAGS], {
      env,
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    return child;
  }

  const child = spawn(exe, [...DEBUG_LAUNCH_FLAGS], {
    env,
    stdio: 'ignore',
    detached: platform !== 'win32',
    windowsHide: platform === 'win32',
  });
  child.unref();
  return child;
}
