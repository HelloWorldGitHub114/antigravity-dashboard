import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AntigravityClient } from '../client.mjs';
import { SessionHistory } from '../history.mjs';
import { MetricsStore } from '../store.mjs';
import { buildModelTimeline, countTimelineNodes, MAX_TIMELINE_BYTES, MAX_TIMELINE_NODES } from '../timeline.mjs';
import { TimelineStore } from '../timeline-store.mjs';

const mainId = '00000000-0000-4000-8000-000000000001';
const childSwarmId = '00000000-0000-4000-8000-000000000002';
const childDirectId = '00000000-0000-4000-8000-000000000003';
const scopeHash = createHash('sha256').update('orch@example.test').digest('hex');

function makeOrchestratorFixture() {
  const summaries = {
    [mainId]: {
      summary: 'SECRET TITLE SHOULD NOT ENTER TIMELINE',
      stepCount: 12,
      lastModifiedTime: '2026-11-14T07:00:00Z',
      status: 'CASCADE_RUN_STATUS_IDLE',
      lastUserInputStepIndex: 0,
      trajectoryMetadata: { rootConversationId: mainId },
    },
    [childSwarmId]: {
      summary: 'SECRET CHILD TITLE',
      stepCount: 1,
      lastModifiedTime: '2026-11-14T06:55:00Z',
      status: 'CASCADE_RUN_STATUS_IDLE',
      trajectoryMetadata: {
        parentConversationId: mainId,
        rootConversationId: mainId,
        nestingDepth: 1,
        subagentSpec: { role: 'Swarm Worker (verifier)', typeName: 'worker' },
      },
    },
    [childDirectId]: {
      summary: 'SECRET DIRECT CHILD TITLE',
      stepCount: 1,
      lastModifiedTime: '2026-11-14T06:58:00Z',
      status: 'CASCADE_RUN_STATUS_IDLE',
      trajectoryMetadata: {
        parentConversationId: mainId,
        rootConversationId: mainId,
        nestingDepth: 1,
        subagentSpec: { role: 'subagent', typeName: 'research' },
      },
    },
  };

  const mainSteps = [
    {
      type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: '2026-11-14T06:38:52.000Z' },
      userInput: { text: 'SECRET PROMPT DO NOT RETAIN', userConfig: { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M668' } } },
    },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: '2026-11-14T06:39:00.000Z', generatorModel: 'MODEL_PLACEHOLDER_M668' },
      plannerResponse: {
        response: 'SECRET ASSISTANT PLAN',
        thought: 'SECRET THINKING TEXT',
        toolCalls: [
          { name: 'read_file', status: 'DONE', argumentsJson: '{"path":"C:/secrets/a.env"}' },
          { name: 'read_file', status: 'DONE', argumentsJson: '{"path":"C:/secrets/b.env"}' },
          { name: 'read_file', status: 'DONE', argumentsJson: '{"path":"C:/secrets/c.env"}' },
        ],
      },
    },
    { type: 'CORTEX_STEP_TYPE_VIEW_FILE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { startedAt: '2026-11-14T06:39:01.000Z', completedAt: '2026-11-14T06:39:02.000Z', toolCall: { name: 'read_file', argumentsJson: '{"path":"C:/secrets/a.env"}' } } },
    { type: 'CORTEX_STEP_TYPE_VIEW_FILE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { startedAt: '2026-11-14T06:39:02.000Z', completedAt: '2026-11-14T06:39:03.000Z', toolCall: { name: 'read_file', argumentsJson: '{"path":"C:/secrets/b.env"}' } } },
    { type: 'CORTEX_STEP_TYPE_VIEW_FILE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { startedAt: '2026-11-14T06:39:03.000Z', completedAt: '2026-11-14T06:39:04.000Z', toolCall: { name: 'read_file', argumentsJson: '{"path":"C:/secrets/c.env"}' } } },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: '2026-11-14T06:40:00.000Z', generatorModel: 'MODEL_PLACEHOLDER_M668' },
      plannerResponse: { response: '', toolCalls: [{ name: 'exit_plan_mode', argumentsJson: '{"plan":"SECRET PLAN"}' }] },
    },
    {
      type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE', status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: '2026-11-14T06:40:05.000Z' },
      systemMessage: { eventType: 'plan_mode_handoff', message: 'SECRET HANDOFF MSG' },
    },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: '2026-11-14T06:40:10.000Z', generatorModel: 'MODEL_PLACEHOLDER_M669' },
      plannerResponse: {
        response: 'SECRET WORKER OUTPUT',
        toolCalls: [
          { name: 'swarm', argumentsJson: '{"brief":"SECRET SWARM BRIEF"}' },
          { name: 'run_command', argumentsJson: '{"CommandLine":"echo SECRET_CMD"}' },
        ],
      },
    },
    { type: 'CORTEX_STEP_TYPE_GENERIC', status: 'CORTEX_STEP_STATUS_DONE', metadata: { startedAt: '2026-11-14T06:40:11.000Z', completedAt: '2026-11-14T06:40:12.000Z', toolCall: { name: 'swarm' } } },
    { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', status: 'CORTEX_STEP_STATUS_DONE', metadata: { startedAt: '2026-11-14T06:40:12.000Z', completedAt: '2026-11-14T06:40:15.000Z', toolCall: { name: 'run_command', argumentsJson: '{"CommandLine":"echo SECRET_CMD"}' } } },
    { type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-14T06:41:00.000Z' }, errorMessage: { userErrorMessage: 'SECRET ERROR TRACE' } },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: '2026-11-14T06:42:00.000Z', generatorModel: 'MODEL_PLACEHOLDER_M669' },
      plannerResponse: { response: '1' },
      invokeSubagent: { conversationId: childDirectId },
    },
  ];

  const mainGens = [
    {
      stepIndices: [1, 2, 3, 4],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M668', modelDisplayName: 'Orchestrator (Argon)', responseModel: 'gemini-pro-orchestrator-g1-pro',
        timeToFirstToken: '1s', streamingDuration: '2s',
        usage: { responseId: 'm-plan-1', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', inputTokens: '1000', cacheReadTokens: '2000', outputTokens: '300', responseOutputTokens: '100', thinkingOutputTokens: '200' },
      },
    },
    {
      stepIndices: [5],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M668', modelDisplayName: 'Orchestrator (Argon)',
        timeToFirstToken: '0.5s', streamingDuration: '1s',
        usage: { responseId: 'm-plan-2', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', inputTokens: '500', cacheReadTokens: '1000', outputTokens: '100', responseOutputTokens: '50', thinkingOutputTokens: '50' },
      },
    },
    {
      stepIndices: [7, 8, 9],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M669', modelDisplayName: 'Gemini Flash', responseModel: 'gemini-flash-worker-agy',
        timeToFirstToken: '0.5s', streamingDuration: '2s',
        usage: { responseId: 'm-work-1', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', inputTokens: '800', cacheReadTokens: '1200', outputTokens: '200', responseOutputTokens: '150', thinkingOutputTokens: '50' },
      },
    },
    {
      stepIndices: [11],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M669', modelDisplayName: 'Gemini Flash',
        timeToFirstToken: '0.4s', streamingDuration: '1.6s',
        chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 5000, maxContextTokens: 1000000 } },
        usage: { responseId: 'm-work-2', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', inputTokens: '400', cacheReadTokens: '600', outputTokens: '120', responseOutputTokens: '100', thinkingOutputTokens: '20' },
      },
    },
  ];

  const trajectories = {
    [mainId]: { steps: mainSteps, generatorMetadata: mainGens },
    [childSwarmId]: {
      steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { startedAt: '2026-11-14T06:40:12.000Z', completedAt: '2026-11-14T06:41:30.000Z' }, plannerResponse: { response: '1' } }],
      generatorMetadata: [{ stepIndices: [0], chatModel: { model: 'MODEL_PLACEHOLDER_M525', modelDisplayName: 'Gemini 4 Hydrogen (High)', streamingDuration: '3s', usage: { responseId: 's-1', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', inputTokens: '3000', cacheReadTokens: '7000', outputTokens: '500', thinkingOutputTokens: '150' } } }],
    },
    [childDirectId]: {
      steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { startedAt: '2026-11-14T06:42:01.000Z', completedAt: '2026-11-14T06:42:10.000Z' }, plannerResponse: { response: '1' } }],
      generatorMetadata: [{ stepIndices: [0], chatModel: { model: 'MODEL_PLACEHOLDER_M669', modelDisplayName: 'Gemini Flash', streamingDuration: '1s', usage: { responseId: 'd-1', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', inputTokens: '200', outputTokens: '40' } } }],
    },
  };

  return { summaries, trajectories };
}

async function startFixtureServer(t, fixture) {
  const server = createServer(async (req, res) => {
    let bodyText = '';
    for await (const c of req) bodyText += c;
    let body = {};
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const method = req.url.split('/').at(-1);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (method === 'GetUserStatus') { res.end(JSON.stringify({ userStatus: { email: 'orch@example.test', name: 'Tester' } })); return; }
    if (method === 'RetrieveUserQuotaSummary') { res.end(JSON.stringify({ response: { groups: [] } })); return; }
    if (method === 'GetAllCascadeTrajectories') { res.end(JSON.stringify({ trajectorySummaries: fixture.summaries })); return; }
    if (method === 'GetCascadeTrajectorySteps') {
      const tr = fixture.trajectories[body.cascadeId];
      res.end(JSON.stringify({ steps: tr ? tr.steps.slice(body.stepOffset || 0) : [] }));
      return;
    }
    if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
      const tr = fixture.trajectories[body.cascadeId];
      res.end(JSON.stringify({ generatorMetadata: tr ? tr.generatorMetadata.slice(body.generatorMetadataOffset || 0) : [] }));
      return;
    }
    res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;
  return new AntigravityClient({
    paths: () => ({ log: 'fixture' }),
    readLog: async () => `listening on random port at ${port} for HTTP\n`,
    processes: async () => [{ ProcessId: 777, CommandLine: 'language_server --standalone --csrf_token=fixture', Ports: [port] }],
  });
}

test('default modelTimelineEnabled=false blocks extra step fields, timeline tree, and timeline-v1 files while enabling multi-model usage', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agp-orch-off-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = makeOrchestratorFixture();
  const client = await startFixtureServer(t, fixture);
  assert.equal(client.modelTimelineEnabled, false);
  const store = new MetricsStore(client, { history: new SessionHistory(join(dir, 'history-v1')), dataDir: dir });
  assert.equal(store.modelTimelineEnabled, false);

  const snapOff = await store.snapshot({ conversationId: mainId });
  await store.delegated.idle();
  const snapOffSettled = await store.snapshot({ conversationId: mainId });

  assert.equal(snapOff.speed.planModel, 'Orchestrator (Argon)');
  assert.equal(snapOff.speed.activeModel, 'Gemini Flash');
  assert.equal(snapOff.speed.modelTimeline, null);
  assert.equal(snapOffSettled.speed.modelTimeline, null);
  assert.equal(snapOffSettled.speed.modelUsage.totalRequests, 4);
  assert.equal(snapOffSettled.speed.taskUsage.modelUsage.totalRequests, 6);
  const taskRoles = Object.fromEntries(snapOffSettled.speed.taskUsage.modelUsage.models.map(m => [m.id, m.role]));
  assert.deepEqual(taskRoles, {
    'gemini-4-hydrogen-high': 'subagent',
    'orchestrator-argon': 'plan',
    'gemini-flash': 'worker',
  });

  // Zero timeline-v1 directory or files when default OFF
  await assert.rejects(stat(join(dir, 'timeline-v1')));

  // Toggle ON dynamically -> forces structural re-read, builds tree, persists timeline-v1, keeps zero secrets
  store.setModelTimelineEnabled(true);
  const snapOn = await store.snapshot({ conversationId: mainId });
  await store.delegated.idle();
  const snapOnWithChildren = await store.snapshot({ conversationId: mainId });

  const tl = snapOnWithChildren.speed.modelTimeline;
  assert.ok(tl && tl.enabled === true);
  assert.equal(tl.cascadeId, mainId);
  assert.equal(tl.planModel, 'Orchestrator (Argon)');
  assert.equal(tl.activeModel, 'Gemini Flash');
  assert.equal(tl.truncated, false);
  assert.ok(tl.savedAt);
  assert.ok(tl.swimlanes.some(l => l.kind === 'plan' && l.calls === 2));
  assert.ok(tl.swimlanes.some(l => l.kind === 'handoff'));
  assert.ok(tl.swimlanes.some(l => l.kind === 'worker' && l.calls === 2));
  assert.ok(tl.swimlanes.some(l => l.kind === 'subagent' && l.label === 'Swarm Worker (verifier)'));

  const turn1 = tl.nodes[0];
  assert.equal(turn1.kind, 'turn');
  const phasePlan = turn1.children.find(c => c.kind === 'phase' && c.role === 'plan');
  const handoff = turn1.children.find(c => c.kind === 'handoff');
  const phaseWorker = turn1.children.find(c => c.kind === 'phase' && c.role === 'worker');
  assert.ok(phasePlan && handoff && phaseWorker);
  assert.equal(handoff.meta.fromModel, 'Orchestrator (Argon)');
  assert.equal(handoff.meta.toModel, 'Gemini Flash');
  // Verify consecutive read_file calls collapsed into a single tool_group with count=3
  const readGroup = phasePlan.children[0].children.find(c => c.kind === 'tool_group');
  assert.equal(readGroup.meta.tool, 'read_file');
  assert.equal(readGroup.meta.category, 'file_read');
  assert.equal(readGroup.meta.count, 3);
  // Verify privacy: zero prompts, responses, paths, commands, error messages, or conversation titles
  const tlSerialized = JSON.stringify(tl);
  for (const secret of ['SECRET', 'secrets/a.env', 'BRIEF', 'TRACE', 'TITLE', 'argumentsJson']) {
    assert.equal(tlSerialized.includes(secret), false, `Secret leaked into timeline: ${secret}`);
  }
  const savedFiles = await readdir(join(dir, 'timeline-v1', scopeHash));
  assert.equal(savedFiles.length, 1);

  // Toggle back OFF -> returns null timeline immediately and clearTimeline removes persisted files
  store.setModelTimelineEnabled(false);
  const snapDisabledAgain = await store.snapshot({ conversationId: mainId });
  assert.equal(snapDisabledAgain.speed.modelTimeline, null);
  await store.clearTimeline(mainId);
  assert.deepEqual(await readdir(join(dir, 'timeline-v1', scopeHash)), []);
});

test('timeline compaction enforces 400-node and 192 KiB bounds with truncated flag and scope isolation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agp-tl-bounds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaultStore = new TimelineStore(join(root, 'default', 'timeline-v1'));
  const vertexStore = new TimelineStore(join(root, 'vertex', 'timeline-v1'));

  const steps = [], gens = [];
  for (let i = 0; i < 650; i++) {
    const sIdx = i * 2;
    steps.push({
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: new Date(1700000000000 + i * 1000).toISOString(), generatorModel: 'MODEL_PLACEHOLDER_M669' },
      plannerResponse: { response: '1', toolCalls: [{ name: i % 2 ? 'read_file' : 'run_command' }] },
    });
    steps.push({
      type: 'CORTEX_STEP_TYPE_VIEW_FILE',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { startedAt: new Date(1700000000200 + i * 1000).toISOString(), completedAt: new Date(1700000000400 + i * 1000).toISOString(), toolCall: { name: i % 2 ? 'read_file' : 'run_command' } },
    });
    gens.push({
      stepIndices: [sIdx, sIdx + 1],
      chatModel: { model: 'MODEL_PLACEHOLDER_M669', streamingDuration: '0.5s', usage: { responseId: `g-${i}`, apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', inputTokens: '10', outputTokens: '5' } },
    });
  }
  const huge = buildModelTimeline({ trajectory: { cascadeId: mainId, steps, generatorMetadata: gens } });
  assert.equal(huge.truncated, true);
  assert.ok(countTimelineNodes(huge.nodes) <= MAX_TIMELINE_NODES);
  assert.ok(Buffer.byteLength(JSON.stringify(huge), 'utf8') <= MAX_TIMELINE_BYTES);

  const savedDefault = await defaultStore.save(scopeHash, mainId, huge);
  const diskText = await readFile(defaultStore.file(scopeHash, mainId), 'utf8');
  assert.ok(Buffer.byteLength(diskText, 'utf8') <= MAX_TIMELINE_BYTES);
  assert.equal(savedDefault.truncated, true);
  assert.equal(await vertexStore.load(scopeHash, mainId), null);

  await vertexStore.save('vertex-local', childSwarmId, { ...huge, cascadeId: childSwarmId });
  assert.ok(await vertexStore.load('vertex-local', childSwarmId));
  await defaultStore.clearAll(scopeHash);
  assert.equal(await defaultStore.load(scopeHash, mainId), null);
  assert.ok(await vertexStore.load('vertex-local', childSwarmId));
  await vertexStore.clearAll();
  assert.equal(await vertexStore.load('vertex-local', childSwarmId), null);
});
