import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeTaskUsage } from '../task-usage.mjs';
import { DelegatedUsage } from '../delegated-usage.mjs';
import { SessionHistory } from '../history.mjs';

const require = createRequire(import.meta.url);
const createI18n = require('../../../compat/i18n.cjs');

function baseTaskUsage(items) {
  const tokens = {
    inputTokens: 1000,
    cachedTokens: 400,
    cacheWriteTokens: 0,
    uncachedTokens: 600,
    outputTokens: 200,
    totalTokens: 1200,
    measuredRequests: 1,
    inputRequests: 1,
    outputRequests: 1,
    missingInputRequests: 0,
    missingOutputRequests: 0,
    uncachedRequests: 1,
    cachedRequests: 1,
    cacheWriteRequests: 1,
    outputAvailable: true,
    complete: true
  };
  const cache = {
    inputTokens: 1000,
    cachedTokens: 400,
    cacheWriteTokens: 0,
    uncachedTokens: 600,
    outputTokens: 200,
    totalTokens: 1200,
    measuredRequests: 1,
    missingRequests: 0,
    hitRate: 0.4,
    complete: true
  };
  return {
    tokens,
    cache,
    ownTokens: 0,
    subagentTokens: 1200,
    subagents: items.length,
    loadedSubagents: items.length,
    state: 'ready',
    complete: true,
    items
  };
}

function childTrajectory({ role, inputTokens = 1000, outputTokens = 200, estimatedTokensUsed, maxContextTokens }) {
  const contextWindowMetadata = {};
  if (estimatedTokensUsed !== undefined) contextWindowMetadata.estimatedTokensUsed = estimatedTokensUsed;
  if (maxContextTokens !== undefined) contextWindowMetadata.maxContextTokens = maxContextTokens;
  return {
    status: 'CASCADE_RUN_STATUS_IDLE',
    trajectoryMetadata: {
      subagentSpec: { role }
    },
    trajectory: {
      generatorMetadata: [{
        chatModel: {
          model: 'MODEL_PLACEHOLDER_M26',
          usage: { inputTokens, outputTokens, responseOutputTokens: outputTokens },
          ...(Object.keys(contextWindowMetadata).length ? { chatStartMetadata: { contextWindowMetadata } } : {})
        }
      }],
      steps: []
    }
  };
}

test('safeTaskUsage sanitizes item.context, recomputes fraction, and keeps top-level taskUsage unchanged', () => {
  const input = baseTaskUsage([
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      role: 'panel-ui',
      status: 'CASCADE_RUN_STATUS_IDLE',
      steps: 10,
      totalTokens: 1200,
      context: { usedTokens: 82450, maxTokens: 256000, usedFraction: 0.99, rogue: 'drop-me' }
    },
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      role: 'verifier',
      status: 'CASCADE_RUN_STATUS_RUNNING',
      steps: 20,
      totalTokens: 1200,
      context: { usedTokens: 268800, maxTokens: 256000, usedFraction: 0.1 }
    },
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      role: 'monitor',
      status: 'CASCADE_RUN_STATUS_IDLE',
      steps: 5,
      totalTokens: 1200,
      context: { usedTokens: 15000, maxTokens: 0, usedFraction: 0.5 }
    },
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
      role: 'narrator',
      status: 'CASCADE_RUN_STATUS_IDLE',
      steps: 1,
      totalTokens: 1200,
      context: { usedTokens: -5, maxTokens: 'bad', usedFraction: 0.5 }
    }
  ]);

  const sanitized = safeTaskUsage(input);
  assert.ok(sanitized);
  assert.equal('context' in sanitized, false);
  assert.deepEqual(sanitized.items[0].context, {
    usedTokens: 82450,
    maxTokens: 256000,
    usedFraction: 82450 / 256000
  });
  assert.deepEqual(sanitized.items[1].context, {
    usedTokens: 268800,
    maxTokens: 256000,
    usedFraction: 268800 / 256000
  });
  assert.deepEqual(sanitized.items[2].context, {
    usedTokens: 15000,
    maxTokens: null,
    usedFraction: null
  });
  assert.equal(sanitized.items[3].context, null);
});

