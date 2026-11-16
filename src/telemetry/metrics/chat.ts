import type { RateReason } from '../../contracts/metrics.ts';
import { formatModelName, isOrchestratorModel } from '../context.ts';
import type { GeneratorMetadataLike, TrajectoryStepLike } from '../identity.ts';
import type { RateSample } from '../rate-quality.ts';
import { seconds, tokenCount } from './primitives.ts';

export function resolveChatModelName(chat: unknown = null): string | null {
  if (!chat || typeof chat !== 'object') return null;
  const c = chat as Record<string, unknown>;
  const usage = c.usage && typeof c.usage === 'object' ? (c.usage as Record<string, unknown>) : null;
  if (typeof c.modelDisplayName === 'string' && c.modelDisplayName.trim()) {
    const formatted = formatModelName(c.modelDisplayName);
    if (formatted) return formatted;
  }
  for (const cand of [c.model, c.responseModel, usage?.model]) {
    const formatted = formatModelName(cand);
    if (formatted && !/^MODEL_PLACEHOLDER_M\d+$/i.test(formatted)) return formatted;
  }
  for (const cand of [c.model, c.responseModel, usage?.model]) {
    const formatted = formatModelName(cand);
    if (formatted) return formatted;
  }
  return null;
}

export function extractPlanModel(response: unknown): string | null {
  const resp = response && typeof response === 'object' ? (response as Record<string, unknown>) : null;
  const trajectory =
    resp?.trajectory && typeof resp.trajectory === 'object'
      ? (resp.trajectory as Record<string, unknown>)
      : {};
  const steps: TrajectoryStepLike[] = Array.isArray(trajectory.steps)
    ? (trajectory.steps as TrajectoryStepLike[])
    : Array.isArray(resp?.steps)
      ? (resp.steps as TrajectoryStepLike[])
      : [];

  let raw: string | null = null;
  for (const step of steps) {
    const pm = step?.userInput?.userConfig?.plannerConfig?.planModel;
    if (typeof pm === 'string' && pm.trim()) raw = pm;
  }
  if (!raw) {
    const direct = trajectory.planModel || resp?.planModel;
    if (typeof direct === 'string' && direct.trim()) raw = direct;
  }
  if (raw) return formatModelName(raw);

  const generators: GeneratorMetadataLike[] = Array.isArray(trajectory.generatorMetadata)
    ? (trajectory.generatorMetadata as GeneratorMetadataLike[])
    : Array.isArray(resp?.generatorMetadata)
      ? (resp.generatorMetadata as GeneratorMetadataLike[])
      : [];

  for (const g of generators) {
    const pm = g?.plannerConfig?.planModel;
    if (typeof pm === 'string' && pm.trim()) return formatModelName(pm);
  }
  for (const g of generators) {
    const name = resolveChatModelName(g?.chatModel);
    if (name && isOrchestratorModel(name)) return name;
  }
  return null;
}

export function buildChatRateSample(
  generator: GeneratorMetadataLike,
  chat: NonNullable<GeneratorMetadataLike['chatModel']>,
  usage: Record<string, unknown>,
  steps: readonly TrajectoryStepLike[],
  parsed: {
    output: number | null;
    visible: number | null;
    thinking: number | null;
    rawVisible: number | null;
    duration: number | null;
    ttft: number | null;
  },
): RateSample {
  const { output, visible, thinking, rawVisible, duration, ttft } = parsed;
  const reasons: RateReason[] = [];
  if (
    (['outputTokens', 'responseOutputTokens', 'thinkingOutputTokens'] as const).some(
      (key) => usage[key] !== undefined && tokenCount(usage[key]) === null,
    ) ||
    (output !== null &&
      ((visible !== null && visible > output) ||
        (thinking !== null && thinking > output) ||
        (visible !== null && thinking !== null && visible + thinking > output)))
  ) {
    reasons.push('token-scope');
  }

  // One retryInfos entry is the ordinary attempt record, not evidence of a retry.
  // Multiple differing usage records lack attempt-specific timing in this API.
  const attempts = (Array.isArray(chat.retryInfos) ? chat.retryInfos : []).filter(
    (info): info is { usage: Record<string, unknown> } =>
      Boolean(info && typeof info === 'object' && (info as { usage?: unknown }).usage),
  );
  if (
    attempts.length > 1 &&
    attempts.some((info) =>
      (['outputTokens', 'responseOutputTokens', 'thinkingOutputTokens'] as const).some(
        (key) => tokenCount(info.usage[key]) !== tokenCount(usage[key]),
      ),
    )
  ) {
    reasons.push('retry-scope');
  }

  const stepIndices = Array.isArray(generator.stepIndices) ? generator.stepIndices : [];
  const planners = stepIndices
    .map((i) => (Number.isInteger(i) && (i as number) >= 0 ? steps[i as number] : null))
    .filter((step): step is TrajectoryStepLike =>
      Boolean(step && /PLANNER_RESPONSE/.test(String(step.type || ''))),
    );
  const hasTools = planners.some(
    (step) => Array.isArray(step.plannerResponse?.toolCalls) && step.plannerResponse.toolCalls.length > 0,
  );
  const toolOnly =
    planners.length > 0 &&
    planners.every(
      (step) =>
        Array.isArray(step.plannerResponse?.toolCalls) &&
        step.plannerResponse.toolCalls.length > 0 &&
        !String(step.plannerResponse?.response || '').trim(),
    );

  const rawBasis: 'response' | 'all-output' =
    visible !== null || thinking !== null ? 'response' : 'all-output';
  let responseTokens = rawVisible;
  let basis = rawBasis;
  if (
    !reasons.length &&
    thinking !== null &&
    thinking > 0 &&
    output !== null &&
    rawVisible !== null &&
    duration !== null &&
    duration > 0
  ) {
    const fullRate = ttft !== null && ttft + duration > 0 ? output / (ttft + duration) : null;
    const visRate = rawVisible / duration;
    const spilled =
      rawVisible === 0 ||
      (fullRate !== null && visRate < fullRate * 0.85) ||
      (ttft === null && thinking > rawVisible && duration >= 2);
    if (spilled) {
      if (
        (!hasTools && duration > 0) ||
        duration >= 15 ||
        (ttft !== null && duration >= Math.max(2, ttft * 2))
      ) {
        responseTokens = output;
        basis = 'all-output';
      } else {
        reasons.push('token-scope');
      }
    }
  }

  return {
    responseTokens,
    rawOutput: output,
    duration,
    ttft,
    reasons,
    hasTools,
    toolOnly,
    tps:
      responseTokens !== null && responseTokens > 0 && duration !== null && duration > 0
        ? responseTokens / duration
        : null,
    model: String(chat.modelDisplayName || chat.responseModel || chat.model || usage.model || ''),
    basis,
    profile: JSON.stringify([
      usage.apiProvider || '',
      chat.responseModel || usage.model || chat.model || chat.modelDisplayName || '',
      rawBasis,
    ]),
  };
}

export function chatTimingSignature(
  chat: NonNullable<GeneratorMetadataLike['chatModel']>,
  usage: Record<string, unknown>,
): string {
  return JSON.stringify([
    usage.outputTokens,
    usage.responseOutputTokens,
    usage.thinkingOutputTokens,
    seconds(chat.streamingDuration),
    seconds(chat.timeToFirstToken),
    chat.responseModel,
    chat.model,
    usage.model,
  ]);
}
