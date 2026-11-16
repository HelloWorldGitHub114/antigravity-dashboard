// A newer host sidecar supersedes old instances without killing arbitrary PIDs.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../shared/atomic-fs.ts';
import { isPidAlive, withFileLock } from '../shared/file-lock.ts';

export interface SidecarOwnerRecord {
  pid: number;
  startedAt: number;
  token: string;
}

export interface SidecarOwnerOptions {
  pid?: number;
  startedAt?: number;
  token?: string;
  interval?: number;
  isAlive?: (pid: number) => boolean;
}

interface UnrefableTimer {
  unref?: () => void;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null | undefined)?.code === code;
}

function isValidOwnerRecord(record: unknown): record is SidecarOwnerRecord {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const candidate = record as Partial<SidecarOwnerRecord>;
  return (
    typeof candidate.pid === 'number' &&
    Number.isSafeInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.startedAt === 'number' &&
    Number.isFinite(candidate.startedAt) &&
    typeof candidate.token === 'string'
  );
}

function isNewerOwner(a: SidecarOwnerRecord, b: SidecarOwnerRecord): boolean {
  return a.startedAt > b.startedAt || (a.startedAt === b.startedAt && a.token > b.token);
}

/**
 * Coordinates single-active-sidecar ownership across concurrent process startups.
 */
export class SidecarOwner {
  file: string;
  data: string;
  pid: number;
  startedAt: number;
  token: string;
  interval: number;
  running: boolean;
  isAlive: (pid: number) => boolean;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    data: string,
    {
      pid = process.pid,
      startedAt = Math.floor(Date.now() - process.uptime() * 1000),
      token = randomUUID(),
      interval = 2000,
      isAlive = isPidAlive,
    }: SidecarOwnerOptions = {},
  ) {
    this.file = join(data, 'active-sidecar.json');
    this.data = data;
    this.pid = pid;
    this.startedAt = startedAt;
    this.token = token;
    this.interval = interval;
    this.running = false;
    this.isAlive = isAlive;
    this.timer = undefined;
  }

  /**
   * Read the current active-sidecar ownership marker from disk.
   */
  async read(): Promise<SidecarOwnerRecord> {
    return JSON.parse(await readFile(this.file, 'utf8')) as SidecarOwnerRecord;
  }

  /**
   * Check whether this instance is currently running and still holds the ownership marker.
   */
  async isOwner(): Promise<boolean> {
    if (!this.running) return false;
    try {
      const owner = await this.read();
      return owner.pid === this.pid && owner.token === this.token;
    } catch {
      return false;
    }
  }

  /**
   * Attempt to claim sidecar ownership unless a live newer instance already owns it.
   */
  async claim(): Promise<boolean> {
    mkdirSync(this.data, { recursive: true });
    const claimed = await withFileLock<boolean>(
      `${this.file}.lock`,
      () => {
        const record: SidecarOwnerRecord = {
          pid: this.pid,
          startedAt: this.startedAt,
          token: this.token,
        };
        try {
          const prior = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
          // Serialize claims so concurrent SDK startups always select the newest.
          if (
            isValidOwnerRecord(prior) &&
            isNewerOwner(prior, record) &&
            this.isAlive(prior.pid)
          ) {
            return false;
          }
        } catch (error) {
          if (!isErrnoCode(error, 'ENOENT') && !(error instanceof SyntaxError)) {
            throw error;
          }
        }
        atomicWriteFileSync(this.file, `${JSON.stringify(record)}\n`, { ensureDir: false });
        return true;
      },
      {
        pid: process.pid,
        token: this.token,
        timeoutMessage: 'Sidecar ownership claim timed out',
        isAlive: isPidAlive,
        ensureDir: false,
      },
    );
    if (!claimed) return false;
    this.running = true;
    return this.isOwner();
  }

  /**
   * Poll ownership periodically and invoke `onLost` once when superseded.
   */
  watch(onLost: () => void | Promise<void>): void {
    let checking = false;
    this.timer = setInterval(() => {
      if (checking || !this.running) return;
      checking = true;
      void (async () => {
        try {
          if (!(await this.isOwner())) {
            this.stop();
            await onLost();
          }
        } finally {
          checking = false;
        }
      })();
    }, this.interval);
    (this.timer as UnrefableTimer | undefined)?.unref?.();
  }

  /**
   * Stop watching ownership without deleting the marker (a newer claim replaces it atomically).
   */
  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
