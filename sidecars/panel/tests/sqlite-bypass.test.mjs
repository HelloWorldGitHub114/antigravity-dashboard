import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  extractSqliteUsageRecords,
  isNativeAccelAvailable,
  readSqliteConversationMeta,
  readSqliteTrajectory,
} from '../../../src/platform/native-bridge.ts';
import { DesktopUsage, UsageLedger, usageRecords } from '../usage.mjs';
import { trajectoryMetrics } from '../metrics.mjs';
import { buildModelTimeline } from '../timeline.mjs';
import { TrajectoryReader } from '../trajectory-reader.mjs';

const ACCOUNT = 'a'.repeat(64);
const CID_ROOT = '11111111-2222-3333-4444-555555555555';
const CID_SUB = '22222222-3333-4444-5555-666666666666';
const CID_CHILD = '99999999-8888-7777-6666-555555555555';
const CID_PARENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CID_EMPTY = '33333333-4444-5555-6666-777777777777';
const sha = (v) => createHash('sha256').update(v).digest('hex');

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
const ts = (sec, nanos = 0) => msg(fU64(1, sec), ...(nanos ? [fU64(2, nanos)] : []));
const mapEntry = (k, v) => msg(fStr(1, k), fStr(2, v));

function openFixtureDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
     CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
     CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);`,
  );
  return db;
}

function buildUsageBlob({
  modelEnum,
  input = 1200,
  output = 350,
  write = 100,
  read = 800,
  provider = 24,
  responseId = 'resp-001',
  messageId = null,
  thinkingOutput = null,
  responseOutput = null,
} = {}) {
  return msg(
    ...(modelEnum ? [fU64(1, modelEnum)] : []),
    ...(input !== null && input !== undefined ? [fU64(2, input)] : []),
    ...(output !== null && output !== undefined ? [fU64(3, output)] : []),
    ...(write !== null && write !== undefined ? [fU64(4, write)] : []),
    ...(read !== null && read !== undefined ? [fU64(5, read)] : []),
    ...(provider !== null && provider !== undefined ? [fU64(6, provider)] : []),
    ...(messageId ? [fStr(7, messageId)] : []),
    ...(thinkingOutput !== null ? [fU64(9, thinkingOutput)] : []),
    ...(responseOutput !== null ? [fU64(10, responseOutput)] : []),
    ...(responseId ? [fStr(11, responseId)] : []),
  );
}

function buildStep132(name, args = [], anyValues = []) {
  const meta = msg(fBytes(4, msg(fStr(1, `call_${name}`), fStr(2, name))));
  const inner = msg(
    ...args.map(([k, v]) => fBytes(1, mapEntry(k, v))),
    ...anyValues.map((av) => fBytes(2, fBytes(6, fBytes(2, av)))),
  );
  return { meta, payload: fBytes(140, inner) };
}

function populateRichFixture(dbPath, { asSubagent = false } = {}) {
  const db = openFixtureDb(dbPath);
  try {
    const spec = msg(fStr(1, 'research'), fStr(2, 'Codebase Researcher'), fU64(4, 0), fU64(8, 3));
    const trajMeta = msg(
      fBytes(2, ts(1776429000)),
      ...(asSubagent ? [fStr(5, CID_PARENT), fStr(6, CID_ROOT), fBytes(8, spec), fU64(17, 1)] : []),
    );
    db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(trajMeta);

    const ins = db.prepare(
      'INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)',
    );
    // 0: USER_INPUT (14) with planModel = 1668 -> MODEL_PLACEHOLDER_M668
    ins.run(
      0,
      14,
      3,
      msg(fBytes(1, ts(1776429001))),
      fBytes(19, fBytes(12, fBytes(1, fU64(1, 1668)))),
    );
    // 1: PLANNER_RESPONSE (15)
    ins.run(
      1,
      15,
      3,
      msg(fBytes(1, ts(1776429005, 500_000_000)), fU64(11, 1668)),
      fBytes(20, msg(fStr(1, 'Plan response'), fBytes(7, msg(fStr(1, 'c1'), fStr(2, 'view_file'))))),
    );
    // 2: ERROR_MESSAGE (17)
    ins.run(2, 17, 7, msg(fBytes(1, ts(1776429006))), Buffer.alloc(0));
    // 3: CHECKPOINT (23)
    ins.run(3, 23, 3, msg(fBytes(1, ts(1776429007))), Buffer.alloc(0));
    // 4: TASK_BOUNDARY (81) -> mode = AGENT_MODE_EXECUTION (2)
    ins.run(4, 81, 3, msg(fBytes(1, ts(1776429008))), fBytes(93, fU64(5, 2)));
    // 5: SYSTEM_MESSAGE (101) -> eventType
    ins.run(5, 101, 3, msg(fBytes(1, ts(1776429009))), fBytes(114, fStr(3, 'USER_QUEUED')));
    // 6..10: GENERIC (132) mapped tools
    const vf = buildStep132('view_file');
    ins.run(6, 132, 3, vf.meta, vf.payload);
    const rc = buildStep132('run_command');
    ins.run(7, 132, 3, rc.meta, rc.payload);
    const wf = buildStep132('write_file');
    ins.run(8, 132, 3, wf.meta, wf.payload);
    const inv = buildStep132('invoke_subagent', [
      ['ConversationId', CID_CHILD],
      ['Role', 'Worker Subagent'],
      ['TypeName', 'research'],
    ]);
    ins.run(9, 132, 3, inv.meta, inv.payload);
    const sm = buildStep132('send_message', [['Recipient', CID_CHILD]]);
    ins.run(10, 132, 3, sm.meta, sm.payload);

    // Primary gen_metadata with unresolved model enum (999 -> MODEL_ENUM_999) + custom_metadata["model_enum"]
    const chatModel = msg(
      fU64(3, 999),
      fBytes(4, buildUsageBlob({ modelEnum: 999 })),
      fBytes(9, fBytes(4, ts(1776429002))),
      fBytes(20, mapEntry('model_enum', 'MODEL_PLACEHOLDER_M668')),
    );
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (0, ?)').run(
      msg(fBytes(1, chatModel), fU64(2, 1)),
    );
  } finally {
    db.close();
  }
}

function requireNative(t) {
  if (process.env.PULSE_DISABLE_NATIVE_ACCEL === '1' || !isNativeAccelAvailable()) {
    t.skip('native pulse-accel addon is disabled or unavailable');
    return false;
  }
  return true;
}

test('native bridge loads pulse-accel.node and respects PULSE_DISABLE_NATIVE_ACCEL=1', async (t) => {
  if (!requireNative(t)) return;
  const dir = await mkdtemp(join(tmpdir(), 'ag-sqlite-bridge-'));
  const dbPath = join(dir, `${CID_ROOT}.db`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  populateRichFixture(dbPath);

  const prev = process.env.PULSE_DISABLE_NATIVE_ACCEL;
  try {
    delete process.env.PULSE_DISABLE_NATIVE_ACCEL;
    assert.equal(isNativeAccelAvailable(), true);
    assert.equal(extractSqliteUsageRecords(dbPath, CID_ROOT)?.length, 1);
    assert.ok(readSqliteTrajectory(dbPath, CID_ROOT, { modelTimelineEnabled: true }));

    process.env.PULSE_DISABLE_NATIVE_ACCEL = '1';
    assert.equal(isNativeAccelAvailable(), false);
    assert.equal(extractSqliteUsageRecords(dbPath, CID_ROOT), null);
    assert.equal(readSqliteTrajectory(dbPath, CID_ROOT, { modelTimelineEnabled: true }), null);
  } finally {
    if (prev === undefined) delete process.env.PULSE_DISABLE_NATIVE_ACCEL;
    else process.env.PULSE_DISABLE_NATIVE_ACCEL = prev;
  }
});

test('extractSqliteUsageRecords matches usageRecords parity, synthesizes step fallback, and never creates missing files', async (t) => {
  if (!requireNative(t)) return;
  const dir = await mkdtemp(join(tmpdir(), 'ag-sqlite-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const missingPath = join(dir, 'nonexistent.db');
  assert.equal(extractSqliteUsageRecords(missingPath, CID_ROOT), null);
  assert.equal(existsSync(missingPath), false);

  const primaryDb = join(dir, `${CID_ROOT}.db`);
  populateRichFixture(primaryDb);
  const sqliteRows = extractSqliteUsageRecords(primaryDb, CID_ROOT);
  const expectedJsRows = usageRecords(
    {
      trajectory: {
        steps: [{ type: 'CORTEX_STEP_TYPE_USER_INPUT' }, { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' }],
        generatorMetadata: [
          {
            stepIndices: [1],
            chatModel: {
              model: 'MODEL_PLACEHOLDER_M668',
              usage: {
                model: 'MODEL_PLACEHOLDER_M668',
                inputTokens: 1200,
                outputTokens: 350,
                cacheWriteTokens: 100,
                cacheReadTokens: 800,
                apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                responseId: 'resp-001',
              },
              chatStartMetadata: { createdAt: '2026-04-17T12:30:02Z' },
            },
          },
        ],
      },
    },
    CID_ROOT,
  );
  assert.deepEqual(sqliteRows, expectedJsRows);

  // Fallback synthesis from steps.metadata.model_usage when gen_metadata has no usage
  const fallbackDb = join(dir, `${CID_SUB}.db`);
  const db = openFixtureDb(fallbackDb);
  try {
    const stepMeta = msg(
      fBytes(1, ts(1776429100)),
      fBytes(9, buildUsageBlob({ modelEnum: 1668, input: 500, output: 125, write: 50, read: 200, responseId: 'synth-1' })),
      fBytes(24, fStr(20, 'Gemini Custom')),
    );
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)').run(
      0,
      15,
      3,
      stepMeta,
      Buffer.alloc(0),
    );
  } finally {
    db.close();
  }
  const synthRows = extractSqliteUsageRecords(fallbackDb, CID_SUB);
  const synthTraj = readSqliteTrajectory(fallbackDb, CID_SUB, { modelTimelineEnabled: true });
  assert.equal(synthRows?.length, 1);
  assert.deepEqual(synthRows, usageRecords(synthTraj, CID_SUB));
  assert.equal(synthRows[0].model, 'Gemini Custom');
  assert.equal(synthRows[0].uncached, 500);
  assert.equal(synthRows[0].output, 125);
  assert.equal(synthRows[0].cacheRead, 200);
  assert.equal(synthRows[0].cacheWrite, 50);
  assert.equal(synthRows[0].partial, false);
});

test('readSqliteTrajectory decodes metadata, step types, generic tool upgrades, and send_message root/subagent gating', async (t) => {
  if (!requireNative(t)) return;
  const dir = await mkdtemp(join(tmpdir(), 'ag-sqlite-traj-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const rootDb = join(dir, `${CID_ROOT}.db`);
  const subDb = join(dir, `${CID_SUB}.db`);
  populateRichFixture(rootDb, { asSubagent: false });
  populateRichFixture(subDb, { asSubagent: true });

  const rootTraj = readSqliteTrajectory(rootDb, CID_ROOT, { modelTimelineEnabled: true });
  const subTraj = readSqliteTrajectory(subDb, CID_SUB, { modelTimelineEnabled: true });
  const subMeta = readSqliteConversationMeta(subDb, CID_SUB);

  assert.equal(rootTraj.trajectory.planModel, 'MODEL_PLACEHOLDER_M668');
  assert.equal(rootTraj.trajectory.metadata.createdAt, '2026-04-17T12:30:00Z');
  assert.equal(subTraj.trajectory.metadata.parentConversationId, CID_PARENT);
  assert.equal(subTraj.trajectory.metadata.rootConversationId, CID_ROOT);
  assert.equal(subTraj.trajectory.metadata.nestingDepth, 1);
  assert.deepEqual(subTraj.trajectory.metadata.subagentSpec, {
    typeName: 'research',
    role: 'Codebase Researcher',
    inherit: false,
    modelTier: 'MODEL_TIER_FLASH',
  });
  assert.equal(subMeta.stepCount, 11);
  assert.equal(subMeta.parentConversationId, CID_PARENT);

  const steps = rootTraj.trajectory.steps;
  assert.equal(steps[0].type, 'CORTEX_STEP_TYPE_USER_INPUT');
  assert.equal(steps[0].userInput.userConfig.plannerConfig.planModel, 'MODEL_PLACEHOLDER_M668');
  assert.equal(steps[1].type, 'CORTEX_STEP_TYPE_PLANNER_RESPONSE');
  assert.equal(steps[1].plannerResponse.response, '1');
  assert.equal(steps[2].type, 'CORTEX_STEP_TYPE_ERROR_MESSAGE');
  assert.equal(steps[3].type, 'CORTEX_STEP_TYPE_CHECKPOINT');
  assert.equal(steps[4].type, 'CORTEX_STEP_TYPE_TASK_BOUNDARY');
  assert.equal(steps[4].taskBoundary.mode, 'AGENT_MODE_EXECUTION');
  assert.equal(steps[5].type, 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE');
  assert.equal(steps[5].systemMessage.eventType, 'USER_QUEUED');
  assert.equal(steps[6].type, 'CORTEX_STEP_TYPE_VIEW_FILE');
  assert.equal(steps[7].type, 'CORTEX_STEP_TYPE_RUN_COMMAND');
  assert.equal(steps[8].type, 'CORTEX_STEP_TYPE_CODE_ACTION');
  assert.equal(steps[9].type, 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT');
  assert.equal(steps[9].invokeSubagent.conversationId, CID_CHILD);
  assert.equal(steps[9].invokeSubagent.subagents[0].role, 'Worker Subagent');
  assert.equal(steps[9].invokeSubagent.subagents[0].typeName, 'research');

  // send_message projected on root, suppressed on subagent
  assert.deepEqual(steps[10].sendMessage, { conversationId: CID_CHILD });
  assert.equal(subTraj.trajectory.steps[10].sendMessage, undefined);
});

test('DesktopUsage backfill syncs settled .db and unlisted 0-turn archive with 0 RPC calls', async (t) => {
  if (!requireNative(t)) return;
  const dir = await mkdtemp(join(tmpdir(), 'ag-sqlite-backfill-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const settledDb = join(dir, `${CID_ROOT}.db`);
  const emptyDb = join(dir, `${CID_EMPTY}.db`);
  populateRichFixture(settledDb);
  openFixtureDb(emptyDb).close();

  const ledger = new UsageLedger(join(dir, 'ledger'));
  let rpcCalls = 0;
  const store = {
    identity: ACCOUNT,
    epoch: 1,
    conversationsDir: dir,
    listConversations: async () => [
      { id: CID_ROOT, status: 'CASCADE_RUN_STATUS_IDLE', modifiedAt: '2026-04-17T12:31:00Z', stepCount: 11 },
    ],
    client: {
      trajectory: async () => {
        rpcCalls++;
        throw new Error('RPC should not be called');
      },
    },
  };
  const usage = new DesktopUsage(store, ledger, {
    host: 'app',
    conversationsDir: dir,
    discoverLocal: async () => ({
      conversations: [
        { id: CID_ROOT, signature: 'sig-root', dbPath: settledDb },
        { id: CID_EMPTY, signature: 'sig-empty', dbPath: emptyDb },
      ],
      errors: 0,
    }),
  });
  t.after(() => usage.dispose());

  await usage.sync();
  assert.equal(rpcCalls, 0);
  assert.equal(usage.status, 'ready');
  assert.equal(usage.missingConversations, 0);
  const summary = await ledger.summary(ACCOUNT);
  assert.equal(summary.requests, 1);
  assert.equal(summary.totalTokens, 2450);

  const journal = await ledger.backfillState(ACCOUNT, 'app');
  assert.equal(journal[sha(CID_ROOT)].state, 'complete');
  assert.equal(journal[sha(CID_EMPTY)].state, 'complete');
});

test('TrajectoryReader reads settled .db with 0 RPC calls and rescues RUNNING resource_exhausted from SQLite', async (t) => {
  if (!requireNative(t)) return;
  const dir = await mkdtemp(join(tmpdir(), 'ag-sqlite-reader-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const settledDb = join(dir, `${CID_ROOT}.db`);
  const runningDb = join(dir, `${CID_SUB}.db`);
  populateRichFixture(settledDb);
  populateRichFixture(runningDb, { asSubagent: true });

  const calls = [];
  const client = {
    now: () => 1000,
    discover: async () => ({ pid: 1, port: 2, csrf: 'x' }),
    call: async (method) => {
      calls.push(method);
      if (method === 'GetCascadeTrajectorySteps') {
        throw new Error('resource_exhausted: message larger than 8 MiB');
      }
      throw new Error(`Unexpected RPC: ${method}`);
    },
  };
  const reader = new TrajectoryReader(client, { conversationsDir: dir, modelTimelineEnabled: true });

  const settledRes = await reader.read(CID_ROOT, {
    summary: { stepCount: 11, status: 'CASCADE_RUN_STATUS_IDLE', lastModifiedTime: '2026-04-17T12:31:00Z' },
  });
  assert.equal(calls.length, 0);
  assert.equal(settledRes.numTotalSteps, 11);
  assert.equal(settledRes.trajectory.planModel, 'MODEL_PLACEHOLDER_M668');
  assert.equal(settledRes.trajectoryMetadata.stepCount, 11);

  const rescuedRes = await reader.read(CID_SUB, {
    summary: { stepCount: 11, status: 'CASCADE_RUN_STATUS_RUNNING', lastModifiedTime: '2026-04-17T12:31:05Z' },
  });
  assert.deepEqual(calls, ['GetCascadeTrajectorySteps']);
  assert.equal(rescuedRes.status, 'CASCADE_RUN_STATUS_RUNNING');
  assert.equal(rescuedRes.numTotalSteps, 11);
  assert.equal(rescuedRes.trajectoryMetadata.parentConversationId, CID_PARENT);
});

test('SQLite identity, proto3 zero-omission, metrics, timeline, and root self-rootConversationId parity', async (t) => {
  if (!requireNative(t)) return;
  const dir = await mkdtemp(join(tmpdir(), 'ag-sqlite-parity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const dbPath = join(dir, `${CID_ROOT}.db`);
  const db = openFixtureDb(dbPath);
  try {
    // Root conversation that carries rootConversationId === selfId
    db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(
      msg(fBytes(2, ts(1776429000)), fStr(6, CID_ROOT)),
    );
    const ins = db.prepare(
      'INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)',
    );
    ins.run(0, 14, 3, msg(fBytes(1, ts(1776429001))), fBytes(19, fBytes(12, fBytes(1, fU64(1, 1668)))));
    ins.run(1, 15, 3, msg(fBytes(1, ts(1776429005))), fBytes(20, msg(fStr(1, 'hi'))));
    ins.run(
      2,
      127,
      3,
      msg(fBytes(1, ts(1776429006))),
      fBytes(143, msg(fStr(5, CID_CHILD), fBytes(1, msg(fStr(1, 'research'), fStr(2, 'Direct Sub'))))),
    );
    const smOther = buildStep132('send_message', [['Recipient', CID_PARENT]]);
    ins.run(3, 132, 3, smOther.meta, smOther.payload);
    const smSelf = buildStep132('send_message', [['Recipient', CID_ROOT]]);
    ins.run(4, 132, 3, smSelf.meta, smSelf.payload);

    // Gen 0: message: identity (no responseId)
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      0,
      msg(
        fBytes(
          1,
          msg(
            fU64(3, 1668),
            fBytes(
              4,
              buildUsageBlob({
                modelEnum: 1668,
                input: 100,
                output: 50,
                write: 0,
                read: 400,
                responseId: null,
                messageId: 'msg-xyz',
                thinkingOutput: 20,
                responseOutput: 30,
              }),
            ),
            fBytes(9, fBytes(4, ts(1776429002))),
            fBytes(11, ts(1, 500_000_000)),
            fBytes(12, ts(2, 0)),
          ),
        ),
        fU64(2, 1),
      ),
    );
    // Gen 1: proto3 zero-omitted inputTokens (null) -> partial: true + fallback dated planner-created
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      1,
      msg(
        fBytes(
          1,
          msg(
            fU64(3, 1668),
            fBytes(
              4,
              buildUsageBlob({
                modelEnum: 1668,
                input: null,
                output: 40,
                write: 0,
                read: 500,
                responseId: null,
                messageId: null,
              }),
            ),
          ),
        ),
        fU64(2, 1),
      ),
    );
    // Gen 2 & 3: duplicate responseId -> recordSum keeps higher sum (500 vs 200) + zero-token skip
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      2,
      msg(
        fBytes(1, msg(fU64(3, 1668), fBytes(4, buildUsageBlob({ input: 100, output: 100, write: 0, read: 0, responseId: 'dup-1' })))),
        fU64(2, 1),
      ),
    );
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      3,
      msg(
        fBytes(1, msg(fU64(3, 1668), fBytes(4, buildUsageBlob({ input: 300, output: 200, write: 0, read: 0, responseId: 'dup-1' })))),
        fU64(2, 1),
      ),
    );
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      4,
      msg(
        fBytes(1, msg(fU64(3, 1668), fBytes(4, buildUsageBlob({ input: 0, output: 0, write: 0, read: 0, responseId: 'empty-1' })))),
        fU64(2, 1),
      ),
    );
  } finally {
    db.close();
  }

  const trajTrue = readSqliteTrajectory(dbPath, CID_ROOT, { modelTimelineEnabled: true });
  const trajFalse = readSqliteTrajectory(dbPath, CID_ROOT, { modelTimelineEnabled: false });
  const rows = extractSqliteUsageRecords(dbPath, CID_ROOT);
  assert.deepEqual(rows, usageRecords(trajTrue, CID_ROOT));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].timeBasis, 'request-start');
  assert.equal(rows[1].timeBasis, 'planner-created');
  assert.equal(rows[1].uncached, null);
  assert.equal(rows[1].partial, true);
  assert.equal(rows[2].uncached + rows[2].output, 500);

  // Root with self rootConversationId preserves sendMessage to parent/child, suppresses self-send
  assert.equal(trajTrue.trajectory.steps[2].type, 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT');
  assert.equal(trajTrue.trajectory.steps[2].invokeSubagent.conversationId, CID_CHILD);
  assert.deepEqual(trajTrue.trajectory.steps[3].sendMessage, { conversationId: CID_PARENT });
  assert.equal(trajTrue.trajectory.steps[4].sendMessage, undefined);
  assert.equal(trajFalse.trajectory.steps[0].i, undefined);
  assert.equal(trajFalse.trajectory.steps[3].metadata.toolCall, true);

  const m = trajectoryMetrics(trajTrue, { now: 1776429999000 });
  assert.equal(m.tokens.complete, false);
  assert.equal(m.tokens.missingInputRequests, 1);
  assert.equal(m.tokens.outputTokens, 190);
  const tl = buildModelTimeline(trajTrue, { cascadeId: CID_ROOT, now: 1776429999000 });
  assert.ok(tl && Array.isArray(tl.nodes) && tl.nodes.length >= 1);
});

test('TrajectoryReader unlisted idleRecheckMs cache, stale stepCount fallback, budgetBytes, and backfill RUNNING/corrupt rescue', async (t) => {
  if (!requireNative(t)) return;
  const dir = await mkdtemp(join(tmpdir(), 'ag-sqlite-edge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const unlistedDb = join(dir, `${CID_ROOT}.db`);
  populateRichFixture(unlistedDb);

  let now = 1000;
  const calls = [];
  const client = {
    now: () => now,
    discover: async () => ({ pid: 1, port: 2, csrf: 'x' }),
    call: async (method) => {
      calls.push(method);
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            [CID_SUB]: { stepCount: 99, status: 'CASCADE_RUN_STATUS_IDLE', lastModifiedTime: '2026-04-17T12:31:00Z' },
          },
        };
      }
      if (method === 'GetCascadeTrajectorySteps') {
        return { steps: Array.from({ length: 99 }, () => ({ type: 'CORTEX_STEP_TYPE_VIEW_FILE' })) };
      }
      if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
        return { generatorMetadata: [] };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    },
  };

  // 1. Unlisted .db idleRecheckMs cache hit avoids re-reading & bumping rev
  const reader = new TrajectoryReader(client, { conversationsDir: dir, idleRecheckMs: 5000, modelTimelineEnabled: true });
  const r1 = await reader.read(CID_ROOT);
  now = 2000;
  const r2 = await reader.read(CID_ROOT);
  assert.equal(r1.numTotalSteps, 11);
  assert.equal(r2, r1);
  assert.equal(calls.filter((m) => m !== 'GetAllCascadeTrajectories').length, 0);

  // 2. Stale stepCount (11 < 99) must fall back to RPC instead of trusting incomplete SQLite
  populateRichFixture(join(dir, `${CID_SUB}.db`));
  const rSub = await reader.read(CID_SUB);
  assert.equal(rSub.numTotalSteps, 99);
  assert.ok(calls.includes('GetCascadeTrajectorySteps'));

  // 3. budgetBytes early abort throws consistently
  const tinyReader = new TrajectoryReader(client, { conversationsDir: dir, budgetBytes: 64 });
  await assert.rejects(() => tinyReader.read(CID_ROOT), /会话统计数据超过内存预算/);

  // 4. RUNNING backfill hits RPC, rescues on error; corrupt DB returns null and hits RPC
  const corruptDb = join(dir, `${CID_EMPTY}.db`);
  writeFileSync(corruptDb, 'corrupt-sqlite-bytes');
  assert.equal(extractSqliteUsageRecords(corruptDb, CID_EMPTY), null);

  let runningRpcCalls = 0;
  let corruptRpcCalls = 0;
  const ledger = new UsageLedger(join(dir, 'ledger'));
  const usage = new DesktopUsage(
    {
      identity: ACCOUNT,
      epoch: 1,
      conversationsDir: dir,
      listConversations: async () => [
        { id: CID_ROOT, status: 'CASCADE_RUN_STATUS_RUNNING', modifiedAt: '2026-04-17T12:31:00Z', stepCount: 11 },
        { id: CID_EMPTY, status: 'CASCADE_RUN_STATUS_IDLE', modifiedAt: '2026-04-17T12:32:00Z', stepCount: 1 },
      ],
      client: {
        trajectory: async (id) => {
          if (id === CID_ROOT) {
            runningRpcCalls++;
            throw new Error('resource_exhausted: too large');
          }
          corruptRpcCalls++;
          return { trajectory: { steps: [{ type: 'CORTEX_STEP_TYPE_USER_INPUT' }], generatorMetadata: [] } };
        },
      },
    },
    ledger,
    {
      host: 'app',
      conversationsDir: dir,
      discoverLocal: async () => ({
        conversations: [
          { id: CID_ROOT, signature: 'sig-run', dbPath: unlistedDb },
          { id: CID_EMPTY, signature: 'sig-corrupt', dbPath: corruptDb },
        ],
        errors: 0,
      }),
    },
  );
  t.after(() => usage.dispose());
  await usage.sync();
  assert.equal(runningRpcCalls, 1);
  assert.equal(corruptRpcCalls, 1);
  const s = await ledger.summary(ACCOUNT);
  assert.equal(s.requests, 1);
  assert.equal(s.totalTokens, 2450);
});

test('commercial Vertex provider=3 in SQLite produces partial:false usage records and non-null cache.hitRate', async (t) => {
  if (process.env.PULSE_DISABLE_NATIVE_ACCEL === '1' || !isNativeAccelAvailable()) {
    t.skip('native pulse-accel addon is disabled or unavailable');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'ag-sqlite-vertex-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const dbPath = join(dir, `${CID_ROOT}.db`);
  const db = openFixtureDb(dbPath);
  try {
    db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(
      msg(fBytes(2, ts(1776429000))),
    );
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)').run(
      0,
      15,
      3,
      msg(fBytes(1, ts(1776429005)), fU64(11, 1668)),
      fBytes(20, fStr(1, 'ok')),
    );
    const usage = buildUsageBlob({
      modelEnum: 1668,
      input: 360589,
      read: 3712977,
      write: 0,
      output: 29260,
      provider: 3, // API_PROVIDER_GOOGLE_VERTEX
      responseId: 'resp-vertex-1',
    });
    const chatModel = msg(fU64(3, 1668), fBytes(4, usage), fStr(6, '2s'), fBytes(9, msg(fBytes(4, ts(1776429002)))));
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, msg(fBytes(1, chatModel), fU64(2, 0)));
  } finally {
    db.close();
  }

  const recs = extractSqliteUsageRecords(dbPath, CID_ROOT);
  assert.equal(recs?.length, 1);
  assert.equal(recs[0].partial, false);
  assert.equal(recs[0].uncached, 360589);
  assert.equal(recs[0].cacheRead, 3712977);
  assert.equal(recs[0].output, 29260);

  const traj = readSqliteTrajectory(dbPath, CID_ROOT, false);
  const metrics = trajectoryMetrics(traj);
  assert.equal(metrics.cache.missingRequests, 0);
  assert.equal(metrics.cache.complete, true);
  assert.equal(metrics.cache.hitRate, 3712977 / (360589 + 3712977));

  const ledgerDir = join(dir, 'ledger');
  const ledger = new UsageLedger(ledgerDir);
  await ledger.ingest(ACCOUNT, CID_ROOT, traj);
  const summary = await ledger.summary(ACCOUNT);
  assert.equal(summary.partialRequests, 0);
  assert.equal(summary.totalTokens, 4102826);
});
