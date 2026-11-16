import type { ModelUsageSummary } from '../../contracts/metrics.ts';
import { formatModelName, normalizeModelId } from '../context.ts';
import {
  extractRequestIdentity,
  type GeneratorMetadataLike,
  type TrajectoryStepLike,
} from '../identity.ts';
import {
  buildModelUsage,
  resolveChatModelName,
  tokenCount,
  type RawModelBucket,
} from '../metrics/index.ts';

const HASH = /^[a-f0-9]{64}$/;

export interface TaskModelRecord {
  id: string;
  modelId: string;
  modelName: string;
  uncachedTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const modelNum = (value: number | null | undefined): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

const modelCoverage = (row: TaskModelRecord): number =>
  (['uncachedTokens', 'cachedTokens', 'cacheWriteTokens', 'outputTokens'] as const).reduce(
    (n, k) => n + (row[k] !== null ? 1 : 0),
    0,
  );

const modelSum = (row: TaskModelRecord): bigint =>
  BigInt(row.uncachedTokens ?? 0) +
  BigInt(row.cachedTokens ?? 0) +
  BigInt(row.cacheWriteTokens ?? 0) +
  BigInt(row.outputTokens ?? 0);

function normalizeModelRecord(value: unknown): TaskModelRecord | null {
  if (!isObject(value) || typeof value.id !== 'string' || !HASH.test(value.id)) return null;
  const modelName = formatModelName(value.modelName || value.modelId) || 'Unknown';
  const modelId = normalizeModelId(value.modelId || modelName) || 'unknown';
  return {
    id: value.id,
    modelId,
    modelName,
    uncachedTokens: isCount(value.uncachedTokens) ? value.uncachedTokens : null,
    cachedTokens: isCount(value.cachedTokens) ? value.cachedTokens : null,
    cacheWriteTokens: isCount(value.cacheWriteTokens) ? value.cacheWriteTokens : null,
    outputTokens: isCount(value.outputTokens) ? value.outputTokens : null,
    thinkingTokens: isCount(value.thinkingTokens) ? value.thinkingTokens : 0,
  };
}

function richerModelRow(previous: TaskModelRecord, next: TaskModelRecord): TaskModelRecord {
  const a = modelCoverage(previous);
  const b = modelCoverage(next);
  if (a !== b) return b > a ? next : previous;
  return modelSum(next) > modelSum(previous) ? next : previous;
}

export function taskModelRecords(raw: unknown, conversationId: unknown): TaskModelRecord[] {
  const rawObj = isObject(raw) ? raw : null;
  const trajectory = rawObj && isObject(rawObj.trajectory) ? rawObj.trajectory : {};
  const steps: TrajectoryStepLike[] = Array.isArray(trajectory.steps)
    ? (trajectory.steps as TrajectoryStepLike[])
    : [];
  const generators: GeneratorMetadataLike[] = Array.isArray(trajectory.generatorMetadata)
    ? (trajectory.generatorMetadata as GeneratorMetadataLike[])
    : [];
  const rows = new Map<string, TaskModelRecord>();

  for (const [index, g] of generators.entries()) {
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
    const modelName = resolveChatModelName(chat) || 'Unknown';
    const modelId = normalizeModelId(modelName) || 'unknown';
    const row: TaskModelRecord = {
      id,
      modelId,
      modelName,
      uncachedTokens: input,
      cachedTokens: u.cacheReadTokens === undefined && input !== null ? 0 : tokenCount(u.cacheReadTokens),
      cacheWriteTokens:
        u.cacheWriteTokens === undefined && input !== null ? 0 : tokenCount(u.cacheWriteTokens),
      outputTokens: tokenCount(u.outputTokens),
      thinkingTokens: tokenCount(u.thinkingOutputTokens) ?? 0,
    };
    const previous = rows.get(row.id);
    rows.set(row.id, previous ? richerModelRow(previous, row) : row);
  }
  return [...rows.values()];
}

export function mergeTaskModelRecords(previousRows: unknown, nextRows: unknown): TaskModelRecord[] {
  const unique = (values: unknown): Map<string, TaskModelRecord> => {
    const result = new Map<string, TaskModelRecord>();
    for (const value of Array.isArray(values) ? values : []) {
      const row = normalizeModelRecord(value);
      if (!row) continue;
      const old = result.get(row.id);
      result.set(row.id, old ? richerModelRow(old, row) : row);
    }
    return result;
  };
  const previous = unique(previousRows);
  const next = unique(nextRows);
  const merged = new Map(previous);
  for (const [id, row] of next) {
    const old = previous.get(id);
    const keep = old && (modelCoverage(old) > modelCoverage(row) || modelSum(old) > modelSum(row));
    if (!keep) merged.set(id, row);
  }
  return [...merged.values()];
}

export function aggregateTaskModelUsage(
  rootModelRows: unknown = [],
  childModelRowSets: unknown = [],
  options: { planModel?: string | null; activeModel?: string | null; maxModels?: number } = {},
): ModelUsageSummary {
  const deduped = new Map<string, { row: TaskModelRecord; own: boolean }>();
  const collect = (values: unknown, own: boolean): void => {
    for (const value of Array.isArray(values) ? values : []) {
      const row = normalizeModelRecord(value);
      if (!row) continue;
      const old = deduped.get(row.id);
      deduped.set(row.id, {
        row: old ? richerModelRow(old.row, row) : row,
        own: own || old?.own === true,
      });
    }
  };
  collect(rootModelRows, true);
  for (const child of Array.isArray(childModelRowSets) ? childModelRowSets : []) {
    collect(child, false);
  }

  const buckets = new Map<string, RawModelBucket>();
  for (const { row, own } of deduped.values()) {
    let bucket = buckets.get(row.modelId);
    if (!bucket) {
      bucket = {
        id: row.modelId,
        name: row.modelName,
        hasOwn: false,
        hasChild: false,
        requests: 0,
        inputTokens: 0,
        uncachedTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        totalTokens: 0,
      };
      buckets.set(row.modelId, bucket);
    }
    if (own) bucket.hasOwn = true;
    else bucket.hasChild = true;
    const uncached = modelNum(row.uncachedTokens);
    const cached = modelNum(row.cachedTokens);
    const write = modelNum(row.cacheWriteTokens);
    const input = uncached + cached + write;
    const output = modelNum(row.outputTokens);
    const thinking = modelNum(row.thinkingTokens);
    bucket.requests = (bucket.requests ?? 0) + 1;
    bucket.uncachedTokens = (bucket.uncachedTokens ?? 0) + uncached;
    bucket.cachedTokens = (bucket.cachedTokens ?? 0) + cached;
    bucket.cacheWriteTokens = (bucket.cacheWriteTokens ?? 0) + write;
    bucket.inputTokens = (bucket.inputTokens ?? 0) + input;
    bucket.outputTokens = (bucket.outputTokens ?? 0) + output;
    bucket.thinkingTokens = (bucket.thinkingTokens ?? 0) + thinking;
    bucket.totalTokens = (bucket.totalTokens ?? 0) + input + output;
  }

  return buildModelUsage(buckets.values(), {
    planModel: options.planModel || null,
    activeModel: options.activeModel || null,
    maxModels: options.maxModels || 64,
  });
}
