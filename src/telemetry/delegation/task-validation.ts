import type {
  CacheMetrics,
  LatestRateStatus,
  SubagentContextSummary,
  SubagentItem,
  TaskUsageState,
  TaskUsageSummary,
  TokenSummary,
} from '../../contracts/metrics.ts';
import { safeModelUsage } from '../metrics/index.ts';

const GUID =
  /^(?:[a-zA-Z0-9_.-]+\/)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const tokenValues = [
  'inputTokens',
  'cachedTokens',
  'cacheWriteTokens',
  'uncachedTokens',
  'outputTokens',
  'totalTokens',
] as const;

const tokenCounts = [
  'measuredRequests',
  'inputRequests',
  'outputRequests',
  'missingInputRequests',
  'missingOutputRequests',
  'uncachedRequests',
  'cachedRequests',
  'cacheWriteRequests',
] as const;

const cacheValues = [
  'inputTokens',
  'cachedTokens',
  'cacheWriteTokens',
  'uncachedTokens',
  'outputTokens',
  'totalTokens',
] as const;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const checkedAdd = (values: unknown[]): number | null => {
  if (!values.every(isCount)) return null;
  const sum = values.reduce<number>((n, value) => n + value, 0);
  return isCount(sum) ? sum : null;
};

function safeSubagentContext(value: unknown): SubagentContextSummary | null {
  if (!isObject(value)) return null;
  const usedTokens = isCount(value.usedTokens) ? value.usedTokens : null;
  if (usedTokens === null) return null;
  const maxTokens = isCount(value.maxTokens) && value.maxTokens > 0 ? value.maxTokens : null;
  return {
    usedTokens,
    maxTokens,
    usedFraction: maxTokens === null ? null : usedTokens / maxTokens,
  };
}

const PLACEHOLDER_ROLES = new Set(['未命名会话', 'Untitled Session']);

function sanitizeRole(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || PLACEHOLDER_ROLES.has(trimmed)) return null;
  return trimmed.slice(0, 128);
}

export function safeSubagentItem(item: unknown): SubagentItem | null {
  if (!isObject(item) || typeof item.id !== 'string' || !GUID.test(item.id)) return null;
  const rateStatus: LatestRateStatus = ['ok', 'missing', 'unreliable', 'legacy'].includes(
    item.latestRateStatus as string,
  )
    ? (item.latestRateStatus as LatestRateStatus)
    : 'missing';
  return {
    id: item.id.toLowerCase(),
    role: sanitizeRole(item.role),
    parentId:
      typeof item.parentId === 'string' && GUID.test(item.parentId)
        ? item.parentId.toLowerCase()
        : null,
    depth: isCount(item.depth) ? item.depth : 1,
    model: typeof item.model === 'string' ? item.model.slice(0, 128) : null,
    tps: typeof item.tps === 'number' && Number.isFinite(item.tps) && item.tps >= 0 ? item.tps : null,
    latestTps:
      typeof item.latestTps === 'number' && Number.isFinite(item.latestTps) && item.latestTps >= 0
        ? item.latestTps
        : null,
    latestRateStatus: rateStatus,
    totalTokens: isCount(item.totalTokens) ? item.totalTokens : null,
    context: safeSubagentContext(item.context),
    status:
      typeof item.status === 'string' && /^[A-Z0-9_]+$/.test(item.status) ? item.status : null,
    steps: isCount(item.steps) ? item.steps : 0,
  };
}

