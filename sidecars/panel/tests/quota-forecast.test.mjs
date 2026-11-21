import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  quotaForecast,
  groupQuotaPace,
  shortEta,
  classifyQuotaGroupId,
} from '../metrics.mjs';
import { UsageLedger, summarizeQuotaWindows } from '../usage.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');

test('quotaForecast handles idle, warming-up, comfortable, tight, and early exhaustion', () => {
  const now = Date.parse('2026-11-21T12:00:00.000Z');
  const fiveHourMs = 5 * 60 * 60 * 1000;

  // 1. 未使用（remaining = 1）
  const idle = quotaForecast(
    { available: true, remaining: 1, resetAt: new Date(now + fiveHourMs).toISOString(), disabled: false },
    '5h',
    now,
  );
  assert.equal(idle?.outlook, 'idle');
  assert.equal(idle?.forecastReady, true);
  assert.equal(idle?.projectedRemaining, 1);

  // 2. 窗口刚开启 2 分钟且消耗 2% -> 采样预热中，不误报耗尽
  const warming = quotaForecast(
    { available: true, remaining: 0.98, resetAt: new Date(now + fiveHourMs - 2 * 60000).toISOString(), disabled: false },
    '5h',
    now,
  );
  assert.equal(warming?.warmingUp, true);
  assert.equal(warming?.forecastReady, false);
  assert.equal(warming?.outlook, null);

  // 3. 已过一半时间（2.5h），仅用 20% -> 预计重置剩 60%（ok）
  const ok = quotaForecast(
    { available: true, remaining: 0.8, resetAt: new Date(now + fiveHourMs / 2).toISOString(), disabled: false },
    '5h',
    now,
  );
  assert.equal(ok?.outlook, 'ok');
  assert.equal(ok?.willExhaust, false);
  assert.ok(Math.abs((ok?.projectedRemaining ?? 0) - 0.6) < 0.001);

  // 4. 已过一半时间（2.5h），用了 45% -> 预计重置剩 10%（tight）
  const tight = quotaForecast(
    { available: true, remaining: 0.55, resetAt: new Date(now + fiveHourMs / 2).toISOString(), disabled: false },
    '5h',
    now,
  );
  assert.equal(tight?.outlook, 'tight');
  assert.equal(tight?.willExhaust, false);
  assert.ok(Math.abs((tight?.projectedRemaining ?? 0) - 0.1) < 0.001);

  // 5. 已过 1 小时，已用 50% -> 预计再过 1 小时耗尽，比重置早 3 小时
  const exhaust = quotaForecast(
    { available: true, remaining: 0.5, resetAt: new Date(now + 4 * 3600000).toISOString(), disabled: false },
    '5h',
    now,
  );
  assert.equal(exhaust?.outlook, 'exhaust');
  assert.equal(exhaust?.willExhaust, true);
  assert.equal(shortEta(exhaust?.exhaustInMs), '1h');
  assert.equal(shortEta(exhaust?.earlyByMs), '3h');
});

test('groupQuotaPace selects the most at-risk window and flags critical urgency', () => {
  const now = Date.parse('2026-11-21T12:00:00.000Z');
  const group = {
    id: 'gemini',
    name: 'Gemini Models',
    description: '',
    windows: {
      '5h': {
        available: true,
        id: 'gemini-5h',
        remaining: 0.25,
        amount: null,
        resetAt: new Date(now + 4 * 3600000).toISOString(), // 1h elapsed, 75% used -> ~20m left!
        expired: false,
        disabled: false,
        description: '',
      },
      weekly: {
        available: true,
        id: 'gemini-weekly',
        remaining: 0.9,
        amount: null,
        resetAt: new Date(now + 3 * 86400000).toISOString(),
        expired: false,
        disabled: false,
        description: '',
      },
    },
  };
  const pace = groupQuotaPace(group, now);
  assert.equal(pace?.window, '5h');
  assert.equal(pace?.pace, 'exhaust');
  assert.equal(pace?.labelKey, 'outlookExhaust');
  assert.equal(pace?.critical, true);
});

test('summarizeQuotaWindows aggregates active-window tokens by model family and estimates full capacity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-pulse-qw-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const scope = hash('forecast-test@example.com');
  const ledger = new UsageLedger(dir);
  const now = Date.now();
  const fiveReset = new Date(now + 3 * 3600000).toISOString(); // window: [now - 2h, now + 3h]
  const weekReset = new Date(now + 5 * 86400000).toISOString(); // window: [now - 2d, now + 5d]

  await ledger.ingestRows(scope, '11111111-2222-4333-8444-555555555555', [
    { id: hash('r1'), at: now - 30 * 60000, model: 'Gemini 4 Neon (XHigh)', uncached: 100000, cacheRead: 900000, cacheWrite: 0, output: 20000, partial: false, timeBasis: 'request-start' },
    { id: hash('r2'), at: now - 3600000 * 10, model: 'Gemini 4 Neon (XHigh)', uncached: 500000, cacheRead: 0, cacheWrite: 0, output: 50000, partial: false, timeBasis: 'request-start' }, // outside 5h, inside weekly
    { id: hash('r3'), at: now - 15 * 60000, model: 'Claude Opus 5.5', uncached: 50000, cacheRead: 150000, cacheWrite: 0, output: 10000, partial: false, timeBasis: 'request-start' },
  ]);

  const groups = [
    {
      id: 'gemini',
      name: 'Gemini Models',
      description: '',
      windows: {
        '5h': { available: true, id: 'g-5h', remaining: 0.8, amount: null, resetAt: fiveReset, expired: false, disabled: false, description: '' },
        weekly: { available: true, id: 'g-w', remaining: 0.98, amount: null, resetAt: weekReset, expired: false, disabled: false, description: '' },
      },
    },
    {
      id: '3p',
      name: 'Claude and GPT models',
      description: '',
      windows: {
        '5h': { available: true, id: '3p-5h', remaining: 0.9, amount: null, resetAt: fiveReset, expired: false, disabled: false, description: '' },
      },
    },
  ];

  assert.equal(classifyQuotaGroupId(groups, 'Gemini 4 Neon (XHigh)'), 'gemini');
  assert.equal(classifyQuotaGroupId(groups, 'Claude Opus 5.5'), '3p');

  const result = await summarizeQuotaWindows(ledger, scope, groups);
  // gemini:5h -> only r1 (1,020,000 tok), usedFraction=0.2 >= 0.05 -> estFull = 5,100,000
  assert.equal(result['gemini:5h']?.observedTokens, 1020000);
  assert.equal(result['gemini:5h']?.requests, 1);
  assert.equal(result['gemini:5h']?.estimatedFullTokens, 5100000);

  // gemini:weekly -> r1 + r2 (1,570,000 tok), usedFraction=0.02 < 0.05 -> estFull = null
  assert.equal(result['gemini:weekly']?.observedTokens, 1570000);
  assert.equal(result['gemini:weekly']?.requests, 2);
  assert.equal(result['gemini:weekly']?.estimatedFullTokens, null);

  // 3p:5h -> r3 (210,000 tok), usedFraction=0.1 -> estFull = 2,100,000
  assert.equal(result['3p:5h']?.observedTokens, 210000);
  assert.equal(result['3p:5h']?.estimatedFullTokens, 2100000);
});
