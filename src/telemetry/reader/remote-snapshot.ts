// Statistics-only acquisition. Host schemas accept offsets, not page sizes.
// Cached immutable prefixes are local numeric/structural projections only.
import { formatModelName } from '../context.ts';
import type {
  ContextWindowUsageLike,
  NormalizeRemoteOptions,
  NormalizedRemoteSnapshot,
  ProjectedStep,
  RawGeneratorMetadataLike,
  RawStepLike,
  RemoteUpdateLike,
} from './types.ts';

export const TOOL_STEP =
  /SEARCH_WEB|BROWSE|RUN_COMMAND|COMMAND|READ|WRITE|EDIT|CODE_ACTION|TOOL|MCP|LIST|GREP|VIEW|FIND|TERMINAL/i;

export const settled = (status: unknown): boolean =>
  /IDLE|DONE|COMPLETED|CANCELLED|CANCELED|STOPPED|FAILED|ERROR/.test(String(status || ''));

export const unavailable = (): Error => new Error('后台已重新连接，请等待刷新');

export const safeCount = (value: unknown): number | null =>
  (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : null;

function isoNanoParts(value: unknown): { sec: number; ns: number } | null {
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!m) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? { sec: Math.floor(ms / 1000), ns: Math.round((ms % 1000) * 1e6) } : null;
  }
  const baseMs = Date.parse(m[1] + m[3]);
  if (!Number.isFinite(baseMs)) return null;
  return { sec: Math.floor(baseMs / 1000), ns: m[2] ? Number(m[2].padEnd(9, '0')) : 0 };
}

function isoDiffSeconds(startIso: unknown, endIso: unknown): number | null {
  const a = isoNanoParts(startIso);
  const b = isoNanoParts(endIso);
  if (!a || !b) return null;
  const diff = b.sec - a.sec + (b.ns - a.ns) / 1e9;
  return Number.isFinite(diff) && diff >= 0 ? diff : null;
}

function followedByToolStep(rawSteps: readonly RawStepLike[], fromIndex: number): boolean {
  for (let j = fromIndex + 1; j < rawSteps.length; j++) {
    const next = rawSteps[j];
    const type = String(next?.type || '');
    if (/USER_INPUT|PLANNER_RESPONSE/.test(type)) return false;
    if (TOOL_STEP.test(type) || next?.metadata?.toolCall || (safeCount(next?.metadata?.toolCallOutputTokens) ?? 0) > 0) {
      return true;
    }
  }
  return false;
}

function inferApiProvider(
  usage: Record<string, unknown> | undefined,
  meta: RawStepLike['metadata'],
  rawModelName: string,
): string | undefined {
  if (typeof usage?.apiProvider === 'string' && usage.apiProvider) return usage.apiProvider;
  const hint = [
    meta?.generatorModel,
    meta?.requestedModel?.model,
    meta?.modelInfo?.modelName,
    meta?.modelInfo?.displayName,
    rawModelName,
  ]
    .filter(Boolean)
    .join(' ');
  if (/GEMINI|GOOGLE/i.test(hint)) return 'API_PROVIDER_GOOGLE_GEMINI';
  if (/ANTHROPIC|CLAUDE/i.test(hint)) return 'API_PROVIDER_ANTHROPIC';
  if (/OPENAI|GPT/i.test(hint)) return 'API_PROVIDER_OPENAI';
  return undefined;
}

/**
 * Deduplicate and sort generator metadata entries by `stepIndices` or `responseId`.
 */
export function mergeGeneratorMetadata(
  older: readonly RawGeneratorMetadataLike[] = [],
  newer: readonly RawGeneratorMetadataLike[] = [],
): RawGeneratorMetadataLike[] {
  const genMap = new Map<string | symbol, RawGeneratorMetadataLike>();
  const keyOf = (g: RawGeneratorMetadataLike, tag: string): string | symbol => {
    if (Array.isArray(g?.stepIndices) && g.stepIndices.length) return `s:${g.stepIndices.join(',')}`;
    const rid = g?.chatModel?.usage?.responseId;
    return rid ? `r:${rid}` : Symbol(tag);
  };
  for (const g of older) genMap.set(keyOf(g, 'o'), g);
  for (const g of newer) genMap.set(keyOf(g, 'n'), g);
  const merged = [...genMap.values()];
  if (merged.length > 1 && merged.every((g) => Number.isInteger(g?.stepIndices?.[0]))) {
    merged.sort((a, b) => (a.stepIndices![0] as number) - (b.stepIndices![0] as number));
  }
  return merged;
}

/**
 * Extract the latest non-empty `planModel` string declared on user input steps.
 */
