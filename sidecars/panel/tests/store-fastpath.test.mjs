import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SessionHistory } from '../history.mjs';
import { MetricsStore, samePlainValue, sameTranscriptStats, sameTaskUsage } from '../store.mjs';

const convId = '11111111-1111-4111-8111-111111111111';
const childA = '22222222-2222-4222-8222-222222222222';
const childB = '33333333-3333-4333-8333-333333333333';
const scope = createHash('sha256').update('fastpath@example.test').digest('hex');

function makeRaw(id = convId) {
  return {
    trajectory: {
      cascadeId: id,
      steps: [
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', metadata: { createdAt: '2026-11-16T00:00:00Z' } },
        { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: { createdAt: '2026-11-16T00:00:01Z' }, plannerResponse: { response: 'ok' } },
      ],
      generatorMetadata: [
        {
          stepIndices: [1],
          chatModel: {
            model: 'MODEL_PLACEHOLDER_M669',
            modelDisplayName: 'Gemini Flash',
            streamingDuration: '2s',
            usage: {
              responseId: 'r-1',
              apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
              inputTokens: '1000',
              outputTokens: '100',
              responseOutputTokens: '100',
            },
          },
        },
      ],
    },
  };
}

function makeTranscriptStats(overrides = {}) {
  const userTokens = overrides.userTokens ?? 120;
  const assistantTokens = overrides.assistantTokens ?? 380;
  const toolTokens = overrides.toolTokens ?? 40;
  const systemTokens = overrides.systemTokens ?? 10;
  return {
    version: 1,
    status: 'partial',
    reason: 'reading',
    source: 'local-recorded-text',
    estimated: true,
    complete: false,
    userTokens,
    assistantTokens,
    toolTokens,
    systemTokens,
    matchedSteps: 2,
    compactionMarkers: 0,
    imageSteps: 0,
    totalTokens: userTokens + assistantTokens + toolTokens + systemTokens,
    ...overrides,
  };
}

function makeTaskUsage(overrides = {}) {
  const ownTokens = overrides.ownTokens ?? 1100;
  const subagentTokens = overrides.subagentTokens ?? 1200;
  const totalTokens = ownTokens + subagentTokens;
  const tokens = {
    inputTokens: 1900,
    cachedTokens: 700,
    cacheWriteTokens: 0,
    uncachedTokens: 1200,
    outputTokens: 400,
    totalTokens,
    measuredRequests: 2,
    inputRequests: 2,
    outputRequests: 2,
    missingInputRequests: 0,
    missingOutputRequests: 0,
    uncachedRequests: 2,
    cachedRequests: 2,
    cacheWriteRequests: 2,
    outputAvailable: true,
    complete: true,
    ...(overrides.tokens || {}),
  };
  const cache = {
    inputTokens: 1900,
    cachedTokens: 700,
    cacheWriteTokens: 0,
    uncachedTokens: 1200,
    outputTokens: 400,
    totalTokens,
    measuredRequests: 2,
    missingRequests: 0,
    hitRate: 700 / 1900,
    complete: true,
    ...(overrides.cache || {}),
  };
  const items = overrides.items ?? [
    {
      id: childA,
      role: 'worker',
      parentId: convId,
      depth: 1,
      model: 'Gemini Flash',
      tps: 50,
      latestTps: 50,
      latestRateStatus: 'ok',
      totalTokens: subagentTokens,
      context: { usedTokens: 12000, maxTokens: 256000, usedFraction: 12000 / 256000 },
      status: 'CASCADE_RUN_STATUS_IDLE',
      steps: 4,
    },
  ];
  const modelUsage = overrides.modelUsage ?? {
    planModel: 'Orchestrator (Argon)',
    activeModel: 'Gemini Flash',
    totalTokens,
    outputTokens: 400,
    totalRequests: 2,
    models: [
      {
        id: 'gemini-flash',
        name: 'Gemini Flash',
        role: 'worker',
        requests: 2,
        inputTokens: 1900,
        uncachedTokens: 1200,
        cachedTokens: 700,
        cacheWriteTokens: 0,
        outputTokens: 400,
        thinkingTokens: 50,
        totalTokens,
      },
    ],
  };
  const base = {
    tokens,
    cache,
    ownTokens,
    subagentTokens,
    subagents: 1,
    loadedSubagents: 1,
    state: 'ready',
    complete: true,
    items,
    modelUsage,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (!['tokens', 'cache', 'items', 'modelUsage'].includes(k)) base[k] = v;
  }
  return base;
}

function reorderObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reorderObjectKeys);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).reverse()) {
    out[key] = reorderObjectKeys(value[key]);
  }
  return out;
}

function makeHarness(dir, raw, { transcriptFn, delegatedFn, modelTimelineEnabled = false } = {}) {
  const history = new SessionHistory(dir);
  let saveCalls = 0;
  const origSave = history.save.bind(history);
  history.save = async (...args) => {
    saveCalls++;
    return origSave(...args);
  };
  const readerEntries = new Map([[convId, { data: raw, rev: 1 }]]);
  const client = {
    discover: async () => ({ pid: 100 }),
    call: async method => {
      if (method === 'GetUserStatus') return { userStatus: { email: 'fastpath@example.test' } };
      if (method === 'RetrieveUserQuotaSummary') return { response: { groups: [] } };
      return { trajectorySummaries: {} };
    },
    trajectory: async () => raw,
    reader: { entries: readerEntries, summaries: {} },
    setModelTimelineEnabled() {},
    resetTrajectories() {},
  };
  const transcripts = {
    request: (s, id, r) => transcriptFn(s, id, r),
    reset() {},
    dispose() {},
  };
  const taskChildren = new Set([childA]);
  const delegated = {
    tasks: new Map([[convId, { children: taskChildren }]]),
    request: (s, id, r, opts) => delegatedFn(s, id, r, opts),
    getTimelineChildren: () => [],
    setModelTimelineEnabled() {},
    reset() {},
    dispose() {},
  };
  const timelineSaves = [];
  const timelineStore = {
    load: async () => null,
    save: async (_s, _id, tl) => { timelineSaves.push(tl); return tl; },
    clear: async () => ({ cleared: true }),
    clearAll: async () => ({ cleared: true }),
  };
  const store = new MetricsStore(client, {
    history,
    timelineStore,
    modelTimelineEnabled,
    transcripts,
    delegated,
    owns: () => true,
  });
  return {
    store,
    history,
    readerEntries,
    taskChildren,
    get saveCalls() { return saveCalls; },
    get timelineSaves() { return timelineSaves; },
  };
}

