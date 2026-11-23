import type { UsageRecord } from '../../contracts/usage.ts';
import {
  extractRequestIdentity,
  type GeneratorMetadataLike,
  type TrajectoryStepLike,
} from '../identity.ts';
import {
  buildChatRateSample,
  requestCacheMetrics,
  seconds,
  tokenCount,
} from '../metrics/index.ts';
import { classifyRates, type RateSample } from '../rate-quality.ts';
import { cleanModel, recordSum } from './helpers.ts';

export interface RawTrajectoryContainer {
  trajectory?: {
    steps?: readonly TrajectoryStepLike[] | null;
    generatorMetadata?: readonly GeneratorMetadataLike[] | null;
  } | null;
}

function toSafeMs(sec: number | null): number | null {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return null;
  const ms = Math.round(sec * 1000);
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

function hasTiming(r: Pick<UsageRecord, 'ttftMs' | 'streamMs' | 'tps'>): boolean {
  return r.ttftMs != null || r.streamMs != null || r.tps != null;
}

/**
 * Extracts normalized, hashed per-request usage records from a raw trajectory payload,
 * including per-request TTFT, streaming duration, and quality-checked TPS when reported.
 */
export function usageRecords(raw: unknown, conversationId?: string | null): UsageRecord[] {
  const container = (raw && typeof raw === 'object' ? raw : {}) as RawTrajectoryContainer;
  const trajectory = container.trajectory || {};
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
  const generators = Array.isArray(trajectory.generatorMetadata) ? trajectory.generatorMetadata : [];

  const pending: Array<{
    row: UsageRecord;
    sample: RateSample;
    ttftMs: number | null;
    streamMs: number | null;
  }> = [];

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

    const visible = tokenCount(u.responseOutputTokens);
    const thinking = tokenCount(u.thinkingOutputTokens);
    const rawVisible =
      visible ?? (output !== null && thinking !== null ? Math.max(0, output - thinking) : output);
    const duration = seconds(chat.streamingDuration);
    const ttft = seconds(chat.timeToFirstToken);
    const sample = buildChatRateSample(g, chat, u, steps, {
      output,
      visible,
      thinking,
      rawVisible,
      duration,
      ttft,
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

    pending.push({
      row,
      sample,
      ttftMs: toSafeMs(ttft),
      streamMs: toSafeMs(duration),
    });
  }

  // 复用主面板一致的测速质量校验，过滤工具调用缓冲突发与异常短窗
  classifyRates(pending.map((p) => p.sample));

  const rows = new Map<string, UsageRecord>();
  for (const { row, sample, ttftMs, streamMs } of pending) {
    const tps =
      sample.status === 'ok' &&
      sample.tps !== null &&
      Number.isFinite(sample.tps) &&
      sample.tps > 0
        ? Math.round(sample.tps * 10) / 10
        : null;
    if (ttftMs !== null) row.ttftMs = ttftMs;
    if (streamMs !== null) row.streamMs = streamMs;
    if (tps !== null) row.tps = tps;

    const old = rows.get(row.id);
    if (!old) {
      rows.set(row.id, row);
      continue;
    }
    const nextSum = recordSum(row);
    const oldSum = recordSum(old);
    if (nextSum > oldSum || (nextSum === oldSum && hasTiming(row) && !hasTiming(old))) {
      // 若胜出记录缺少某项耗时字段，保留旧记录已有耗时避免信息回退
      if (row.ttftMs === undefined && old.ttftMs !== undefined) row.ttftMs = old.ttftMs;
      if (row.streamMs === undefined && old.streamMs !== undefined) row.streamMs = old.streamMs;
      if (row.tps === undefined && old.tps !== undefined) row.tps = old.tps;
      rows.set(row.id, row);
    } else if (nextSum === oldSum && !hasTiming(old) && hasTiming(row)) {
      rows.set(row.id, row);
    }
  }

  return [...rows.values()];
}
