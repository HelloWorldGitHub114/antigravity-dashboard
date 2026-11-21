import type { RateReason, SpeedMetrics, TokenSummary } from '../../contracts/metrics.ts';
import { contextMetrics, formatModelName } from '../context.ts';
import {
  extractRequestIdentity,
  type GeneratorMetadataLike,
  type TrajectoryStepLike,
} from '../identity.ts';
import { classifyRates, RATE_REASONS, RATE_VERSION, type RateSample } from '../rate-quality.ts';
import { accumulateGeneratorUsage, createTrajectoryAccumulator } from './accumulator.ts';
import {
  buildChatRateSample,
  chatTimingSignature,
  extractPlanModel,
  resolveChatModelName,
} from './chat.ts';
import { buildModelUsage } from './model-usage.ts';
import { seconds, tokenCount, unionSeconds } from './primitives.ts';

const parseMs = (value: unknown): number => (typeof value === 'string' ? Date.parse(value) : NaN);

const COMPACTION_STEP_RE = /(?:^|_)(?:CHECKPOINT|COMPACTION|CONTEXT_COMPACTION)$/i;
const UNSETTLED_STEP_RE = /RUNNING|PENDING|IN_PROGRESS|ERROR|FAILED|CANCEL/i;

interface CompactionStepInfo {
  stepIdx: number;
  atIso: string | null;
  atMs: number | null;
}

function stepNumber(step: TrajectoryStepLike | null | undefined, fallback: number): number {
  const explicit = (step as { i?: unknown } | null | undefined)?.i;
  return typeof explicit === 'number' && Number.isInteger(explicit) && explicit >= 0
    ? explicit
    : fallback;
}

function generatorStepRange(gen: GeneratorMetadataLike | null | undefined): {
  min: number | null;
  max: number | null;
} {
  const indices = Array.isArray(gen?.stepIndices)
    ? gen.stepIndices.filter((i): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0)
    : [];
  if (!indices.length) return { min: null, max: null };
  return { min: Math.min(...indices), max: Math.max(...indices) };
}

function collectCompactionSteps(steps: ReadonlyArray<TrajectoryStepLike>): CompactionStepInfo[] {
  const out: CompactionStepInfo[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const type = String(step?.type || '');
    if (!COMPACTION_STEP_RE.test(type)) continue;
    const status = String((step as { status?: unknown } | null | undefined)?.status || '');
    if (status && UNSETTLED_STEP_RE.test(status)) continue;
    const atIso =
      typeof step?.metadata?.completedAt === 'string' && step.metadata.completedAt
        ? step.metadata.completedAt
        : typeof step?.metadata?.createdAt === 'string' && step.metadata.createdAt
          ? step.metadata.createdAt
          : null;
    const atMs = atIso ? parseMs(atIso) : NaN;
    out.push({
      stepIdx: stepNumber(step, i),
      atIso,
      atMs: Number.isFinite(atMs) ? atMs : null,
    });
  }
  return out;
}

/**
 * 解析当前会话上下文占用：
 * 常规情况下直接返回宿主最近一次请求的实测上下文；
 * 若最近一次请求之后刚完成了 `/compact` 检查点且尚无新请求覆盖，
 * 则按本会话自身真实基线（优先前一次压缩后首轮实测，其次本会话首轮实测）给出压缩后估算值，
 * 避免面板继续停留在压缩前的高占比告警。
 */
