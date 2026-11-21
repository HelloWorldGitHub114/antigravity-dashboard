import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isNativeAccelAvailable } from '../../../src/platform/native-bridge.ts';
import {
  AntigravityClient,
  NO_LOCAL_CREDENTIALS_CODE,
  NO_LOCAL_CREDENTIALS_MESSAGE,
  serverFromDiscovery,
} from '../client.mjs';
import { formatModelName } from '../context.mjs';
import { SessionHistory } from '../history.mjs';
import { MetricsStore } from '../store.mjs';
import { DesktopUsage, UsageLedger } from '../usage.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const createI18n = require('../../../compat/i18n.cjs');

const CID_ROOT = '11111111-2222-3333-4444-555555555555';
const CID_SUB = '22222222-3333-4444-5555-666666666666';
const ACCOUNT = 'b'.repeat(64);

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
const dur = (sec, nanos = 0) => msg(fU64(1, sec), ...(nanos ? [fU64(2, nanos)] : []));

function createConversationDb(
  dbPath,
  { running = false, outputTokens = 200, modelEnum = 1532, parentId = null, rootId = null, subagentSpec = null, nestingDepth = null } = {},
) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);
    const specBlob = subagentSpec
      ? msg(
          ...(subagentSpec.typeName ? [fStr(1, subagentSpec.typeName)] : []),
          ...(subagentSpec.role ? [fStr(2, subagentSpec.role)] : []),
        )
      : null;
    const trajMeta = msg(
      fBytes(2, ts(1795241000)),
      ...(parentId ? [fStr(5, parentId)] : []),
      ...(rootId ? [fStr(6, rootId)] : []),
      ...(specBlob ? [fBytes(8, specBlob)] : []),
      ...(typeof nestingDepth === 'number' ? [fU64(17, nestingDepth)] : []),
    );
    db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(trajMeta);

    const stepStatus = running ? 2 : 3;
    const ins = db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)');
    ins.run(0, 14, 3, msg(fBytes(1, ts(1795241001))), fBytes(19, fBytes(12, fBytes(1, fU64(1, modelEnum)))));
    ins.run(1, 15, stepStatus, msg(fBytes(1, ts(1795241005)), fU64(11, modelEnum)), fBytes(20, fStr(1, 'Answer')));

    const usageBlob = msg(
      fU64(1, modelEnum),
      fU64(2, 1000),
      fU64(3, outputTokens),
      fU64(5, 4000),
      fU64(6, 24),
      fU64(10, outputTokens),
      fStr(11, `resp-${outputTokens}`),
    );
    const ctxMeta = msg(fU64(1, 50000), fU64(4, 512000));
    const startMeta = msg(fBytes(4, ts(1795241002)), fBytes(10, ctxMeta));
    const chatModel = msg(
      fU64(3, modelEnum),
      fBytes(4, usageBlob),
      fBytes(9, startMeta),
      fBytes(11, dur(1, 500_000_000)),
      fBytes(12, dur(4, 0)),
    );
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (0, ?)').run(msg(fBytes(1, chatModel), fU64(2, 1)));
  } finally {
    db.close();
  }
}

