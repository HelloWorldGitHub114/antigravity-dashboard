import type { UsageRecord } from '../../contracts/usage.ts';
import {
  extractRequestIdentity,
  type GeneratorMetadataLike,
  type TrajectoryStepLike,
} from '../identity.ts';
import { requestCacheMetrics, tokenCount } from '../metrics/index.ts';
import { cleanModel, recordSum } from './helpers.ts';

export interface RawTrajectoryContainer {
  trajectory?: {
    steps?: readonly TrajectoryStepLike[] | null;
    generatorMetadata?: readonly GeneratorMetadataLike[] | null;
  } | null;
}

/**
 * Extracts normalized, hashed per-request usage records from a raw trajectory payload.
 */
export function usageRecords(raw: unknown, conversationId?: string | null): UsageRecord[] {
  const container = (raw && typeof raw === 'object' ? raw : {}) as RawTrajectoryContainer;
  const trajectory = container.trajectory || {};
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
  const generators = Array.isArray(trajectory.generatorMetadata) ? trajectory.generatorMetadata : [];
  const rows = new Map<string, UsageRecord>();

  for (const [index, g] of generators.entries()) {
    const chat = g?.chatModel;
    const rawUsage = chat?.usage;
    if (!rawUsage || typeof rawUsage !== 'object') continue;
    const u = rawUsage as Record<string, unknown>;

    const output = tokenCount(u.outputTokens);
    const cache = requestCacheMetrics(u);
    const uncached = cache?.uncachedTokens ?? tokenCount(u.inputTokens);
    const read = tokenCount(u.cacheReadTokens) ?? (u.cacheReadTokens === undefined ? 0 : null);
    const write = tokenCount(u.cacheWriteTokens) ?? (u.cacheWriteTokens === undefined ? 0 : null);

    // Empty failed-attempt records have no reported consumption.
    if ([uncached, read, write, output].every((n) => n === null || n === 0)) continue;

    const identity = extractRequestIdentity(g, {
      index,
      conversationId,
      steps,
      fallback: 'conversation',
    });

    const row: UsageRecord = {
      id: identity.hash,
      at: identity.at,
      model: cleanModel(chat?.modelDisplayName || chat?.responseModel || u.model || chat?.model),
      uncached,
      cacheRead: read,
      cacheWrite: write,
      output,
      partial:
        uncached === null ||
        read === null ||
        write === null ||
        output === null ||
        (!cache && uncached > 0),
      timeBasis: identity.timeBasis,
    };

    const old = rows.get(row.id);
    if (!old || recordSum(row) > recordSum(old)) {
      rows.set(row.id, row);
    }
  }

  return [...rows.values()];
}
