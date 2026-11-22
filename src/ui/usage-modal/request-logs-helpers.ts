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
  if (hitRate >= 0.7) return 'hot';
  if (hitRate >= 0.2) return 'warm';
  return 'miss';
}

export function formatHitPct(hitRate: number | null | undefined): string {
  if (typeof hitRate !== 'number' || !Number.isFinite(hitRate)) return '—';
  return `${(hitRate * 100).toFixed(1)}%`;
}
