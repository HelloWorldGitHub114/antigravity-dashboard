import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UsageLedger,
  queryQuotaCycleUsage,
  recordQuotaCycleBoundaries,
} from '../usage.mjs';
import {
  buildQuotaCycleView,
  formatQuotaCycleRange,
  formatQuotaCycleStatus,
} from '../../../src/ui/usage-modal/quota-cycle.ts';

const hash = (s) => createHash('sha256').update(s).digest('hex');

const makeGroups = ({ geminiWeeklyReset, gemini5hReset, claudeWeeklyReset, geminiWeeklyRem = 0.72, gemini5hRem = 0.65, claudeWeeklyRem = 0.5 }) => [
  {
    id: 'gemini',
    name: 'Gemini',
    windows: {
      weekly: { available: true, remaining: geminiWeeklyRem, resetAt: geminiWeeklyReset, disabled: false },
      '5h': { available: true, remaining: gemini5hRem, resetAt: gemini5hReset, disabled: false },
    },
  },
  {
    id: '3p',
    name: 'Claude & GPT',
    windows: {
      weekly: { available: true, remaining: claudeWeeklyRem, resetAt: claudeWeeklyReset, disabled: false },
      '5h': { available: true, remaining: 1, resetAt: gemini5hReset, disabled: false },
    },
  },
];