export function extractPlanModelFromSteps(rawSteps: readonly RawStepLike[] | unknown): string | null {
  let planModel: string | null = null;
  for (const s of Array.isArray(rawSteps) ? (rawSteps as RawStepLike[]) : []) {
    const pm = s?.userInput?.userConfig?.plannerConfig?.planModel;
    if (typeof pm === 'string' && pm.trim()) planModel = pm.trim().slice(0, 256);
  }
  return planModel;
}

function projectStep(s: RawStepLike, idx: number, rawSteps: readonly RawStepLike[], withTimeline: boolean): ProjectedStep {
  const m = s?.metadata || {};
  const type = String(s?.type || '');
  const tcObj = m.toolCall && typeof m.toolCall === 'object' ? m.toolCall : null;
  const projectedMeta: Record<string, unknown> = {
    ...(m.createdAt ? { createdAt: m.createdAt } : {}),
    ...(m.startedAt ? { startedAt: m.startedAt } : {}),
    ...(m.completedAt ? { completedAt: m.completedAt } : {}),
    ...(withTimeline && m.generatorModel ? { generatorModel: String(m.generatorModel).slice(0, 256) } : {}),
    ...(withTimeline && typeof tcObj?.name === 'string' && tcObj.name
      ? { toolCall: { name: tcObj.name.slice(0, 64) } }
      : m.toolCall
        ? { toolCall: true }
        : {}),
  };
  const out: ProjectedStep = {
    ...(s?.i !== undefined ? { i: s.i } : {}),
    ...(s?.type !== undefined ? { type: s.type } : {}),
    ...(withTimeline && s?.status !== undefined ? { status: String(s.status).slice(0, 64) } : {}),
    metadata: projectedMeta,
    ...(s?.invokeSubagent ? { invokeSubagent: s.invokeSubagent } : {}),
  };
  if (withTimeline) {
    const stepPlanModel = s?.userInput?.userConfig?.plannerConfig?.planModel;
    if (typeof stepPlanModel === 'string' && stepPlanModel.trim()) {
      out.userInput = { userConfig: { plannerConfig: { planModel: stepPlanModel.trim().slice(0, 256) } } };
    }
    const eventType = s?.systemMessage?.eventType;
    if (typeof eventType === 'string' && eventType.trim()) out.systemMessage = { eventType: eventType.trim().slice(0, 64) };
    const tbMode = s?.taskBoundary?.mode || s?.taskBoundary?.Mode;
    if (typeof tbMode === 'string' && tbMode.trim()) {
      out.taskBoundary = s.taskBoundary?.mode ? { mode: tbMode.trim().slice(0, 64) } : { Mode: tbMode.trim().slice(0, 64) };
    }
    if (s?.exitPlanMode) out.exitPlanMode = true;
    if (s?.enterPlanMode) out.enterPlanMode = true;
  }
  if (/PLANNER_RESPONSE/.test(type)) {
    const hasResp = Boolean(String(s?.plannerResponse?.response || '').trim());
    const rawCalls = Array.isArray(s?.plannerResponse?.toolCalls) ? s.plannerResponse.toolCalls : [];
    const hasToolCalls = Boolean(rawCalls.length > 0 || followedByToolStep(rawSteps, idx));
    let toolCalls: Array<{ name?: string; status?: string }> | undefined;
    if (withTimeline && rawCalls.length) {
      toolCalls = rawCalls.map((tc) => ({
        ...(typeof tc?.name === 'string' && tc.name.trim() ? { name: tc.name.trim().slice(0, 64) } : {}),
        ...(typeof tc?.status === 'string' && tc.status.trim() ? { status: tc.status.trim().slice(0, 64) } : {}),
      }));
    } else if (hasToolCalls) {
      toolCalls = [{}];
    }
    out.plannerResponse = { response: hasResp ? '1' : '', ...(toolCalls ? { toolCalls } : {}) };
  }
  return out;
}

/**
 * Project a `StreamAgentStateUpdates` payload into the statistical trajectory shape.
 */
