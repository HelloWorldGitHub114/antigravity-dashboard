import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  extractSqliteUsageRecords,
  isNativeAccelAvailable,
} from '../../../src/platform/native-bridge.ts';

const CID = '11111111-2222-3333-4444-555555555555';

const varint = (n) => {
  let v = BigInt(n);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return Buffer.from(out);
};
const tag = (f, wt) => varint((BigInt(f) << 3n) | BigInt(wt));
const fU64 = (f, v) => Buffer.concat([tag(f, 0), varint(v)]);
const fBytes = (f, b) => Buffer.concat([tag(f, 2), varint(b.length), b]);
const fStr = (f, s) => fBytes(f, Buffer.from(s, 'utf8'));
const msg = (...parts) => Buffer.concat(parts);
const ts = (sec) => msg(fU64(1, sec));

function buildGenMetadataBlob({ responseId, input = 1200, output = 350, write = 100, read = 800 }) {
  const usage = msg(
    fU64(1, 1668),
    fU64(2, input),
    fU64(3, output),
    fU64(4, write),
    fU64(5, read),
    fU64(6, 24),
    fStr(11, responseId),
  );
  const csm = msg(fBytes(4, ts(1776429002)));
  const chatModel = msg(fU64(3, 1668), fBytes(4, usage), fBytes(9, csm));
  return msg(fBytes(1, chatModel), fU64(2, 0));
}

function createFixtureDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      `CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
       CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
       CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);`,
    );
    db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(
      msg(fBytes(2, ts(1776429000))),
    );
    db.prepare(
      'INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)',
    ).run(
      0,
      15,
      3,
      msg(fBytes(1, ts(1776429005)), fU64(11, 1668)),
      fBytes(20, fStr(1, 'ok')),
    );
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      0,
      buildGenMetadataBlob({ responseId: 'resp-cache-001' }),
    );
  } finally {
    db.close();
  }
}

