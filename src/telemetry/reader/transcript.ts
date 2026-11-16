// Optional local text estimates. Never substitute these for host context or
// request usage. The cache contains numeric summaries, not transcript bodies.
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import type { TranscriptReason, TranscriptStats } from '../../contracts/metrics.ts';
import { TrajectoryJson, type ProjectionNode } from '../projector/trajectory-json.ts';
import {
  aggregateTranscriptEntry,
  buildBoundary,
  emptyStats,
  isNonNegInt,
  safeTranscriptStats,
  summarizeTranscriptRecord,
  transcriptBrainRoot,
  type Anchor,
  type TranscriptEntry,
  type TranscriptFileState,
} from './transcript-stats.ts';

export { safeTranscriptStats, transcriptBrainRoot, type TranscriptEntry };

export interface TranscriptReaderOptions {
  root?: string;
  maxEntries?: number;
  maxRows?: number;
  bytesPerPass?: number;
  passMs?: number;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE = /^[0-9a-f]{64}$/;
const projection: ProjectionNode = { step_index: 'scalar', type: 'scalar', source: 'scalar', created_at: 'scalar', content: 'textEstimate', thinking: 'textEstimate' };
const contains = (root: string, file: string): boolean => {
  const r = relative(root, file);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const newState = (identity: string, info: Stats): TranscriptFileState => ({
  identity, size: info.size, mtime: info.mtimeMs, offset: 0, rows: new Map(), decoder: new StringDecoder('utf8'),
  parser: null, lineStarted: false, badLine: false, invalid: false, eof: false, limit: false, anchors: [],
});

/**
 * Bounded, continuous `setImmediate`-chunked reader for local `transcript*.jsonl` estimates.
 */
export class TranscriptReader {
  root: string;
  maxEntries: number;
  maxRows: number;
  bytesPerPass: number;
  passMs: number;
  entries = new Map<string, TranscriptEntry>();
  generation = 0;
  running: Promise<void> | null = null;
  nextImmediate: NodeJS.Immediate | null = null;
  #lastContinuedKey: string | null = null;
  #drainWaiters = new Set<() => void>();

  constructor({ root = transcriptBrainRoot(), maxEntries = 8, maxRows = 8192, bytesPerPass = 2 * 1024 * 1024, passMs = 100 }: TranscriptReaderOptions = {}) {
    this.root = root;
    this.maxEntries = isNonNegInt(maxEntries) && maxEntries > 0 ? Math.min(8, maxEntries) : 8;
    this.maxRows = isNonNegInt(maxRows) && maxRows > 0 ? Math.min(8192, maxRows) : 8192;
    this.bytesPerPass = isNonNegInt(bytesPerPass) ? Math.max(65536, Math.min(2 * 1024 * 1024, bytesPerPass)) : 2 * 1024 * 1024;
    this.passMs = isNonNegInt(passMs) ? Math.max(1, Math.min(100, passMs)) : 100;
  }

  #notifyDrain(): void { for (const resolve of this.#drainWaiters) resolve(); this.#drainWaiters.clear(); }

  #pickEntry(allowContinuing: boolean): { entry: TranscriptEntry; mode: 'requested' | 'continuing' } | null {
    const values = [...this.entries.values()];
    const requested = values.find((e) => e.requested);
    if (requested) return { entry: requested, mode: 'requested' };
    if (!allowContinuing) return null;
    const idx = this.#lastContinuedKey ? values.findIndex((e) => e.key === this.#lastContinuedKey) : -1;
    if (idx >= 0) {
      for (let i = 1; i <= values.length; i++) {
        const candidate = values[(idx + i) % values.length];
        if (candidate.continuing) return { entry: candidate, mode: 'continuing' };
      }
    }
    const first = values.find((e) => e.continuing);
    return first ? { entry: first, mode: 'continuing' } : null;
  }

  reset(): void {
    this.generation++;
    this.entries.clear();
    this.#lastContinuedKey = null;
    if (this.nextImmediate) { clearImmediate(this.nextImmediate); this.nextImmediate = null; }
    this.#notifyDrain();
  }

  request(scope: string | undefined, id: string | undefined, raw: unknown): TranscriptStats {
    if (!SCOPE.test(scope || '') || !GUID.test(id || '')) return emptyStats('unavailable', 'invalid-boundary');
    const key = `${scope}:${id!.toLowerCase()}`;
    const b = buildBoundary(raw, this.maxRows);
    if (!b) return emptyStats('unavailable', 'invalid-boundary');
    let entry = this.entries.get(key);
    if (!entry) entry = { key, id: id!.toLowerCase(), state: null, error: null, requested: false, continuing: false };
    entry.boundary = b; entry.requested = true; entry.continuing = false;
    this.entries.delete(key); this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.schedule();
    return aggregateTranscriptEntry(entry);
  }

  schedule(allowContinuing = false): void {
    if (this.nextImmediate) { clearImmediate(this.nextImmediate); this.nextImmediate = null; }
    if (this.running) return;
    if (!this.#pickEntry(allowContinuing)) { this.#notifyDrain(); return; }
    let continueUsed = false;
    this.running = Promise.resolve().then(async () => {
      for (;;) {
        const picked = this.#pickEntry(allowContinuing && !continueUsed);
        if (!picked) break;
        const { entry, mode } = picked;
        if (mode === 'continuing') { continueUsed = true; this.#lastContinuedKey = entry.key; }
        entry.requested = false; entry.continuing = false;
        const generation = this.generation;
        const current = (): boolean => generation === this.generation && this.entries.get(entry.key) === entry;
        try {
          await this.read(entry, current);
          if (current() && !entry.error && entry.state && !entry.state.eof && !entry.state.limit && !entry.requested) entry.continuing = true;
        } catch {
          if (current()) { entry.error = 'io-error'; entry.continuing = false; }
        }
      }
    }).finally(() => {
      this.running = null;
      if ([...this.entries.values()].some((e) => e.requested)) this.schedule(false);
      else if ([...this.entries.values()].some((e) => e.continuing)) {
        const generation = this.generation;
        this.nextImmediate = setImmediate(() => {
          this.nextImmediate = null;
          if (generation === this.generation) this.schedule(true);
          else this.#notifyDrain();
        });
      } else { this.#notifyDrain(); }
    });
  }

  async idle(): Promise<void> { while (this.running) await this.running; }

  async drain(): Promise<void> {
    for (;;) {
      while (this.running) await this.running;
      if (!this.nextImmediate && ![...this.entries.values()].some((e) => e.requested || e.continuing)) return;
      await new Promise<void>((resolve) => this.#drainWaiters.add(resolve));
    }
  }

  peek(scope: string, id: string): TranscriptStats {
    return aggregateTranscriptEntry(this.entries.get(`${scope}:${id.toLowerCase()}`) || {});
  }

  async locate(id: string): Promise<{ error: TranscriptReason } | { file: string; info: Stats }> {
    let root: string;
    try { root = await realpath(this.root); } catch (e) { if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { error: 'missing' }; throw e; }
    for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
      const candidate = join(this.root, id, '.system_generated', 'logs', name);
      try {
        const file = await realpath(candidate);
        const expected = join(root, id, '.system_generated', 'logs', name);
        const normalize = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
        if (!contains(root, file) || normalize(file) !== normalize(expected)) return { error: 'unsafe-path' };
        const info = await stat(file);
        if (!info.isFile()) return { error: 'unsafe-path' };
        return { file, info };
      } catch (e) { if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e; }
    }
    return { error: 'missing' };
  }

  async read(entry: TranscriptEntry, current: () => boolean): Promise<void> {
    const located = await this.locate(entry.id);
    if (!current()) return;
    if ('error' in located) { entry.error = located.error; entry.state = null; return; }
    const { file, info } = located;
    const identity = [file, info.dev, info.ino, info.birthtimeMs].join(':');
    let s = entry.state;
    const changed = Boolean(s && (s.size !== info.size || s.mtime !== info.mtimeMs));
    if (!s || s.identity !== identity || info.size < s.size || (info.size <= s.size && info.mtimeMs !== s.mtime)) {
      s = entry.state = newState(identity, info);
    }
    entry.error = null;
    const handle = await open(file, 'r');
    try {
      const opened = await handle.stat();
      if (!current()) return;
      if (opened.dev !== info.dev || opened.ino !== info.ino) { entry.error = 'io-error'; return; }
      if (changed) {
        for (const anchor of s.anchors) {
          const bytes = Buffer.alloc(anchor.length);
          const read = await handle.read(bytes, 0, bytes.length, anchor.offset);
          if (!current()) return;
          if (read.bytesRead !== bytes.length || digest(bytes) !== anchor.hash) { s = entry.state = newState(identity, info); break; }
        }
      }
      s.size = info.size; s.mtime = info.mtimeMs;
      if (s.limit) return;
      const buffer = Buffer.alloc(65536);
      const end = Math.min(info.size, s.offset + this.bytesPerPass);
      const deadline = performance.now() + this.passMs;
      while (s.offset < end && current()) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - s.offset), s.offset);
        if (!bytesRead) break;
        const anchor: Anchor = { offset: s.offset, length: bytesRead, hash: digest(buffer.subarray(0, bytesRead)) };
        s.anchors = s.anchors.length ? [s.anchors[0], anchor] : [anchor];
        s.offset += bytesRead;
        const text = s.decoder.write(buffer.subarray(0, bytesRead));
        let start = 0;
        for (let i = 0; i <= text.length; i++) {
          if (i !== text.length && text[i] !== '\n') continue;
          const part = text.slice(start, i); start = i + 1;
          if (part.trim().length || s.lineStarted) {
            s.lineStarted = true; s.parser ??= new TrajectoryJson({ projection, maxRetainedBytes: 32768 });
            if (!s.badLine) { try { s.parser.write(part); } catch { s.badLine = true; s.invalid = true; } }
          }
          if (i === text.length) break;
          if (s.lineStarted && !s.badLine) {
            try {
              const row = summarizeTranscriptRecord(s.parser!.end());
              if (!row) s.invalid = true;
              else if (!s.rows.has(row.index) && s.rows.size >= this.maxRows) { s.limit = true; break; }
              else s.rows.set(row.index, row);
            } catch { s.invalid = true; }
          }
          s.parser = null; s.lineStarted = false; s.badLine = false;
        }
        await yieldLoop();
        if (s.limit || performance.now() >= deadline) break;
      }
      if (!current()) return;
      s.eof = s.offset === info.size;
    } finally { await handle.close(); }
  }
}
