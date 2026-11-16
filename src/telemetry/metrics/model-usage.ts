import type { ModelRole, ModelUsageBucket, ModelUsageSummary } from '../../contracts/metrics.ts';
import { formatModelName, isOrchestratorModel, normalizeModelId } from '../context.ts';
import { safeAdd, tokenCount } from './primitives.ts';

const MODEL_ROLES = new Set<ModelRole>(['plan', 'worker', 'subagent', 'model']);
const ROLE_ORDER: Record<ModelRole, number> = { plan: 0, worker: 1, model: 2, subagent: 3 };

export interface RawModelBucket {
  id: string;
  name?: string | null;
  hasOwn?: boolean;
  hasChild?: boolean;
  requests?: number;
  inputTokens?: number;
  uncachedTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  totalTokens?: number;
}

export interface BuildModelUsageOptions {
  planModel?: string | null;
  activeModel?: string | null;
  maxModels?: number;
}

export function buildModelUsage(
  rawBuckets: Iterable<RawModelBucket> | null | undefined,
  { planModel = null, activeModel = null, maxModels = 64 }: BuildModelUsageOptions = {},
): ModelUsageSummary {
  const cleanPlan = formatModelName(planModel);
  const cleanActive = formatModelName(activeModel);
  const list = [...(rawBuckets || [])].filter(
    (b): b is RawModelBucket => Boolean(b && typeof b === 'object' && typeof b.id === 'string' && b.id),
  );
  const ownBuckets = list.filter((b) => b.hasOwn !== false);
  const planId = cleanPlan ? normalizeModelId(cleanPlan) : null;
  const hasHybridOwn =
    ownBuckets.length > 1 ||
    ownBuckets.some((b) => isOrchestratorModel(b.name)) ||
    Boolean(planId && ownBuckets.some((b) => b.id !== planId));

  const models: ModelUsageBucket[] = list.map((b) => {
    let role: ModelRole;
    if (b.hasOwn === false && b.hasChild === true) {
      role = 'subagent';
    } else if (hasHybridOwn) {
      role = (planId && b.id === planId) || isOrchestratorModel(b.name) ? 'plan' : 'worker';
    } else {
      role = 'model';
    }
    const uncachedTokens = tokenCount(b.uncachedTokens) ?? 0;
    const cachedTokens = tokenCount(b.cachedTokens) ?? 0;
    const cacheWriteTokens = tokenCount(b.cacheWriteTokens) ?? 0;
    const inputTokens =
      tokenCount(b.inputTokens) ?? safeAdd(safeAdd(uncachedTokens, cachedTokens), cacheWriteTokens);
    const outputTokens = tokenCount(b.outputTokens) ?? 0;
    const thinkingTokens = tokenCount(b.thinkingTokens) ?? 0;
    const totalTokens = tokenCount(b.totalTokens) ?? safeAdd(inputTokens, outputTokens);
    const requests = tokenCount(b.requests) ?? 0;
    const name = formatModelName(b.name || b.id) || 'Unknown';
    const id = normalizeModelId(b.id) || normalizeModelId(name) || 'unknown';
    return {
      id,
      name,
      role,
      requests,
      inputTokens,
      uncachedTokens,
      cachedTokens,
      cacheWriteTokens,
      outputTokens,
      thinkingTokens,
      totalTokens,
    };
  });

  models.sort(
    (a, b) =>
      b.totalTokens - a.totalTokens ||
      b.requests - a.requests ||
      (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) ||
      a.name.localeCompare(b.name),
  );

  const capped = models.slice(0, Math.max(1, maxModels));
  let totalTokens = 0;
  let outputTokens = 0;
  let totalRequests = 0;
  for (const m of capped) {
    totalTokens = safeAdd(totalTokens, m.totalTokens);
    outputTokens = safeAdd(outputTokens, m.outputTokens);
    totalRequests = safeAdd(totalRequests, m.requests);
  }
  return {
    planModel: cleanPlan,
    activeModel: cleanActive,
    totalTokens,
    outputTokens,
    totalRequests,
    models: capped,
  };
}

export function safeModelUsage(
  value: unknown,
  { maxModels = 64 }: { maxModels?: number } = {},
): ModelUsageSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.models)) return null;

  const models: ModelUsageBucket[] = [];
  const seen = new Set<string>();
  for (const item of raw.models) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const name = formatModelName(rec.name || rec.id);
    const id = normalizeModelId(rec.id || name);
    if (!name || !id || seen.has(id)) continue;
    const requests = tokenCount(rec.requests);
    const uncachedTokens = tokenCount(rec.uncachedTokens) ?? 0;
    const cachedTokens = tokenCount(rec.cachedTokens) ?? 0;
    const cacheWriteTokens = tokenCount(rec.cacheWriteTokens) ?? 0;
    const inputTokens =
      tokenCount(rec.inputTokens) ?? safeAdd(safeAdd(uncachedTokens, cachedTokens), cacheWriteTokens);
    const outputTokens = tokenCount(rec.outputTokens);
    const thinkingTokens = tokenCount(rec.thinkingTokens) ?? 0;
    const totalTokens =
      tokenCount(rec.totalTokens) ?? (outputTokens !== null ? safeAdd(inputTokens, outputTokens) : null);
    if (requests === null || outputTokens === null || totalTokens === null) continue;
    const role: ModelRole = MODEL_ROLES.has(rec.role as ModelRole) ? (rec.role as ModelRole) : 'model';
    seen.add(id);
    models.push({
      id,
      name,
      role,
      requests,
      inputTokens,
      uncachedTokens,
      cachedTokens,
      cacheWriteTokens,
      outputTokens,
      thinkingTokens,
      totalTokens,
    });
    if (models.length >= Math.max(1, maxModels)) break;
  }

  let totalTokens = 0;
  let outputTokens = 0;
  let totalRequests = 0;
  for (const m of models) {
    totalTokens = safeAdd(totalTokens, m.totalTokens);
    outputTokens = safeAdd(outputTokens, m.outputTokens);
    totalRequests = safeAdd(totalRequests, m.requests);
  }
  return {
    planModel: formatModelName(raw.planModel),
    activeModel: formatModelName(raw.activeModel),
    totalTokens,
    outputTokens,
    totalRequests,
    models,
  };
}