export function normalizeRemoteSnapshot(
  update: RemoteUpdateLike | null | undefined,
  fallbackId: string,
  stepOffset = 0,
  { modelTimelineEnabled = false }: NormalizeRemoteOptions = {},
): NormalizedRemoteSnapshot {
  const main = update?.mainTrajectoryUpdate || {};
  const rawSteps = Array.isArray(main.stepsUpdate?.steps) ? main.stepsUpdate.steps : [];
  const rawGenerators = Array.isArray(main.generatorMetadatasUpdate?.generatorMetadatas)
    ? main.generatorMetadatasUpdate.generatorMetadatas
    : [];
  const hasNativeChatModel = rawGenerators.some((g) => g?.chatModel?.usage || g?.chatModel?.chatStartMetadata);
  const withTimeline = modelTimelineEnabled === true;
  const planModel =
    (typeof update?.planModel === 'string' && update.planModel.trim() ? update.planModel.trim().slice(0, 256) : null) ||
    extractPlanModelFromSteps(rawSteps);
  const steps = rawSteps.map((s, idx) => projectStep(s, idx, rawSteps, withTimeline));
  if (hasNativeChatModel) {
    return {
      cascadeId: update?.conversationId || fallbackId,
      ...(planModel ? { planModel } : {}),
      steps,
      generatorMetadata: rawGenerators,
      contextWindowUsage: update?.contextWindowUsage,
    };
  }
  const genByStep = new Map<number, RawGeneratorMetadataLike>();
  for (const g of rawGenerators) {
    for (const idx of g?.stepIndices || []) {
      if (typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 && !genByStep.has(idx)) genByStep.set(idx, g);
    }
  }
  const usageSteps: Array<{ localIdx: number; globalIdx: number }> = [];
  for (let idx = 0; idx < rawSteps.length; idx++) {
    if (rawSteps[idx]?.metadata?.modelUsage) {
      const globalIdx = rawSteps[idx]?.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? stepOffset + idx;
      usageSteps.push({ localIdx: idx, globalIdx });
    }
  }
  const lastUsage = usageSteps.at(-1);
  let synthesizedContext: ContextWindowUsageLike | null = null;
  if (lastUsage) {
    const lm = rawSteps[lastUsage.localIdx].metadata || {};
    const lu = lm.modelUsage || {};
    const inTok = safeCount(lu.inputTokens);
    if (inTok !== null) {
      const used = inTok + (safeCount(lu.cacheReadTokens) ?? 0) + (safeCount(lu.cacheWriteTokens) ?? 0) + (safeCount(lu.outputTokens) ?? 0);
      const rawMax = safeCount(lm.modelInfo?.maxTokens ?? lm.modelInfo?.contextWindow ?? lm.modelInfo?.maxInputTokens);
      if (Number.isSafeInteger(used)) {
        synthesizedContext = { estimatedTokensUsed: used, ...(rawMax !== null && rawMax > 0 ? { maxContextTokens: rawMax } : {}) };
      }
    }
  }
  const effectiveContext =
    safeCount(update?.contextWindowUsage?.estimatedTokensUsed) !== null ? update?.contextWindowUsage : synthesizedContext;
  const generatorMetadata: RawGeneratorMetadataLike[] = usageSteps.map(({ localIdx, globalIdx }) => {
    const s = rawSteps[localIdx];
    const m = s.metadata || {};
    const u = m.modelUsage || {};
    const g = genByStep.get(globalIdx) || genByStep.get(localIdx);
    const rawModelName = String(
      m.modelInfo?.displayName || m.modelInfo?.modelName || g?.plannerConfig?.modelName || u.model || m.requestedModel?.model || m.generatorModel || '',
    );
    const apiProvider = inferApiProvider(u, m, rawModelName);
    const responseId = (typeof u.responseId === 'string' && u.responseId) || m.modelApiContentId || undefined;
    const ttft = isoDiffSeconds(m.createdAt, m.viewableAt);
    const stream = isoDiffSeconds(m.viewableAt, m.finishedGeneratingAt);
    const displayName = formatModelName(rawModelName) || m.modelInfo?.displayName || rawModelName || undefined;
    const isLast = localIdx === lastUsage?.localIdx;
    const modelStr = (typeof u.model === 'string' && u.model) || rawModelName || undefined;
    return {
      stepIndices: [globalIdx],
      chatModel: {
        usage: { ...u, ...(apiProvider ? { apiProvider } : {}), ...(responseId ? { responseId } : {}), ...(modelStr ? { model: modelStr } : {}) },
        ...(displayName ? { modelDisplayName: displayName } : {}),
        ...(rawModelName ? { responseModel: rawModelName } : {}),
        ...(ttft !== null ? { timeToFirstToken: ttft } : {}),
        ...(stream !== null && stream > 0 ? { streamingDuration: stream } : {}),
        chatStartMetadata: { ...(m.createdAt ? { createdAt: m.createdAt } : {}), ...(isLast && effectiveContext ? { contextWindowMetadata: effectiveContext } : {}) },
      },
    };
  });
  return {
    cascadeId: update?.conversationId || fallbackId,
    ...(planModel ? { planModel } : {}),
    steps,
    generatorMetadata,
    contextWindowUsage: effectiveContext || undefined,
  };
}
