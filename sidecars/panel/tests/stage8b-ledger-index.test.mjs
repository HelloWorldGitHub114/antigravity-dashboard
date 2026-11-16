import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNativeAccelAvailable } from '../../../src/platform/native-bridge.ts';
import { UsageLedger } from '../usage.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');

const rawDoc = ({
  time = '2026-10-11T02:00:00Z',
  start = null,
  model = 'Gemini 3.8',
  responseId = 'resp-1',
  inputTokens = 100,
  cacheReadTokens = 900,
  cacheWriteTokens = 20,
  outputTokens = 80,
} = {}) => ({
  trajectory: {
    steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: time ? { createdAt: time } : {} }],
    generatorMetadata: [
      {
        stepIndices: [0],
        chatModel: {
          modelDisplayName: model,
          ...(start ? { chatStartMetadata: { createdAt: start } } : {}),
          usage: {
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            responseId,
            inputTokens: String(inputTokens),
            cacheReadTokens: String(cacheReadTokens),
            cacheWriteTokens: String(cacheWriteTokens),
            outputTokens: String(outputTokens),
          },
        },
      },
    ],
  },
});

async function withNativeDisabled(fn) {
  const prev = process.env.PULSE_DISABLE_NATIVE_ACCEL;
  process.env.PULSE_DISABLE_NATIVE_ACCEL = '1';
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PULSE_DISABLE_NATIVE_ACCEL;
    else process.env.PULSE_DISABLE_NATIVE_ACCEL = prev;
  }
}

async function assertNativeMatchesTs(dir, scope, nowMs, options = {}) {
  const tsSnap = await withNativeDisabled(async () => {
    const tsLedger = new UsageLedger(dir, options);
    return await tsLedger.summary(scope, nowMs);
  });
  if (process.env.PULSE_DISABLE_NATIVE_ACCEL === '1' || !isNativeAccelAvailable()) {
    return tsSnap;
  }
  const nativeLedger = new UsageLedger(dir, options);
  const nativeSnap = await nativeLedger.summary(scope, nowMs);
  assert.deepEqual(nativeSnap, tsSnap);
  return nativeSnap;
}