async function withSharedCacheEnv(overrides, fn) {
  const keys = ['PULSE_SHARED_CACHE_PATH', 'PULSE_DISABLE_SHARED_CACHE'];
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    const next = overrides[k];
    if (next === undefined || next === null) delete process.env[k];
    else process.env[k] = next;
  }
  try {
    return await fn();
  } finally {
    for (const [k, prev] of saved.entries()) {
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

function requireNative(t) {
  if (process.env.PULSE_DISABLE_NATIVE_ACCEL === '1' || !isNativeAccelAvailable()) {
    t.skip('native pulse-accel addon is disabled or unavailable');
    return false;
  }
  return true;
}

test('Stage 8C-2: first call populates shared-usage-cache-v1.db and second call hits cache', async (t) => {
  if (!requireNative(t)) return;

  const dir = await mkdtemp(join(tmpdir(), 'ag-stage8c-cache-hit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const dbPath = join(dir, `${CID}.db`);
  const cachePath = join(dir, 'shared-usage-cache-v1.db');
  createFixtureDb(dbPath);

  await withSharedCacheEnv(
    { PULSE_SHARED_CACHE_PATH: cachePath, PULSE_DISABLE_SHARED_CACHE: undefined },
    async () => {
      assert.equal(existsSync(cachePath), false);

      const first = extractSqliteUsageRecords(dbPath, CID);
      assert.ok(Array.isArray(first) && first.length === 1);
      assert.equal(first[0].uncached, 1200);
      assert.equal(first[0].output, 350);
      assert.equal(existsSync(cachePath), true);

      const cacheDb = new DatabaseSync(cachePath);
      try {
        const row = cacheDb
          .prepare(
            'SELECT db_path, db_mtime_ms, db_size_bytes, wal_mtime_ms, wal_size_bytes, payload_json, updated_at_ms FROM usage_cache WHERE db_path = ?',
          )
          .get(dbPath);
        assert.ok(row, 'expected cache row for fixture dbPath');
        assert.ok(row.db_mtime_ms > 0);
        assert.equal(row.db_size_bytes, statSync(dbPath).size);
        assert.equal(row.wal_mtime_ms, 0);
        assert.equal(row.wal_size_bytes, 0);
        assert.ok(row.updated_at_ms > 0);
        assert.deepEqual(JSON.parse(row.payload_json), first);

        // Second call hits cache identically.
        const second = extractSqliteUsageRecords(dbPath, CID);
        assert.deepEqual(second, first);

        // Mutate payload_json in cache without altering the 4 file stat columns to prove cache hit.
        const sentinel = [{ ...first[0], model: 'CACHED_SENTINEL_MODEL' }];
        cacheDb
          .prepare('UPDATE usage_cache SET payload_json = ? WHERE db_path = ?')
          .run(JSON.stringify(sentinel), dbPath);
      } finally {
        cacheDb.close();
      }

      const hit = extractSqliteUsageRecords(dbPath, CID);
      assert.equal(hit?.length, 1);
      assert.equal(hit?.[0]?.model, 'CACHED_SENTINEL_MODEL');
    },
  );
});

test('Stage 8C-2: companion -wal append invalidates shared cache and refreshes payload', async (t) => {
  if (!requireNative(t)) return;

  const dir = await mkdtemp(join(tmpdir(), 'ag-stage8c-cache-wal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const dbPath = join(dir, `${CID}.db`);
  const walPath = `${dbPath}-wal`;
  const cachePath = join(dir, 'shared-usage-cache-v1.db');
  createFixtureDb(dbPath);

  const dbWalInit = new DatabaseSync(dbPath);
  try {
    dbWalInit.exec('PRAGMA journal_mode = WAL; PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    dbWalInit.close();
  }

  await withSharedCacheEnv(
    { PULSE_SHARED_CACHE_PATH: cachePath, PULSE_DISABLE_SHARED_CACHE: undefined },
    async () => {
      const initial = extractSqliteUsageRecords(dbPath, CID);
      assert.equal(initial?.length, 1);

      // Append a new record into -wal without checkpointing the main .db file.
      const dbAppend = new DatabaseSync(dbPath);
      try {
        dbAppend.exec('PRAGMA wal_autocheckpoint = 0;');
        dbAppend.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
          1,
          buildGenMetadataBlob({ responseId: 'resp-cache-002', input: 500, output: 90, write: 0, read: 0 }),
        );
        assert.equal(existsSync(walPath), true);
        assert.ok(statSync(walPath).size > 0);

        const refreshed = extractSqliteUsageRecords(dbPath, CID);
        assert.equal(refreshed?.length, 2);
        assert.equal(refreshed?.[1]?.uncached, 500);
        assert.equal(refreshed?.[1]?.output, 90);
      } finally {
        dbAppend.close();
      }

      const cacheDb = new DatabaseSync(cachePath, { readOnly: true });
      try {
        const row = cacheDb
          .prepare('SELECT wal_mtime_ms, wal_size_bytes, payload_json FROM usage_cache WHERE db_path = ?')
          .get(dbPath);
        assert.ok(row);
        assert.ok(row.wal_mtime_ms > 0);
        assert.ok(row.wal_size_bytes > 0);
        assert.equal(JSON.parse(row.payload_json).length, 2);
      } finally {
        cacheDb.close();
      }
    },
  );
});

test('Stage 8C-2: PULSE_DISABLE_SHARED_CACHE=1 bypasses cache read and write', async (t) => {
  if (!requireNative(t)) return;

  const dir = await mkdtemp(join(tmpdir(), 'ag-stage8c-cache-disable-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const dbPath = join(dir, `${CID}.db`);
  const cachePath = join(dir, 'disabled-cache.db');
  createFixtureDb(dbPath);

  await withSharedCacheEnv(
    { PULSE_SHARED_CACHE_PATH: cachePath, PULSE_DISABLE_SHARED_CACHE: '1' },
    async () => {
      const records = extractSqliteUsageRecords(dbPath, CID);
      assert.equal(records?.length, 1);
      assert.equal(existsSync(cachePath), false);
    },
  );

  // Populate cache, tamper payload_json, then verify PULSE_DISABLE_SHARED_CACHE=1 ignores it.
  await withSharedCacheEnv(
    { PULSE_SHARED_CACHE_PATH: cachePath, PULSE_DISABLE_SHARED_CACHE: undefined },
    async () => {
      const populated = extractSqliteUsageRecords(dbPath, CID);
      assert.equal(populated?.length, 1);
      const cacheDb = new DatabaseSync(cachePath);
      try {
        cacheDb
          .prepare('UPDATE usage_cache SET payload_json = ? WHERE db_path = ?')
          .run(JSON.stringify([{ ...populated[0], model: 'TAMPERED_CACHE_ROW' }]), dbPath);
      } finally {
        cacheDb.close();
      }
    },
  );

  await withSharedCacheEnv(
    { PULSE_SHARED_CACHE_PATH: cachePath, PULSE_DISABLE_SHARED_CACHE: '1' },
    async () => {
      const bypassed = extractSqliteUsageRecords(dbPath, CID);
      assert.equal(bypassed?.length, 1);
      assert.notEqual(bypassed?.[0]?.model, 'TAMPERED_CACHE_ROW');
    },
  );
});