test('samePlainValue, sameTranscriptStats, and sameTaskUsage handle clones, key order, and subtle differences', () => {
  assert.equal(samePlainValue({ a: 1, b: [2, { c: 3 }] }, { b: [2, { c: 3 }], a: 1 }), true);
  assert.equal(samePlainValue({ a: 1, extra: undefined }, { a: 1 }), true);
  assert.equal(samePlainValue({ a: 1, extra: null }, { a: 1 }), false);
  assert.equal(samePlainValue([1, 2], { 0: 1, 1: 2, length: 2 }), false);
  assert.equal(samePlainValue(NaN, NaN), true);

  const t1 = makeTranscriptStats({ steps: [{ index: 0, tokens: 10 }] });
  const t2 = reorderObjectKeys(structuredClone(t1));
  assert.equal(sameTranscriptStats(t1, t2), true);
  assert.equal(sameTranscriptStats(null, undefined), true);
  assert.equal(sameTranscriptStats(t1, null), false);

  assert.equal(sameTranscriptStats(t1, { ...t1, userTokens: t1.userTokens + 1, assistantTokens: t1.assistantTokens - 1 }), false);
  assert.equal(sameTranscriptStats(t1, { ...t1, status: 'ready', complete: true, reason: null }), false);
  assert.equal(sameTranscriptStats(t1, { ...t1, truncated: true }), false);
  assert.equal(sameTranscriptStats(t1, { ...t1, error: 'io-error' }), false);
  assert.equal(sameTranscriptStats(t1, { ...t1, steps: [{ index: 0, tokens: 11 }] }), false);

  const u1 = makeTaskUsage();
  const u2 = reorderObjectKeys(structuredClone(u1));
  assert.equal(sameTaskUsage(u1, u2), true);
  assert.equal(sameTaskUsage(null, undefined), true);
  assert.equal(sameTaskUsage(u1, null), false);

  assert.equal(sameTaskUsage(u1, { ...u1, state: 'partial' }), false);
  assert.equal(sameTaskUsage(u1, { ...u1, truncated: true }), false);
  assert.equal(sameTaskUsage(u1, { ...u1, error: 'timeout' }), false);
  assert.equal(sameTaskUsage(u1, { ...u1, subagents: 2 }), false);
  assert.equal(sameTaskUsage(u1, { ...u1, loadedSubagents: 0 }), false);
  assert.equal(sameTaskUsage(u1, { ...u1, cache: { ...u1.cache, hitRate: 0.5 } }), false);
  assert.equal(sameTaskUsage(u1, { ...u1, tokens: { ...u1.tokens, cachedTokens: 701 } }), false);
  assert.equal(sameTaskUsage(u1, {
    ...u1,
    items: [{ ...u1.items[0], context: { ...u1.items[0].context, usedTokens: 12001 } }],
  }), false);
  assert.equal(sameTaskUsage(u1, {
    ...u1,
    modelUsage: {
      ...u1.modelUsage,
      models: [{ ...u1.modelUsage.models[0], thinkingTokens: 51 }],
    },
  }), false);
});

test('sameRaw fast path skips history.save, timelineStore.save, and JSON.stringify for equivalent cloned objects', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-fastpath-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const raw = makeRaw();
  const baseTranscript = makeTranscriptStats();
  const baseTask = makeTaskUsage();

  const h = makeHarness(dir, raw, {
    modelTimelineEnabled: true,
    transcriptFn: () => reorderObjectKeys(structuredClone(baseTranscript)),
    delegatedFn: () => reorderObjectKeys(structuredClone(baseTask)),
  });

  await h.store.refreshQuota(true);
  const first = await h.store.session(convId);
  assert.equal(h.saveCalls, 1);
  assert.equal(h.timelineSaves.length, 1);
  assert.equal(h.store.sessions.get(convId).rawWeak.deref(), raw);

  // Bypass the 1800ms TTL while keeping same raw reference and reader revision.
  h.store.sessions.get(convId).updatedAt = 0;

  let stringifyCalls = 0;
  const origStringify = JSON.stringify;
  JSON.stringify = function spyStringify(...args) {
    stringifyCalls++;
    return origStringify.apply(this, args);
  };
  let second;
  try {
    second = await h.store.session(convId);
  } finally {
    JSON.stringify = origStringify;
  }

  assert.equal(second, first, 'Fast path returns cached entry.data reference');
  assert.equal(stringifyCalls, 0, 'Fast path must not invoke JSON.stringify');
  assert.equal(h.saveCalls, 1, 'Fast path must not rewrite SessionHistory');
  assert.equal(h.timelineSaves.length, 1, 'Fast path must not re-save TimelineStore');
  assert.equal(h.store.sessions.get(convId).rawWeak.deref(), raw);
});

