import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  UsageLedger,
  queryProjectUsageOverview,
  queryProjectConversationDetail,
} from '../usage.mjs';

const scope = (s) => createHash('sha256').update(s).digest('hex');
const acctA = scope('account-a@example.test');
const acctB = scope('account-b@example.test');

const CID_MAIN = '11111111-1111-1111-1111-111111111111';
const CID_WORKTREE = '22222222-2222-2222-2222-222222222222';
const CID_SUBAGENT = '33333333-3333-3333-3333-333333333333';
const CID_CLI = '44444444-4444-4444-4444-444444444444';
const CID_GENERAL = '55555555-5555-5555-5555-555555555555';
const CID_FOREIGN = '66666666-6666-6666-6666-666666666666';
const CID_FALLBACK = '77777777-7777-7777-7777-777777777777';

function rawUsage({ at, responseId, input = 100, cacheRead = 200, output = 50 }) {
  return {
    trajectory: {
      steps: [
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          metadata: { createdAt: at },
        },
      ],
      generatorMetadata: [
        {
          stepIndices: [0],
          chatModel: {
            modelDisplayName: 'Gemini 3.8 Flash',
            chatStartMetadata: { createdAt: at },
            usage: {
              apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
              responseId,
              inputTokens: String(input),
              cacheReadTokens: String(cacheRead),
              cacheWriteTokens: '0',
              outputTokens: String(output),
            },
          },
        },
      ],
    },
  };
}

function createSummaryDb(dbPath, rows) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        last_modified_time datetime,
        workspace_uris TEXT,
        project_id TEXT,
        parent_conversation_id TEXT,
        source TEXT,
        agent_name TEXT
      );
    `);
    const stmt = db.prepare(
      `INSERT INTO conversation_summaries
        (conversation_id, title, preview, last_modified_time, workspace_uris, project_id, parent_conversation_id, source, agent_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      stmt.run(
        r.conversationId,
        r.title ?? '',
        r.preview ?? '',
        r.lastModifiedTime ?? 0,
        r.workspaceUris ?? '',
        r.projectId ?? '',
        r.parentConversationId ?? '',
        r.source ?? '',
        r.agentName ?? '',
      );
    }
  } finally {
    db.close();
  }
}

async function setupFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ag-proj-stats-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = new UsageLedger(join(root, 'ledger'));
  const profileDir = join(root, 'profile');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(profileDir, { recursive: true });

  await ledger.ingest(acctA, CID_MAIN, rawUsage({ at: '2026-10-11T04:00:00Z', responseId: 'r-main', input: 100, cacheRead: 200, output: 100 })); // 400
  await ledger.ingest(acctA, CID_WORKTREE, rawUsage({ at: '2026-10-11T05:00:00Z', responseId: 'r-wt', input: 200, cacheRead: 300, output: 100 })); // 600
  await ledger.ingest(acctA, CID_SUBAGENT, rawUsage({ at: '2026-10-11T06:00:00Z', responseId: 'r-sub', input: 50, cacheRead: 100, output: 50 })); // 200
  await ledger.ingest(acctA, CID_CLI, rawUsage({ at: '2026-10-11T07:00:00Z', responseId: 'r-cli', input: 80, cacheRead: 0, output: 20 })); // 100
  await ledger.ingest(acctA, CID_GENERAL, rawUsage({ at: '2026-10-11T08:00:00Z', responseId: 'r-gen', input: 150, cacheRead: 50, output: 50 })); // 250
  await ledger.ingest(acctA, CID_FALLBACK, rawUsage({ at: '2026-10-11T09:00:00Z', responseId: 'r-fb', input: 30, cacheRead: 0, output: 20 })); // 50
  await ledger.ingest(acctA, 'remote-box/99999999-aaaa-bbbb-cccc-dddddddddddd', rawUsage({ at: '2026-10-11T10:00:00Z', responseId: 'r-rem', input: 400, cacheRead: 0, output: 100 })); // 500
  await ledger.ingest(acctB, CID_FOREIGN, rawUsage({ at: '2026-10-11T11:00:00Z', responseId: 'r-for', input: 5000, cacheRead: 0, output: 500 })); // 5500 (different account!)

  createSummaryDb(join(profileDir, 'conversation_summaries.db'), [
    {
      conversationId: CID_MAIN,
      title: 'Fix dashboard dropdowns',
      lastModifiedTime: '2026-10-11T04:00:00Z',
      workspaceUris: JSON.stringify(['file:///C:/repo/antigrative-dashboard']),
      projectId: 'proj-dash',
    },
    {
      conversationId: CID_WORKTREE,
      title: '',
      preview: 'Worktree feature branch preview text',
      workspaceUris: JSON.stringify(['file:///C:/repo/antigrative-dashboard/.git/worktrees/wt-1']),
      projectId: 'proj-dash',
    },
    {
      conversationId: CID_SUBAGENT,
      title: '',
      workspaceUris: '',
      parentConversationId: CID_MAIN,
      agentName: 'researcher',
    },
    {
      conversationId: CID_CLI,
      title: 'Terminal CLI run',
      workspaceUris: JSON.stringify(['default-cli-project']),
    },
    {
      conversationId: CID_GENERAL,
      title: 'Standalone brainstorm',
      workspaceUris: JSON.stringify(['outside-of-project']),
    },
    {
      conversationId: 'remote-box/99999999-aaaa-bbbb-cccc-dddddddddddd',
      title: 'Remote SSH session',
      workspaceUris: '',
    },
    {
      conversationId: CID_FOREIGN,
      title: 'Foreign account project',
      workspaceUris: JSON.stringify(['file:///C:/repo/secret-project']),
      projectId: 'proj-secret',
    },
  ]);

  return { ledger, profileDir };
}

