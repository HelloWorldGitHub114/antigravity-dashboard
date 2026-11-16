import type {
  SubagentItem,
  TaskUsageState,
  TaskUsageSummary,
} from '../../contracts/metrics.ts';
import type { DelegatedTaskState } from './delegated-types.ts';
import { resolveTaskHint } from './hints.ts';
import { aggregateTaskUsage, safeTaskUsage } from './task-usage.ts';

export function createDelegatedTaskState(
  id: string,
  scope: string,
  saved: unknown,
): DelegatedTaskState {
  return {
    id,
    scope,
    children: new Set(),
    hints: new Map(),
    sources: new Map(),
    modelSources: new Map(),
    details: new Map(),
    childTimelines: new Map(),
    failures: new Map(),
    staleSources: new Set(),
    attempted: new Map(),
    order: 0,
    bytes: 0,
    lastAt: -Infinity,
    requested: false,
    force: false,
    result: safeTaskUsage(saved),
    truncated: false,
    planModel: null,
    activeModel: null,
  };
}

export function buildTaskResult(
  task: DelegatedTaskState,
  state: TaskUsageState,
  summaries: Record<string, unknown>,
): TaskUsageSummary {
  const childRows = [...task.children]
    .filter((id) => task.sources.has(id))
    .map((id) => task.sources.get(id)!.rows);
  const rootModelRows = task.modelSources?.get(task.id)?.rows || [];
  const childModelRowSets = [...task.children]
    .filter((id) => task.modelSources?.has(id))
    .map((id) => task.modelSources.get(id)!.rows);
  const items: SubagentItem[] = [...task.children].map((id) => {
    const d = task.details?.get(id);
    if (d) return d;
    const { role, parentId, depth } = resolveTaskHint(task, id, summaries);
    return {
      id,
      role,
      parentId,
      depth,
      model: null,
      tps: null,
      latestTps: null,
      latestRateStatus: 'missing',
      totalTokens: null,
      context: null,
      status: task.failures.has(id) ? 'CASCADE_RUN_STATUS_ERROR' : 'CASCADE_RUN_STATUS_RUNNING',
      steps: 0,
    };
  });
  const res = aggregateTaskUsage(task.sources.get(task.id)?.rows || [], childRows, {
    subagents: task.children.size,
    loadedSubagents: childRows.length,
    state: task.truncated || task.staleSources.size ? 'partial' : state,
    items,
    rootModelRecords: rootModelRows,
    childModelRecordSets: childModelRowSets,
    planModel: task.planModel || null,
    activeModel: task.activeModel || null,
  });
  // On restart, numeric saved task totals remain visible until the first pass
  // can account for every known child. They are never treated as fresh/complete.
  const savedTotal = task.result?.tokens?.totalTokens;
  if (
    typeof savedTotal === 'number' &&
    Number.isSafeInteger(savedTotal) &&
    (res.tokens?.totalTokens === null ||
      res.tokens?.totalTokens === undefined ||
      savedTotal > res.tokens.totalTokens)
  ) {
    const bestModelUsage =
      (res.modelUsage?.totalTokens || 0) >= savedTotal && res.modelUsage?.models?.length
        ? res.modelUsage
        : task.result?.modelUsage || res.modelUsage;
    return {
      ...task.result!,
      tokens: { ...task.result!.tokens, complete: false },
      cache: { ...task.result!.cache, complete: false },
      subagents: Math.max(task.children.size, task.result!.subagents),
      state: state === 'loading' ? 'loading' : 'partial',
      complete: false,
      items,
      ...(bestModelUsage ? { modelUsage: bestModelUsage } : {}),
    };
  }
  return res;
}
