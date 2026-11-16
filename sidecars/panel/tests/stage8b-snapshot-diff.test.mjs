import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diffSessionSnapshots,
  isNativeAccelAvailable,
} from '../../../src/platform/native-bridge.ts';
import {
  computeSessionFingerprintHex,
  diffSessionSnapshotsFallback,
  diffSessionSnapshotsWithFallback,
} from '../../../src/telemetry/snapshot-diff.ts';
import { DesktopUsage, UsageLedger } from '../usage.mjs';
import { MetricsStore } from '../store.mjs';
import { SessionHistory } from '../history.mjs';

const ACCOUNT = 'a'.repeat(64);
const CONV_A = '11111111-1111-4111-8111-111111111111';
const CONV_B = '22222222-2222-4222-8222-222222222222';
const CONV_C = '33333333-3333-4333-8333-333333333333';
const CONV_D = '44444444-4444-4444-8444-444444444444';
const CONV_E = '55555555-5555-4555-8555-555555555555';

const rawTrajectory = (id, steps = 2) => ({
  trajectory: {
    cascadeId: id,
    steps: Array.from({ length: steps }, (_, idx) => ({
      type: idx % 2 === 0 ? 'CORTEX_STEP_TYPE_USER_INPUT' : 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      metadata: { createdAt: '2026-11-16T00:00:00Z' },
    })),
    generatorMetadata: [
      {
        stepIndices: [1],
        chatModel: {
          modelDisplayName: 'Gemini Flash',
          usage: {
            responseId: `resp-${id}-${steps}`,
            inputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 50,
          },
          chatStartMetadata: { createdAt: '2026-11-16T00:00:00Z' },
        },
      },
    ],
  },
});

test('64-bit hex fingerprint precision and parity between native Rust and pure-TS fallback', () => {
  const nativeDisabled = process.env.PULSE_DISABLE_NATIVE_ACCEL === '1';
  const nativeAvailable = isNativeAccelAvailable();
  if (nativeDisabled) {
    assert.equal(nativeAvailable, false);
  }

  const sample = {
    cascadeId: CONV_A,
    mtimeMs: 1763300000123,
    sizeBytes: 1048576,
    stepCount: 42,
    lastUserInputStepIndex: 39,
    status: 'CASCADE_RUN_STATUS_IDLE',
    prevFingerprint: null,
    prevSettled: null,
  };
  const fallback = diffSessionSnapshotsFallback([sample]);
  const fp = fallback.items[0].fingerprint;
  assert.equal(typeof fp, 'string');
  assert.match(fp, /^[0-9a-f]{16}$/);
  // Verify top bits above 2^53-1 are preserved cleanly as hex string.
  const asBigInt = BigInt(`0x${fp}`);
  assert.ok(asBigInt > BigInt(Number.MAX_SAFE_INTEGER), `expected 64-bit hash > MAX_SAFE_INTEGER, got ${fp}`);

  assert.equal(
    fp,
    computeSessionFingerprintHex(
      sample.mtimeMs,
      sample.sizeBytes,
      sample.stepCount,
      sample.lastUserInputStepIndex,
      sample.status,
    ),
  );
  assert.notEqual(
    fp,
    computeSessionFingerprintHex(sample.mtimeMs + 1, sample.sizeBytes, sample.stepCount, sample.lastUserInputStepIndex, sample.status),
  );
  assert.notEqual(
    fp,
    computeSessionFingerprintHex(sample.mtimeMs, sample.sizeBytes, sample.stepCount, -1, sample.status),
  );

  const nativeOut = diffSessionSnapshots([sample]);
  if (nativeDisabled || !nativeAvailable) {
    assert.equal(nativeOut, null);
  } else {
    assert.deepEqual(nativeOut, fallback);
  }
});