test('Stage 8B-2: cold build creates ledger-compact-v1.bin, warm hit skips JSON reads, and matches TS 100%', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-stage8b-ledger-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const alpha = sha('alpha@example.test');
  const beta = sha('beta@example.test');
  const knownAccounts = {
    [alpha]: { email: 'alpha@example.test', name: 'Alpha', primary: true },
    [beta]: { email: 'beta@example.test', name: 'Beta', primary: false },
  };
  const opts = { knownAccounts, timeZone: 'Asia/Shanghai', source: 'desktop-local' };
  const ledger = new UsageLedger(dir, opts);

  const convOwned = '11111111-1111-4111-8111-111111111111';
  const convDup = '22222222-2222-4222-8222-222222222222';
  const convUnknown = '33333333-3333-4333-8333-333333333333';
  const convPartial = '44444444-4444-4444-8444-444444444444';

  await ledger.registerAccount(alpha, { email: 'alpha@example.test', primary: true, addedAt: 1000 });
  await ledger.registerAccount(beta, { email: 'beta@example.test', primary: false, addedAt: 2000 });

  await ledger.ingest(alpha, convOwned, rawDoc({ responseId: 'r-owned', inputTokens: 300, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  await ledger.ingest(beta, convOwned, rawDoc({ responseId: 'r-owned', inputTokens: 300, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  await ledger.registerOwnership(convOwned, beta, { overwrite: true });

  await ledger.ingest(alpha, convDup, rawDoc({ responseId: 'r-dup', inputTokens: 200, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  await ledger.ingest(beta, convDup, rawDoc({ responseId: 'r-dup', inputTokens: 200, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }));

  await ledger.ingest(alpha, convUnknown, rawDoc({ time: null, responseId: 'r-unk', inputTokens: 70, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  await ledger.ingest(beta, convPartial, {
    trajectory: {
      steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: { createdAt: '2026-10-11T04:00:00Z' } }],
      generatorMetadata: [{
        stepIndices: [0],
        chatModel: {
          modelDisplayName: 'Gemini 2.5 Pro',
          usage: { responseId: 'r-part', inputTokens: '40', outputTokens: 'bad' },
        },
      }],
    },
  });

  await ledger.addManualUsage(alpha, {
    id: 'manual-1',
    timestamp: Date.parse('2026-10-11T05:00:00Z'),
    model: 'manual-pro',
    tokens: { prompt: 120, candidates: 30, total: 150 },
    projectName: 'RemoteX',
    note: 'Manual note',
  });

  // Add one corrupt JSON file and one wrong-schema JSON file in alpha
  await writeFile(join(dir, alpha, `${'e'.repeat(64)}.json`), '{broken-json');
  await writeFile(
    join(dir, alpha, `${'f'.repeat(64)}.json`),
    JSON.stringify({ schema: 2, account: alpha, records: [] }),
  );

  const nowMs = Date.parse('2026-10-11T10:00:00Z');
  const allSnap = await assertNativeMatchesTs(dir, 'all', nowMs, opts);
  assert.equal(allSnap.unreadableFiles, 2);
  assert.equal(allSnap.unknownTokens, 100);
  assert.equal(allSnap.unknownRequests, 1);
  assert.equal(allSnap.partialRequests, 1);
  assert.equal(allSnap.legacyTokens, 250);
  assert.equal(allSnap.manualEntries.length, 1);
  assert.equal(allSnap.manualEntries[0].projectName, 'RemoteX');

  await assertNativeMatchesTs(dir, alpha, nowMs, opts);
  await assertNativeMatchesTs(dir, beta, nowMs, opts);

  if (process.env.PULSE_DISABLE_NATIVE_ACCEL !== '1' && isNativeAccelAvailable()) {
    const cacheBin = await readFile(join(dir, 'ledger-compact-v1.bin'));
    assert.equal(cacheBin.subarray(0, 8).toString('ascii'), 'AGPLDG01');
    assert.equal(cacheBin.readUInt32LE(8), 1);

    // Warm hit from new UsageLedger instance does not rewrite cache file if nothing changed
    const stBefore = await stat(join(dir, 'ledger-compact-v1.bin'));
    const warmLedger = new UsageLedger(dir, opts);
    const warmSnap = await warmLedger.summary('all', nowMs);
    assert.deepEqual(warmSnap, allSnap);
    const stAfter = await stat(join(dir, 'ledger-compact-v1.bin'));
    assert.equal(stAfter.mtimeNs, stBefore.mtimeNs);
  }
});

test('Stage 8B-2: corrupt sidecar rebuilds, dirtyRelPaths catches same-size writes, and deletions/manual deletes sync', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-stage8b-dirty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const account = sha('dirty-test@example.test');
  const convId = '55555555-5555-4555-8555-555555555555';
  const ledger = new UsageLedger(dir, { knownAccounts: {}, timeZone: 'UTC' });
  const nowMs = Date.parse('2026-10-11T12:00:00Z');

  await ledger.ingest(
    account,
    convId,
    rawDoc({ time: '2026-10-11T10:00:00Z', responseId: 'r-d1', inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 }),
  );
  let snap = await ledger.summary(account, nowMs);
  assert.equal(snap.totalTokens, 150);

  // Corrupt sidecar -> graceful rebuild
  await writeFile(join(dir, 'ledger-compact-v1.bin'), Buffer.from('CORRUPT_HEADER'));
  snap = await assertNativeMatchesTs(dir, account, nowMs, { knownAccounts: {}, timeZone: 'UTC' });
  assert.equal(snap.totalTokens, 150);

  // Same-size sub-millisecond rewrite via ingest -> dirtyRelPaths must force re-parse
  await ledger.ingest(
    account,
    convId,
    rawDoc({ time: '2026-10-11T10:00:00Z', responseId: 'r-d1', inputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 }),
  );
  assert.ok(ledger.dirtyRelPaths.size > 0);
  snap = await ledger.summary(account, nowMs);
  if (process.env.PULSE_DISABLE_NATIVE_ACCEL !== '1' && isNativeAccelAvailable()) {
    assert.equal(ledger.dirtyRelPaths.size, 0);
  }
  assert.equal(snap.totalTokens, 300);

  const manual = await ledger.addManualUsage(account, {
    id: 'man-del-1',
    timestamp: nowMs,
    tokens: { prompt: 80, candidates: 20, total: 100 },
  });
  snap = await ledger.summary(account, nowMs);
  assert.equal(snap.totalTokens, 400);
  assert.equal(snap.manualEntries.length, 1);

  assert.equal(await ledger.deleteManualUsage(account, manual.id), true);
  snap = await ledger.summary(account, nowMs);
  assert.equal(snap.totalTokens, 300);
  assert.equal(snap.manualEntries.length, 0);

  // External file delete
  await unlink(ledger.file(account, convId));
  snap = await assertNativeMatchesTs(dir, account, nowMs, { knownAccounts: {}, timeZone: 'UTC' });
  assert.equal(snap.totalTokens, 0);
  assert.equal(snap.requests, 0);
});

test('Stage 8B-2: parallel dirty parsing (>8 files) and DST/fixed timezone parity (UTC, Asia/Shanghai, America/New_York)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-stage8b-tz-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const account = sha('tz-parallel@example.test');
  const ledger = new UsageLedger(dir, { knownAccounts: {} });

  // 20 conversations across winter (EST -5) and summer (EDT -4) + DST transition boundaries
  const times = [
    '2026-01-15T04:30:00Z', // NY 2026-01-14 23:30
    '2026-03-08T06:30:00Z', // NY right before spring-forward (01:30 EST)
    '2026-03-08T07:30:00Z', // NY right after spring-forward (03:30 EDT)
    '2026-06-15T03:30:00Z', // NY 2026-06-14 23:30 EDT
    '2026-11-01T05:30:00Z', // NY fall-back first 01:30 (EDT -4)
    '2026-11-01T06:30:00Z', // NY fall-back second 01:30 (EST -5)
  ];
  for (let i = 0; i < 20; i++) {
    const convId = `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`;
    const time = times[i % times.length];
    await ledger.ingest(
      account,
      convId,
      rawDoc({
        time,
        responseId: `tz-req-${i}`,
        inputTokens: 100 + i,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 50,
      }),
    );
  }

  const nowMs = Date.parse('2026-11-01T12:00:00Z');
  for (const timeZone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
    await assertNativeMatchesTs(dir, account, nowMs, { knownAccounts: {}, timeZone });
  }
});

test('Stage 8B-2: custom fs overrides set hasCustomFs=true and bypass native accelerator', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-stage8b-mockfs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const account = sha('mockfs@example.test');
  const convId = '66666666-6666-4666-8666-666666666666';
  const seed = new UsageLedger(dir, { knownAccounts: {} });
  await seed.ingest(account, convId, rawDoc({ responseId: 'mock-1' }));

  const readPaths = [];
  const custom = new UsageLedger(dir, {
    knownAccounts: {},
    fs: {
      readFile: async (p, ...args) => {
        readPaths.push(p);
        return await readFile(p, ...args);
      },
    },
  });
  assert.equal(seed.hasCustomFs, false);
  assert.equal(custom.hasCustomFs, true);

  const snap = await custom.summary(account, Date.parse('2026-10-11T10:00:00Z'));
  assert.equal(snap.totalTokens, 1100);
  assert.ok(readPaths.some((p) => p.endsWith('.json')));
});

test('Stage 8B-2: dirtyRelPaths preserves unscanned scope & resolves relative PULSE_ACCEL_PATH', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-stage8b-dirty-'));
  const prevPath = process.env.PULSE_ACCEL_PATH;
  t.after(async () => {
    if (prevPath === undefined) delete process.env.PULSE_ACCEL_PATH;
    else process.env.PULSE_ACCEL_PATH = prevPath;
    await rm(dir, { recursive: true, force: true });
  });

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const addonExists = existsSync(join(repoRoot, 'sidecars', 'panel', 'pulse-accel.node'));
  process.env.PULSE_ACCEL_PATH = 'sidecars/panel/pulse-accel.node';
  const expectedNative = addonExists && process.env.PULSE_DISABLE_NATIVE_ACCEL !== '1';
  assert.equal(isNativeAccelAvailable(), expectedNative);

  const scopeA = sha('dirty-a@example.test');
  const scopeB = sha('dirty-b@example.test');
  const convId = '77777777-7777-4777-8777-777777777777';
  const ledger = new UsageLedger(dir, { knownAccounts: {} });
  await ledger.ingest(scopeB, convId, rawDoc({ responseId: 'dirty-b-1' }));

  const dirtyBRel = `${scopeB}/${sha(convId)}.json`;
  assert.ok(ledger.dirtyRelPaths.has(dirtyBRel));

  await ledger.summary(scopeA, Date.parse('2026-10-11T10:00:00Z'));
  assert.ok(ledger.dirtyRelPaths.has(dirtyBRel), 'unscanned scopeB dirty mark must stay intact');

  await ledger.summary(scopeB, Date.parse('2026-10-11T10:00:00Z'));
  if (isNativeAccelAvailable()) {
    assert.equal(ledger.dirtyRelPaths.has(dirtyBRel), false);
  }
});
