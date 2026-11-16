import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { rotateLogTailNative } from '../platform/native-bridge.ts';

const CHUNK_SIZE = 64 * 1024;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_KEEP_LINES = 2000;
const SYNC_WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));

const writeQueues = new Map<string, Promise<void>>();
const ensuredDirs = new Set<string>();
let tempSeq = 0;

export interface RotateLogTailOptions {
  allowNative?: boolean;
}

export interface AppendBoundedLogLineOptions {
  maxBytes?: number;
  keepLines?: number;
  allowNative?: boolean;
  ensureDir?: boolean;
}

function isErrnoCode(error: unknown, ...codes: string[]): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' && codes.includes(code);
}

function safeUnlinkSync(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Best-effort cleanup of temp artifacts.
  }
}

function createUniqueTempPath(logPath: string): string {
  tempSeq += 1;
  return `${logPath}.${process.pid}.${tempSeq}.${randomUUID()}.tmp`;
}

function renameAtomicSync(tmpPath: string, logPath: string): void {
  if (process.platform !== 'win32') {
    renameSync(tmpPath, logPath);
    return;
  }
  const maxAttempts = 5;
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmpPath, logPath);
      return;
    } catch (error) {
      if (attempt + 1 < maxAttempts && isErrnoCode(error, 'EPERM', 'EACCES', 'EBUSY')) {
        Atomics.wait(SYNC_WAIT_CELL, 0, 0, 2 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
}

function rotateLogTailFallback(
  logPath: string,
  maxBytes: number,
  keepLines: number,
): boolean {
  let fileLen: number;
  try {
    fileLen = statSync(logPath).size;
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT', 'ENOTDIR')) return false;
    throw error;
  }
  if (fileLen <= maxBytes) return false;

  if (keepLines === 0) {
    const tmpPath = createUniqueTempPath(logPath);
    let outFd: number | null = null;
    try {
      outFd = openSync(tmpPath, 'wx');
      fsyncSync(outFd);
      closeSync(outFd);
      outFd = null;
      renameAtomicSync(tmpPath, logPath);
      return true;
    } finally {
      if (outFd !== null) {
        try {
          closeSync(outFd);
        } catch {
          // Ignore close error during cleanup.
        }
      }
      safeUnlinkSync(tmpPath);
    }
  }

  let readFd: number | null = null;
  let outFd: number | null = null;
  let tmpPath: string | null = null;

  try {
    readFd = openSync(logPath, 'r');
    fileLen = statSync(logPath).size;
    if (fileLen <= maxBytes) return false;

    const buf = Buffer.allocUnsafe(CHUNK_SIZE);
    let pos = fileLen;
    let newlinesFound = 0;
    let cutOffset = 0;

    while (pos > 0) {
      const readLen = Math.min(pos, CHUNK_SIZE);
      pos -= readLen;
      let totalRead = 0;
      while (totalRead < readLen) {
        const bytesRead = readSync(
          readFd,
          buf,
          totalRead,
          readLen - totalRead,
          pos + totalRead,
        );
        if (bytesRead <= 0) break;
        totalRead += bytesRead;
      }
      for (let i = totalRead - 1; i >= 0; i--) {
        if (buf[i] === 0x0a) {
          if (pos + i + 1 === fileLen) {
            continue;
          }
          newlinesFound += 1;
          if (newlinesFound === keepLines) {
            cutOffset = pos + i + 1;
            break;
          }
        }
      }
      if (newlinesFound >= keepLines || totalRead < readLen) {
        break;
      }
    }

    if (cutOffset === 0) return false;

    tmpPath = createUniqueTempPath(logPath);
    outFd = openSync(tmpPath, 'wx');
    let readPos = cutOffset;
    while (readPos < fileLen) {
      const toRead = Math.min(CHUNK_SIZE, fileLen - readPos);
      const bytesRead = readSync(readFd, buf, 0, toRead, readPos);
      if (bytesRead <= 0) break;
      let written = 0;
      while (written < bytesRead) {
        written += writeSync(outFd, buf.subarray(written, bytesRead));
      }
      readPos += bytesRead;
    }
    fsyncSync(outFd);
    closeSync(outFd);
    outFd = null;
    closeSync(readFd);
    readFd = null;
    renameAtomicSync(tmpPath, logPath);
    return true;
  } finally {
    if (outFd !== null) {
      try {
        closeSync(outFd);
      } catch {
        // Ignore close error during cleanup.
      }
    }
    if (readFd !== null) {
      try {
        closeSync(readFd);
      } catch {
        // Ignore close error during cleanup.
      }
    }
    if (tmpPath) {
      safeUnlinkSync(tmpPath);
    }
  }
}

/**
 * Truncates `logPath` to at most the last `keepLines` lines whenever its byte
 * size exceeds `maxBytes`. Uses `O(1)` reverse chunk scanning via the native
 * accelerator (when enabled) or an identical pure-TS `64 KiB` fallback.
 */
export function rotateLogTail(
  logPath: string,
  maxBytes: number,
  keepLines: number,
  options?: RotateLogTailOptions,
): boolean {
  if (!logPath) return false;
  const safeMaxBytes =
    Number.isFinite(maxBytes) && maxBytes >= 0 ? Math.floor(maxBytes) : 0;
  const safeKeepLines =
    Number.isFinite(keepLines) && keepLines >= 0 ? Math.floor(keepLines) : 0;

  if (options?.allowNative !== false) {
    const nativeResult = rotateLogTailNative(logPath, safeMaxBytes, safeKeepLines);
    if (nativeResult !== null) {
      return nativeResult;
    }
  }
  return rotateLogTailFallback(logPath, safeMaxBytes, safeKeepLines);
}

/**
 * Serializes log appends per file path and rotates the log tail via
 * {@link rotateLogTail} whenever the file size exceeds `maxBytes`.
 */
export async function appendBoundedLogLine(
  logPath: string,
  line: string,
  options?: AppendBoundedLogLineOptions,
): Promise<void> {
  if (!logPath) return;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const keepLines = options?.keepLines ?? DEFAULT_KEEP_LINES;
  const allowNative = options?.allowNative !== false;
  const ensureDir = options?.ensureDir !== false;
  const dir = dirname(logPath);
  const queueKey = resolve(logPath);

  const prev = writeQueues.get(queueKey) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      if (ensureDir && !ensuredDirs.has(dir)) {
        await mkdir(dir, { recursive: true });
        ensuredDirs.add(dir);
      }
      try {
        await appendFile(logPath, line, 'utf8');
      } catch (error) {
        if (ensureDir && isErrnoCode(error, 'ENOENT')) {
          ensuredDirs.delete(dir);
          await mkdir(dir, { recursive: true });
          ensuredDirs.add(dir);
          await appendFile(logPath, line, 'utf8');
        } else {
          throw error;
        }
      }
      const st = await stat(logPath);
      if (st.size > maxBytes) {
        rotateLogTail(logPath, maxBytes, keepLines, { allowNative });
      }
    });

  writeQueues.set(queueKey, next);
  try {
    await next;
  } finally {
    if (writeQueues.get(queueKey) === next) {
      writeQueues.delete(queueKey);
    }
  }
}