function resolveTrajectoryContext(
  steps: ReadonlyArray<TrajectoryStepLike>,
  generators: ReadonlyArray<GeneratorMetadataLike>,
  resp: Record<string, unknown>,
  trajectory: Record<string, unknown>,
): ReturnType<typeof contextMetrics> {
  const lastChatGen = [...generators].reverse().find((g) => g?.chatModel) ?? null;
  const lastChat = lastChatGen?.chatModel ?? null;
  const rawMeta =
    lastChat?.chatStartMetadata?.contextWindowMetadata ||
    resp.contextWindowUsage ||
    trajectory.contextWindowUsage;
  const model =
    lastChat?.modelDisplayName || lastChat?.responseModel || String(lastChat?.model || '') || null;
  const sampledAt = lastChat?.chatStartMetadata?.createdAt ?? null;
  const compactions = collectCompactionSteps(steps);
  const compactionCount = compactions.length;

  const liveContext = contextMetrics(rawMeta, { model, sampledAt, compactionCount });
  if (!compactionCount || !liveContext) return liveContext;

  const latestCompaction = compactions[compactions.length - 1];
  const lastRange = generatorStepRange(lastChatGen);
  const lastChatMs = typeof sampledAt === 'string' ? parseMs(sampledAt) : NaN;
  const compactedAfterLastChat =
    lastRange.max !== null
      ? latestCompaction.stepIdx > lastRange.max
      : latestCompaction.atMs !== null && Number.isFinite(lastChatMs)
        ? latestCompaction.atMs > lastChatMs
        : false;
  if (!compactedAfterLastChat) return liveContext;

  // 从本会话历史请求中提取当前用户配置的真实底噪，不依赖任何硬编码常数
  let firstMeasuredUsed: number | null = null;
  let prevPostCompactionUsed: number | null = null;
  const prevCompaction = compactions.length >= 2 ? compactions[compactions.length - 2] : null;
  for (const gen of generators) {
    const parsed = contextMetrics(gen?.chatModel?.chatStartMetadata?.contextWindowMetadata);
    if (!parsed) continue;
    if (firstMeasuredUsed === null) firstMeasuredUsed = parsed.usedTokens;
    if (prevCompaction && prevPostCompactionUsed === null) {
      const range = generatorStepRange(gen);
      const genMs = parseMs(gen?.chatModel?.chatStartMetadata?.createdAt);
      const isAfterPrev =
        range.min !== null
          ? range.min > prevCompaction.stepIdx && range.min < latestCompaction.stepIdx
          : Number.isFinite(genMs) &&
            prevCompaction.atMs !== null &&
            latestCompaction.atMs !== null &&
            genMs > prevCompaction.atMs &&
            genMs < latestCompaction.atMs;
      if (isAfterPrev) prevPostCompactionUsed = parsed.usedTokens;
    }
  }

  const preCompactionUsed = liveContext.usedTokens;
  const candidateBaseline =
    prevPostCompactionUsed !== null && prevPostCompactionUsed < preCompactionUsed
      ? prevPostCompactionUsed
      : firstMeasuredUsed !== null && firstMeasuredUsed < preCompactionUsed
        ? firstMeasuredUsed
        : null;
  if (candidateBaseline === null) return liveContext;

  return contextMetrics(
    {
      estimatedTokensUsed: candidateBaseline,
      maxContextTokens: liveContext.maxTokens,
    },
    {
      model,
      sampledAt: latestCompaction.atIso || sampledAt,
      compacted: true,
      preCompactionUsedTokens: preCompactionUsed,
      compactionCount,
    },
  );
}

