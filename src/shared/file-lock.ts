import {
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface FileLockRecord {
  pid: number;
  token: string;
}

export interface FileLockHandle {
  lockPath: string;
  pid: number;
  token: string;
}

export interface FileLockOptions {
  pid?: number;
  token?: string;
  timeoutMs?: number;
  deadline?: number;
  pollIntervalMs?: number;
  staleMs?: number;
  timeoutMessage?: string;
  isAlive?: (pid: number) => boolean;
  ensureDir?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 20;
const DEFAULT_STALE_MS = 10000;
const SYNC_WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));

function isErrnoCode(error: unknown, ...codes: string[]): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' && codes.includes(code);
}

/**
 * Checks whether a process with `pid` is currently alive using `process.kill(pid, 0)`.
 * Treats `EPERM` as alive and non-positive / non-safe-integer PIDs as dead.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoCode(error, 'EPERM');
  }
}

function tryAcquireOnce(
  lockPath: string,
  pid: number,
  token: string,
  staleMs: number,
  isAlive: (pid: number) => boolean,
): FileLockHandle | 'retry' | 'wait' {
  try {
    writeFileSync(lockPath, JSON.stringify({ pid, token }), { flag: 'wx', mode: 0o600 });
    return { lockPath, pid, token };
  } catch (error) {
    if (!isErrnoCode(error, 'EEXIST')) throw error;
    try {
      let record: Partial<FileLockRecord> | undefined;
      try {
        record = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<FileLockRecord>;
      } catch {
        // Partial or corrupt lock file; fall back to mtime age check.
      }
      const evict =
        typeof record?.pid === 'number' && record.pid !== 0
          ? !isAlive(record.pid)
          : Date.now() - statSync(lockPath).mtimeMs > staleMs;
      if (evict) {
        unlinkSync(lockPath);
        return 'retry';
      }
    } catch (evictError) {
      if (isErrnoCode(evictError, 'ENOENT')) return 'retry';
      throw evictError;
    }
    return 'wait';
  }
}

function resolveLockConfig(options: FileLockOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    pid: options.pid ?? process.pid,
    token: options.token ?? randomUUID(),
    deadline: options.deadline ?? Date.now() + timeoutMs,
    pollIntervalMs: Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
    timeoutMessage: options.timeoutMessage ?? 'File lock acquisition timed out',
    isAlive: options.isAlive ?? isPidAlive,
    ensureDir: options.ensureDir !== false,
  };
}

/**
 * Acquires an exclusive advisory lock file (`{ pid, token }`, `wx`, `0o600`),
 * evicting dead-PID locks and corrupt locks older than `staleMs` (default 10s).
 */
export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions = {},
): Promise<FileLockHandle> {
  const cfg = resolveLockConfig(options);
  if (cfg.ensureDir) {
    mkdirSync(dirname(lockPath), { recursive: true });
  }
  for (;;) {
    const attempt = tryAcquireOnce(lockPath, cfg.pid, cfg.token, cfg.staleMs, cfg.isAlive);
    if (attempt === 'retry') continue;
    if (attempt !== 'wait') return attempt;
    if (Date.now() > cfg.deadline) {
      throw new Error(cfg.timeoutMessage);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, cfg.pollIntervalMs);
    });
  }
}

/**
 * Releases a previously acquired file lock only if its stored token still matches.
 */
export function releaseFileLockSync(handle: FileLockHandle): void {
  try {
    const record = JSON.parse(readFileSync(handle.lockPath, 'utf8')) as Partial<FileLockRecord>;
    if (record?.token === handle.token) {
      unlinkSync(handle.lockPath);
    }
  } catch (error) {
    if (!isErrnoCode(error, 'ENOENT') && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
}

/**
 * Async wrapper around {@link releaseFileLockSync}.
 */
export async function releaseFileLock(handle: FileLockHandle): Promise<void> {
  releaseFileLockSync(handle);
}

/**
 * Runs `fn` while holding the exclusive advisory file lock at `lockPath`,
 * releasing the lock in `finally`.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: (handle: FileLockHandle) => Promise<T> | T,
  options: FileLockOptions = {},
): Promise<T> {
  const handle = await acquireFileLock(lockPath, options);
  try {
    return await fn(handle);
  } finally {
    await releaseFileLock(handle);
  }
}

/**
 * Synchronous variant of {@link acquireFileLock}.
 */
export function acquireFileLockSync(
  lockPath: string,
  options: FileLockOptions = {},
): FileLockHandle {
  const cfg = resolveLockConfig(options);
  if (cfg.ensureDir) {
    mkdirSync(dirname(lockPath), { recursive: true });
  }
  for (;;) {
    const attempt = tryAcquireOnce(lockPath, cfg.pid, cfg.token, cfg.staleMs, cfg.isAlive);
    if (attempt === 'retry') continue;
    if (attempt !== 'wait') return attempt;
    if (Date.now() > cfg.deadline) {
      throw new Error(cfg.timeoutMessage);
    }
    Atomics.wait(SYNC_WAIT_CELL, 0, 0, cfg.pollIntervalMs);
  }
}

/**
 * Synchronous variant of {@link withFileLock}.
 */
export function withFileLockSync<T>(
  lockPath: string,
  fn: (handle: FileLockHandle) => T,
  options: FileLockOptions = {},
): T {
  const handle = acquireFileLockSync(lockPath, options);
  try {
    return fn(handle);
  } finally {
    releaseFileLockSync(handle);
  }
}