// Strict structural validation, with conservative completeness. No raw rows,
// identifiers, provider labels, titles or caller-supplied extra keys survive.
export function safeTaskUsage(value: unknown): TaskUsageSummary | null {
  if (!isObject(value) || !isObject(value.tokens) || !isObject(value.cache)) return null;
  const t = value.tokens;
  const c = value.cache;

  if (
    !tokenValues.every((key) => t[key] === null || isCount(t[key])) ||
    !tokenCounts.every((key) => isCount(t[key])) ||
    !cacheValues.every((key) => c[key] === null || isCount(c[key])) ||
    !(['measuredRequests', 'missingRequests'] as const).every((key) => isCount(c[key])) ||
    !(['ownTokens', 'subagentTokens'] as const).every(
      (key) => value[key] === null || isCount(value[key]),
    ) ||
    !isCount(value.subagents) ||
    !isCount(value.loadedSubagents) ||
    value.loadedSubagents > value.subagents ||
    typeof t.complete !== 'boolean' ||
    typeof t.outputAvailable !== 'boolean' ||
    typeof c.complete !== 'boolean' ||
    typeof value.complete !== 'boolean'
  ) {
    return null;
  }

  const rawState = value.state === 'unavailable' ? 'partial' : value.state;
  if (!['ready', 'partial', 'loading'].includes(rawState as string)) return null;
  const state = rawState as TaskUsageState;

  const tInputReq = t.inputRequests as number;
  const tMissingInputReq = t.missingInputRequests as number;
  const tOutputReq = t.outputRequests as number;
  const tMissingOutputReq = t.missingOutputRequests as number;
  const tMeasuredReq = t.measuredRequests as number;
  const tUncachedReq = t.uncachedRequests as number;
  const tCachedReq = t.cachedRequests as number;
  const tCacheWriteReq = t.cacheWriteRequests as number;
  const cMeasuredReq = c.measuredRequests as number;
  const cMissingReq = c.missingRequests as number;

  const requests = checkedAdd([tInputReq, tMissingInputReq]);
  if (
    requests === null ||
    requests !== checkedAdd([tOutputReq, tMissingOutputReq]) ||
    requests !== checkedAdd([cMeasuredReq, cMissingReq]) ||
    tokenCounts.some((key) => (t[key] as number) > requests) ||
    tInputReq > Math.min(tUncachedReq, tCachedReq, tCacheWriteReq) ||
    tMeasuredReq <
      Math.max(tInputReq, tOutputReq, tUncachedReq, tCachedReq, tCacheWriteReq) ||
    cMeasuredReq > tInputReq
  ) {
    return null;
  }

  if (
    t.inputTokens !== checkedAdd([t.uncachedTokens, t.cachedTokens, t.cacheWriteTokens]) ||
    t.totalTokens !== checkedAdd([t.inputTokens, t.outputTokens]) ||
    c.inputTokens !== checkedAdd([c.uncachedTokens, c.cachedTokens, c.cacheWriteTokens]) ||
    c.totalTokens !== checkedAdd([c.inputTokens, c.outputTokens]) ||
    t.totalTokens !== checkedAdd([value.ownTokens, value.subagentTokens])
  ) {
    return null;
  }

  if (
    (['uncachedTokens', 'cachedTokens', 'cacheWriteTokens', 'inputTokens', 'outputTokens'] as const).some(
      (key) => isCount(c[key]) && isCount(t[key]) && (c[key] as number) > (t[key] as number),
    )
  ) {
    return null;
  }

  const cInput = c.inputTokens as number | null;
  const ratio =
    cInput !== null && cInput > 0 && isCount(c.cachedTokens) ? c.cachedTokens / cInput : null;
  if (
    c.hitRate !== ratio ||
    (c.hitRate !== null &&
      (typeof c.hitRate !== 'number' || !Number.isFinite(c.hitRate) || c.hitRate < 0 || c.hitRate > 1))
  ) {
    return null;
  }

  const covered = state === 'ready' && value.loadedSubagents === value.subagents;
  const tokens: TokenSummary = {
    inputTokens: t.inputTokens as number | null,
    cachedTokens: t.cachedTokens as number | null,
    cacheWriteTokens: t.cacheWriteTokens as number | null,
    uncachedTokens: t.uncachedTokens as number | null,
    outputTokens: t.outputTokens as number | null,
    totalTokens: t.totalTokens as number | null,
    measuredRequests: tMeasuredReq,
    inputRequests: tInputReq,
    outputRequests: tOutputReq,
    missingInputRequests: tMissingInputReq,
    missingOutputRequests: tMissingOutputReq,
    uncachedRequests: tUncachedReq,
    cachedRequests: tCachedReq,
    cacheWriteRequests: tCacheWriteReq,
    outputAvailable: isCount(t.outputTokens) && tOutputReq > 0,
    complete:
      t.complete &&
      covered &&
      tMissingInputReq === 0 &&
      tMissingOutputReq === 0 &&
      tokenValues.every((key) => isCount(t[key])),
  };

  const cache: CacheMetrics = {
    inputTokens: c.inputTokens as number | null,
    cachedTokens: c.cachedTokens as number | null,
    cacheWriteTokens: c.cacheWriteTokens as number | null,
    uncachedTokens: c.uncachedTokens as number | null,
    outputTokens: c.outputTokens as number | null,
    totalTokens: c.totalTokens as number | null,
    measuredRequests: cMeasuredReq,
    missingRequests: cMissingReq,
    hitRate: ratio,
    complete: c.complete && covered && cMissingReq === 0 && cacheValues.every((key) => isCount(c[key])),
  };

  const res: TaskUsageSummary = {
    tokens,
    cache,
    ownTokens: value.ownTokens as number | null,
    subagentTokens: value.subagentTokens as number | null,
    subagents: value.subagents,
    loadedSubagents: value.loadedSubagents,
    state,
    complete: value.complete && tokens.complete && covered,
  };
  if (Array.isArray(value.items)) {
    const items = value.items.map(safeSubagentItem).filter((item): item is SubagentItem => item !== null);
    if (items.length) res.items = items;
  }
  if (value.modelUsage != null) {
    const mu = safeModelUsage(value.modelUsage);
    if (mu) res.modelUsage = mu;
  }
  return res;
}
