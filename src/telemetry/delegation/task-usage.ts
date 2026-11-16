// Task-scoped usage only. Request identities are hashed in memory and are never
// included in persisted task summaries; speed and context stay conversation-local.
import type {
  CacheMetrics,
  ModelUsageSummary,
  SubagentItem,
  TaskUsageState,
  TaskUsageSummary,
  TokenSummary,
} from '../../contracts/metrics.ts';
import { safeModelUsage, trajectoryMetrics } from '../metrics/index.ts';
import { aggregateTaskModelUsage } from './task-models.ts';
import {
  contributionTotal,
  normalizedTaskRecord,
  richerTaskRecord,
  type TaskUsageRecord,
} from './task-records.ts';
import { safeSubagentItem } from './task-validation.ts';

export { mergeTaskRecords, taskRecords, type TaskUsageRecord } from './task-records.ts';
export {
  taskModelRecords,
  mergeTaskModelRecords,
  aggregateTaskModelUsage,
  type TaskModelRecord,
} from './task-models.ts';
export { safeTaskUsage } from './task-validation.ts';

const tokenValues = [
  'inputTokens',
  'cachedTokens',
  'cacheWriteTokens',
  'uncachedTokens',
  'outputTokens',
  'totalTokens',
] as const;
const cacheValues = [
  'inputTokens',
  'cachedTokens',
  'cacheWriteTokens',
  'uncachedTokens',
  'outputTokens',
  'totalTokens',
] as const;

export interface AggregateTaskUsageOptions {
  subagents?: number;
  loadedSubagents?: number;
  state?: TaskUsageState | string;
  items?: unknown[];
  modelUsage?: ModelUsageSummary | null;
  rootModelRecords?: unknown;
  childModelRecordSets?: unknown;
  planModel?: string | null;
  activeModel?: string | null;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const checkedAdd = (values: Array<number | null | undefined>): number | null => {
  if (!values.every(isCount)) return null;
  const sum = values.reduce<number>((n, value) => n + value, 0);
  return isCount(sum) ? sum : null;
};

function summarize(rows: TaskUsageRecord[]): { tokens: TokenSummary; cache: CacheMetrics } {
  const raw = {
    trajectory: {
      generatorMetadata: rows.map((row) => ({
        chatModel: {
          usage: {
            inputTokens: row.inputTokens,
            cacheReadTokens: row.cacheReadTokens,
            cacheWriteTokens: row.cacheWriteTokens,
            outputTokens: row.outputTokens,
            messageId: row.id,
            apiProvider: row.apiProvider,
          },
        },
      })),
    },
  };
  const metrics = trajectoryMetrics(raw);
  const tokens: TokenSummary = { ...metrics.tokens };
  const cache: CacheMetrics = { ...metrics.cache };
  // trajectoryMetrics retains known lower-bound components. At task scope an
  // arithmetic overflow must remain unavailable, not become a smaller total.
  tokens.inputTokens = checkedAdd([
    tokens.uncachedTokens,
    tokens.cachedTokens,
    tokens.cacheWriteTokens,
  ]);
  tokens.totalTokens = checkedAdd([tokens.inputTokens, tokens.outputTokens]);
  tokens.outputAvailable = isCount(tokens.outputTokens) && (tokens.outputRequests ?? 0) > 0;
  tokens.complete = metrics.tokens.complete && tokenValues.every((key) => isCount(tokens[key]));
  for (const key of cacheValues) {
    if (!isCount(cache[key])) cache[key] = null;
  }
  cache.inputTokens = checkedAdd([cache.uncachedTokens, cache.cachedTokens, cache.cacheWriteTokens]);
  cache.totalTokens = checkedAdd([cache.inputTokens, cache.outputTokens]);
  cache.hitRate =
    cache.inputTokens !== null && cache.inputTokens > 0 && isCount(cache.cachedTokens)
      ? cache.cachedTokens / cache.inputTokens
      : null;
  cache.complete = metrics.cache.complete && cacheValues.every((key) => isCount(cache[key]));
  return { tokens, cache };
}

export function aggregateTaskUsage(
  rootRecords: unknown,
  childRecordSets: unknown = [],
  options: AggregateTaskUsageOptions = {},
): TaskUsageSummary {
  const rows = new Map<string, { row: TaskUsageRecord; own: boolean }>();
  const collect = (values: unknown, own: boolean): void => {
    for (const value of Array.isArray(values) ? values : []) {
      const row = normalizedTaskRecord(value);
      if (!row) continue;
      const old = rows.get(row.id);
      rows.set(row.id, {
        row: old ? richerTaskRecord(old.row, row) : row,
        own: own || old?.own === true,
      });
    }
  };
  collect(rootRecords, true);
  const children = Array.isArray(childRecordSets) ? childRecordSets : [];
  for (const child of children) collect(child, false);
  const all = [...rows.values()];
  const summary = summarize(all.map((value) => value.row));
  const subagents = isCount(options.subagents) ? options.subagents : children.length;
  const loadedSubagents = isCount(options.loadedSubagents)
    ? Math.min(options.loadedSubagents, subagents)
    : Math.min(children.length, subagents);
  let state: TaskUsageState = ['ready', 'partial', 'loading'].includes(options.state as string)
    ? (options.state as TaskUsageState)
    : options.state === undefined
      ? 'ready'
      : 'partial';
  if (state === 'ready' && (loadedSubagents !== subagents || !summary.tokens.complete)) {
    state = 'partial';
  }
  const complete = state === 'ready' && loadedSubagents === subagents && summary.tokens.complete;
  summary.tokens.complete = complete;
  summary.cache.complete = summary.cache.complete && state === 'ready' && loadedSubagents === subagents;

  const res: TaskUsageSummary = {
    ...summary,
    ownTokens: contributionTotal(all.filter((value) => value.own).map((value) => value.row)),
    subagentTokens: contributionTotal(all.filter((value) => !value.own).map((value) => value.row)),
    subagents,
    loadedSubagents,
    state,
    complete,
  };
  if (Array.isArray(options.items)) {
    const items = options.items
      .map(safeSubagentItem)
      .filter((item): item is SubagentItem => item !== null);
    if (items.length) res.items = items;
  }
  if (options.modelUsage) {
    const mu = safeModelUsage(options.modelUsage);
    if (mu) res.modelUsage = mu;
  } else if (Array.isArray(options.rootModelRecords) || Array.isArray(options.childModelRecordSets)) {
    res.modelUsage = aggregateTaskModelUsage(
      options.rootModelRecords || [],
      options.childModelRecordSets || [],
      {
        planModel: options.planModel || null,
        activeModel: options.activeModel || null,
      },
    );
  }
  return res;
}
