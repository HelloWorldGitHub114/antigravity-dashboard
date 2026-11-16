import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface FileStatLike {
  size?: number | bigint;
  mtimeNs?: bigint;
  mtimeMs?: number;
  ctimeNs?: bigint;
  ctimeMs?: number;
  ino?: number | bigint;
}

export interface AtomicFileHandle {
  writeFile(
    data: string | Uint8Array,
    options?: { encoding?: BufferEncoding | null } | BufferEncoding,
  ): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicFsAdapter {
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  writeFile?: (
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: BufferEncoding | null; mode?: number; flag?: string },
  ) => Promise<void>;
  open?: (path: string, flags: string, mode?: number) => Promise<AtomicFileHandle>;
  mkdir?: (
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ) => Promise<string | undefined>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
  rm?: (
    path: string,
    options?: { force?: boolean; recursive?: boolean },
  ) => Promise<void>;
  stat?: (path: string, options?: { bigint?: boolean }) => Promise<FileStatLike>;
}

export interface AtomicFsSyncAdapter {
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
  writeFileSync?: (
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: BufferEncoding | null; mode?: number; flag?: string },
  ) => void;
  openSync?: (path: string, flags: string, mode?: number) => number;
  writeSync?: (
    fd: number,
    data: ArrayBufferView | string,
    position?: number | null,
    encoding?: BufferEncoding,
  ) => number;
  fsyncSync?: (fd: number) => void;
  closeSync?: (fd: number) => void;
  mkdirSync?: (
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ) => string | undefined;
  renameSync?: (oldPath: string, newPath: string) => void;
  unlinkSync?: (path: string) => void;
}

export interface ReadJsonOptions {
  maxBytes?: number;
  stripBom?: boolean;
  rethrowIo?: boolean;
  rethrowParse?: boolean;
  fs?: Pick<AtomicFsAdapter, 'readFile'>;
}

export interface ReadJsonSyncOptions {
  maxBytes?: number;
  stripBom?: boolean;
  rethrowIo?: boolean;
  rethrowParse?: boolean;
  fs?: Pick<AtomicFsSyncAdapter, 'readFileSync'>;
}

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
  fsync?: boolean;
  ensureDir?: boolean;
  createdDirs?: Set<string>;
  fs?: AtomicFsAdapter;
}

export interface AtomicWriteSyncOptions {
  encoding?: BufferEncoding;
  mode?: number;
  flag?: string;
  fsync?: boolean;
  ensureDir?: boolean;
  createdDirs?: Set<string>;
  fs?: AtomicFsSyncAdapter;
}

export interface AtomicWriteJsonOptions extends AtomicWriteOptions {
  space?: number | string;
  trailingNewline?: boolean;
}

export interface AtomicWriteJsonSyncOptions extends AtomicWriteSyncOptions {
  space?: number | string;
  trailingNewline?: boolean;
}

function isErrnoCode(error: unknown, ...codes: string[]): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' && codes.includes(code);
}

/**
 * Formats a file stat object into a compact change-detection stamp string.
 */
export function formatStatStamp(st: FileStatLike | null | undefined): string | null {
  if (!st) return null;
  return `${st.size ?? 0}:${st.mtimeNs ?? st.mtimeMs ?? 0}:${st.ctimeNs ?? st.ctimeMs ?? 0}:${st.ino ?? 0}`;
}

/**
 * Computes a change-detection stamp string for `file`, returning `null` if
 * missing (`ENOENT`/`ENOTDIR`) or `undefined` on unexpected stat errors.
 */
export async function statStamp(
  file: string,
  fsAdapter?: Pick<AtomicFsAdapter, 'stat'>,
): Promise<string | null | undefined> {
  const statFn = (fsAdapter?.stat ?? stat) as (
    path: string,
    options?: { bigint?: boolean },
  ) => Promise<FileStatLike>;
  try {
    const st = await statFn(file, { bigint: true });
    return formatStatStamp(st);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT', 'ENOTDIR')) return null;
    if (error instanceof TypeError) {
      try {
        const st = await statFn(file);
        return formatStatStamp(st);
      } catch (retryError) {
        if (isErrnoCode(retryError, 'ENOENT', 'ENOTDIR')) return null;
        return undefined;
      }
    }
    return undefined;
  }
}

function parseJsonText<T>(
  raw: string,
  maxBytes: number | undefined,
  stripBom: boolean,
  rethrowParse: boolean,
): T | null {
  if (maxBytes !== undefined && Buffer.byteLength(raw, 'utf8') > maxBytes) {
    return null;
  }
  const normalized = stripBom ? raw.replace(/^\uFEFF/, '') : raw;
  try {
    return JSON.parse(normalized) as T;
  } catch (error) {
    if (rethrowParse) throw error;
    return null;
  }
}

/**
 * Safely reads and parses a JSON file, returning `null` when missing,
 * oversized, or malformed (unless `rethrowIo`/`rethrowParse` is enabled).
 */
