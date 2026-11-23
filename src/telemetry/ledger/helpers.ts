import { createHash } from 'node:crypto';
import type { UsageRecord } from '../../contracts/usage.ts';
import { HASH_RE, RECORD_KEYS } from './types.ts';

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export const cleanModel = (value: unknown): string =>
  String(value || 'Unknown').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120);

export const recordSum = (r: Pick<UsageRecord, 'uncached' | 'cacheRead' | 'cacheWrite' | 'output'>): number =>
  RECORD_KEYS.reduce((n, k) => n + (r[k] ?? 0), 0);

export function validRow(r: unknown): r is UsageRecord {
  if (!r || typeof r !== 'object') return false;
  const row = r as Record<string, unknown>;
  const validAt = row.at === null || (typeof row.at === 'number' && Number.isSafeInteger(row.at) && row.at >= 0);
  const validOptMs = (v: unknown): boolean =>
    v === undefined || v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
  const validOptRate = (v: unknown): boolean =>
    v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
  return (
    typeof row.id === 'string' &&
    HASH_RE.test(row.id) &&
    typeof row.model === 'string' &&
    row.model.length <= 120 &&
    validAt &&
    validOptMs(row.ttftMs) &&
    validOptMs(row.streamMs) &&
    validOptRate(row.tps) &&
    RECORD_KEYS.every(
      (k) => row[k] === null || (typeof row[k] === 'number' && Number.isSafeInteger(row[k]) && (row[k] as number) >= 0),
    )
  );
}

export function uniqueRecordIds(records: readonly UsageRecord[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      ids.push(r.id);
    }
  }
  return ids;
}

export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const run = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  };
  const count = Math.min(limit, items.length);
  if (count > 0) await Promise.all(Array.from({ length: count }, run));
  return results;
}

export function isErrno(error: unknown, ...codes: string[]): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' && codes.includes(code);
}
