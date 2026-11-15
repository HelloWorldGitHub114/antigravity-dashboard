// Opt-in local persistence for bounded structural model timelines.
// Stores snapshots under <dataDir>/timeline-v1/<scope>/<cascadeId>.json.
import { readFile, mkdir, writeFile, rename, unlink, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { compactTimeline, safeTimeline, MAX_TIMELINE_BYTES, MAX_TIMELINE_NODES } from './timeline.mjs';

const GUID = /^(?:[a-zA-Z0-9_.-]+\/)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE = /^(?:[0-9a-f]{64}|[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63})$/;

function validScope(scope) {
  return typeof scope === 'string' && SCOPE.test(scope) && !scope.includes('..');
}

export class TimelineStore {
  pending = new Map();
  createdDirs = new Set();
  writeCache = new Map();

  constructor(
    directory = join(
      process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'antigravity-pulse', 'panel', 'data'),
      'timeline-v1',
    ),
    { maxNodes = MAX_TIMELINE_NODES, maxBytes = MAX_TIMELINE_BYTES } = {},
  ) {
    this.directory = directory;
    this.maxNodes = maxNodes;
    this.maxBytes = maxBytes;
  }

  file(scope, cascadeId) {
    if (!validScope(scope) || typeof cascadeId !== 'string' || !GUID.test(cascadeId)) {
      throw new Error('Invalid timeline scope or conversation ID');
    }
    const safeId = cascadeId.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    return join(this.directory, scope, `${safeId}.json`);
  }

  async stamp(file) {
    try {
      const s = await stat(file, { bigint: true });
      return `${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}`;
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      return undefined;
    }
  }

  rememberWrite(file, fileStamp, result, bodyKey) {
    this.writeCache.delete(file);
    if (this.writeCache.size >= 64) {
      this.writeCache.delete(this.writeCache.keys().next().value);
    }
    this.writeCache.set(file, { fileStamp, result, bodyKey });
  }

  async load(scope, cascadeId) {
    if (!scope) return null;
    try {
      const file = this.file(scope, cascadeId);
      const text = await readFile(file, 'utf8');
      if (Buffer.byteLength(text, 'utf8') > this.maxBytes) return null;
      const record = JSON.parse(text);
      if (record.schema !== 1 || record.account !== scope || record.cascadeId !== cascadeId.toLowerCase()) return null;
      if (!Number.isFinite(Date.parse(record.savedAt))) return null;
      const timeline = safeTimeline(record.timeline, { maxNodes: this.maxNodes, maxBytes: this.maxBytes });
      if (!timeline) return null;
      return { ...timeline, savedAt: record.savedAt };
    } catch {
      return null;
    }
  }

  async save(scope, cascadeId, timeline) {
    if (!scope || !timeline || timeline.enabled !== true) return null;
    const key = this.file(scope, cascadeId);
    const previous = this.pending.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.write(scope, cascadeId, timeline));
    this.pending.set(key, pending);
    try { return await pending; }
    finally { if (this.pending.get(key) === pending) this.pending.delete(key); }
  }

  async write(scope, cascadeId, rawTimeline) {
    const normalized = compactTimeline({ ...rawTimeline, cascadeId: rawTimeline.cascadeId || cascadeId, savedAt: null }, {
      maxNodes: this.maxNodes,
      maxBytes: Math.max(4096, this.maxBytes - 512),
    });
    if (!normalized) return null;
    const file = this.file(scope, cascadeId);
    const bodyKey = JSON.stringify(normalized);
    const fileStamp = await this.stamp(file);
    const cached = this.writeCache.get(file);
    if (fileStamp === null) {
      this.writeCache.delete(file);
    } else if (cached && fileStamp !== undefined && cached.fileStamp === fileStamp && cached.bodyKey === bodyKey) {
      return cached.result;
    }

    const savedAt = new Date().toISOString();
    const persisted = { ...normalized, savedAt };
    const payload = JSON.stringify({
      schema: 1,
      account: scope,
      cascadeId: cascadeId.toLowerCase(),
      savedAt,
      timeline: persisted,
    });
    if (Buffer.byteLength(payload, 'utf8') > this.maxBytes) return null;

    const dir = join(this.directory, scope);
    const temporary = `${file}.${randomUUID()}.tmp`;
    if (!this.createdDirs.has(dir)) {
      await mkdir(dir, { recursive: true });
      this.createdDirs.add(dir);
    }
    try {
      await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      this.writeCache.delete(file);
      if (error?.code === 'ENOENT') {
        this.createdDirs.delete(dir);
        await mkdir(dir, { recursive: true });
        this.createdDirs.add(dir);
        try {
          await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
          await rename(temporary, file);
        } catch (retryError) {
          await unlink(temporary).catch(() => {});
          throw retryError;
        }
      } else {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    }
    const nextStamp = await this.stamp(file);
    if (nextStamp) this.rememberWrite(file, nextStamp, persisted, bodyKey);
    return persisted;
  }

  async clear(scope, cascadeId) {
    const file = this.file(scope, cascadeId);
    const prev = this.pending.get(file) || Promise.resolve();
    const job = prev.catch(() => {}).then(async () => {
      this.writeCache.delete(file);
      await unlink(file).catch(err => {
        if (err?.code !== 'ENOENT') throw err;
      });
      return { cleared: true, scope, cascadeId: cascadeId.toLowerCase() };
    });
    this.pending.set(file, job);
    try { return await job; }
    finally { if (this.pending.get(file) === job) this.pending.delete(file); }
  }

  async clearAll(scope = null) {
    if (scope !== null && scope !== undefined) {
      if (!validScope(scope)) throw new Error('Invalid timeline scope');
      const dir = join(this.directory, scope);
      this.createdDirs.delete(dir);
      for (const key of [...this.writeCache.keys()]) {
        if (key.startsWith(dir)) this.writeCache.delete(key);
      }
      await rm(dir, { recursive: true, force: true });
      return { cleared: true, scope };
    }
    this.createdDirs.clear();
    this.writeCache.clear();
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(err => {
      if (err?.code === 'ENOENT') return [];
      throw err;
    });
    for (const entry of entries) {
      await rm(join(this.directory, entry.name), { recursive: true, force: true });
    }
    return { cleared: true, scope: 'all' };
  }
}
