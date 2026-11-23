import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger, queryUsageRequestLogs, usageRecords } from '../usage.mjs';
import {
  classifyCacheHitTone,
  classifyLatencyTone,
  formatDurationMs,
  formatTpsValue,
  resolveLogsDateRange,
  summarizeRequestLogCost,
} from '../../../src/ui/usage-modal/request-logs-helpers.ts';

const hash = (s) => createHash('sha256').update(s).digest('hex');

test('queryUsageRequestLogs filters, deduplicates, sorts newest-first, enriches titles, and summarizes full range', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-request-logs-'));
  try {
    const scope = hash('acct-primary');
    const ledger = new UsageLedger(dir, { timeZone: 'Asia/Shanghai' });
    const convA = '11111111-1111-4111-8111-111111111111';
    const convB = '22222222-2222-4222-8222-222222222222';
    const dupId = hash('req-dup');

    await ledger.ingestRows(scope, convA, [
      // 热命中：90%
      {
        id: hash('req-hot'),
        at: Date.parse('2026-11-22T10:15:30+08:00'),
        model: 'gemini-4-neon',
        uncached: 10000,
        cacheRead: 90000,
        cacheWrite: 0,
        output: 2000,
        partial: false,
        timeBasis: 'request-start',
      },
      // 去重较小版本（应被 convB 里更大版本覆盖）
      {
        id: dupId,
        at: Date.parse('2026-11-22T10:20:05+08:00'),
        model: 'gemini-4-neon',
        uncached: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 100,
        partial: true,
        timeBasis: 'request-start',
      },
      // 跨日旧请求：0% 未命中
      {
        id: hash('req-yesterday-miss'),
        at: Date.parse('2026-11-21T23:59:59+08:00'),
        model: 'claude-sonnet-5.5',
        uncached: 50000,
        cacheRead: 0,
        cacheWrite: 10000,
        output: 1500,
        partial: false,
        timeBasis: 'request-start',
      },
      // 无时间戳请求：应在日志流中忽略
      {
        id: hash('req-undated'),
        at: null,
        model: 'gemini-4-neon',
        uncached: 1234,
        cacheRead: 0,
        cacheWrite: 0,
        output: 100,
        partial: false,
        timeBasis: 'unknown',
      },
    ]);

    await ledger.ingestRows(scope, convB, [
      // 去重更大版本：50% 部分命中（含 cacheWrite）
      {
        id: dupId,
        at: Date.parse('2026-11-22T10:20:05+08:00'),
        model: 'gemini-4-neon',
        uncached: 30000,
        cacheRead: 50000,
        cacheWrite: 20000,
        output: 3000,
        partial: false,
        timeBasis: 'request-start',
      },
      // 今日最新请求：0% 未命中
      {
        id: hash('req-latest-miss'),
        at: Date.parse('2026-11-22T11:00:08+08:00'),
        model: 'claude-opus-5.5',
        uncached: 80000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 1200,
        partial: false,
        timeBasis: 'request-start',
      },
    ]);

    const store = {
      rawSummaries: {
        [convA]: {
          summary: '排查缓存命中率波动',
          workspaces: [{ workspaceFolderAbsoluteUri: 'file:///workspace/antigravity-dashboard' }],
        },
        [convB]: {
          summary: '实现请求日志分页界面',
          workspaces: [{ workspaceFolderAbsoluteUri: 'file:///workspace/demo-app' }],
        },
      },
    };

    const todayRes = await queryUsageRequestLogs({
      ledger,
      store,
      activeScope: scope,
      now: Date.parse('2026-11-22T12:00:00+08:00'),
      input: { scope, from: '2026-11-22', to: '2026-11-22', page: 1, pageSize: 10 },
    });

    assert.equal(todayRes.totalCount, 3);
    assert.equal(todayRes.items.length, 3);
    // 严格按时间倒序排列
    assert.equal(todayRes.items[0].timeText, '2026-11-22 11:00:08');
    assert.equal(todayRes.items[0].model, 'claude-opus-5.5');
    assert.equal(todayRes.items[0].cacheHitRate, 0);
    assert.equal(todayRes.items[0].conversationTitle, '实现请求日志分页界面');
    assert.equal(todayRes.items[0].projectName, 'demo-app');

    // 去重保留了较大的那一条（100,000 输入 / 3,000 输出，50% 命中）
    assert.equal(todayRes.items[1].timeText, '2026-11-22 10:20:05');
    assert.equal(todayRes.items[1].inputTokens, 100000);
    assert.equal(todayRes.items[1].cacheWrite, 20000);
    assert.equal(todayRes.items[1].output, 3000);
    assert.equal(todayRes.items[1].cacheHitRate, 0.5);

    assert.equal(todayRes.items[2].timeText, '2026-11-22 10:15:30');
    assert.equal(todayRes.items[2].cacheHitRate, 0.9);
    assert.equal(todayRes.items[2].projectName, 'antigravity-dashboard');

    // 汇总与分类计数准确
    assert.equal(todayRes.summary.totalRequests, 3);
    assert.equal(todayRes.summary.hotCount, 1);
    assert.equal(todayRes.summary.warmCount, 1);
    assert.equal(todayRes.summary.missCount, 1);
    assert.equal(todayRes.summary.inputTokens, 280000);
    assert.equal(todayRes.summary.cachedTokens, 140000);
    assert.equal(todayRes.summary.cacheHitRate, 0.5);

    // 模型下拉列表反映当前日期范围全部模型（含请求数排序）
    assert.deepEqual(todayRes.models, [
      { model: 'gemini-4-neon', requests: 2 },
      { model: 'claude-opus-5.5', requests: 1 },
    ]);

    // 缓存状态筛选：仅看未命中 (<20%)，但 models 下拉仍保留日期范围内全部模型
    const missOnly = await queryUsageRequestLogs({
      ledger,
      store,
      activeScope: scope,
      now: Date.parse('2026-11-22T12:00:00+08:00'),
      input: { scope, from: '2026-11-22', to: '2026-11-22', cacheFilter: 'miss' },
    });
    assert.equal(missOnly.totalCount, 1);
    assert.equal(missOnly.items[0].model, 'claude-opus-5.5');
    assert.equal(missOnly.models.length, 2);

    // 模型筛选 + 全部时间（包含昨日请求）
    const claudeAll = await queryUsageRequestLogs({
      ledger,
      store,
      activeScope: scope,
      now: Date.parse('2026-11-22T12:00:00+08:00'),
      input: { scope, from: null, to: null, model: 'claude-sonnet-5.5' },
    });
    assert.equal(claudeAll.totalCount, 1);
    assert.equal(claudeAll.items[0].date, '2026-11-21');
    assert.equal(claudeAll.items[0].cacheWrite, 10000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('queryUsageRequestLogs supports pagination, multi-account all scope, and manual remote entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-request-logs-multi-'));
  try {
    const scopeA = hash('acct-a');
    const scopeB = hash('acct-b');
    const ledger = new UsageLedger(dir, { timeZone: 'Asia/Shanghai' });
    await ledger.registerAccount(scopeA, { email: 'alice@example.com', primary: true });
    await ledger.registerAccount(scopeB, { email: 'bob@example.com' });

    const convA = '33333333-3333-4333-8333-333333333333';
    const baseMs = Date.parse('2026-11-22T09:00:00+08:00');
    const rows = [];
    for (let i = 0; i < 12; i++) {
      rows.push({
        id: hash(`req-p-${i}`),
        at: baseMs + i * 60_000,
        model: 'gemini-3.8-flash',
        uncached: 2000,
        cacheRead: 8000,
        cacheWrite: 0,
        output: 500,
        partial: false,
        timeBasis: 'request-start',
      });
    }
    await ledger.ingestRows(scopeA, convA, rows);

    await ledger.addManualUsage(scopeB, {
      projectName: 'remote-server',
      timestamp: Date.parse('2026-11-22T09:30:00+08:00'),
      model: 'claude-sonnet-5.5',
      prompt: 20000,
      candidates: 1000,
      cacheRead: 15000,
      note: '远程集群补录',
    });

    // 全账号视角 + 分页（pageSize=10，总共 13 条 -> 2 页）
    const page1 = await queryUsageRequestLogs({
      ledger,
      now: Date.parse('2026-11-22T12:00:00+08:00'),
      input: { scope: 'all', page: 1, pageSize: 10 },
    });
    assert.equal(page1.totalCount, 13);
    assert.equal(page1.totalPages, 2);
    assert.equal(page1.items.length, 10);
    // 最新一条应是远程补录
    assert.equal(page1.items[0].source, 'remote');
    assert.equal(page1.items[0].projectName, 'remote-server');
    assert.equal(page1.items[0].note, '远程集群补录');
    assert.equal(page1.items[0].accountName, 'bob@example.com');
    assert.equal(page1.items[1].accountName, 'alice@example.com');

    // 汇总覆盖全 13 条，而非仅当前 10 条
    assert.equal(page1.summary.totalRequests, 13);

    const page2 = await queryUsageRequestLogs({
      ledger,
      now: Date.parse('2026-11-22T12:00:00+08:00'),
      input: { scope: 'all', page: 2, pageSize: 10 },
    });
    assert.equal(page2.page, 2);
    assert.equal(page2.items.length, 3);
    assert.equal(page2.summary.totalRequests, 13);

    // 单账号视角不附带 accountName 且隔离另一账号记录
    const onlyB = await queryUsageRequestLogs({
      ledger,
      now: Date.parse('2026-11-22T12:00:00+08:00'),
      input: { scope: scopeB, page: 1, pageSize: 10 },
    });
    assert.equal(onlyB.totalCount, 1);
    assert.equal(onlyB.items[0].accountName, undefined);
    assert.equal(onlyB.items[0].source, 'remote');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('request log frontend helpers resolve date ranges, tones, and custom USD pricing accurately', () => {
  assert.deepEqual(resolveLogsDateRange('today', '2026-11-22', '', ''), {
    from: '2026-11-22',
    to: '2026-11-22',
  });
  assert.deepEqual(resolveLogsDateRange('7d', '2026-11-22', '', ''), {
    from: '2026-11-16',
    to: '2026-11-22',
  });
  assert.deepEqual(resolveLogsDateRange('30d', '2026-11-22', '', ''), {
    from: '2026-10-24',
    to: '2026-11-22',
  });
  assert.deepEqual(resolveLogsDateRange('all', '2026-11-22', '', ''), {
    from: null,
    to: null,
  });
  assert.deepEqual(resolveLogsDateRange('custom', '2026-11-22', '2026-11-20', '2026-11-10'), {
    from: '2026-11-10',
    to: '2026-11-20',
  });

  assert.equal(classifyCacheHitTone(0.95), 'hot');
  assert.equal(classifyCacheHitTone(0.7), 'hot');
  assert.equal(classifyCacheHitTone(0.45), 'warm');
  assert.equal(classifyCacheHitTone(0.199), 'miss');
  assert.equal(classifyCacheHitTone(0), 'miss');
  assert.equal(classifyCacheHitTone(null), 'none');

  // 验证汇总等效花费支持日期切换价与自定义单价覆写
  // gemini-4-carbon 11/30 前优惠价: in $2, cacheRead $0.1, cacheWrite $2, out $10
  // 12/1 起标准价: in $4, cacheRead $0.2, cacheWrite $4, out $20
  const buckets = [
    {
      date: '2026-11-22',
      model: 'gemini-4-carbon',
      uncached: 500_000,
      cacheRead: 1_000_000,
      cacheWrite: 0,
      output: 100_000,
      total: 1_600_000,
    },
    {
      date: '2026-12-05',
      model: 'gemini-4-carbon',
      uncached: 500_000,
      cacheRead: 0,
      cacheWrite: 0,
      output: 100_000,
      total: 600_000,
    },
  ];
  const builtinCost = summarizeRequestLogCost(buckets);
  // 11-22: 0.5*2 + 1*0.1 + 0.1*10 = $2.10; 12-05: 0.5*4 + 0.1*20 = $4.00 => $6.10
  assert.ok(Math.abs(builtinCost.costUsd - 6.1) < 1e-9);
  assert.equal(builtinCost.hasUnpriced, false);

  const customCost = summarizeRequestLogCost(buckets, {
    'gemini-4-carbon': { input: 10, cacheRead: 1, cacheWrite: 10, output: 20 },
  });
  // (1_000_000 * 10 + 1_000_000 * 1 + 200_000 * 20) / 1M = 10 + 1 + 4 = $15.00
  assert.ok(Math.abs(customCost.costUsd - 15.0) < 1e-9);

  // 耗时与速度格式化校验
  assert.equal(formatDurationMs(null), '—');
  assert.equal(formatDurationMs(450), '0.5s');
  assert.equal(formatDurationMs(6100), '6.1s');
  assert.equal(formatDurationMs(61000), '1m 1s');
  assert.equal(formatDurationMs(120000), '2m');
  assert.equal(formatTpsValue(null), '—');
  assert.equal(formatTpsValue(45.36), '45.4 t/s');
  assert.equal(formatTpsValue(128.4), '128 t/s');
  assert.equal(classifyLatencyTone(4200, 'ttft'), 'fast');
  assert.equal(classifyLatencyTone(12000, 'ttft'), 'normal');
  assert.equal(classifyLatencyTone(45000, 'ttft'), 'slow');
  assert.equal(classifyLatencyTone(15000, 'total'), 'fast');
  assert.equal(classifyLatencyTone(40000, 'total'), 'normal');
  assert.equal(classifyLatencyTone(75000, 'total'), 'slow');
});

test('usageRecords extracts TTFT, duration, and quality-checked TPS, and upgrades existing records on ingest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-request-logs-timing-'));
  try {
    const scope = hash('acct-timing');
    const ledger = new UsageLedger(dir, { timeZone: 'Asia/Shanghai' });
    const convId = '44444444-4444-4444-8444-444444444444';

    const raw = {
      trajectory: {
        steps: [
          { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'hello world' } },
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: { response: '', toolCalls: [{ name: 'run_command' }] },
          },
          { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'done' } },
        ],
        generatorMetadata: [
          // 正常请求 1：TTFT 10s，流式 4s，responseOutput 200 -> TPS 50.0
          {
            stepIndices: [0],
            chatModel: {
              modelDisplayName: 'Gemini 4 Neon (XHigh)',
              timeToFirstToken: '10.0s',
              streamingDuration: '4.0s',
              chatStartMetadata: { createdAt: '2026-11-23T10:00:00+08:00' },
              usage: {
                apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                responseId: 'r-normal-1',
                inputTokens: 1000,
                cacheReadTokens: 9000,
                outputTokens: 350,
                responseOutputTokens: 200,
                thinkingOutputTokens: 150,
              },
            },
          },
          // 缓冲工具调用短窗：TTFT 60s，流式 0.2s，toolOnly -> 应保留耗时，但 TPS 过滤掉避免出现虚高 500 t/s
          {
            stepIndices: [1],
            chatModel: {
              modelDisplayName: 'Gemini 4 Neon (XHigh)',
              timeToFirstToken: '60.0s',
              streamingDuration: '0.2s',
              chatStartMetadata: { createdAt: '2026-11-23T10:02:00+08:00' },
              usage: {
                apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                responseId: 'r-tool-burst',
                inputTokens: 500,
                cacheReadTokens: 9500,
                outputTokens: 150,
                responseOutputTokens: 100,
                thinkingOutputTokens: 50,
              },
            },
          },
          // 正常请求 2：TTFT 5s，流式 6s，responseOutput 180 -> TPS 30.0
          {
            stepIndices: [2],
            chatModel: {
              modelDisplayName: 'Gemini 4 Neon (XHigh)',
              timeToFirstToken: '5.0s',
              streamingDuration: '6.0s',
              chatStartMetadata: { createdAt: '2026-11-23T10:05:00+08:00' },
              usage: {
                apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                responseId: 'r-normal-2',
                inputTokens: 2000,
                cacheReadTokens: 8000,
                outputTokens: 180,
                responseOutputTokens: 180,
                thinkingOutputTokens: 0,
              },
            },
          },
        ],
      },
    };

    const extracted = usageRecords(raw, convId);
    assert.equal(extracted.length, 3);
    const byAt = [...extracted].sort((a, b) => a.at - b.at);
    assert.equal(byAt[0].ttftMs, 10000);
    assert.equal(byAt[0].streamMs, 4000);
    assert.equal(byAt[0].tps, 50);

    // 缓冲工具短窗：保留 ttftMs 与 streamMs，但 tps 不写入
    assert.equal(byAt[1].ttftMs, 60000);
    assert.equal(byAt[1].streamMs, 200);
    assert.equal(byAt[1].tps, undefined);

    assert.equal(byAt[2].ttftMs, 5000);
    assert.equal(byAt[2].streamMs, 6000);
    assert.equal(byAt[2].tps, 30);

    // 先写入无耗时旧版记录，再用含耗时新版覆盖，验证无损升级
    const legacyRows = extracted.map(({ ttftMs: _a, streamMs: _b, tps: _c, ...rest }) => rest);
    await ledger.ingestRows(scope, convId, legacyRows);
    await ledger.ingestRows(scope, convId, extracted);

    const logSnap = await queryUsageRequestLogs({
      ledger,
      activeScope: scope,
      now: Date.parse('2026-11-23T11:00:00+08:00'),
      input: { scope, from: '2026-11-23', to: '2026-11-23' },
    });

    assert.equal(logSnap.totalCount, 3);
    // 倒序第 1 条是 r-normal-2（10:05）：output=180, duration=11s -> 综合 16.4 t/s，纯流式 30.0 t/s
    assert.equal(logSnap.items[0].ttftMs, 5000);
    assert.equal(logSnap.items[0].streamMs, 6000);
    assert.equal(logSnap.items[0].durationMs, 11000);
    assert.equal(logSnap.items[0].tps, 16.4);
    assert.equal(logSnap.items[0].streamTps, 30);

    // 倒序第 2 条是 r-tool-burst（10:02）：output=150, duration=60.2s -> 综合 2.5 t/s（稳定不爆炸），纯流式为 null
    assert.equal(logSnap.items[1].ttftMs, 60000);
    assert.equal(logSnap.items[1].streamMs, 200);
    assert.equal(logSnap.items[1].durationMs, 60200);
    assert.equal(logSnap.items[1].tps, 2.5);
    assert.equal(logSnap.items[1].streamTps, null);

    // 倒序第 3 条是 r-normal-1（10:00）：output=350, duration=14s -> 综合 25.0 t/s，纯流式 50.0 t/s
    assert.equal(logSnap.items[2].tps, 25);
    assert.equal(logSnap.items[2].streamTps, 50);

    // 汇总均速按全量「总输出 / 总耗时」计算：(350 + 150 + 180) / (14 + 60.2 + 11) = 680 / 85.2 ≈ 8.0 t/s
    assert.equal(logSnap.summary.timedRequests, 3);
    assert.equal(logSnap.summary.tpsSamples, 3);
    assert.equal(logSnap.summary.avgTps, 8);
    // 平均首字：(10000 + 60000 + 5000) / 3 = 25000ms
    assert.equal(logSnap.summary.avgTtftMs, 25000);
    // 平均总耗时：(14000 + 60200 + 11000) / 3 = 28400ms
    assert.equal(logSnap.summary.avgDurationMs, 28400);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