export function trajectoryMetrics(response: unknown): SpeedMetrics {
  const resp = response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  const trajectory =
    resp.trajectory && typeof resp.trajectory === 'object'
      ? (resp.trajectory as Record<string, unknown>)
      : {};
  const generators: GeneratorMetadataLike[] = Array.isArray(trajectory.generatorMetadata)
    ? (trajectory.generatorMetadata as GeneratorMetadataLike[])
    : [];
  const steps: TrajectoryStepLike[] = Array.isArray(trajectory.steps)
    ? (trajectory.steps as TrajectoryStepLike[])
    : [];

  const samples: RateSample[] = [];
  const ids = new Map<string, { signature: string; sample: RateSample }>();
  const acc = createTrajectoryAccumulator();

  for (const [index, generator] of generators.entries()) {
    const chat = generator?.chatModel;
    if (!chat?.usage) continue;
    const usage =
      chat.usage && typeof chat.usage === 'object' ? (chat.usage as Record<string, unknown>) : {};

    // IDE executionId identifies a planner run/turn, not an individual model
    // request: tool follow-ups share it while having distinct responseIds.
    // Never collapse those follow-ups, even when no request ID was returned.
    const id = extractRequestIdentity(generator, { index, fallback: 'index' }).key;
    const signature = chatTimingSignature(chat, usage);
    if (ids.has(id)) {
      const previous = ids.get(id)!;
      if (previous.signature !== signature && !previous.sample.reasons.includes('duplicate-scope')) {
        previous.sample.reasons.push('duplicate-scope');
      }
      continue;
    }

    const parsed = accumulateGeneratorUsage(acc, chat, usage);
    const sample = buildChatRateSample(generator, chat, usage, steps, parsed);
    samples.push(sample);
    ids.set(id, { signature, sample });
  }

  classifyRates(samples);
  const accepted = samples.filter((sample) => sample.status === 'ok');
  const statusStr = typeof resp.status === 'string' ? resp.status : '';
  const isSettled = /IDLE|DONE|COMPLETED|CANCELLED|CANCELED|STOPPED|FAILED|ERROR/.test(statusStr);
  const isRunning = !isSettled && (/RUNNING/i.test(statusStr) || resp.running === true);
  const lastChat = [...generators].reverse().find((g) => g.chatModel)?.chatModel;
  const inFlightDur = seconds(lastChat?.streamingDuration);
  const hasActiveGen =
    isRunning &&
    Boolean(lastChat) &&
    (inFlightDur === null || inFlightDur === 0) &&
    Boolean(
      lastChat?.chatStartMetadata?.createdAt ||
        lastChat?.timeToFirstToken !== undefined ||
        lastChat?.usage,
    );
  const hasActiveInSamples = Boolean(hasActiveGen && lastChat?.usage);

  const missingTiming = samples.filter(
    (sample) =>
      sample.status === 'missing' &&
      ((sample.responseTokens ?? 0) > 0 || (sample.rawOutput ?? 0) > 0) &&
      (!hasActiveInSamples || sample !== samples.at(-1)),
  ).length;
  const excludedTiming = samples.filter((sample) => sample.status === 'unreliable').length;
  const rateWarnings = samples.filter(
    (sample) =>
      sample.status === 'ok' && ((sample.duration !== null && sample.duration < 1) || sample.outlier),
  ).length;
  const timingReasons = Object.fromEntries(
    RATE_REASONS.map((reason) => [
      reason,
      samples.filter((sample) => sample.reasons.includes(reason)).length,
    ]),
  ) as Record<RateReason, number>;

  const streamingSeconds = accepted.reduce((sum, s) => sum + (s.duration ?? 0), 0);
  const sampledTokens = accepted.reduce((sum, s) => sum + (s.responseTokens ?? 0), 0);
  const basisSamples = accepted.length ? accepted : samples;
  const tools = steps.filter(
    (s) =>
      /SEARCH_WEB|BROWSE|RUN_COMMAND|COMMAND|READ|WRITE|EDIT|CODE_ACTION|TOOL|MCP|LIST|GREP|VIEW|FIND|TERMINAL/i.test(
        String(s?.type || ''),
      ) || Boolean(s?.metadata?.toolCall),
  );
  const toolSeconds = unionSeconds(
    tools.map((s) => [
      parseMs(s.metadata?.startedAt || s.metadata?.createdAt),
      parseMs(s.metadata?.completedAt),
    ]),
  );

  const pool = isRunning && hasActiveInSamples && samples.length > 0 ? samples.slice(0, -1) : samples;
  const latest =
    (isRunning ? [...pool].reverse().find((s) => s.status === 'ok') : null) ||
    [...pool]
      .reverse()
      .find(
        (s) =>
          s.reasons.length ||
          (s.duration ?? 0) > 0 ||
          (s.rawOutput ?? 0) > 0 ||
          (s.responseTokens ?? 0) > 0,
      ) ||
    pool.at(-1) ||
    null;

  const { tokens, cache, counts, modelBuckets } = acc;
  const inputParts = [tokens.uncachedTokens, tokens.cachedTokens, tokens.cacheWriteTokens];
  tokens.inputTokens = tokenCount(inputParts.reduce<number>((sum, value) => sum + (value ?? 0), 0));
  const totalTokens = tokenCount((tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0));
  const tokenSummary: TokenSummary = {
    ...tokens,
    totalTokens,
    complete:
      tokens.missingInputRequests === 0 &&
      tokens.missingOutputRequests === 0 &&
      inputParts.every((value) => value !== null) &&
      tokens.outputTokens !== null &&
      totalTokens !== null,
  };

  const planModel = extractPlanModel(response);
  const lastStepModel =
    [...steps]
      .reverse()
      .find((s) => typeof s?.metadata?.generatorModel === 'string' && s.metadata.generatorModel.trim())
      ?.metadata?.generatorModel || null;
  const activeModel =
    resolveChatModelName(lastChat) ||
    (latest?.model ? formatModelName(latest.model) : null) ||
    (lastStepModel ? formatModelName(lastStepModel) : null);
  const modelUsage = buildModelUsage(modelBuckets.values(), { planModel, activeModel });

  return {
    source: 'Antigravity request metadata',
    status: statusStr || null,
    conversationId:
      typeof trajectory.cascadeId === 'string' && trajectory.cascadeId ? trajectory.cascadeId : null,
    planModel,
    activeModel,
    modelUsage,
    steps: Number(resp.numTotalSteps ?? steps.length),
    rounds: steps.filter((s) => /USER_INPUT/.test(String(s?.type))).length,
    requests: ids.size,
    measuredRequests: accepted.length,
    missingTiming,
    excludedTiming,
    rateWarnings,
    timingReasons,
    rateVersion: RATE_VERSION,
    counts,
    tokens: tokenSummary,
    cache: {
      ...cache,
      totalTokens: cache.inputTokens + cache.outputTokens,
      hitRate: cache.inputTokens > 0 ? cache.cachedTokens / cache.inputTokens : null,
      complete: cache.missingRequests === 0,
    },
    tps: streamingSeconds > 0 ? sampledTokens / streamingSeconds : null,
    latestTps: latest?.status === 'ok' ? latest.tps : null,
    latestRateStatus: latest?.status ?? 'missing',
    rateBasis:
      basisSamples.length && basisSamples.every((s) => s.basis === 'response')
        ? 'response'
        : 'all-output',
    streamingSeconds,
    modelSeconds: acc.modelSeconds,
    toolSeconds,
    ttftSeconds: acc.ttftSamples ? acc.ttftSeconds / acc.ttftSamples : null,
    latestShortSample: Boolean(
      latest?.status === 'ok' && latest.duration !== null && latest.duration < 1,
    ),
    model: latest?.model || null,
    context: resolveTrajectoryContext(steps, generators, resp, trajectory),
    complete: Number(resp.numTotalGeneratorMetadata ?? generators.length) === generators.length,
  };
}