export async function readJsonSafe<T = unknown>(
  file: string,
  options: ReadJsonOptions = {},
): Promise<T | null> {
  const readFn = options.fs?.readFile ?? readFile;
  let text: string;
  try {
    text = await readFn(file, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT', 'ENOTDIR')) return null;
    if (options.rethrowIo) throw error;
    return null;
  }
  return parseJsonText<T>(
    text,
    options.maxBytes,
    options.stripBom !== false,
    options.rethrowParse === true,
  );
}

/**
 * Synchronous variant of {@link readJsonSafe}.
 */
export function readJsonSyncSafe<T = unknown>(
  file: string,
  options: ReadJsonSyncOptions = {},
): T | null {
  const readFn = options.fs?.readFileSync ?? readFileSync;
  let text: string;
  try {
    text = readFn(file, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT', 'ENOTDIR')) return null;
    if (options.rethrowIo) throw error;
    return null;
  }
  return parseJsonText<T>(
    text,
    options.maxBytes,
    options.stripBom !== false,
    options.rethrowParse === true,
  );
}

async function writeTempAndRename(
  temp: string,
  file: string,
  data: string | Uint8Array,
  encoding: BufferEncoding,
  mode: number,
  useFsync: boolean,
  fs: AtomicFsAdapter,
): Promise<void> {
  if (useFsync) {
    const openFn = fs.open ?? open;
    const handle = await openFn(temp, 'wx', mode);
    try {
      await handle.writeFile(data, encoding);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    const writeFn = fs.writeFile ?? writeFile;
    await writeFn(temp, data, { encoding, mode });
  }
  const renameFn = fs.rename ?? rename;
  await renameFn(temp, file);
}

async function cleanupTempFile(temp: string, fs: AtomicFsAdapter): Promise<void> {
  try {
    if (fs.rm) {
      await fs.rm(temp, { force: true });
    } else if (fs.unlink) {
      await fs.unlink(temp);
    } else {
      await unlink(temp);
    }
  } catch {
    // Best-effort cleanup of temp artifact.
  }
}

/**
 * Atomically writes `data` to `file` via a `0o600` temp file (`file.<pid>.<uuid>.tmp`),
 * optional `fsync`, `ENOENT` parent-dir retry, and guaranteed temp cleanup.
 */
export async function atomicWriteFile(
  file: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const fs = options.fs ?? {};
  const mkdirFn = fs.mkdir ?? mkdir;
  const encoding = options.encoding ?? 'utf8';
  const mode = options.mode ?? 0o600;
  const useFsync = options.fsync === true;
  const ensureDir = options.ensureDir !== false;
  const dir = dirname(file);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;

  if (ensureDir && !options.createdDirs?.has(dir)) {
    await mkdirFn(dir, { recursive: true });
    options.createdDirs?.add(dir);
  }

  try {
    try {
      await writeTempAndRename(temp, file, data, encoding, mode, useFsync, fs);
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        options.createdDirs?.delete(dir);
        await mkdirFn(dir, { recursive: true });
        options.createdDirs?.add(dir);
        await writeTempAndRename(temp, file, data, encoding, mode, useFsync, fs);
      } else {
        throw error;
      }
    }
  } finally {
    await cleanupTempFile(temp, fs);
  }
}

/**
 * Serializes `value` as JSON and writes it atomically via {@link atomicWriteFile}.
 */
export async function atomicWriteJson(
  file: string,
  value: unknown,
  options: AtomicWriteJsonOptions = {},
): Promise<void> {
  const payload =
    JSON.stringify(value, null, options.space) + (options.trailingNewline ? '\n' : '');
  await atomicWriteFile(file, payload, options);
}

function writeTempAndRenameSync(
  temp: string,
  file: string,
  data: string | Uint8Array,
  encoding: BufferEncoding,
  mode: number,
  flag: string,
  useFsync: boolean,
  fs: AtomicFsSyncAdapter,
): void {
  if (useFsync) {
    const openFn = fs.openSync ?? openSync;
    const writeFn = fs.writeSync ?? writeSync;
    const fsyncFn = fs.fsyncSync ?? fsyncSync;
    const closeFn = fs.closeSync ?? closeSync;
    const fd = openFn(temp, flag, mode);
    try {
      if (typeof data === 'string') {
        writeFn(fd, data, null, encoding);
      } else {
        writeFn(fd, data);
      }
      fsyncFn(fd);
    } finally {
      closeFn(fd);
    }
  } else {
    const writeFn = fs.writeFileSync ?? writeFileSync;
    writeFn(temp, data, { encoding, mode, flag });
  }
  const renameFn = fs.renameSync ?? renameSync;
  renameFn(temp, file);
}

/**
 * Synchronous variant of {@link atomicWriteFile}.
 */
export function atomicWriteFileSync(
  file: string,
  data: string | Uint8Array,
  options: AtomicWriteSyncOptions = {},
): void {
  const fs = options.fs ?? {};
  const mkdirFn = fs.mkdirSync ?? mkdirSync;
  const unlinkFn = fs.unlinkSync ?? unlinkSync;
  const encoding = options.encoding ?? 'utf8';
  const mode = options.mode ?? 0o600;
  const flag = options.flag ?? 'wx';
  const useFsync = options.fsync === true;
  const ensureDir = options.ensureDir !== false;
  const dir = dirname(file);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;

  if (ensureDir && !options.createdDirs?.has(dir)) {
    mkdirFn(dir, { recursive: true });
    options.createdDirs?.add(dir);
  }

  try {
    try {
      writeTempAndRenameSync(temp, file, data, encoding, mode, flag, useFsync, fs);
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        options.createdDirs?.delete(dir);
        mkdirFn(dir, { recursive: true });
        options.createdDirs?.add(dir);
        writeTempAndRenameSync(temp, file, data, encoding, mode, flag, useFsync, fs);
      } else {
        throw error;
      }
    }
  } finally {
    try {
      unlinkFn(temp);
    } catch (error) {
      if (!isErrnoCode(error, 'ENOENT')) {
        // Ignore cleanup errors after main operation.
      }
    }
  }
}

/**
 * Synchronous variant of {@link atomicWriteJson}.
 */
export function atomicWriteJsonSync(
  file: string,
  value: unknown,
  options: AtomicWriteJsonSyncOptions = {},
): void {
  const payload =
    JSON.stringify(value, null, options.space) + (options.trailingNewline ? '\n' : '');
  atomicWriteFileSync(file, payload, options);
}