test('DelegatedUsage exposes compact subagent context and survives SessionHistory persistence', async () => {
  const scope = 'a'.repeat(64);
  const rootId = '11111111-1111-4111-8111-111111111111';
  const child1 = '22222222-2222-4222-8222-222222222222';
  const child2 = '33333333-3333-4333-8333-333333333333';

  const childMap = new Map([
    [child1, childTrajectory({ role: 'panel-ui', estimatedTokensUsed: 82450, maxContextTokens: 256000 })],
    [child2, childTrajectory({ role: 'monitor', estimatedTokensUsed: 12000 })]
  ]);

  const rootRaw = {
    trajectory: {
      generatorMetadata: [{ chatModel: { model: 'MODEL_PLACEHOLDER_M26', usage: { inputTokens: 100, outputTokens: 50 } } }],
      steps: [
        { type: 'CORTEX_STEP_TYPE_SUBAGENT', subagentId: child1 },
        { type: 'CORTEX_STEP_TYPE_SUBAGENT', subagentId: child2 }
      ]
    }
  };

  let resolvedTaskUsage = null;
  const collector = new DelegatedUsage(
    {
      reader: { summaries: {} },
      trajectory: async id => childMap.get(id) || null
    },
    {
      onUpdate: async (_scope, _id, taskUsage) => {
        resolvedTaskUsage = taskUsage;
      }
    }
  );

  const initial = collector.request(scope, rootId, rootRaw, { knownIds: [child1, child2] });
  assert.equal(initial.items[0].context, null);

  await collector.idle();
  collector.dispose();

  assert.ok(resolvedTaskUsage);
  const byId = Object.fromEntries(resolvedTaskUsage.items.map(item => [item.id, item]));
  assert.deepEqual(byId[child1].context, {
    usedTokens: 82450,
    maxTokens: 256000,
    usedFraction: 82450 / 256000
  });
  assert.deepEqual(byId[child2].context, {
    usedTokens: 12000,
    maxTokens: null,
    usedFraction: null
  });

  const dir = await mkdtemp(join(tmpdir(), 'pulse-subagent-ctx-'));
  try {
    const history = new SessionHistory(dir);
    await history.save(scope, rootId, {
      conversationId: rootId,
      model: 'MODEL_PLACEHOLDER_M26',
      steps: 10,
      rounds: 2,
      requests: 1,
      tokens: resolvedTaskUsage.tokens,
      cache: resolvedTaskUsage.cache,
      taskUsage: resolvedTaskUsage,
      context: null,
      complete: true
    });
    const loaded = await history.load(scope, rootId);
    assert.ok(loaded?.metrics?.taskUsage?.items);
    const loadedById = Object.fromEntries(loaded.metrics.taskUsage.items.map(item => [item.id, item]));
    assert.deepEqual(loadedById[child1].context, {
      usedTokens: 82450,
      maxTokens: 256000,
      usedFraction: 82450 / 256000
    });
    assert.deepEqual(loadedById[child2].context, {
      usedTokens: 12000,
      maxTokens: null,
      usedFraction: null
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('i18n dictionaries define subagentContext and plain-language subagentStatus labels in en and zh-CN', () => {
  const en = createI18n('en');
  const zh = createI18n('zh-CN');
  assert.equal(en.t('subagentContext'), 'Context');
  assert.equal(zh.t('subagentContext'), '上下文');
  assert.equal(en.t('subagentStatusIdle'), 'Idle (waiting or done)');
  assert.equal(zh.t('subagentStatusIdle'), '空闲 · 待命或已完成');
  assert.equal(en.t('subagentStatusRunning'), 'Running');
  assert.equal(zh.t('subagentStatusRunning'), '正在运行');
  assert.equal(en.t('subagentStatusError'), 'Error');
  assert.equal(zh.t('subagentStatusError'), '执行出错');
});
