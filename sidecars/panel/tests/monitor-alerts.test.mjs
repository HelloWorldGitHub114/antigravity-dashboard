import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyRequestError,
  computeContextBreakdown,
  computeTurnAndAlerts,
  formatCompactElapsedMs,
  resolveCacheTtl,
  resolveContextLoad,
  resolveSpeedPulse,
  summarizeActiveWaitAlert,
  trajectoryMetrics,
} from '../metrics.mjs';
import { PreferencesStore } from '../../../compat/preferences.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('classifyRequestError categorizes errors and redacts URLs', () => {
  assert.equal(classifyRequestError('').kind, 'none');
  assert.equal(classifyRequestError('context canceled by user').kind, 'canceled');
  assert.equal(classifyRequestError('rpc error: deadline_exceeded').kind, 'request_timeout');
  assert.equal(classifyRequestError('input token count (520000) exceeds limit').kind, 'context_overflow');
  assert.equal(classifyRequestError('HTTP 401 UNAUTHENTICATED').kind, 'auth_error');
  assert.equal(classifyRequestError('503 Service Unavailable at https://api.example.com/v1/chat').kind, 'service_unavailable');
  assert.equal(
    classifyRequestError('503 Service Unavailable at https://api.example.com/v1/chat').diagnostic,
    '503 Service Unavailable at <API>',
  );
  assert.equal(classifyRequestError('read tcp ECONNRESET').kind, 'network_error');
  assert.equal(classifyRequestError('RESOURCE_EXHAUSTED: weekly quota reached').kind, 'quota_exhausted');

  const rl = classifyRequestError('HTTP 429 rate limit exceeded, retry in 18.5s');
  assert.equal(rl.kind, 'rate_limited');
  assert.equal(rl.retryAfterSec, 18.5);
});

test('resolveCacheTtl tracks active, fresh, warn, and cold stages', () => {
  const base = 1_700_000_000_000;
  assert.equal(resolveCacheTtl(base, base + 30_000, true).state, 'active');
  assert.equal(resolveCacheTtl(base, base + 90_000, false).state, 'fresh');
  assert.equal(resolveCacheTtl(base, base + 185_000, false).state, 'warn');
  assert.equal(resolveCacheTtl(base, base + 250_000, false).state, 'cold');
  assert.equal(resolveCacheTtl(base, base + 250_000, false, { cacheWarnMinutes: 0, cacheColdMinutes: 0 }).state, 'idle');
  assert.equal(formatCompactElapsedMs(192_000), '3m 12s');
});

test('resolveContextLoad applies configurable warn and danger thresholds', () => {
  assert.equal(resolveContextLoad(0.74), 'normal');
  assert.equal(resolveContextLoad(0.75), 'warn');
  assert.equal(resolveContextLoad(0.899), 'warn');
  assert.equal(resolveContextLoad(0.9), 'danger');
  assert.equal(resolveContextLoad(0.65, { contextWarnPct: 60, contextDangerPct: 80 }), 'warn');
});

test('resolveSpeedPulse blinks while generating and holds color 15s after completion', () => {
  const doneAt = 1_700_000_000_000;
  assert.deepEqual(resolveSpeedPulse(8, true, doneAt, doneAt + 1000, true), {
    visible: true,
    level: 'slow',
    blinking: true,
  });
  assert.deepEqual(resolveSpeedPulse(18, false, doneAt, doneAt + 10_000, true), {
    visible: true,
    level: 'medium',
    blinking: false,
  });
  assert.deepEqual(resolveSpeedPulse(40, false, doneAt, doneAt + 20_000, true), {
    visible: true,
    level: 'idle',
    blinking: false,
  });
  assert.equal(resolveSpeedPulse(40, true, doneAt, doneAt, false).visible, false);
});

