import type {
  QuotaCycleRecord,
  QuotaCycleSliceBucket,
  QuotaCycleUsageSnapshot,
  UsageBucketCounts,
} from '../../contracts/index.ts';
import { calculateBucketCost } from '../../shared/model-pricing.ts';
import type { AggregationQuery } from './aggregator.ts';
import { effectiveModelKey } from './palette.ts';
import type { ModelCostBucket, UsageTotalsResult } from './types.ts';

const COUNT_KEYS: ReadonlyArray<keyof UsageBucketCounts> = [
  'total',
  'requests',
  'uncached',
  'cacheRead',
  'cacheWrite',
  'output',
];

const rangeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function createEmptyBucket(): UsageBucketCounts {
  return { total: 0, requests: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

function createEmptyCostBucket(): ModelCostBucket {
  return { costUsd: 0, pricedTokens: 0, unpricedTokens: 0 };
}

function getRangeFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = rangeFormatterCache.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      fmt = new Intl.DateTimeFormat('en-CA', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    }
    rangeFormatterCache.set(timeZone, fmt);
  }
  return fmt;
}

function formatDateParts(ms: number, timeZone: string): { year: string; md: string; hm: string } {
  const parts = getRangeFormatter(timeZone).formatToParts(ms);
  let year = '';
  let month = '01';
  let day = '01';
  let hour = '00';
  let minute = '00';
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
    else if (p.type === 'hour') hour = p.value.padStart(2, '0');
    else if (p.type === 'minute') minute = p.value.padStart(2, '0');
  }
  return { year, md: `${month}/${day}`, hm: `${hour}:${minute}` };
}

/**
 * 格式化额度重置周期的精确起止时间标签，例如 `11/15 16:50 – 11/22 16:50`。
 */
export function formatQuotaCycleRange(cycle: QuotaCycleRecord | null | undefined, timeZone: string): string {
  if (!cycle || !Number.isFinite(cycle.startAt) || !Number.isFinite(cycle.endAt)) return '—';
  const s = formatDateParts(cycle.startAt, timeZone);
  const e = formatDateParts(cycle.endAt, timeZone);
  const crossYear = s.year !== e.year;
  const sameDay = s.year === e.year && s.md === e.md;
  if (sameDay) {
    return `${s.md} ${s.hm} – ${e.hm}`;
  }
  const startStr = crossYear ? `${s.year}/${s.md} ${s.hm}` : `${s.md} ${s.hm}`;
  const endStr = crossYear ? `${e.year}/${e.md} ${e.hm}` : `${e.md} ${e.hm}`;
  return `${startStr} – ${endStr}`;
}

/**
 * 构造周期来源与剩余额度状态提示文案。
 */
export function formatQuotaCycleStatus(
  snapshot: QuotaCycleUsageSnapshot | null | undefined,
  w: (cn: string, en: string) => string,
): string {
  const cycle = snapshot?.cycle;
  if (!cycle) return '';
  const parts: string[] = [];
  if (cycle.source === 'live') {
    if (cycle.idle) {
      parts.push(w('当期尚未消耗 · 窗口滑动中', 'Idle · rolling window'));
    } else if (typeof cycle.remaining === 'number' && Number.isFinite(cycle.remaining)) {
      const usedPct = Math.max(0, Math.min(100, Math.round((1 - cycle.remaining) * 100)));
      const remPct = Math.max(0, Math.min(100, Math.round(cycle.remaining * 100)));
      parts.push(w(`当前周期 · 已用 ${usedPct}%（剩 ${remPct}%）`, `Current · ${usedPct}% used (${remPct}% left)`));
    } else {
      parts.push(w('当前周期', 'Current cycle'));
    }
  } else if (cycle.source === 'recorded') {
    parts.push(w('已记录历史周期', 'Recorded cycle'));
  } else {
    parts.push(w('按固定周期回推', 'Estimated cycle'));
  }
  if (snapshot?.requestedScope === 'all') {
    parts.push(w('当前活跃账号', 'Active account'));
  }
  return parts.join(' · ');
}

/**
 * 构造无周期数据时的精确提示，区分“该额度池满额空闲（待首次请求锁定周期）”与“离线/无记录”。
 */
