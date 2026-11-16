import type { UsageBucketCounts, UsageDayBucket, UsageSummarySnapshot, UsageUserBucket } from '../../contracts/index.ts';
import { effectiveModelKey } from './palette.ts';
import type { ModelViewMode, UsageDimension, UsagePeriod, UsageTotalsResult } from './types.ts';

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function startOfWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

export function shiftMonth(date: string, shift: number): string {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + shift);
  return d.toISOString().slice(0, 10);
}

export interface AggregationQuery {
  dimension: UsageDimension;
  modelViewMode: ModelViewMode;
  disabledModels: Set<string>;
  disabledUsers: Set<string>;
}

const COUNT_KEYS: ReadonlyArray<keyof UsageBucketCounts> = [
  'total',
  'requests',
  'uncached',
  'cacheRead',
  'cacheWrite',
  'output',
];

function createEmptyBucket(): UsageBucketCounts {
  return { total: 0, requests: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

export class UsageDayIndex {
  readonly dayMap = new Map<string, UsageDayBucket>();
  sortedDays: UsageDayBucket[] = [];

  rebuild(value: UsageSummarySnapshot | null): void {
    this.dayMap.clear();
    const list: UsageDayBucket[] = [];
    for (const day of value?.days || []) {
      if (day?.date) {
        this.dayMap.set(day.date, day);
        list.push(day);
      }
    }
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    this.sortedDays = list;
  }

  totals(from: string, to: string, query: AggregationQuery, filter = false): UsageTotalsResult {
    const models: Record<string, UsageBucketCounts> = {};
    const modelVariants: Record<string, Record<string, UsageBucketCounts>> = {};
    const users: Record<string, UsageUserBucket> = {};
    let legacyTokens = 0;
    let total = 0;
    let requests = 0;

    const accum = (day: UsageDayBucket | undefined): void => {
      if (!day) return;
      legacyTokens += day.legacyTokens || 0;
      for (const [rawModel, r] of Object.entries(day.models || {})) {
        const key = query.dimension === 'model' ? effectiveModelKey(rawModel, query.modelViewMode) : rawModel;
        if (filter && query.dimension === 'model' && query.disabledModels.has(key)) continue;
        const m = (models[key] ??= createEmptyBucket());
        for (const k of COUNT_KEYS) m[k] += r[k] || 0;
        if (query.dimension === 'model') {
          const gv = (modelVariants[key] ??= {});
          const v = (gv[rawModel] ??= createEmptyBucket());
          for (const k of COUNT_KEYS) v[k] += r[k] || 0;
        }
        if (query.dimension !== 'user') {
          total += r.total || 0;
          requests += r.requests || 0;
        }
      }
      for (const [u, r] of Object.entries(day.users || {})) {
        if (filter && query.dimension === 'user' && query.disabledUsers.has(u)) continue;
        const usr = (users[u] ??= {
          name: r.name,
          userKey: u,
          isLegacy: r.isLegacy,
          ...createEmptyBucket(),
        });
        for (const k of COUNT_KEYS) usr[k] += r[k] || 0;
        if (query.dimension === 'user') {
          total += r.total || 0;
          requests += r.requests || 0;
        }
      }
    };

    if (from === to) {
      accum(this.dayMap.get(from));
    } else if (from <= to && this.sortedDays.length) {
      let lo = 0;
      let hi = this.sortedDays.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.sortedDays[mid].date < from) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < this.sortedDays.length; i++) {
        const day = this.sortedDays[i];
        if (day.date > to) break;
        accum(day);
      }
    }
    return { from, to, models, modelVariants, users, legacyTokens, total, requests };
  }

  aggregateHourlyRange(start: string, end: string): number[] {
    const hours = Array<number>(24).fill(0);
    if (start <= end && this.sortedDays.length) {
      let lo = 0;
      let hi = this.sortedDays.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.sortedDays[mid].date < start) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < this.sortedDays.length; i++) {
        const day = this.sortedDays[i];
        if (day.date > end) break;
        if (Array.isArray(day.hours)) {
          for (let h = 0; h < 24; h++) hours[h] += day.hours[h] || 0;
        }
      }
    }
    return hours;
  }

  buildPeriodBuckets(
    period: UsagePeriod,
    anchor: string,
    customStart: string,
    customEnd: string,
    query: AggregationQuery,
  ): { buckets: UsageTotalsResult[]; rangeLabel: string } {
    const buckets: UsageTotalsResult[] = [];
    let rangeLabel = '';
    if (period === 'day') {
      const start = shiftMonth(anchor, 0);
      const end = addDays(shiftMonth(anchor, 1), -1);
      for (let date = start; date <= end; date = addDays(date, 1)) {
        buckets.push(this.totals(date, date, query, true));
      }
      rangeLabel = start.slice(0, 7);
    } else if (period === 'week') {
      const start = addDays(startOfWeek(anchor), -11 * 7);
      for (let i = 0; i < 12; i++) {
        const from = addDays(start, i * 7);
        buckets.push(this.totals(from, addDays(from, 6), query, true));
      }
      rangeLabel = `${start.slice(5)} – ${addDays(startOfWeek(anchor), 6).slice(5)}`;
    } else if (period === 'month') {
      for (let i = -11; i <= 0; i++) {
        const from = shiftMonth(anchor, i);
        buckets.push(this.totals(from, addDays(shiftMonth(from, 1), -1), query, true));
      }
      rangeLabel = `${buckets[0].from.slice(0, 7)} – ${shiftMonth(anchor, 0).slice(0, 7)}`;
    } else {
      for (let date = customStart; date <= customEnd; date = addDays(date, 1)) {
        buckets.push(this.totals(date, date, query, true));
      }
      rangeLabel = `${customStart} – ${customEnd}`;
    }
    return { buckets, rangeLabel };
  }
}
