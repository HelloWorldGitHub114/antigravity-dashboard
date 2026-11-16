import {
  extractRequestIdentity,
  type GeneratorMetadataLike,
  type TrajectoryStepLike,
} from '../identity.ts';
import { tokenCount } from '../metrics/index.ts';

const HASH = /^[a-f0-9]{64}$/;
export const TASK_FIELDS = [
  'inputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
] as const;

export interface TaskUsageRecord {
  id: string;
  apiProvider: string;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const provider = (value: unknown): string =>
  typeof value === 'string' && /^(?:API_PROVIDER_)?(?:GOOGLE_GEMINI|OPENAI|ANTHROPIC)$/.test(value)
    ? value
    : '';

const coverage = (row: TaskUsageRecord): number =>
  TASK_FIELDS.reduce((n, key) => n + (row[key] !== null ? 1 : 0), 0);

const rowTotal = (row: TaskUsageRecord): bigint =>
  TASK_FIELDS.reduce((n, key) => n + BigInt(row[key] ?? 0), 0n);

const sameRecord = (a: TaskUsageRecord, b: TaskUsageRecord): boolean =>
  a.apiProvider === b.apiProvider && TASK_FIELDS.every((key) => a[key] === b[key]);

export function normalizedTaskRecord(value: unknown): TaskUsageRecord | null {
  if (!isObject(value) || typeof value.id !== 'string' || !HASH.test(value.id)) return null;
  return {
    id: value.id,
    apiProvider: provider(value.apiProvider),
    inputTokens: isCount(value.inputTokens) ? value.inputTokens : null,
    cacheReadTokens: isCount(value.cacheReadTokens) ? value.cacheReadTokens : null,
    cacheWriteTokens: isCount(value.cacheWriteTokens) ? value.cacheWriteTokens : null,
    outputTokens: isCount(value.outputTokens) ? value.outputTokens : null,
  };
}

// Prefer a more complete observation of one request, never add observations of
// the same request. A whole-row choice avoids combining conflicting counters.
export function richerTaskRecord(
  previous: TaskUsageRecord,
  next: TaskUsageRecord,
): TaskUsageRecord {
  const a = coverage(previous);
  const b = coverage(next);
  if (a !== b) return b > a ? next : previous;
  return rowTotal(next) > rowTotal(previous) ? next : previous;
}

export function mergeTaskRecords(
  previousRows: unknown,
  nextRows: unknown,
): { rows: TaskUsageRecord[]; restored: boolean } {
  const unique = (values: unknown): Map<string, TaskUsageRecord> => {
    const result = new Map<string, TaskUsageRecord>();
    for (const value of Array.isArray(values) ? values : []) {
      const row = normalizedTaskRecord(value);
      if (!row) continue;
      const old = result.get(row.id);
      result.set(row.id, old ? richerTaskRecord(old, row) : row);
    }
    return result;
  };
  const previous = unique(previousRows);
  const next = unique(nextRows);
  const merged = new Map(previous);
  let restored = false;
  for (const [id] of previous) {
    if (!next.has(id)) restored = true;
  }
  for (const [id, row] of next) {
    const old = previous.get(id);
    // A temporary metadata omission cannot erase recorded consumption or a
    // known component. Retain one coherent old row, not a synthetic field sum.
    const keep = old && (coverage(old) > coverage(row) || rowTotal(old) > rowTotal(row));
    if (keep) {
      if (!sameRecord(old, row)) restored = true;
    } else {
      merged.set(id, row);
    }
  }
  return { rows: [...merged.values()], restored };
}

export function contributionTotal(rows: TaskUsageRecord[]): number | null {
  // Contribution totals need no timing/cache transform. Nonnegative request
  // components make one checked sum equivalent to summarize(rows).totalTokens.
  let total = 0;
  for (const row of rows) {
    for (const key of TASK_FIELDS) {
      total += row[key] ?? 0;
      if (!isCount(total)) return null;
    }
  }
  return total;
}

export function taskRecords(raw: unknown, conversationId: unknown): TaskUsageRecord[] {
  const rawObj = isObject(raw) ? raw : null;
  const trajectory = rawObj && isObject(rawObj.trajectory) ? rawObj.trajectory : {};
  const steps: TrajectoryStepLike[] = Array.isArray(trajectory.steps)
    ? (trajectory.steps as TrajectoryStepLike[])
    : [];
  const generators: GeneratorMetadataLike[] = Array.isArray(trajectory.generatorMetadata)
    ? (trajectory.generatorMetadata as GeneratorMetadataLike[])
    : [];
  const rows = new Map<string, TaskUsageRecord>();

  for (const [index, g] of generators.entries()) {
    // Match trajectoryMetrics request presence. A malformed but present usage
    // container is an unknown request, not evidence that no request occurred.
    const chat = g?.chatModel;
    const rawUsage = chat?.usage;
    if (!rawUsage) continue;
    const u = isObject(rawUsage) ? rawUsage : {};
    const input = tokenCount(u.inputTokens);
    const id = extractRequestIdentity(g, {
      index,
      conversationId: conversationId as string | null | undefined,
      steps,
      fallback: 'conversation',
    }).hash;
    const row: TaskUsageRecord = {
      id,
      apiProvider: provider(u.apiProvider),
      inputTokens: input,
      cacheReadTokens:
        u.cacheReadTokens === undefined && input !== null ? 0 : tokenCount(u.cacheReadTokens),
      cacheWriteTokens:
        u.cacheWriteTokens === undefined && input !== null ? 0 : tokenCount(u.cacheWriteTokens),
      outputTokens: tokenCount(u.outputTokens),
    };
    const previous = rows.get(row.id);
    rows.set(row.id, previous ? richerTaskRecord(previous, row) : row);
  }
  return [...rows.values()];
}
