import type { QuotaGroup, QuotaWindow } from '../../contracts/metrics.ts';
import { tokenCount } from './primitives.ts';

interface RawQuotaBucket {
  bucketId?: unknown;
  window?: unknown;
  remainingFraction?: unknown;
  remainingAmount?: unknown;
  resetTime?: unknown;
  disabled?: unknown;
  description?: unknown;
}

interface RawQuotaGroup {
  displayName?: unknown;
  description?: unknown;
  buckets?: unknown;
}

export function quotaMetrics(response: unknown, now = Date.now()): QuotaGroup[] {
  const resp = response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  const root =
    resp.response && typeof resp.response === 'object'
      ? (resp.response as Record<string, unknown>)
      : resp;

  const rawGroups = Array.isArray(root.groups) && root.groups.length
    ? (root.groups as RawQuotaGroup[])
    : Array.isArray(root.buckets) && root.buckets.length
      ? [{ displayName: '账户额度', buckets: root.buckets }]
      : [];

  return rawGroups.map((group, index): QuotaGroup => {
    const buckets = Array.isArray(group?.buckets) ? (group.buckets as RawQuotaBucket[]) : [];
    const firstBucketId = typeof buckets[0]?.bucketId === 'string' ? buckets[0].bucketId : '';
    const windows = Object.fromEntries(
      (['5h', 'weekly'] as const).map((window): [string, QuotaWindow] => {
        const bucket = buckets.find(
          (b) => b?.window === window || (typeof b?.bucketId === 'string' && b.bucketId.endsWith(`-${window}`)),
        );
        if (!bucket) {
          return [window, { available: false, reason: '账户未返回此额度窗口' }];
        }
        const fraction = Number(bucket.remainingFraction);
        const remaining =
          bucket.remainingFraction !== undefined &&
          Number.isFinite(fraction) &&
          fraction >= 0 &&
          fraction <= 1
            ? fraction
            : null;
        const date = typeof bucket.resetTime === 'string' ? Date.parse(bucket.resetTime) : NaN;
        return [
          window,
          {
            available: true,
            id: typeof bucket.bucketId === 'string' ? bucket.bucketId : '',
            remaining,
            amount: tokenCount(bucket.remainingAmount),
            resetAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
            expired: Number.isFinite(date) && date <= now,
            disabled: bucket.disabled === true,
            description: typeof bucket.description === 'string' ? bucket.description : '',
          },
        ];
      }),
    );

    return {
      id: firstBucketId.replace(/-(5h|weekly)$/, '') || `group-${index}`,
      name: typeof group?.displayName === 'string' && group.displayName ? group.displayName : `额度组 ${index + 1}`,
      description: typeof group?.description === 'string' ? group.description : '',
      windows,
    };
  });
}