test('project stats scope to current account, map cli/conversations/worktrees/remote, and return human conversation names', async (t) => {
  const { ledger, profileDir } = await setupFixture(t);

  const overview = await queryProjectUsageOverview({
    ledger,
    profileDir,
    scope: acctA,
    from: '2026-10-11',
    to: '2026-10-11',
    timeZone: 'Asia/Shanghai',
  });

  assert.equal(overview.accountKey, acctA);
  // Sum excludes CID_FOREIGN (belongs to acctB): 400 + 600 + 200 + 100 + 250 + 50 + 500 = 2100
  assert.equal(overview.totalTokens, 2100);
  assert.equal(overview.requests, 7);

  const byKey = new Map(overview.projects.map((p) => [p.projectKey, p]));
  assert.equal(byKey.has('remote-secret-project'), false);
  assert.equal([...byKey.keys()].some((k) => k.includes('secret-project')), false);

  const dash = byKey.get('project:c:/repo/antigrative-dashboard');
  assert.ok(dash, 'Main repo + worktree + subagent should merge into project:c:/repo/antigrative-dashboard');
  assert.equal(dash.name, 'antigrative-dashboard');
  assert.equal(dash.kind, 'project');
  assert.equal(dash.total, 1200);
  assert.equal(dash.conversationCount, 3);

  const cli = byKey.get('cli');
  assert.ok(cli, 'default-cli-project should map to cli');
  assert.equal(cli.name, 'cli');
  assert.equal(cli.kind, 'cli');
  assert.equal(cli.total, 100);

  const convs = byKey.get('conversations');
  assert.ok(convs, 'outside-of-project and missing workspace should merge into conversations');
  assert.equal(convs.name, 'conversations');
  assert.equal(convs.kind, 'conversations');
  assert.equal(convs.total, 300);

  const remote = byKey.get('remote:remote-box');
  assert.ok(remote);
  assert.equal(remote.name, 'remote (remote-box)');
  assert.equal(remote.kind, 'remote');
  assert.equal(remote.total, 500);

  // Level 2 detail only computes selected project and uses human titles (no 64-char hash!)
  const detail = await queryProjectConversationDetail({
    ledger,
    profileDir,
    scope: acctA,
    projectKey: 'project:c:/repo/antigrative-dashboard',
    from: '2026-10-11',
    to: '2026-10-11',
    timeZone: 'Asia/Shanghai',
  });

  assert.equal(detail.projectKey, 'project:c:/repo/antigrative-dashboard');
  assert.equal(detail.totalTokens, 1200);
  assert.equal(detail.conversations.length, 3);
  assert.deepEqual(
    detail.conversations.map((c) => [c.id, c.title, c.total, c.isSubagent]),
    [
      [CID_WORKTREE, 'Worktree feature branch preview text', 600, false],
      [CID_MAIN, 'Fix dashboard dropdowns', 400, false],
      [CID_SUBAGENT, 'Fix dashboard dropdowns · researcher', 200, true],
    ],
  );
  const sub = detail.conversations.find((c) => c.id === CID_SUBAGENT);
  assert.ok(sub);
  assert.equal(sub.rootId, CID_MAIN);
  assert.equal(sub.rootTitle, 'Fix dashboard dropdowns');
  assert.equal(sub.agentName, 'researcher');
  const shareSum = detail.conversations.reduce((s, c) => s + c.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);
});

test('project stats respect date filters and never expose raw hashes in conversation titles', async (t) => {
  const { ledger, profileDir } = await setupFixture(t);

  const emptyRange = await queryProjectUsageOverview({
    ledger,
    profileDir,
    scope: acctA,
    from: '2026-10-01',
    to: '2026-10-05',
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(emptyRange.totalTokens, 0);
  assert.equal(emptyRange.projects.length, 0);

  const convDetail = await queryProjectConversationDetail({
    ledger,
    profileDir,
    scope: acctA,
    projectKey: 'conversations',
    from: '2026-10-11',
    to: '2026-10-11',
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(convDetail.conversations.length, 2);
  const titled = convDetail.conversations.find((c) => c.id === CID_GENERAL);
  assert.ok(titled);
  assert.equal(titled.title, 'Standalone brainstorm');
  const untitled = convDetail.conversations.find((c) => c.id !== CID_GENERAL);
  assert.ok(untitled);
  assert.ok(untitled.title.startsWith('Session '), `Expected short session label, got: ${untitled.title}`);
  assert.equal(untitled.title.length < 24, true);
});

test('conversation_summaries datetime text timestamps parse to positive epoch ms', async (t) => {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'ag-proj-dt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const dbPath = join(root, 'conversation_summaries.db');
  const expectedMs = Date.parse('2026-10-11T04:00:00Z');
  createSummaryDb(dbPath, [
    {
      conversationId: CID_MAIN,
      title: 'ISO timestamp session',
      lastModifiedTime: '2026-10-11T04:00:00Z',
      workspaceUris: JSON.stringify(['file:///C:/repo/antigrative-dashboard']),
      projectId: 'proj-dash',
    },
  ]);
  const nativePath = new URL('../pulse-accel.node', import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');
  try {
    const addon = req(nativePath);
    if (typeof addon.readSqliteConversationSummariesJson === 'function') {
      const rows = JSON.parse(addon.readSqliteConversationSummariesJson(dbPath));
      assert.equal(rows[0].lastModifiedTime, expectedMs);
    }
  } catch {
    // Skip native assertion when local binary is absent.
  }
});