test('all transition types, status kinds, needsPoll, and preferSqlite match across native and fallback', () => {
  const unchangedIdleFp = computeSessionFingerprintHex(1763300000000, 2048, 10, 7, 'CASCADE_RUN_STATUS_IDLE');
  const runningFp = computeSessionFingerprintHex(1763300001000, 4096, 11, 9, 'CASCADE_RUN_STATUS_RUNNING');

  const inputs = [
    {
      cascadeId: CONV_A,
      mtimeMs: 1763300000000,
      sizeBytes: 0,
      stepCount: 5,
      lastUserInputStepIndex: 3,
      status: 'CASCADE_RUN_STATUS_DONE',
      prevFingerprint: null,
      prevSettled: null,
    },
    {
      cascadeId: CONV_B,
      mtimeMs: 1763300000000,
      sizeBytes: 2048,
      stepCount: 10,
      lastUserInputStepIndex: 7,
      status: 'CASCADE_RUN_STATUS_IDLE',
      prevFingerprint: unchangedIdleFp,
      prevSettled: true,
    },
    {
      cascadeId: CONV_C,
      mtimeMs: 1763300000500,
      sizeBytes: 2048,
      stepCount: 12,
      lastUserInputStepIndex: 10,
      status: 'CASCADE_RUN_STATUS_COMPLETED',
      prevFingerprint: unchangedIdleFp,
      prevSettled: true,
    },
    {
      cascadeId: CONV_D,
      mtimeMs: 1763300002000,
      sizeBytes: 8192,
      stepCount: 14,
      lastUserInputStepIndex: 12,
      status: 'CASCADE_RUN_STATUS_CANCELLED',
      prevFingerprint: runningFp,
      prevSettled: false,
    },
    {
      cascadeId: CONV_E,
      mtimeMs: 1763300001000,
      sizeBytes: 4096,
      stepCount: 11,
      lastUserInputStepIndex: 9,
      status: 'CASCADE_RUN_STATUS_RUNNING',
      prevFingerprint: runningFp,
      prevSettled: false,
    },
  ];

  const fallback = diffSessionSnapshotsFallback(inputs);
  const actual = diffSessionSnapshotsWithFallback(inputs);
  assert.deepEqual(actual, fallback);

  assert.equal(actual.items[0].transition, 'newly_discovered');
  assert.equal(actual.items[0].statusKind, 'settled');
  assert.equal(actual.items[0].needsPoll, true);
  assert.equal(actual.items[0].preferSqlite, false);

  assert.equal(actual.items[1].transition, 'unchanged');
  assert.equal(actual.items[1].statusKind, 'settled');
  assert.equal(actual.items[1].needsPoll, false);
  assert.equal(actual.items[1].preferSqlite, true);

  assert.equal(actual.items[2].transition, 'modified');
  assert.equal(actual.items[2].statusKind, 'settled');
  assert.equal(actual.items[2].needsPoll, true);
  assert.equal(actual.items[2].preferSqlite, true);

  assert.equal(actual.items[3].transition, 'newly_settled');
  assert.equal(actual.items[3].statusKind, 'settled');
  assert.equal(actual.items[3].needsPoll, true);
  assert.equal(actual.items[3].preferSqlite, true);

  assert.equal(actual.items[4].transition, 'unchanged');
  assert.equal(actual.items[4].statusKind, 'running');
  assert.equal(actual.items[4].needsPoll, true);
  assert.equal(actual.items[4].preferSqlite, false);

  assert.deepEqual(actual.dirtyIds, [CONV_A, CONV_C, CONV_D, CONV_E]);
  assert.deepEqual(actual.newlySettledIds, [CONV_D]);
  assert.deepEqual(actual.runningIds, [CONV_E]);
});

test('500-session batch diff throughput and parity', () => {
  const batch = Array.from({ length: 500 }, (_, idx) => {
    const id = `00000000-0000-4000-8000-${String(idx).padStart(12, '0')}`;
    const isRunning = idx % 50 === 0;
    const isModified = idx % 25 === 1;
    const status = isRunning ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE';
    const baseFp = computeSessionFingerprintHex(1763300000000 + idx, 4096 + idx, 10 + (idx % 20), 8, status);
    return {
      cascadeId: id,
      mtimeMs: 1763300000000 + idx + (isModified ? 1000 : 0),
      sizeBytes: 4096 + idx,
      stepCount: 10 + (idx % 20),
      lastUserInputStepIndex: 8,
      status,
      prevFingerprint: baseFp,
      prevSettled: !isRunning,
    };
  });

  const start = performance.now();
  const out = diffSessionSnapshotsWithFallback(batch);
  const elapsedMs = performance.now() - start;

  assert.equal(out.items.length, 500);
  assert.equal(out.runningIds.length, 10);
  assert.equal(out.dirtyIds.length, 30); // 10 running + 20 modified
  assert.ok(elapsedMs < 250, `expected 500-session diff < 250ms, took ${elapsedMs.toFixed(2)}ms`);

  if (process.env.PULSE_DISABLE_NATIVE_ACCEL !== '1' && isNativeAccelAvailable()) {
    assert.deepEqual(diffSessionSnapshots(batch), diffSessionSnapshotsFallback(batch));
  }
});

