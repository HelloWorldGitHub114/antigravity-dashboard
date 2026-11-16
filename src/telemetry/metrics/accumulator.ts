import type { TokenCounts } from '../../contracts/metrics.ts';
import { formatModelName, normalizeModelId } from '../context.ts';
import type { GeneratorMetadataLike } from '../identity.ts';
import { resolveChatModelName } from './chat.ts';
import type { RawModelBucket } from './model-usage.ts';
import { requestCacheMetrics, safeAdd, seconds, tokenCount } from './primitives.ts';

export interface MutableTokens {
  inputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  uncachedTokens: number | null;
  outputTokens: number | null;
  measuredRequests: number;
  inputRequests: number;
  outputRequests: number;
  missingInputRequests: number;
  missingOutputRequests: number;
  uncachedRequests: number;
  cachedRequests: number;
  cacheWriteRequests: number;
}

export interface CacheAccumulator {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  uncachedTokens: number;
  outputTokens: number;
  measuredRequests: number;
  missingRequests: number;
}

export interface TrajectoryAccumulator {
  counts: TokenCounts;
  cache: CacheAccumulator;
  tokens: MutableTokens;
  modelBuckets: Map<string, RawModelBucket>;
  modelSeconds: number;
  ttftSeconds: number;
  ttftSamples: number;
}

export function createTrajectoryAccumulator(): TrajectoryAccumulator {
  return {
    counts: {
      input: 0,
      output: 0,
      responseOutput: 0,
      thinkingOutput: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    cache: {
      inputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      uncachedTokens: 0,
      outputTokens: 0,
      measuredRequests: 0,
      missingRequests: 0,
    },
    tokens: {
      inputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      uncachedTokens: 0,
      outputTokens: 0,
      measuredRequests: 0,
      inputRequests: 0,
      outputRequests: 0,
      missingInputRequests: 0,
      missingOutputRequests: 0,
      uncachedRequests: 0,
      cachedRequests: 0,
      cacheWriteRequests: 0,
    },
    modelBuckets: new Map(),
    modelSeconds: 0,
    ttftSeconds: 0,
    ttftSamples: 0,
  };
}

export function accumulateGeneratorUsage(
  acc: TrajectoryAccumulator,
  chat: NonNullable<GeneratorMetadataLike['chatModel']>,
  usage: Record<string, unknown>,
): {
  output: number | null;
  visible: number | null;
  thinking: number | null;
  rawVisible: number | null;
  duration: number | null;
  ttft: number | null;
} {
  const { counts, cache, tokens, modelBuckets } = acc;
  const cached = requestCacheMetrics(usage);
  if (cached) {
    cache.inputTokens += cached.inputTokens;
    cache.cachedTokens += cached.cachedTokens;
    cache.cacheWriteTokens += cached.cacheWriteTokens;
    cache.uncachedTokens += cached.uncachedTokens;
    cache.outputTokens += tokenCount(usage.outputTokens) ?? 0;
    cache.measuredRequests++;
  } else {
    cache.missingRequests++;
  }

  const output = tokenCount(usage.outputTokens);
  // These fields come from the local normalized ModelUsageStats contract,
  // not upstream prompt_tokens. Account for each readable component even
  // when another component (or the cache-ratio provider) is unavailable.
  const input = tokenCount(usage.inputTokens);
  const read =
    usage.cacheReadTokens === undefined && input !== null ? 0 : tokenCount(usage.cacheReadTokens);
  const write =
    usage.cacheWriteTokens === undefined && input !== null ? 0 : tokenCount(usage.cacheWriteTokens);

  const parts: Array<
    [
      'uncachedTokens' | 'cachedTokens' | 'cacheWriteTokens',
      'uncachedRequests' | 'cachedRequests' | 'cacheWriteRequests',
      number | null,
    ]
  > = [
    ['uncachedTokens', 'uncachedRequests', input],
    ['cachedTokens', 'cachedRequests', read],
    ['cacheWriteTokens', 'cacheWriteRequests', write],
  ];
  for (const [field, coverage, value] of parts) {
    if (value !== null) {
      const current = tokens[field];
      tokens[field] = current === null ? null : tokenCount(current + value);
      tokens[coverage]++;
    }
  }
  if (input !== null && read !== null && write !== null && tokenCount(input + read + write) !== null) {
    tokens.inputRequests++;
  } else {
    tokens.missingInputRequests++;
  }
  if (output !== null) {
    tokens.outputTokens = tokens.outputTokens === null ? null : tokenCount(tokens.outputTokens + output);
    tokens.outputRequests++;
  } else {
    tokens.missingOutputRequests++;
  }
  if (parts.some(([, , value]) => value !== null) || output !== null) {
    tokens.measuredRequests++;
  }

  const visible = tokenCount(usage.responseOutputTokens);
  const thinking = tokenCount(usage.thinkingOutputTokens);
  const resolvedModelName = resolveChatModelName(chat) || 'Unknown';
  const resolvedModelId = normalizeModelId(resolvedModelName) || 'unknown';
  let bucket = modelBuckets.get(resolvedModelId);
  if (!bucket) {
    bucket = {
      id: resolvedModelId,
      name: resolvedModelName,
      hasOwn: true,
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
    modelBuckets.set(resolvedModelId, bucket);
  }
  const bInput = safeAdd(safeAdd(input ?? 0, read ?? 0), write ?? 0);
  const bOutput = output ?? 0;
  bucket.requests = safeAdd(bucket.requests ?? 0, 1);
  bucket.uncachedTokens = safeAdd(bucket.uncachedTokens ?? 0, input ?? 0);
  bucket.cachedTokens = safeAdd(bucket.cachedTokens ?? 0, read ?? 0);
  bucket.cacheWriteTokens = safeAdd(bucket.cacheWriteTokens ?? 0, write ?? 0);
  bucket.inputTokens = safeAdd(bucket.inputTokens ?? 0, bInput);
  bucket.outputTokens = safeAdd(bucket.outputTokens ?? 0, bOutput);
  bucket.thinkingTokens = safeAdd(bucket.thinkingTokens ?? 0, thinking ?? 0);
  bucket.totalTokens = safeAdd(bucket.totalTokens ?? 0, safeAdd(bInput, bOutput));

  // Short thinking may finish inside TTFT before the first visible token, while
  // multi-block thought summaries end TTFT early so remaining thinking streams
  // inside streamingDuration. Align the token numerator with the actual span.
  const rawVisible =
    visible ?? (output !== null && thinking !== null ? Math.max(0, output - thinking) : output);
  const duration = seconds(chat.streamingDuration);
  const ttft = seconds(chat.timeToFirstToken);
  counts.input += input ?? 0;
  counts.output += output ?? 0;
  counts.responseOutput += rawVisible ?? 0;
  counts.thinkingOutput += thinking ?? 0;
  counts.cacheRead += tokenCount(usage.cacheReadTokens) ?? 0;
  counts.cacheWrite += tokenCount(usage.cacheWriteTokens) ?? 0;
  if (ttft !== null) {
    acc.ttftSeconds += ttft;
    acc.ttftSamples++;
  }
  acc.modelSeconds += (ttft ?? 0) + (duration ?? 0);

  return { output, visible, thinking, rawVisible, duration, ttft };
}
