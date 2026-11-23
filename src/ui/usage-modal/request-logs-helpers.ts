import type {
  ModelPricingOverrides,
  UsageRequestLogCostBucket,
} from '../../contracts/index.ts';
import {
  calculateBucketCost,
  type CostAggregate,
} from '../../shared/model-pricing.ts';
import { addDays } from './aggregator.ts';
import type { UsageLogsRange } from './types.ts';

export type CacheHitTone = 'hot' | 'warm' | 'miss' | 'none';
export type LatencyTone = 'fast' | 'normal' | 'slow' | 'none';

/**
 * 将快捷时间范围映射为账本查询所需的起止日期（含两端）。
 */
export function resolveLogsDateRange(
  range: UsageLogsRange,
  today: string,
  customFrom: string,
  customTo: string,
): { from: string | null; to: string | null } {
  if (range === 'all') return { from: null, to: null };
  if (range === 'today') return { from: today, to: today };
  if (range === '7d') return { from: addDays(today, -6), to: today };
  if (range === '30d') return { from: addDays(today, -29), to: today };
  const from = customFrom || today;
  const to = customTo || today;
  return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * 按当前生效的单价配置汇总整个筛选结果集（跨所有分页）的等效 API 花费。
 */
export function summarizeRequestLogCost(
  costBuckets: ReadonlyArray<UsageRequestLogCostBucket>,
  overrides?: ModelPricingOverrides | null,
): CostAggregate {
  let costUsd = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  let hasUnpriced = false;
  for (const bucket of costBuckets) {
    const usd = calculateBucketCost(bucket.model, bucket, bucket.date, overrides);
    if (usd === null) {
      if (bucket.total > 0) {
        unpricedTokens += bucket.total;
        hasUnpriced = true;
      }
    } else {
      costUsd += usd;
      pricedTokens += bucket.total;
    }
  }
  return { costUsd, pricedTokens, unpricedTokens, hasUnpriced };
}

/**
 * 将单次请求或汇总缓存命中率映射为视觉语义级别。
 */
export function classifyCacheHitTone(hitRate: number | null | undefined): CacheHitTone {
  if (typeof hitRate !== 'number' || !Number.isFinite(hitRate)) return 'none';
  if (hitRate > 0.9) return 'hot';
  if (hitRate >= 0.5) return 'warm';
  return 'miss';
}

export function formatHitPct(hitRate: number | null | undefined): string {
  if (typeof hitRate !== 'number' || !Number.isFinite(hitRate)) return '—';
  return `${(hitRate * 100).toFixed(1)}%`;
}

/**
 * 格式化请求总耗时或首 Token 耗时（毫秒 -> 紧凑可读时长）。
 */
export function formatDurationMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const wholeSec = Math.round(totalSec);
  if (wholeSec < 3600) {
    const mins = Math.floor(wholeSec / 60);
    const secs = wholeSec % 60;
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  const hours = Math.floor(wholeSec / 3600);
  const mins = Math.floor((wholeSec % 3600) / 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * 格式化单次请求或范围均速 TPS。
 */
export function formatTpsValue(tps: number | null | undefined): string {
  if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) return '—';
  return tps >= 100 ? `${Math.round(tps)} t/s` : `${tps.toFixed(1)} t/s`;
}

/**
 * 将耗时映射为视觉语义档位，便于快速扫视慢请求与高首字延迟。
 */
export function classifyLatencyTone(
  ms: number | null | undefined,
  kind: 'total' | 'ttft',
): LatencyTone {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'none';
  if (kind === 'ttft') {
    if (ms < 5_000) return 'fast';
    if (ms < 30_000) return 'normal';
    return 'slow';
  }
  if (ms < 20_000) return 'fast';
  if (ms < 60_000) return 'normal';
  return 'slow';
}