test('DesktopUsage.runSync prunes unchanged sessions via diffSessionSnapshots and preserves retry/newly-settled parity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-stage8b-backfill-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const ledger = new UsageLedger(dir);
  let trajectoryCalls = [];
  let listedRows = [
    { id: CONV_A, status: 'CASCADE_RUN_STATUS_IDLE', modifiedAt: '2026-11-16T00:00:00Z', stepCount: 2 },
    { id: CONV_B, status: 'CASCADE_RUN_STATUS_RUNNING', modifiedAt: '2026-11-16T00:01:00Z', stepCount: 2 },
  ];
  const store = {
    identity: ACCOUNT,
    epoch: 1,
    listConversations: async () => listedRows,
    client: {
      trajectory: async (id) => {
        trajectoryCalls.push(id);
        return rawTrajectory(id, 2);
      },
    },
  };
  const usage = new DesktopUsage(store, ledger, {
    host: 'app',
    discoverLocal: async () => ({ conversations: [], errors: 0 }),
  });
  t.after(() => usage.dispose());

  // Pass 1: both newly_discovered -> both synced
  await usage.sync();
  assert.deepEqual(trajectoryCalls, [CONV_A, CONV_B]);

  // Pass 2: CONV_A unchanged settled (pruned), CONV_B still running (polled)
  trajectoryCalls = [];
  await usage.sync();
  assert.deepEqual(trajectoryCalls, [CONV_B]);

  // Pass 3: CONV_B transitions to IDLE (newly_settled) -> polled once more, then pruned on Pass 4
  listedRows = [
    { id: CONV_A, status: 'CASCADE_RUN_STATUS_IDLE', modifiedAt: '2026-11-16T00:00:00Z', stepCount: 2 },
    { id: CONV_B, status: 'CASCADE_RUN_STATUS_IDLE', modifiedAt: '2026-11-16T00:02:00Z', stepCount: 4 },
  ];
  trajectoryCalls = [];
  await usage.sync();
  assert.deepEqual(trajectoryCalls, [CONV_B]);

  trajectoryCalls = [];
  await usage.sync();
  assert.deepEqual(trajectoryCalls, []);
});

test('MetricsStore.listConversations tracks dirty/newly-settled fingerprints and invalidates stale session TTL', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-stage8b-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let stepCount = 2;
  let status = 'CASCADE_RUN_STATUS_RUNNING';
  let modifiedAt = '2026-11-16T00:00:00Z';
  let trajectoryCalls = 0;

  const client = {
    discover: async () => ({ pid: 500 }),
    call: async (method) => {
      if (method === 'GetUserStatus') return { userStatus: { email: 'stage8b@example.test' } };
      if (method === 'RetrieveUserQuotaSummary') return { response: { groups: [] } };
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            [CONV_A]: { summary: 'Active', status, stepCount, lastModifiedTime: modifiedAt },
          },
        };
      }
      return {};
    },
    trajectory: async (id) => {
      trajectoryCalls++;
      return rawTrajectory(id, stepCount);
    },
    reader: { entries: new Map(), summaries: {} },
    setModelTimelineEnabled() {},
    resetTrajectories() {},
  };

  const store = new MetricsStore(client, {
    history: new SessionHistory(dir),
    timelineStore: null,
    owns: () => true,
  });
  t.after(() => store.dispose());

  await store.refreshQuota(true);
  await store.listConversations(true);
  assert.equal(store.dirtySessionIds.has(CONV_A), true);
  assert.equal(store.runningSessionIds.has(CONV_A), true);
  assert.equal(store.newlySettledSessionIds.has(CONV_A), false);

  await store.session(CONV_A);
  assert.equal(trajectoryCalls, 1);
  assert.equal(store.dirtySessionIds.has(CONV_A), false);

  // Within 1800ms TTL, unchanged summary uses cached session entry
  await store.session(CONV_A);
  assert.equal(trajectoryCalls, 1);

  // Transition to IDLE -> newly_settled must bypass 1800ms TTL and refresh session
  status = 'CASCADE_RUN_STATUS_IDLE';
  stepCount = 4;
  modifiedAt = '2026-11-16T00:01:00Z';
  await store.listConversations(true);
  assert.equal(store.newlySettledSessionIds.has(CONV_A), true);
  assert.equal(store.dirtySessionIds.has(CONV_A), true);
  assert.equal(store.getSummaryDiff()?.items[0]?.transition, 'newly_settled');

  await store.session(CONV_A);
  assert.equal(trajectoryCalls, 2);
  assert.equal(store.newlySettledSessionIds.has(CONV_A), false);
});