function createSummariesDb(dbPath, rows) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        last_modified_time INTEGER,
        workspace_uris TEXT,
        project_id TEXT,
        parent_conversation_id TEXT,
        source TEXT,
        agent_name TEXT
      );
    `);
    const ins = db.prepare(
      'INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of rows) {
      ins.run(
        r.id,
        r.title ?? 'Test Session',
        '',
        r.mtime,
        r.workspaceUris || '',
        r.projectId || '',
        r.parentId || '',
        r.source || '',
        r.agentName || '',
      );
    }
  } finally {
    db.close();
  }
}

test('serverFromDiscovery attaches structured NO_LOCAL_CREDENTIALS metadata for Antigravity 2.34+', () => {
  const log = 'Language server listening on random port at 61734 for HTTP\n';
  const rows = [
    {
      ProcessId: 31508,
      CommandLine: 'language_server.exe --standalone --override_ide_version 2.34.0 --enable_sidecars',
      Ports: [61734],
    },
  ];
  let caught = null;
  try {
    serverFromDiscovery(log, rows, {});
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, NO_LOCAL_CREDENTIALS_MESSAGE);
  assert.equal(caught.code, NO_LOCAL_CREDENTIALS_CODE);
  assert.equal(caught.pid, 31508);
  assert.equal(caught.port, 61734);
});

test('formatModelName maps M532 to Gemini 4 Neon (High) and i18n translates local SQLite notice', () => {
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M532'), 'Gemini 4 Neon (High)');
  assert.equal(formatModelName('gemini-4-neon-medium'), 'Gemini 4 Neon (Medium)');
  const en = createI18n('en');
  assert.equal(
    en.errorMessage('当前版本已切换为本地 SQLite 直读模式（云端额度暂不可用）'),
    'Local SQLite mode active (cloud quota unavailable in this host version).',
  );
});

test('MetricsStore & DesktopUsage recover live metrics via local SQLite when Antigravity 2.34 omits --csrf_token', async (t) => {
  if (!isNativeAccelAvailable()) {
    t.skip('native pulse-accel addon unavailable');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'ag-pulse-local-sqlite-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const agDir = join(root, '.gemini', 'antigravity');
  const convDir = join(agDir, 'conversations');
  const dataDir = join(root, 'data');
  await mkdir(convDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  createConversationDb(join(convDir, `${CID_ROOT}.db`), { running: true, outputTokens: 200, modelEnum: 1532 });
  createConversationDb(join(convDir, `${CID_SUB}.db`), {
    running: false,
    outputTokens: 120,
    modelEnum: 1669,
    parentId: CID_ROOT,
    rootId: CID_ROOT,
  });
  createSummariesDb(join(agDir, 'conversation_summaries.db'), [
    { id: CID_SUB, title: 'Subagent', mtime: 1795242000000, parentId: CID_ROOT },
    { id: CID_ROOT, title: 'Main 2.34 Task', mtime: 1795241900000, parentId: '' },
  ]);

  const client = new AntigravityClient({
    paths: () => ({ home: root, profile: join(root, 'profile'), log: join(root, 'ls.log') }),
    readLog: async () => 'Language server listening on random port at 61734 for HTTP\n',
    env: {},
    processes: async () => [
      {
        ProcessId: 4242,
        CommandLine: 'language_server.exe --standalone --override_ide_version 2.34.0 --enable_sidecars',
        Ports: [61734],
      },
    ],
  });

  const ledger = new UsageLedger(join(dataDir, 'usage-v1'));
  const store = new MetricsStore(client, {
    dataDir,
    history: new SessionHistory(join(dataDir, 'history-v1')),
    timelineStore: null,
    transcripts: null,
    resolveLocalIdentity: async () => ACCOUNT,
  });
  const usage = new DesktopUsage(store, ledger, {
    host: 'app',
    conversationsDir: convDir,
    discoverLocal: async () => ({
      conversations: [
        { id: CID_ROOT, signature: 'sig-root', readSignature: async () => 'sig-root', dbPath: join(convDir, `${CID_ROOT}.db`) },
      ],
      errors: 0,
    }),
  });
  store.onTrajectory = (scope, id, raw) => usage.ingest(scope, id, raw);

  const snap = await store.snapshot();
  assert.equal(snap.connection, 'live');
  assert.equal(snap.source, 'Antigravity local SQLite');
  assert.equal(snap.groups.length, 0);
  assert.equal(snap.error, '当前版本已切换为本地 SQLite 直读模式（云端额度暂不可用）');
  assert.equal(snap.sessionError, null);
  assert.equal(snap.speed?.conversationId, CID_ROOT, 'skips newer subagent and selects root conversation');
  assert.equal(snap.speed?.status, 'CASCADE_RUN_STATUS_RUNNING');
  assert.equal(snap.speed?.activeModel, 'Gemini 4 Neon (High)');
  assert.equal(snap.speed?.tps, 50);
  assert.equal(snap.speed?.context?.usedTokens, 50000);
  assert.equal(snap.speed?.context?.maxTokens, 512000);
  assert.equal(store.identity, ACCOUNT);

  // Verify DesktopUsage sync works in local SQLite mode without RPC.
  await usage.sync(true);
  const summary = await usage.snapshot();
  assert.ok(summary);
  assert.ok((summary.totalTokens || 0) >= 5200);
  assert.ok((summary.requests || 0) >= 1);

  // Verify explicit conversationId also works directly without summaries DB.
  const explicitSnap = await store.snapshot({ conversationId: CID_SUB, force: true });
  assert.equal(explicitSnap.connection, 'live');
  assert.equal(explicitSnap.speed?.conversationId, CID_SUB);
  assert.equal(explicitSnap.speed?.status, 'CASCADE_RUN_STATUS_IDLE');

  usage.dispose();
  store.dispose();
});

test('MetricsStore stays offline on ordinary non-credential discovery errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ag-pulse-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const client = new AntigravityClient({
    paths: () => ({ home: root, profile: join(root, 'profile'), log: join(root, 'ls.log') }),
    readLog: async () => '',
    processes: async () => [],
  });
  const store = new MetricsStore(client, {
    dataDir: join(root, 'data'),
    history: new SessionHistory(join(root, 'data', 'history-v1')),
    timelineStore: null,
    transcripts: null,
  });

  const snap = await store.snapshot();
  assert.equal(snap.connection, 'offline');
  assert.equal(snap.error, '请先打开 Antigravity');
  assert.equal(snap.speed, null);
  store.dispose();
});

test('Local recording account switcher, email sha256 alignment, and conversation ownership reassignment work atomically', async (t) => {
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'ag-pulse-multi-acc-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const ledger = new UsageLedger(join(dataDir, 'usage-v1'));
  const store = new MetricsStore(undefined, {
    dataDir,
    history: new SessionHistory(join(dataDir, 'history-v1')),
    timelineStore: null,
    transcripts: null,
  });
  const usage = new DesktopUsage(store, ledger, { host: 'app' });

  const emailA = 'primary-user@example.com';
  const emailB = 'secondary-user@example.com';
  const scopeA = createHash('sha256').update(emailA).digest('hex');
  const scopeB = createHash('sha256').update(emailB).digest('hex');

  await ledger.registerAccount(scopeA, { email: emailA, name: 'Primary', primary: true });
  store.setLocalIdentity(scopeA);

  // Add Account B via email and verify exact sha256(email) alignment + active switch.
  const added = await usage.addLocalAccount({ identifier: emailB, activate: true });
  assert.equal(added.account.id, scopeB, 'email hash aligns 100% with GetUserStatus sha256(email)');
  assert.equal(added.selected, scopeB);
  assert.equal(store.identity, scopeB);
  assert.equal(await ledger.getActiveLocalAccount(), scopeB);

  // Ingest main conversation + subagent initially into Account A (simulating a mis-recorded session before switching).
  const reqRootId = createHash('sha256').update('req-root-1').digest('hex');
  const reqSubId = createHash('sha256').update('req-sub-1').digest('hex');
  await ledger.ingestRows(scopeA, CID_ROOT, [
    { id: reqRootId, at: 1795241000000, model: 'Gemini 4 Neon (High)', uncached: 1000, cacheRead: 2000, cacheWrite: 0, output: 300, partial: false, timeBasis: 'request-start' },
  ]);
  await ledger.registerOwnership(CID_ROOT, scopeA);
  await ledger.ingestRows(scopeA, CID_SUB, [
    { id: reqSubId, at: 1795241005000, model: 'Gemini 3.8 Flash (High)', uncached: 500, cacheRead: 1000, cacheWrite: 0, output: 200, partial: false, timeBasis: 'request-start' },
  ]);
  await ledger.registerOwnership(CID_SUB, scopeA);

  const beforeA = await ledger.summary(scopeA);
  const beforeB = await ledger.summary(scopeB);
  assert.equal(beforeA?.totalTokens, 5000);
  assert.equal(beforeB?.totalTokens, 0);

  // Reassign CID_ROOT + CID_SUB from Account A to Account B.
  const moved = await usage.reassignConversation({
    conversationIds: [CID_ROOT, CID_SUB],
    targetScope: scopeB,
  });
  assert.equal(moved.success, true);
  assert.equal(moved.reassigned, 2);

  const ownership = await ledger.ownership();
  assert.equal(ownership[CID_ROOT], scopeB);
  assert.equal(ownership[CID_SUB], scopeB);

  const afterA = await ledger.summary(scopeA);
  const afterB = await ledger.summary(scopeB);
  assert.equal(afterA?.totalTokens, 0, 'records removed from Account A');
  assert.equal(afterB?.totalTokens, 5000, 'records migrated to Account B');

  // Switch back to Auto mode (null).
  const autoState = await usage.setRecordingAccount('auto');
  assert.equal(autoState.selected, null);
  assert.equal(await ledger.getActiveLocalAccount(), null);

  usage.dispose();
  store.dispose();
});

test('2.34+ env credential discovery supports loopback formats, log match, missing/lagging log, and rejects non-loopback or mismatched ports', async () => {
  const log = 'Language server listening on random port at 61734 for HTTP\n';
  const rows = [
    {
      ProcessId: 31508,
      CommandLine: 'language_server.exe --standalone --override_ide_version 2.34.0 --enable_sidecars',
      Ports: [61734],
    },
  ];
  const token = 'env-csrf-secret-token';

  for (const addr of [
    '127.0.0.1:61734',
    'localhost:61734',
    '[::1]:61734',
    'http://127.0.0.1:61734',
    'http://localhost:61734',
    'http://[::1]:61734',
  ]) {
    assert.deepEqual(
      serverFromDiscovery(log, rows, { ANTIGRAVITY_LS_ADDRESS: addr, ANTIGRAVITY_CSRF_TOKEN: token }),
      { port: 61734, csrf: token, pid: 31508 },
      `accepts loopback address ${addr}`,
    );
  }

  // Missing/empty or lagging log still matches a unique standalone PID owning envPort.
  assert.deepEqual(
    serverFromDiscovery('', rows, { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:61734', ANTIGRAVITY_CSRF_TOKEN: token }),
    { port: 61734, csrf: token, pid: 31508 },
  );
  assert.deepEqual(
    serverFromDiscovery('listening on random port at 59999 for HTTP\n', rows, {
      ANTIGRAVITY_LS_ADDRESS: 'localhost:61734',
      ANTIGRAVITY_CSRF_TOKEN: token,
    }),
    { port: 61734, csrf: token, pid: 31508 },
  );

  // Missing log file (ENOENT) in AntigravityClient.discover() also succeeds when unique standalone PID owns envPort.
  const noLogClient = new AntigravityClient({
    paths: () => ({ logCandidates: ['missing-a.log', 'missing-b.log'] }),
    readLog: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    env: { ANTIGRAVITY_LS_ADDRESS: 'http://127.0.0.1:61734', ANTIGRAVITY_CSRF_TOKEN: token },
    processes: async () => rows,
  });
  assert.deepEqual(await noLogClient.discover(), { port: 61734, csrf: token, pid: 31508 });

  // Cross-instance / port mismatch falls back to NO_LOCAL_CREDENTIALS when log matched another live LS port.
  assert.throws(
    () =>
      serverFromDiscovery(log, rows, {
        ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:60000',
        ANTIGRAVITY_CSRF_TOKEN: token,
      }),
    (err) => err?.code === NO_LOCAL_CREDENTIALS_CODE && err?.pid === 31508 && err?.port === 61734,
  );

  // Ambiguous or dead-PID envPort without log match is rejected.
  assert.throws(
    () =>
      serverFromDiscovery('', [rows[0], { ...rows[0], ProcessId: 31509 }], {
        ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:61734',
        ANTIGRAVITY_CSRF_TOKEN: token,
      }),
    /接口启动/,
  );
  assert.throws(
    () =>
      serverFromDiscovery('', rows, {
        ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:60000',
        ANTIGRAVITY_CSRF_TOKEN: token,
      }),
    /接口启动/,
  );

  // Non-loopback or malformed ANTIGRAVITY_LS_ADDRESS values are strictly rejected.
  for (const badAddr of [
    '192.168.1.50:61734',
    '0.0.0.0:61734',
    'http://evil.example:61734',
    'https://127.0.0.1:61734',
    'http://127.0.0.1:61734@evil.example',
    '127.0.0.1:0',
    '127.0.0.1:65536',
    '127.0.0.1',
    'http://127.0.0.1:61734/extra',
  ]) {
    assert.throws(
      () => serverFromDiscovery(log, rows, { ANTIGRAVITY_LS_ADDRESS: badAddr, ANTIGRAVITY_CSRF_TOKEN: token }),
      (err) => err?.code === NO_LOCAL_CREDENTIALS_CODE && !String(err?.message || '').includes(token),
      `rejects unsafe address ${badAddr}`,
    );
  }
});

test('401/403 env credential failure gracefully falls back to local SQLite mode without staying offline', async (t) => {
  if (!isNativeAccelAvailable()) {
    t.skip('native pulse-accel addon unavailable');
    return;
  }
  const { createServer } = await import('node:http');
  for (const statusCode of [401, 403]) {
    const root = await mkdtemp(join(tmpdir(), `ag-pulse-env-auth-${statusCode}-`));
    t.after(() => rm(root, { recursive: true, force: true }));

    const agDir = join(root, '.gemini', 'antigravity');
    const convDir = join(agDir, 'conversations');
    const dataDir = join(root, 'data');
    await mkdir(convDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });

    createConversationDb(join(convDir, `${CID_ROOT}.db`), { running: true, outputTokens: 200, modelEnum: 1532 });
    createSummariesDb(join(agDir, 'conversation_summaries.db'), [
      { id: CID_ROOT, title: 'Auth Fallback Task', mtime: 1795241900000, parentId: '' },
    ]);

    let rpcHits = 0;
    const server = createServer((req, res) => {
      rpcHits++;
      req.resume();
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;

    let now = 10000;
    const secretToken = `rotated-secret-${statusCode}`;
    const client = new AntigravityClient({
      now: () => now,
      paths: () => ({ home: root, profile: join(root, 'profile'), log: join(root, 'ls.log') }),
      readLog: async () => `Language server listening on random port at ${port} for HTTP\n`,
      env: { ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`, ANTIGRAVITY_CSRF_TOKEN: secretToken },
      processes: async () => [
        {
          ProcessId: 5252,
          CommandLine: 'language_server.exe --standalone --override_ide_version 2.34.0 --enable_sidecars',
          Ports: [port],
        },
      ],
    });
    const store = new MetricsStore(client, {
      dataDir,
      history: new SessionHistory(join(dataDir, 'history-v1')),
      timelineStore: null,
      transcripts: null,
      resolveLocalIdentity: async () => ACCOUNT,
    });

    const snap1 = await store.snapshot();
    assert.equal(snap1.connection, 'live');
    assert.equal(snap1.source, 'Antigravity local SQLite');
    assert.equal(snap1.error, '当前版本已切换为本地 SQLite 直读模式（云端额度暂不可用）');
    assert.equal(snap1.groups.length, 0);
    assert.equal(snap1.speed?.conversationId, CID_ROOT);
    assert.equal(snap1.speed?.tps, 50);
    assert.equal(store.identity, ACCOUNT);
    assert.equal(JSON.stringify(snap1).includes(secretToken), false);

    // Subsequent polls (including after cooldown expiry) stay in local SQLite mode without looping 401/403s.
    const hitsAfterFirst = rpcHits;
    now += 5000;
    const snap2 = await store.snapshot({ force: true });
    assert.equal(snap2.connection, 'live');
    assert.equal(snap2.source, 'Antigravity local SQLite');
    assert.equal(snap2.speed?.conversationId, CID_ROOT);
    assert.equal(rpcHits, hitsAfterFirst, 'rejected env token is not retried against the same pid/port');

    store.dispose();
  }
});