test('queryQuotaCycleUsage slices weekly cycle by exact timestamps and isolates quota pools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-quota-cycles-'));
  try {
    const scope = hash('acct-weekly');
    const ledger = new UsageLedger(dir, { timeZone: 'Asia/Shanghai' });

    // 周周期：2026-11-15 16:50:00+08:00 -> 2026-11-22 16:50:00+08:00
    const resetAt = '2026-11-22T16:50:00+08:00';
    const convId = '11111111-1111-4111-8111-111111111111';
    await ledger.ingestRows(scope, convId, [
      // 早于周期起点 1 分钟 -> 应排除，且标记 hasOlder = true
      {
        id: hash('before-start'),
        at: Date.parse('2026-11-15T16:49:00+08:00'),
        model: 'gemini-3.1-pro-high',
        uncached: 500,
        cacheRead: 0,
        cacheWrite: 0,
        output: 100,
        partial: false,
        timeBasis: 'request-start',
      },
      // 首日截断后 1 分钟 -> 应计入 2026-11-15
      {
        id: hash('inside-first-day'),
        at: Date.parse('2026-11-15T16:51:00+08:00'),
        model: 'gemini-3.1-pro-high',
        uncached: 1000,
        cacheRead: 2000,
        cacheWrite: 300,
        output: 400,
        partial: false,
        timeBasis: 'request-start',
      },
      // 同一时间段的 Claude 请求 -> 查 Gemini 池时应排除，查 3p 池时应计入
      {
        id: hash('inside-claude'),
        at: Date.parse('2026-11-18T10:00:00+08:00'),
        model: 'claude-sonnet-4-6',
        uncached: 800,
        cacheRead: 1200,
        cacheWrite: 0,
        output: 500,
        partial: false,
        timeBasis: 'request-start',
      },
      // 末日重置前 5 分钟 -> 应计入 2026-11-22
      {
        id: hash('inside-last-day'),
        at: Date.parse('2026-11-22T16:45:00+08:00'),
        model: 'gemini-3-flash',
        uncached: 200,
        cacheRead: 0,
        cacheWrite: 0,
        output: 100,
        partial: false,
        timeBasis: 'request-start',
      },
      // 晚于周期终点 1 分钟 -> 应排除
      {
        id: hash('after-end'),
        at: Date.parse('2026-11-22T16:51:00+08:00'),
        model: 'gemini-3-flash',
        uncached: 9999,
        cacheRead: 0,
        cacheWrite: 0,
        output: 1,
        partial: false,
        timeBasis: 'request-start',
      },
    ]);

    const liveGroups = makeGroups({
      geminiWeeklyReset: resetAt,
      gemini5hReset: '2026-11-22T19:00:00+08:00',
      claudeWeeklyReset: '2026-11-24T12:00:00+08:00',
    });

    const geminiRes = await queryQuotaCycleUsage({
      ledger,
      liveGroups,
      activeScope: scope,
      input: { scope, groupId: 'gemini', window: 'weekly', offset: 0 },
    });

    assert.equal(geminiRes.selectedGroupId, 'gemini');
    assert.equal(geminiRes.totalTokens, 4000);
    assert.equal(geminiRes.requests, 2);
    assert.equal(geminiRes.hasOlder, true);
    assert.equal(geminiRes.cycle?.source, 'live');
    // 跨半天 7 天周期覆盖 8 个自然日（11-15 .. 11-22）
    assert.equal(geminiRes.slices.length, 8);
    assert.equal(geminiRes.slices[0].key, '2026-11-15');
    assert.match(geminiRes.slices[0].rangeLabel, /16:50/);
    assert.equal(geminiRes.slices[0].models['gemini-3.1-pro-high']?.total, 3700);
    assert.equal(geminiRes.slices[7].key, '2026-11-22');
    assert.match(geminiRes.slices[7].rangeLabel, /16:50/);
    assert.equal(geminiRes.slices[7].models['gemini-3-flash']?.total, 300);
    // 24 小时分布只在 16 时累计 4000
    assert.equal(geminiRes.hours[16], 4000);
    assert.equal(geminiRes.hours[10], 0);

    const claudeRes = await queryQuotaCycleUsage({
      ledger,
      liveGroups,
      activeScope: scope,
      input: { scope, groupId: '3p', window: 'weekly', offset: 0 },
    });
    assert.equal(claudeRes.selectedGroupId, '3p');
    assert.equal(claudeRes.totalTokens, 2500);
    assert.equal(claudeRes.requests, 1);
    assert.equal(claudeRes.hours[10], 2500);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('queryQuotaCycleUsage slices 5h cycle hourly across midnight', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-quota-5h-'));
  try {
    const scope = hash('acct-5h');
    const ledger = new UsageLedger(dir, { timeZone: 'Asia/Shanghai' });
    const convId = '22222222-2222-4222-8222-222222222222';
    // 5h 窗口：2026-11-21 22:30 -> 2026-11-22 03:30
    const resetAt = '2026-11-22T03:30:00+08:00';
    await ledger.ingestRows(scope, convId, [
      {
        id: hash('h-22'),
        at: Date.parse('2026-11-21T22:45:00+08:00'),
        model: 'gemini-3-flash',
        uncached: 600,
        cacheRead: 0,
        cacheWrite: 0,
        output: 400,
        partial: false,
        timeBasis: 'request-start',
      },
      {
        id: hash('h-01'),
        at: Date.parse('2026-11-22T01:15:00+08:00'),
        model: 'gemini-3-flash',
        uncached: 300,
        cacheRead: 0,
        cacheWrite: 0,
        output: 200,
        partial: false,
        timeBasis: 'request-start',
      },
    ]);

    const liveGroups = makeGroups({
      geminiWeeklyReset: '2026-11-28T03:30:00+08:00',
      gemini5hReset: resetAt,
      claudeWeeklyReset: '2026-11-28T03:30:00+08:00',
    });

    const res = await queryQuotaCycleUsage({
      ledger,
      liveGroups,
      activeScope: scope,
      input: { scope, groupId: 'gemini', window: '5h', offset: 0 },
    });

    assert.equal(res.window, '5h');
    assert.equal(res.totalTokens, 1500);
    // 22:30-23:00, 23:00-24:00, 00:00-01:00, 01:00-02:00, 02:00-03:00, 03:00-03:30 -> 6 段
    assert.equal(res.slices.length, 6);
    assert.equal(res.slices[0].label, '22:30');
    assert.match(res.slices[1].rangeLabel, /23:00 – 24:00/);
    assert.equal(res.slices[2].label, '11-22 00:00');
    assert.equal(res.slices[0].models['gemini-3-flash']?.total, 1000);
    assert.equal(res.slices[3].models['gemini-3-flash']?.total, 500);
    assert.equal(res.hours[22], 1000);
    assert.equal(res.hours[1], 500);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recordQuotaCycleBoundaries skips idle windows, persists locked cycles, and aligns shifted history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-quota-history-'));
  try {
    const scope = hash('acct-hist');
    const otherScope = hash('acct-other');
    const ledger = new UsageLedger(dir, { timeZone: 'Asia/Shanghai' });

    // 1. 空闲窗口（remaining = 1）不应落盘
    const idleGroups = makeGroups({
      geminiWeeklyReset: '2026-11-10T10:00:00+08:00',
      gemini5hReset: '2026-11-03T15:00:00+08:00',
      claudeWeeklyReset: '2026-11-10T10:00:00+08:00',
      geminiWeeklyRem: 1,
      gemini5hRem: 1,
      claudeWeeklyRem: 1,
    });
    const wroteIdle = await recordQuotaCycleBoundaries(ledger, scope, idleGroups);
    assert.equal(wroteIdle, false);

    // 2. 第一期真实周周期（11-03 10:00 -> 11-10 10:00）已消耗，记录落盘
    const cycle1Groups = makeGroups({
      geminiWeeklyReset: '2026-11-10T10:00:00+08:00',
      gemini5hReset: '2026-11-05T15:00:00+08:00',
      claudeWeeklyReset: '2026-11-10T10:00:00+08:00',
      geminiWeeklyRem: 0.4,
    });
    const wrote1 = await recordQuotaCycleBoundaries(ledger, scope, cycle1Groups);
    assert.equal(wrote1, true);

    // 2 分钟内的微小抖动不应重复写盘
    const jitterGroups = makeGroups({
      geminiWeeklyReset: '2026-11-10T10:01:30+08:00',
      gemini5hReset: '2026-11-05T15:01:00+08:00',
      claudeWeeklyReset: '2026-11-10T10:00:00+08:00',
      geminiWeeklyRem: 0.35,
    });
    const wroteJitter = await recordQuotaCycleBoundaries(ledger, scope, jitterGroups);
    assert.equal(wroteJitter, false);

    // 在第一期与更早之前各写入一条记录
    const convId = '33333333-3333-4333-8333-333333333333';
    await ledger.ingestRows(scope, convId, [
      {
        id: hash('in-cycle-1'),
        at: Date.parse('2026-11-06T12:00:00+08:00'),
        model: 'gemini-3.1-pro-high',
        uncached: 4200,
        cacheRead: 0,
        cacheWrite: 0,
        output: 800,
        partial: false,
        timeBasis: 'request-start',
      },
      {
        id: hash('in-cycle-0-inferred'),
        at: Date.parse('2026-10-30T12:00:00+08:00'),
        model: 'gemini-3.1-pro-high',
        uncached: 1500,
        cacheRead: 0,
        cacheWrite: 0,
        output: 500,
        partial: false,
        timeBasis: 'request-start',
      },
    ]);

    // 3. 下一期因为闲置了 2 天，重置日漂移到了 11-19 18:00（11-12 18:00 -> 11-19 18:00）
    const cycle2Groups = makeGroups({
      geminiWeeklyReset: '2026-11-19T18:00:00+08:00',
      gemini5hReset: '2026-11-14T20:00:00+08:00',
      claudeWeeklyReset: '2026-11-19T18:00:00+08:00',
      geminiWeeklyRem: 0.85,
    });

    // offset = -1 应精准命中本地已记录的第一期（11-03 10:00 -> 11-10 10:00），而非简单减 7 天
    const prevCycle = await queryQuotaCycleUsage({
      ledger,
      liveGroups: cycle2Groups,
      activeScope: scope,
      input: { scope, groupId: 'gemini', window: 'weekly', offset: -1 },
    });
    assert.equal(prevCycle.cycle?.source, 'recorded');
    assert.equal(prevCycle.cycle?.endAt, Date.parse('2026-11-10T10:00:00+08:00'));
    assert.equal(prevCycle.totalTokens, 5000);
    assert.equal(prevCycle.hasOlder, true);

    // offset = -2 超出记录条数，自动从第一期再往前推 7 天（10-27 10:00 -> 11-03 10:00），标记 inferred
    const inferredCycle = await queryQuotaCycleUsage({
      ledger,
      liveGroups: cycle2Groups,
      activeScope: scope,
      input: { scope, groupId: 'gemini', window: 'weekly', offset: -2 },
    });
    assert.equal(inferredCycle.cycle?.source, 'inferred');
    assert.equal(inferredCycle.cycle?.endAt, Date.parse('2026-11-03T10:00:00+08:00'));
    assert.equal(inferredCycle.totalTokens, 2000);
    assert.equal(inferredCycle.hasOlder, false);

    // 4. 查询其他无记录账号时，不得串用当前在线账号的实时额度分组
    const otherRes = await queryQuotaCycleUsage({
      ledger,
      liveGroups: cycle2Groups,
      activeScope: scope,
      input: { scope: otherScope, window: 'weekly', offset: 0 },
    });
    assert.equal(otherRes.groups.length, 0);
    assert.equal(otherRes.cycle, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('usage-modal PAGE_MARKUP only uses ALLOWED_MARKUP_TAGS from shared/dom.ts', async () => {
  const domSrc = await readFile(new URL('../../../src/shared/dom.ts', import.meta.url), 'utf8');
  const allowMatch = domSrc.match(/ALLOWED_MARKUP_TAGS\s*=\s*new Set\(\s*'([^']+)'/);
  assert.ok(allowMatch, 'ALLOWED_MARKUP_TAGS should exist');
  const allowed = new Set(allowMatch[1].split(' '));

  const shellSrc = await readFile(new URL('../../../src/ui/usage-modal/dom-shell.ts', import.meta.url), 'utf8');
  const pageMatch = shellSrc.match(/const PAGE_MARKUP =\s*'([^']+)';/);
  assert.ok(pageMatch, 'PAGE_MARKUP should exist');
  const tags = [...pageMatch[1].matchAll(/<\/?([a-z][\w-]*)/gi)].map((m) => m[1].toLowerCase());
  const disallowed = [...new Set(tags.filter((t) => !allowed.has(t)))];
  assert.deepEqual(disallowed, [], `PAGE_MARKUP contains disallowed tags: ${disallowed.join(', ')}`);
});

test('buildQuotaCycleView computes API USD cost, supports custom pricing overrides and legend filtering', () => {
  const snapshot = {
    accountKey: hash('acct-view'),
    requestedScope: 'all',
    timeZone: 'Asia/Shanghai',
    groups: [],
    selectedGroupId: 'gemini',
    selectedGroupName: 'Gemini',
    window: 'weekly',
    offset: 0,
    hasOlder: false,
    cycle: {
      groupId: 'gemini',
      groupName: 'Gemini',
      window: 'weekly',
      startAt: Date.parse('2026-11-15T16:50:00+08:00'),
      endAt: Date.parse('2026-11-22T16:50:00+08:00'),
      source: 'live',
      remaining: 0.72,
      idle: false,
    },
    slices: [
      {
        key: '2026-11-15',
        date: '2026-11-15',
        label: '11-15',
        rangeLabel: '2026-11-15 (16:50–24:00)',
        startAt: Date.parse('2026-11-15T16:50:00+08:00'),
        endAt: 0,
        models: {
          'gemini-4-neon-high': {
            uncached: 1_000_000,
            cacheRead: 0,
            cacheWrite: 0,
            output: 1_000_000,
            total: 2_000_000,
            requests: 5,
          },
          'gemini-3.8-flash': {
            uncached: 1_000_000,
            cacheRead: 0,
            cacheWrite: 0,
            output: 0,
            total: 1_000_000,
            requests: 2,
          },
        },
      },
    ],
    hours: Array(24).fill(0),
    totalTokens: 3_000_000,
    requests: 7,
    updatedAt: '2026-11-22T08:00:00.000Z',
  };

  assert.equal(formatQuotaCycleRange(snapshot.cycle, 'Asia/Shanghai'), '11/15 16:50 – 11/22 16:50');
  const status = formatQuotaCycleStatus(snapshot, (cn) => cn);
  assert.match(status, /已用 28%/);
  assert.match(status, /当前活跃账号/);

  const baseQuery = {
    dimension: 'model',
    modelViewMode: 'detailed',
    disabledModels: new Set(),
    disabledUsers: new Set(),
    pricingOverrides: {},
  };
  const view = buildQuotaCycleView(snapshot, baseQuery);
  assert.equal(view.buckets.length, 1);
  assert.equal(view.filteredRangeTotals.total, 3_000_000);
  assert.equal(view.filteredRangeTotals.requests, 7);
  // Gemini 4 Neon: $3/1M input + $15/1M output = $18; Gemini 3.8 Flash (2026-11): $0.75/1M input -> $18.75
  assert.ok(Math.abs(view.filteredRangeTotals.costUsd - 18.75) < 1e-6);

  // 自定义单价覆盖生效
  const customView = buildQuotaCycleView(snapshot, {
    ...baseQuery,
    pricingOverrides: {
      'gemini-4-neon': { input: 10, cacheRead: 1, cacheWrite: 0, output: 20 },
    },
  });
  // $10 + $20 + $0.75 = $30.75
  assert.ok(Math.abs(customView.filteredRangeTotals.costUsd - 30.75) < 1e-6);

  // 图例过滤排除 gemini-3.8-flash 后仅剩 Neon 的 $18
  const filteredView = buildQuotaCycleView(snapshot, {
    ...baseQuery,
    disabledModels: new Set(['gemini-3.8-flash']),
  });
  assert.equal(filteredView.filteredRangeTotals.total, 2_000_000);
  assert.ok(Math.abs(filteredView.filteredRangeTotals.costUsd - 18) < 1e-6);
  // allRangeTotals 不受过滤影响，仍保留两模型用于图例展示
  assert.equal(Object.keys(filteredView.allRangeTotals.models).length, 2);
});