test('computeContextBreakdown splits active compaction epoch into 4 parts without exceeding total', () => {
  const steps = [
    { i: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
    { i: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' },
    { i: 2, type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE' },
    { i: 3, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
    { i: 4, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' },
    { i: 5, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' },
  ];
  const generators = [
    // 压缩前的大轮次，不应混入压缩后的占比
    {
      stepIndices: [1],
      chatModel: {
        usage: { inputTokens: 300000, cacheReadTokens: 0, outputTokens: 50000, thinkingOutputTokens: 30000, responseOutputTokens: 20000 },
      },
    },
    // 压缩后的首轮底噪
    {
      stepIndices: [4],
      chatModel: {
        usage: { inputTokens: 20000, cacheReadTokens: 0, outputTokens: 6000, thinkingOutputTokens: 2000, responseOutputTokens: 4000 },
      },
    },
    // 压缩后的第二轮
    {
      stepIndices: [5],
      chatModel: {
        usage: { inputTokens: 10000, cacheReadTokens: 30000, outputTokens: 1000, thinkingOutputTokens: 300, responseOutputTokens: 700 },
      },
    },
  ];

  const bd = computeContextBreakdown(generators, steps, 40000, false);
  assert.deepEqual(bd, {
    baselineTokens: 20000,
    readTokens: 14000,
    thinkingTokens: 2000,
    outputTokens: 4000,
    totalTokens: 40000,
  });
  assert.equal(computeContextBreakdown(generators, steps, 20000, true), null);
});

test('computeTurnAndAlerts pauses wait timer during tools and clears resolved errors', () => {
  const t0 = Date.parse('2026-11-22T06:00:00.000Z');
  const diag = {
    userStepIndex: 10,
    latestUserStepIndex: 10,
    turnSteps: [
      { idx: 10, stepType: 14, status: 3, createdAtMs: t0, inputStartedAtMs: t0, generatingAtMs: null, recordedCompletedAtMs: t0, terminalAtMs: t0, executionId: 'e1' },
      { idx: 11, stepType: 15, status: 3, createdAtMs: t0 + 1000, inputStartedAtMs: null, generatingAtMs: t0 + 36000, recordedCompletedAtMs: t0 + 40000, terminalAtMs: t0 + 40000, executionId: 'e1' },
      // 工具正在运行，不应继续累加首字等待实时计时
      { idx: 12, stepType: 20, status: 2, createdAtMs: t0 + 40100, inputStartedAtMs: null, generatingAtMs: null, recordedCompletedAtMs: null, terminalAtMs: null, executionId: 'e1' },
    ],
    executors: [],
    recentRequests: [
      // 前序失败后已有 idx=11 正常进入流式并完成，报错应自动清除
      { idx: 5, stepIndices: [10], lastStepIndex: 10, ttftSeconds: null, retryErrorText: 'HTTP 429 rate limit' },
    ],
    lastStepEpochMs: t0 + 40100,
  };
  const steps = [
    { i: 10, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: new Date(t0).toISOString() } },
    { i: 11, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: new Date(t0 + 1000).toISOString(), completedAt: new Date(t0 + 40000).toISOString() } },
    { i: 12, type: 'CORTEX_STEP_TYPE_RUN_COMMAND', status: 'CORTEX_STEP_STATUS_RUNNING', metadata: { createdAt: new Date(t0 + 40100).toISOString() } },
  ];
  const generators = [
    {
      stepIndices: [11],
      chatModel: {
        timeToFirstToken: '35s',
        streamingDuration: '4s',
        usage: { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 800, thinkingOutputTokens: 300, responseOutputTokens: 500 },
      },
    },
  ];

  const result = computeTurnAndAlerts(steps, generators, { status: 'CASCADE_RUN_STATUS_RUNNING' }, true, diag);
  assert.equal(result.isGenerating, true);
  assert.equal(result.turnMetrics?.state, 'running');
  assert.equal(result.turnMetrics?.requests, 1);
  assert.equal(result.turnMetrics?.thinkingTokens, 300);
  assert.equal(result.turnMetrics?.outputTokens, 500);
  assert.equal(result.turnQueue?.waitingSinceMs, null);
  assert.deepEqual(result.turnQueue?.waits, [35]);
  assert.equal(result.requestError, null);

  const waitSummary = summarizeActiveWaitAlert(result.turnQueue, t0 + 100_000, 30);
  assert.equal(waitSummary.active, true);
  assert.equal(waitSummary.count, 1);
  assert.equal(waitSummary.isWaitingNow, false);
  assert.equal(waitSummary.maxWaitSec, 35);
});

test('trajectoryMetrics populates context breakdown, turn metrics, and request errors', () => {
  const t0 = '2026-11-22T06:00:00.000Z';
  const t1 = '2026-11-22T06:00:12.000Z';
  const m = trajectoryMetrics({
    status: 'CASCADE_RUN_STATUS_IDLE',
    trajectory: {
      cascadeId: '00000000-0000-0000-0000-000000000001',
      steps: [
        { i: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: t0 } },
        { i: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: t0, completedAt: t1 } },
      ],
      generatorMetadata: [
        {
          stepIndices: [1],
          chatModel: {
            modelDisplayName: 'Gemini 4 Neon (XHigh)',
            timeToFirstToken: '3s',
            streamingDuration: '9s',
            chatStartMetadata: {
              createdAt: t0,
              contextWindowMetadata: { estimatedTokensUsed: 25000, maxContextTokens: 512000 },
            },
            usage: { inputTokens: 25000, cacheReadTokens: 0, outputTokens: 900, thinkingOutputTokens: 200, responseOutputTokens: 700 },
            retryInfos: [{ error: 'request timeout exceeded' }],
          },
        },
      ],
    },
  });
  assert.equal(m.context?.breakdown?.baselineTokens, 25000);
  assert.equal(m.turnMetrics?.requests, 1);
  assert.equal(m.turnMetrics?.thinkingTokens, 200);
  assert.equal(m.turnMetrics?.outputTokens, 700);
  assert.equal(m.lastResponseAtMs, Date.parse(t1));
  assert.equal(m.requestError?.kind, 'request_timeout');
});

test('PreferencesStore validates and persists monitor thresholds without polluting defaults', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-pulse-monitor-prefs-'));
  try {
    const store = new PreferencesStore({ file: join(dir, 'preferences.json') });
    const initial = await store.get();
    assert.equal('cacheWarnMinutes' in initial, false);

    const updated = await store.set({
      cacheWarnMinutes: 5,
      cacheColdMinutes: 8,
      firstTokenWaitSeconds: 45,
      speedPulseEnabled: false,
    });
    assert.equal(updated.cacheWarnMinutes, 5);
    assert.equal(updated.cacheColdMinutes, 8);
    assert.equal(updated.firstTokenWaitSeconds, 45);
    assert.equal(updated.speedPulseEnabled, false);

    const reloaded = await store.get();
    assert.equal(reloaded.cacheWarnMinutes, 5);
    assert.equal(reloaded.speedPulseEnabled, false);

    await assert.rejects(() => store.set({ cacheWarnMinutes: -1 }), /Invalid monitor threshold preference/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inline widget shell markup only uses Trusted-Types allowed tags', async () => {
  const { readFileSync } = await import('node:fs');
  const cardsSrc = readFileSync(new URL('../../../src/ui/inline-widget/cards.ts', import.meta.url), 'utf8');
  const domSrc = readFileSync(new URL('../../../src/shared/dom.ts', import.meta.url), 'utf8');
  const allowMatch = domSrc.match(/ALLOWED_MARKUP_TAGS\s*=\s*new Set\(\s*'([^']+)'/);
  assert.ok(allowMatch, 'ALLOWED_MARKUP_TAGS definition found');
  const allowed = new Set(allowMatch[1].split(/\s+/));
  const markupStart = cardsSrc.indexOf('return `<style>');
  const tailMatch = cardsSrc.slice(markupStart).match(/`;\r?\n\}/);
  assert.ok(markupStart > 0 && tailMatch && typeof tailMatch.index === 'number');
  const template = cardsSrc
    .slice(markupStart, markupStart + tailMatch.index)
    .replace(/\$\{[^}]+\}/g, '');
  for (const m of template.matchAll(/<\/?([a-z][\w-]*)(?:\s[^<>]*?)?\s*\/?\s*>/gi)) {
    const tag = m[1].toLowerCase();
    assert.ok(allowed.has(tag), `Disallowed tag <${tag}> in inline widget shell markup`);
  }
});