test('MetricsStore.snapshot() restores email sha256 identity, cloud quota, and settled SQLite fast path via 2.34+ env credentials', async (t) => {
  if (!isNativeAccelAvailable()) {
    t.skip('native pulse-accel addon unavailable');
    return;
  }
  const { createHash } = await import('node:crypto');
  const { createServer } = await import('node:http');
  const root = await mkdtemp(join(tmpdir(), 'ag-pulse-env-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const agDir = join(root, '.gemini', 'antigravity');
  const convDir = join(agDir, 'conversations');
  const dataDir = join(root, 'data');
  await mkdir(convDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  createConversationDb(join(convDir, `${CID_ROOT}.db`), { running: false, outputTokens: 200, modelEnum: 1532 });

  const email = 'hub234-user@example.com';
  const expectedScope = createHash('sha256').update(email).digest('hex');
  const expectedToken = 'env-live-csrf-token-234';
  const seenMethods = [];
  const server = createServer((req, res) => {
    req.resume();
    if (req.headers['x-codeium-csrf-token'] !== expectedToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const method = (req.url || '').split('/').pop();
    seenMethods.push(method);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (method === 'GetUserStatus') {
      res.end(JSON.stringify({ userStatus: { email, name: 'Hub 2.34 User' } }));
      return;
    }
    if (method === 'RetrieveUserQuotaSummary') {
      res.end(
        JSON.stringify({
          groups: [
            {
              displayName: 'Gemini Pro',
              buckets: [
                {
                  bucketId: 'gemini-5h',
                  window: '5h',
                  remainingFraction: 0.85,
                  resetTime: '2026-11-22T00:00:00Z',
                },
              ],
            },
          ],
        }),
      );
      return;
    }
    if (method === 'GetAllCascadeTrajectories') {
      res.end(
        JSON.stringify({
          trajectorySummaries: {
            [CID_ROOT]: {
              summary: 'Settled 2.34 Session',
              lastModifiedTime: '2026-11-21T09:00:00Z',
              status: 'CASCADE_RUN_STATUS_IDLE',
              stepCount: 2,
              lastUserInputStepIndex: 0,
            },
          },
        }),
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;

  const client = new AntigravityClient({
    paths: () => ({ home: root, profile: join(root, 'profile'), log: join(root, 'ls.log') }),
    readLog: async () => `Language server listening on random port at ${port} for HTTP\n`,
    env: { ANTIGRAVITY_LS_ADDRESS: `localhost:${port}`, ANTIGRAVITY_CSRF_TOKEN: expectedToken },
    processes: async () => [
      {
        ProcessId: 6161,
        CommandLine: 'language_server.exe --standalone --override_ide_version 2.34.0 --enable_sidecars',
        Ports: [port],
      },
    ],
  });
  const registered = [];
  const store = new MetricsStore(client, {
    dataDir,
    history: new SessionHistory(join(dataDir, 'history-v1')),
    timelineStore: null,
    transcripts: null,
    onAccount: (scope, meta) => {
      registered.push({ scope, meta });
    },
  });

  const snap = await store.snapshot();
  assert.equal(snap.connection, 'live');
  assert.equal(snap.source, 'Antigravity local API');
  assert.equal(snap.error, null);
  assert.equal(snap.sessionError, null);
  assert.equal(store.identity, expectedScope);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].scope, expectedScope);
  assert.equal(registered[0].meta.email, email);
  assert.ok(Array.isArray(snap.groups) && snap.groups.length === 1, 'cloud quota groups restored');
  assert.equal(snap.groups[0].name, 'Gemini Pro');
  assert.equal(snap.groups[0].windows['5h'].remaining, 0.85);
  assert.equal(snap.speed?.conversationId, CID_ROOT);
  assert.equal(snap.speed?.activeModel, 'Gemini 4 Neon (High)');
  assert.equal(snap.speed?.tps, 50);
  assert.equal(
    seenMethods.includes('GetCascadeTrajectorySteps'),
    false,
    'settled conversation uses native SQLite direct-read fast path instead of step pagination RPC',
  );

  store.dispose();
});

test('Swarm workers resolve real role names from agent_name, worker subagentSpec, and merged metadata without placeholder regression', async (t) => {
  if (!isNativeAccelAvailable()) {
    t.skip('native pulse-accel addon unavailable');
    return;
  }
  const { DelegatedUsage } = await import('../delegated-usage.mjs');
  const { trajectoryMetrics } = await import('../metrics.mjs');
  const root = await mkdtemp(join(tmpdir(), 'ag-pulse-swarm-names-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const agDir = join(root, '.gemini', 'antigravity');
  const convDir = join(agDir, 'conversations');
  const dataDir = join(root, 'data');
  await mkdir(convDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const CID_WORKER_SPEC = '33333333-4444-5555-6666-777777777777';
  const CID_WORKER_AGENT_ONLY = '44444444-5555-6666-7777-888888888888';

  createConversationDb(join(convDir, `${CID_ROOT}.db`), { running: false, outputTokens: 200, modelEnum: 1532 });
  createConversationDb(join(convDir, `${CID_WORKER_SPEC}.db`), {
    running: false,
    outputTokens: 120,
    modelEnum: 1669,
    parentId: CID_ROOT,
    rootId: CID_ROOT,
    subagentSpec: { typeName: 'worker', role: 'Swarm Worker (rpc-author)' },
    nestingDepth: 1,
  });
  createConversationDb(join(convDir, `${CID_WORKER_AGENT_ONLY}.db`), {
    running: false,
    outputTokens: 90,
    modelEnum: 1669,
    parentId: CID_ROOT,
    rootId: CID_ROOT,
  });
  createSummariesDb(join(agDir, 'conversation_summaries.db'), [
    { id: CID_ROOT, title: 'Swarm Coordinator', mtime: 1795241900000, parentId: '' },
    { id: CID_WORKER_SPEC, title: '', mtime: 1795242000000, parentId: CID_ROOT, agentName: 'rpc-author' },
    { id: CID_WORKER_AGENT_ONLY, title: '', mtime: 1795242001000, parentId: CID_ROOT, agentName: 'verifier' },
  ]);

  // Pre-seed stale history-v1 with placeholder role '未命名会话' to verify self-healing.
  const history = new SessionHistory(join(dataDir, 'history-v1'));
  const baseRoot = trajectoryMetrics({
    status: 'CASCADE_RUN_STATUS_IDLE',
    trajectory: {
      steps: [{ type: 'CORTEX_STEP_TYPE_USER_INPUT', metadata: { createdAt: '2026-11-21T09:00:00Z' } }],
      generatorMetadata: [{ chatModel: { model: 'MODEL_PLACEHOLDER_M532', usage: { inputTokens: 1000, outputTokens: 200 } } }],
    },
  });
  await history.save(ACCOUNT, CID_ROOT, {
    ...baseRoot,
    conversationId: CID_ROOT,
    delegatedConversations: [CID_WORKER_SPEC, CID_WORKER_AGENT_ONLY],
    taskUsage: {
      tokens: {
        inputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0, uncachedTokens: 1000, outputTokens: 200, totalTokens: 1200,
        measuredRequests: 1, inputRequests: 1, outputRequests: 1, missingInputRequests: 0, missingOutputRequests: 0,
        uncachedRequests: 1, cachedRequests: 1, cacheWriteRequests: 1, outputAvailable: true, complete: true,
      },
      cache: {
        inputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0, uncachedTokens: 1000, outputTokens: 200, totalTokens: 1200,
        measuredRequests: 1, missingRequests: 0, hitRate: 0, complete: true,
      },
      ownTokens: 1200,
      subagentTokens: 0,
      subagents: 2,
      loadedSubagents: 2,
      state: 'ready',
      complete: true,
      items: [
        { id: CID_WORKER_SPEC, role: '未命名会话', parentId: CID_ROOT, depth: 1, model: null, tps: null, latestTps: null, latestRateStatus: 'missing', totalTokens: null, context: null, status: 'CASCADE_RUN_STATUS_IDLE', steps: 2 },
        { id: CID_WORKER_AGENT_ONLY, role: '未命名会话', parentId: CID_ROOT, depth: 1, model: null, tps: null, latestTps: null, latestRateStatus: 'missing', totalTokens: null, context: null, status: 'CASCADE_RUN_STATUS_IDLE', steps: 2 },
      ],
    },
  });

  const client = new AntigravityClient({
    paths: () => ({ home: root, profile: join(root, 'profile'), log: join(root, 'ls.log') }),
    readLog: async () => 'Language server listening on random port at 61734 for HTTP\n',
    env: {},
    processes: async () => [
      {
        ProcessId: 4242,
        CommandLine: 'language_server.exe --standalone --override_ide_version 2.34.0 --enable_sidecars',
        Ports: [61734],
      },
    ],
  });
  const store = new MetricsStore(client, {
    dataDir,
    history,
    timelineStore: null,
    transcripts: null,
    resolveLocalIdentity: async () => ACCOUNT,
  });

  const snap = await store.snapshot();
  assert.equal(snap.connection, 'live');
  assert.equal(snap.source, 'Antigravity local SQLite');
  assert.equal(snap.speed?.conversationId, CID_ROOT);

  // Wait for DelegatedUsage background worker collection to settle.
  await store.delegated.idle();
  const snapAfter = await store.snapshot({ conversationId: CID_ROOT, force: true });
  const items = snapAfter.speed?.taskUsage?.items || [];
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));

  assert.equal(byId[CID_WORKER_SPEC]?.role, 'Swarm Worker (rpc-author)');
  assert.equal(byId[CID_WORKER_AGENT_ONLY]?.role, 'verifier');
  assert.equal(items.some((item) => item.role === '未命名会话'), false);

  // Also verify buildTimelineChildren & merged metadata when summary only has partial { parentConversationId }.
  const { buildTimelineChildren } = await import('../delegated-usage.mjs');
  const collector = new DelegatedUsage({
    reader: {
      summaries: {
        [CID_WORKER_SPEC]: {
          lastModifiedTime: '2026-11-21T09:00:00Z',
          status: 'CASCADE_RUN_STATUS_IDLE',
          trajectoryMetadata: { parentConversationId: CID_ROOT },
        },
      },
    },
    trajectory: async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      trajectoryMetadata: {
        parentConversationId: CID_ROOT,
        subagentSpec: { typeName: 'worker', role: 'Swarm Worker (rpc-author)' },
        nestingDepth: 1,
      },
      trajectory: {
        steps: [],
        generatorMetadata: [{ chatModel: { model: 'MODEL_PLACEHOLDER_M532', usage: { inputTokens: 100, outputTokens: 20 } } }],
      },
    }),
  });
  const partialTaskUsage = collector.request(ACCOUNT, CID_ROOT, {
    trajectory: { steps: [], generatorMetadata: [] },
  }, { knownIds: [CID_WORKER_SPEC] });
  assert.ok(partialTaskUsage);
  await collector.idle();
  const taskState = collector.tasks.get(CID_ROOT);
  assert.equal(taskState.details.get(CID_WORKER_SPEC)?.role, 'Swarm Worker (rpc-author)');
  if (typeof buildTimelineChildren === 'function') {
    const tlChildren = buildTimelineChildren(taskState, {});
    assert.equal(tlChildren[0]?.role, 'Swarm Worker (rpc-author)');
  }
  collector.dispose();
  store.dispose();
});