test('subtle nested changes in transcriptStats or taskUsage invalidate the fast path and persist updates', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-fastpath-diff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const raw = makeRaw();
  let currentTranscript = makeTranscriptStats();
  let currentTask = makeTaskUsage();

  const h = makeHarness(dir, raw, {
    transcriptFn: () => structuredClone(currentTranscript),
    delegatedFn: () => structuredClone(currentTask),
  });

  await h.store.refreshQuota(true);
  await h.store.session(convId);
  assert.equal(h.saveCalls, 1);

  const pollSameRaw = async () => {
    h.store.sessions.get(convId).updatedAt = 0;
    return h.store.session(convId);
  };

  // 1. Subtle transcriptStats token + status change
  currentTranscript = makeTranscriptStats({
    status: 'ready',
    reason: null,
    complete: true,
    assistantTokens: 420,
  });
  let updated = await pollSameRaw();
  assert.equal(h.saveCalls, 2);
  assert.equal(updated.transcriptStats.status, 'ready');
  assert.equal(updated.transcriptStats.totalTokens, 590);
  let loaded = await h.history.load(scope, convId);
  assert.equal(loaded.metrics.transcriptStats.assistantTokens, 420);
  assert.equal(loaded.metrics.transcriptStats.complete, true);

  // 2. Subtle taskUsage nested model breakdown change
  currentTask = makeTaskUsage({
    ownTokens: 1150,
    tokens: { outputTokens: 450, totalTokens: 2350 },
    cache: { outputTokens: 450, totalTokens: 2350 },
    modelUsage: {
      planModel: 'Orchestrator (Argon)',
      activeModel: 'Gemini Flash',
      totalTokens: 2350,
      outputTokens: 450,
      totalRequests: 2,
      models: [
        {
          id: 'gemini-flash',
          name: 'Gemini Flash',
          role: 'worker',
          requests: 2,
          inputTokens: 1900,
          uncachedTokens: 1200,
          cachedTokens: 700,
          cacheWriteTokens: 0,
          outputTokens: 450,
          thinkingTokens: 65,
          totalTokens: 2350,
        },
      ],
    },
  });
  updated = await pollSameRaw();
  assert.equal(h.saveCalls, 3);
  assert.equal(updated.taskUsage.modelUsage.models[0].thinkingTokens, 65);
  loaded = await h.history.load(scope, convId);
  assert.equal(loaded.metrics.taskUsage.modelUsage.models[0].outputTokens, 450);

  // 3. Subtle taskUsage item context + status + subagent count change
  h.taskChildren.add(childB);
  const nextItems = [
    ...currentTask.items,
    {
      id: childB,
      role: 'verifier',
      parentId: convId,
      depth: 1,
      model: 'Gemini Flash',
      tps: null,
      latestTps: null,
      latestRateStatus: 'missing',
      totalTokens: null,
      context: { usedTokens: 4096, maxTokens: 256000, usedFraction: 4096 / 256000 },
      status: 'CASCADE_RUN_STATUS_RUNNING',
      steps: 1,
    },
  ];
  currentTask = makeTaskUsage({
    ownTokens: 1150,
    subagents: 2,
    loadedSubagents: 1,
    state: 'partial',
    complete: false,
    tokens: { outputTokens: 450, totalTokens: 2350, complete: false },
    cache: { outputTokens: 450, totalTokens: 2350, complete: false },
    items: nextItems,
    modelUsage: currentTask.modelUsage,
  });
  updated = await pollSameRaw();
  assert.equal(h.saveCalls, 4);
  assert.equal(updated.taskUsage.state, 'partial');
  assert.equal(updated.taskUsage.subagents, 2);
  assert.deepEqual(updated.delegatedConversations, [childA, childB]);
  loaded = await h.history.load(scope, convId);
  assert.equal(loaded.metrics.taskUsage.items.length, 2);
  assert.equal(loaded.metrics.taskUsage.items[1].context.usedTokens, 4096);

  // 4. Subsequent poll with unchanged cloned data hits fast path again
  const prevRef = updated;
  const steady = await pollSameRaw();
  assert.equal(steady, prevRef);
  assert.equal(h.saveCalls, 4);
});