export function formatQuotaCycleEmptyMessage(
  snapshot: QuotaCycleUsageSnapshot | null | undefined,
  window: 'weekly' | '5h',
  w: (cn: string, en: string) => string,
): string {
  const selected = snapshot?.groups?.find((g) => g.id === snapshot.selectedGroupId);
  const rem = selected ? (window === '5h' ? selected.fiveHourRemaining : selected.weeklyRemaining) : null;
  if (selected && typeof rem === 'number' && rem >= 0.9995) {
    return w(
      '该额度池本周期尚未消耗（剩 100%），发出首次请求后将锁定重置周期',
      'This pool has not been used yet (100% left); reset cycle starts on first request',
    );
  }
  return w('暂无可用的额度周期记录（请确保客户端在线）', 'No quota cycle data available yet');
}

function aggregateSlices(
  slices: ReadonlyArray<QuotaCycleSliceBucket>,
  query: AggregationQuery,
  filter: boolean,
  rangeMeta: { from: string; to: string; xLabel?: string; displayRange?: string },
): UsageTotalsResult {
  const models: Record<string, UsageBucketCounts> = {};
  const modelVariants: Record<string, Record<string, UsageBucketCounts>> = {};
  const modelCosts: Record<string, ModelCostBucket> = {};
  const variantCosts: Record<string, Record<string, ModelCostBucket>> = {};
  let total = 0;
  let requests = 0;
  let costUsd = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;

  for (const slice of slices) {
    for (const [rawModel, r] of Object.entries(slice.models || {})) {
      const key = effectiveModelKey(rawModel, query.modelViewMode);
      if (filter && query.disabledModels.has(key)) continue;

      const m = (models[key] ??= createEmptyBucket());
      for (const k of COUNT_KEYS) m[k] += r[k] || 0;

      const rowCost = calculateBucketCost(rawModel, r, slice.date, query.pricingOverrides);
      const mc = (modelCosts[key] ??= createEmptyCostBucket());
      if (rowCost === null) {
        mc.unpricedTokens += r.total || 0;
        unpricedTokens += r.total || 0;
      } else {
        mc.costUsd += rowCost;
        mc.pricedTokens += r.total || 0;
        costUsd += rowCost;
        pricedTokens += r.total || 0;
      }

      const gv = (modelVariants[key] ??= {});
      const v = (gv[rawModel] ??= createEmptyBucket());
      for (const k of COUNT_KEYS) v[k] += r[k] || 0;

      const gvc = (variantCosts[key] ??= {});
      const vc = (gvc[rawModel] ??= createEmptyCostBucket());
      if (rowCost === null) {
        vc.unpricedTokens += r.total || 0;
      } else {
        vc.costUsd += rowCost;
        vc.pricedTokens += r.total || 0;
      }

      total += r.total || 0;
      requests += r.requests || 0;
    }
  }

  return {
    from: rangeMeta.from,
    to: rangeMeta.to,
    xLabel: rangeMeta.xLabel,
    displayRange: rangeMeta.displayRange,
    models,
    modelVariants,
    modelCosts,
    variantCosts,
    users: {},
    legacyTokens: 0,
    total,
    requests,
    costUsd,
    pricedTokens,
    unpricedTokens,
  };
}

export interface QuotaCycleViewData {
  buckets: UsageTotalsResult[];
  allRangeTotals: UsageTotalsResult;
  filteredRangeTotals: UsageTotalsResult;
  rangeLabel: string;
}

/**
 * 将后端返回的额度周期快照转为与堆叠柱状图、明细表、Tooltip 兼容的聚合视图。
 */
export function buildQuotaCycleView(
  snapshot: QuotaCycleUsageSnapshot | null | undefined,
  query: AggregationQuery,
): QuotaCycleViewData {
  if (!snapshot || !snapshot.cycle) {
    const empty = aggregateSlices([], query, true, { from: '', to: '' });
    return {
      buckets: [],
      allRangeTotals: empty,
      filteredRangeTotals: empty,
      rangeLabel: '—',
    };
  }
  const slices = snapshot.slices || [];
  const buckets = slices.map((slice) =>
    aggregateSlices([slice], query, true, {
      from: slice.key,
      to: slice.key,
      xLabel: slice.label,
      displayRange: slice.rangeLabel,
    }),
  );
  const rangeLabel = formatQuotaCycleRange(snapshot.cycle, snapshot.timeZone);
  const overallMeta = {
    from: slices[0]?.date || '',
    to: slices.at(-1)?.date || '',
    displayRange: rangeLabel,
  };
  const allRangeTotals = aggregateSlices(slices, query, false, overallMeta);
  const filteredRangeTotals = aggregateSlices(slices, query, true, overallMeta);
  return {
    buckets,
    allRangeTotals,
    filteredRangeTotals,
    rangeLabel,
  };
}
