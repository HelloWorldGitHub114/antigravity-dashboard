import type {
  ContextBreakdown,
  FirstTokenWaitMetrics,
  RequestErrorInfo,
  TurnMetrics,
  TurnState,
} from '../../contracts/metrics.ts';
import { classifyRequestError } from '../../shared/request-alerts.ts';
import type { GeneratorMetadataLike, TrajectoryStepLike } from '../identity.ts';
import type { SqliteTurnDiagnostics } from '../reader/sqlite-diagnostics.ts';
import { requestCacheMetrics, seconds, tokenCount } from './primitives.ts';

const parseMs = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const COMPACTION_STEP_RE = /(?:^|_)(?:CHECKPOINT|COMPACTION|CONTEXT_COMPACTION)$/i;
const UNSETTLED_STEP_RE = /RUNNING|PENDING|IN_PROGRESS|ERROR|FAILED|CANCEL/i;
const ACTIVE_STATUS_NUMS = new Set([1, 2, 8, 9, 11]);
const ACTIVE_STATUS_RE = /PENDING|RUNNING|GENERATING|WAITING|QUEUED|IN_PROGRESS/i;

function stepNumber(step: TrajectoryStepLike | null | undefined, fallback: number): number {
  const explicit = (step as { i?: unknown } | null | undefined)?.i;
  return typeof explicit === 'number' && Number.isInteger(explicit) && explicit >= 0
    ? explicit
    : fallback;
}

function stepIndicesOf(gen: GeneratorMetadataLike | null | undefined): number[] {
  return Array.isArray(gen?.stepIndices)
    ? gen.stepIndices.filter((i): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0)
    : [];
}

interface EpochTurn {
  minStep: number | null;
  contextTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

/**
 * 按当前压缩周期拆解上下文四段构成（首轮底噪 / 读取 / 思考 / 写入）：
 * 仅累计最近一次压缩检查点（或上下文骤降超过 30%）之后的轮次，
 * 防止压缩前的历史思考与写入虚高当前占比；结果严格保证四项之和等于当前总上下文。
 */
export function computeContextBreakdown(
  generators: ReadonlyArray<GeneratorMetadataLike>,
  steps: ReadonlyArray<TrajectoryStepLike>,
  contextUsedTokens: number | null | undefined,
  isCompacted: boolean,
): ContextBreakdown | null {
  if (isCompacted) return null;

  const checkpointIndices: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!COMPACTION_STEP_RE.test(String(step?.type || ''))) continue;
    const st = String((step as { status?: unknown } | null | undefined)?.status || '');
    if (st && UNSETTLED_STEP_RE.test(st)) continue;
    checkpointIndices.push(stepNumber(step, i));
  }
  checkpointIndices.sort((a, b) => b - a);

  const turns: EpochTurn[] = [];
  for (const gen of generators) {
    const chat = gen?.chatModel;
    const usage = chat?.usage && typeof chat.usage === 'object' ? (chat.usage as Record<string, unknown>) : null;
    if (!usage) continue;
    const uncached = tokenCount(usage.inputTokens) ?? 0;
    const cached = tokenCount(usage.cacheReadTokens) ?? 0;
    const cacheWrite = tokenCount(usage.cacheWriteTokens) ?? 0;
    const ctxMeta = chat?.chatStartMetadata?.contextWindowMetadata as Record<string, unknown> | null | undefined;
    const hostUsed = tokenCount(ctxMeta?.estimatedTokensUsed);
    const contextTokens = uncached + cached > 0 ? uncached + cached + cacheWrite : (hostUsed ?? 0);
    if (contextTokens <= 0) continue;

    const rawTotalOut = tokenCount(usage.outputTokens) ?? 0;
    const rawThinking = tokenCount(usage.thinkingOutputTokens);
    const rawReply = tokenCount(usage.responseOutputTokens);
    const thinkingTokens = rawThinking ?? 0;
    const outputTokens =
      rawReply !== null ? rawReply : Math.max(0, rawTotalOut - thinkingTokens);
    const indices = stepIndicesOf(gen);
    turns.push({
      minStep: indices.length ? Math.min(...indices) : null,
      contextTokens,
      outputTokens,
      thinkingTokens,
    });
  }
  if (!turns.length) return null;

  let epochStart = 0;
  for (const cpIdx of checkpointIndices) {
    const postIdx = turns.findIndex((t) => t.minStep !== null && t.minStep > cpIdx);
    if (postIdx >= 0) {
      epochStart = postIdx;
      break;
    }
  }
  for (let i = epochStart + 1; i < turns.length; i++) {
    if (turns[i].contextTokens < turns[i - 1].contextTokens * 0.7) {
      epochStart = i;
    }
  }

  const latest = turns[turns.length - 1];
  const totalTokens =
    typeof contextUsedTokens === 'number' && Number.isFinite(contextUsedTokens) && contextUsedTokens > 0
      ? Math.round(contextUsedTokens)
      : latest.contextTokens;
  if (totalTokens <= 0) return null;

  // 最近一次请求的 contextTokens 是生成该次输出之前的输入窗口，因此只累计本周期之前各轮的思考与写入
  let rawOut = 0;
  let rawThink = 0;
  for (let i = epochStart; i < turns.length - 1; i++) {
    rawOut += turns[i].outputTokens;
    rawThink += turns[i].thinkingTokens;
  }

  const baselineTokens = Math.min(turns[epochStart].contextTokens, totalTokens);
  const availGen = Math.max(0, totalTokens - baselineTokens);
  const genSum = rawOut + rawThink;
  const genScale = genSum > availGen && genSum > 0 ? availGen / genSum : 1;
  const outputTokens = Math.round(rawOut * genScale);
  const thinkingTokens = Math.round(rawThink * genScale);
  const readTokens = Math.max(0, totalTokens - baselineTokens - outputTokens - thinkingTokens);

  return {
    baselineTokens,
    readTokens,
    thinkingTokens,
    outputTokens,
    totalTokens,
  };
}

export interface TurnDiagnosticsResult {
  isGenerating: boolean;
  lastResponseAtMs: number | null;
  turnMetrics: TurnMetrics | null;
  turnQueue: FirstTokenWaitMetrics | null;
  requestError: RequestErrorInfo | null;
}

function extractErrorString(raw: unknown): string {
  if (!raw) return '';
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const k of ['message', 'error', 'userErrorMessage']) {
      if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim();
    }
  }
  return '';
}

function visibleRequestError(
  error: RequestErrorInfo,
  failedStepIndices: number[],
  diag: SqliteTurnDiagnostics | null,
  steps: ReadonlyArray<TrajectoryStepLike>,
): RequestErrorInfo {
  if (error.kind === 'none') return error;
  const lastOutIdx = failedStepIndices.length ? Math.max(...failedStepIndices) : -1;
  if (lastOutIdx < 0) return error;

  if (diag && diag.turnSteps.length > 0) {
    const lastOut = diag.turnSteps.find((s) => s.idx === lastOutIdx);
    if (!lastOut) return error;
    const failedAt = lastOut.recordedCompletedAtMs ?? lastOut.terminalAtMs;
    const resumed = diag.turnSteps.some(
      (s) =>
        s.idx > lastOutIdx &&
        s.stepType === 15 &&
        (s.status === 8 || (s.status === 3 && (s.generatingAtMs ?? 0) > 0)) &&
        (!lastOut.executionId || s.executionId === lastOut.executionId) &&
        (!failedAt || (s.createdAtMs ?? 0) >= failedAt),
    );
    return resumed ? classifyRequestError('') : error;
  }

  const resumed = steps.some((s, i) => {
    const idx = stepNumber(s, i);
    if (idx <= lastOutIdx) return false;
    if (!/PLANNER_RESPONSE/.test(String(s?.type || ''))) return false;
    const st = String((s as { status?: unknown } | null | undefined)?.status || '');
    return /GENERATING|DONE/i.test(st);
  });
  return resumed ? classifyRequestError('') : error;
}

/**
 * 综合轨迹步骤、生成元数据与可选本地 SQLite 尾部诊断，计算：
 * 1) 当前是否在生成中（供速度呼吸灯与缓存保鲜状态使用）
 * 2) 最近一次完成响应的时间戳（供 Prompt Cache 过期倒计时与速度呼吸灯 15s 保持使用）
 * 3) 本轮统计（耗时、请求数、思考/写入 token）
 * 4) 本轮首字等待记录与实时等待起点（工具执行/流式输出/结束时严格停表）
 * 5) 最近一次请求失败分类（后续恢复流式/成功后自动清除）
 */
export function computeTurnAndAlerts(
  steps: ReadonlyArray<TrajectoryStepLike>,
  generators: ReadonlyArray<GeneratorMetadataLike>,
  resp: Record<string, unknown>,
  isRunning: boolean,
  diag: SqliteTurnDiagnostics | null,
): TurnDiagnosticsResult {
  // 1. 解析最近一次完成响应时间与当前生成状态
  let lastResponseAtMs: number | null = null;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const type = String(step?.type || '');
    if (/PLANNER_RESPONSE/.test(type)) {
      const st = String((step as { status?: unknown } | null | undefined)?.status || '');
      if (!st || /DONE|COMPLETED/i.test(st)) {
        const ts =
          parseMs((step?.metadata as Record<string, unknown> | null | undefined)?.finishedGeneratingAt) ??
          parseMs(step?.metadata?.completedAt) ??
          parseMs(step?.metadata?.startedAt) ??
          parseMs(step?.metadata?.createdAt);
        if (ts !== null) {
          lastResponseAtMs = ts;
          break;
        }
      }
    }
  }
  if (lastResponseAtMs === null && diag?.turnSteps.length) {
    for (let i = diag.turnSteps.length - 1; i >= 0; i--) {
      const s = diag.turnSteps[i];
      if (s.stepType === 15 && s.status === 3) {
        lastResponseAtMs = s.recordedCompletedAtMs ?? s.terminalAtMs ?? s.createdAtMs;
        if (lastResponseAtMs !== null) break;
      }
    }
  }
  if (lastResponseAtMs === null) {
    for (let i = generators.length - 1; i >= 0; i--) {
      const chat = generators[i]?.chatModel;
      const startMs = parseMs(chat?.chatStartMetadata?.createdAt);
      if (startMs !== null) {
        const durSec = (seconds(chat?.timeToFirstToken) ?? 0) + (seconds(chat?.streamingDuration) ?? 0);
        lastResponseAtMs = Math.round(startMs + durSec * 1000);
        break;
      }
    }
  }

  let hasStreamingPlanner = false;
  let hasActiveStep = false;
  if (diag?.turnSteps.length) {
    hasStreamingPlanner = diag.turnSteps.some((s) => s.stepType === 15 && s.status === 8);
    hasActiveStep = diag.turnSteps.some((s) => s.stepType !== 14 && ACTIVE_STATUS_NUMS.has(s.status));
  } else {
    for (let i = Math.max(0, steps.length - 20); i < steps.length; i++) {
      const s = steps[i];
      const st = String((s as { status?: unknown } | null | undefined)?.status || '');
      const type = String(s?.type || '');
      if (/PLANNER_RESPONSE/.test(type) && /GENERATING/i.test(st)) hasStreamingPlanner = true;
      if (!/USER_INPUT/.test(type) && ACTIVE_STATUS_RE.test(st)) hasActiveStep = true;
    }
  }
  const isGenerating = isRunning || hasStreamingPlanner || hasActiveStep;

  // 2. 确定当前轮次的用户输入起点
  let userStepIndex: number | null = diag?.userStepIndex ?? null;
  let latestUserStepIndex: number | null = diag?.latestUserStepIndex ?? null;
  if (userStepIndex === null && latestUserStepIndex === null) {
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (!/USER_INPUT/.test(String(s?.type || ''))) continue;
      const idx = stepNumber(s, i);
      if (latestUserStepIndex === null) latestUserStepIndex = idx;
      const st = String((s as { status?: unknown } | null | undefined)?.status || '');
      if (!/QUEUED/i.test(st)) {
        userStepIndex = idx;
        break;
      }
    }
  }
  const effectiveUserIdx = userStepIndex ?? latestUserStepIndex;

  // 3. 归属当前轮次的模型请求与 token 汇总
  let turnRequests = 0;
  let turnInputTokens = 0;
  let turnCacheInputTokens = 0;
  let turnCachedTokens = 0;
  let turnCacheWriteTokens = 0;
  let turnCacheMeasuredRequests = 0;
  let firstRequestCacheHitRate: number | null = null;
  let lastRequestCacheHitRate: number | null = null;
  let turnThinkingTokens = 0;
  let turnOutputTokens = 0;
  let turnTotalOutputTokens = 0;

  const userStepFallback =
    effectiveUserIdx !== null
      ? steps.find((s, i) => stepNumber(s, i) === effectiveUserIdx) ?? null
      : null;
  const userCreatedMsFallback = parseMs(userStepFallback?.metadata?.createdAt);

  const turnWaits: number[] = [];
  const coveredPlannerSteps = new Set<number>();

  let rpcErrorCandidate: { error: RequestErrorInfo; stepIndices: number[] } | null = null;

  for (const gen of generators) {
    const chat = gen?.chatModel;
    if (!chat) continue;
    const indices = stepIndicesOf(gen);
    const genStartMs = parseMs(chat.chatStartMetadata?.createdAt);
    const belongsToTurn =
      effectiveUserIdx !== null &&
      (indices.length > 0
        ? indices.some((idx) => idx > effectiveUserIdx)
        : userCreatedMsFallback !== null && genStartMs !== null && genStartMs >= userCreatedMsFallback);

    if (belongsToTurn) {
      const usage = chat.usage && typeof chat.usage === 'object' ? (chat.usage as Record<string, unknown>) : null;
      const retries = Array.isArray(chat.retryInfos) ? chat.retryInfos : [];
      if (usage || retries.length > 0 || chat.timeToFirstToken !== undefined || chat.streamingDuration !== undefined) {
        turnRequests += Math.max(1, retries.length);
      }
      if (usage) {
        const uncached = tokenCount(usage.inputTokens) ?? 0;
        const cached = tokenCount(usage.cacheReadTokens) ?? 0;
        const cacheWrite = tokenCount(usage.cacheWriteTokens) ?? 0;
        const totalOut = tokenCount(usage.outputTokens) ?? 0;
        const thinking = tokenCount(usage.thinkingOutputTokens) ?? 0;
        const reply = tokenCount(usage.responseOutputTokens);
        turnInputTokens += uncached + cached + cacheWrite;
        const cacheSample = requestCacheMetrics(usage);
        if (cacheSample) {
          turnCacheInputTokens += cacheSample.inputTokens;
          turnCachedTokens += cacheSample.cachedTokens;
          turnCacheWriteTokens += cacheSample.cacheWriteTokens;
          if (cacheSample.inputTokens > 0) {
            turnCacheMeasuredRequests += 1;
            const reqRate = cacheSample.cachedTokens / cacheSample.inputTokens;
            if (firstRequestCacheHitRate === null) firstRequestCacheHitRate = reqRate;
            lastRequestCacheHitRate = reqRate;
          }
        }
        turnThinkingTokens += thinking;
        turnOutputTokens += reply !== null ? reply : Math.max(0, totalOut - thinking);
        turnTotalOutputTokens += totalOut || thinking + (reply ?? 0);
      }
      const ttft = seconds(chat.timeToFirstToken);
      if (ttft !== null && ttft >= 0) {
        turnWaits.push(ttft);
        for (const idx of indices) coveredPlannerSteps.add(idx);
      }
      // 从 RPC retryInfos 或 chatModel.error 捕获报错（仅看最后一次尝试）
      const lastRetry = retries.at(-1) as Record<string, unknown> | undefined;
      const errStr =
        extractErrorString(lastRetry?.error) ||
        extractErrorString((chat as Record<string, unknown>).error);
      const classified = classifyRequestError(errStr);
      rpcErrorCandidate = { error: classified, stepIndices: indices };
    }
  }

  // 4. 计算本轮统计状态与耗时
  let turnMetrics: TurnMetrics | null = null;
  if (effectiveUserIdx !== null) {
    const diagUserStep = diag?.turnSteps.find((s) => s.idx === effectiveUserIdx && s.stepType === 14) ?? null;
    const startedAtMs = diagUserStep?.createdAtMs ?? userCreatedMsFallback;
    let state: TurnState = 'unknown';
    let endedAtMs: number | null = null;

    if (diag && diagUserStep) {
      const scope = diag.turnSteps.filter((s) => s.idx >= effectiveUserIdx);
      const active = scope.some((s) => s.stepType !== 14 && ACTIVE_STATUS_NUMS.has(s.status));
      const executor = diag.executors.filter((ex) => ex.lastStepIndex >= effectiveUserIdx).at(-1);
      const finalStep = executor ? scope.find((s) => s.idx === executor.lastStepIndex) : undefined;
      const laterExec = Boolean(
        executor &&
          scope.some((s) => s.idx > executor.lastStepIndex && s.stepType !== 14 && s.stepType !== 17 && s.stepType !== 101),
      );
      const execMatch = Boolean(
        finalStep && (!executor?.executionId || !finalStep.executionId || executor.executionId === finalStep.executionId),
      );
      if (diagUserStep.status === 11) {
        state = 'queued';
      } else if (active || isRunning) {
        state = 'running';
      } else if (executor && execMatch && !laterExec && ![0, 7, 12].includes(executor.reason)) {
        state =
          executor.reason === 1
            ? 'failed'
            : [2, 3, 6, 11].includes(executor.reason)
              ? 'interrupted'
              : 'completed';
        if (executor.reason === 2) {
          const lastCompleted = finalStep!.recordedCompletedAtMs ?? finalStep!.terminalAtMs;
          const cancels = scope
            .filter(
              (s) =>
                (s.status === 6 || s.status === 12) &&
                (!executor.executionId || !s.executionId || s.executionId === executor.executionId),
            )
            .map((s) => s.terminalAtMs ?? s.recordedCompletedAtMs)
            .filter((t): t is number => t !== null && (!lastCompleted || t >= lastCompleted));
          endedAtMs = cancels.length ? Math.max(...cancels) : null;
        } else {
          const errorStep =
            executor.reason === 1
              ? [...scope].reverse().find((s) => s.stepType === 17 && s.idx >= executor.lastStepIndex)
              : undefined;
          const endStep = errorStep ?? finalStep;
          endedAtMs = endStep?.recordedCompletedAtMs ?? endStep?.terminalAtMs ?? null;
        }
      } else if (
        (diagUserStep.status === 6 || diagUserStep.status === 12) &&
        scope.every((s) => s.stepType === 14)
      ) {
        state = 'interrupted';
        endedAtMs = diagUserStep.terminalAtMs;
      } else if (!isRunning && scope.length > 1) {
        const lastDone = [...scope].reverse().find((s) => s.stepType !== 14);
        state = lastDone?.status === 7 ? 'failed' : 'completed';
        endedAtMs = lastDone?.recordedCompletedAtMs ?? lastDone?.terminalAtMs ?? null;
      }
    } else {
      const scopeSteps = steps.filter((s, i) => stepNumber(s, i) >= effectiveUserIdx);
      if (isRunning || hasActiveStep) {
        state = 'running';
      } else if (scopeSteps.length > 1) {
        const lastStep = scopeSteps[scopeSteps.length - 1];
        const st = String((lastStep as { status?: unknown } | null | undefined)?.status || '');
        state = /ERROR|FAIL/i.test(st) ? 'failed' : /CANCEL/i.test(st) ? 'interrupted' : 'completed';
        endedAtMs =
          parseMs(lastStep?.metadata?.completedAt) ??
          parseMs((lastStep?.metadata as Record<string, unknown> | null | undefined)?.finishedGeneratingAt) ??
          parseMs(lastStep?.metadata?.startedAt) ??
          parseMs(lastStep?.metadata?.createdAt);
      }
    }

    if (startedAtMs !== null && endedAtMs !== null && endedAtMs < startedAtMs) {
      endedAtMs = null;
    }
    turnMetrics = {
      userStepIndex: effectiveUserIdx,
      state,
      startedAtMs,
      endedAtMs,
      durationSeconds:
        startedAtMs !== null && endedAtMs !== null ? (endedAtMs - startedAtMs) / 1000 : null,
      requests: turnRequests,
      inputTokens: turnCacheInputTokens > 0 ? turnCacheInputTokens : turnInputTokens,
      cachedTokens: turnCachedTokens,
      cacheWriteTokens: turnCacheWriteTokens,
      cacheMeasuredRequests: turnCacheMeasuredRequests,
      cacheHitRate: turnCacheInputTokens > 0 ? turnCachedTokens / turnCacheInputTokens : null,
      firstRequestCacheHitRate,
      lastRequestCacheHitRate,
      thinkingTokens: turnThinkingTokens,
      outputTokens: turnOutputTokens,
      totalOutputTokens: turnTotalOutputTokens,
    };
  }

  // 5. 计算本轮首字等待队列（工具执行、流式输出或轮次结束时不累加实时等待）
  let turnQueue: FirstTokenWaitMetrics | null = null;
  if (userStepIndex !== null) {
    let waitingSinceMs: number | null = null;
    let hasPendingPlanner = false;
    let turnTerminal = !isRunning;

    if (diag && diag.turnSteps.length > 0) {
      const scope = diag.turnSteps.filter((s) => s.idx >= userStepIndex!);
      const user = scope.find((s) => s.idx === userStepIndex && s.stepType === 14);
      const active = scope.some((s) => s.stepType !== 14 && ACTIVE_STATUS_NUMS.has(s.status));
      const executor = diag.executors.filter((ex) => ex.lastStepIndex >= userStepIndex!).at(-1);
      const finalStep = executor ? scope.find((s) => s.idx === executor.lastStepIndex) : undefined;
      const laterExec = Boolean(
        executor &&
          scope.some((s) => s.idx > executor.lastStepIndex && s.stepType !== 14 && s.stepType !== 17 && s.stepType !== 101),
      );
      const execMatch = Boolean(
        finalStep && (!executor?.executionId || !finalStep.executionId || executor.executionId === finalStep.executionId),
      );
      const executorEnded = Boolean(executor && execMatch && !laterExec && ![0, 7, 12].includes(executor.reason));
      turnTerminal =
        !active &&
        (executorEnded ||
          (Boolean(user && (user.status === 6 || user.status === 12)) &&
            scope.every((s) => s.stepType === 14)));

      for (const s of scope) {
        if (s.stepType !== 15 || coveredPlannerSteps.has(s.idx)) continue;
        if (s.createdAtMs && s.generatingAtMs && s.generatingAtMs >= s.createdAtMs) {
          turnWaits.push((s.generatingAtMs - s.createdAtMs) / 1000);
        }
      }

      const hasActiveTool = scope.some(
        (s) => s.stepType !== 14 && s.stepType !== 15 && ACTIVE_STATUS_NUMS.has(s.status),
      );
      const streamingNow = scope.some((s) => s.stepType === 15 && s.status === 8);
      const pendingPlanner = [...scope]
        .reverse()
        .find((s) => s.stepType === 15 && (s.status === 1 || s.status === 2));
      hasPendingPlanner = Boolean(
        pendingPlanner && !coveredPlannerSteps.has(pendingPlanner.idx) && !pendingPlanner.generatingAtMs,
      );

      if (!turnTerminal && !hasActiveTool && !streamingNow) {
        if (pendingPlanner) {
          if (hasPendingPlanner) waitingSinceMs = pendingPlanner.createdAtMs;
        } else {
          const relevant = scope.filter(
            (s) => !(s.stepType === 14 && s.status === 11) && s.stepType !== 17 && s.stepType !== 101,
          );
          const last = relevant.at(-1);
          if (last) {
            if (last.stepType === 14) {
              waitingSinceMs = last.inputStartedAtMs;
            } else if (last.stepType !== 15 || last.status === 3) {
              waitingSinceMs = last.recordedCompletedAtMs ?? last.terminalAtMs;
            }
          }
        }
      }
    } else {
      // 无本地 SQLite 诊断时的回退路径（远程会话或纯 RPC 测试夹具）
      const scope = steps.filter((s, i) => stepNumber(s, i) >= userStepIndex!);
      for (let i = 0; i < scope.length; i++) {
        const s = scope[i];
        const idx = stepNumber(s, i);
        if (!/PLANNER_RESPONSE/.test(String(s?.type || '')) || coveredPlannerSteps.has(idx)) continue;
        const cMs = parseMs(s?.metadata?.createdAt);
        const gMs =
          parseMs((s?.metadata as Record<string, unknown> | null | undefined)?.viewableAt) ??
          parseMs(s?.metadata?.startedAt);
        if (cMs !== null && gMs !== null && gMs >= cMs) {
          turnWaits.push((gMs - cMs) / 1000);
        }
      }
      const hasActiveTool = scope.some((s) => {
        const type = String(s?.type || '');
        const st = String((s as { status?: unknown } | null | undefined)?.status || '');
        return !/USER_INPUT|PLANNER_RESPONSE/.test(type) && ACTIVE_STATUS_RE.test(st);
      });
      const streamingNow = scope.some((s) => {
        const type = String(s?.type || '');
        const st = String((s as { status?: unknown } | null | undefined)?.status || '');
        return /PLANNER_RESPONSE/.test(type) && /GENERATING/i.test(st);
      });
      const pendingPlanner = [...scope].reverse().find((s) => {
        const type = String(s?.type || '');
        const st = String((s as { status?: unknown } | null | undefined)?.status || '');
        return /PLANNER_RESPONSE/.test(type) && /PENDING|RUNNING/i.test(st);
      });
      hasPendingPlanner = Boolean(
        pendingPlanner &&
          !coveredPlannerSteps.has(stepNumber(pendingPlanner, -1)) &&
          !parseMs((pendingPlanner.metadata as Record<string, unknown> | null | undefined)?.viewableAt),
      );
      if (!turnTerminal && !hasActiveTool && !streamingNow && pendingPlanner && hasPendingPlanner) {
        waitingSinceMs = parseMs(pendingPlanner.metadata?.createdAt);
      }
    }

    turnQueue = {
      userStepIndex,
      waits: turnWaits,
      waitingSinceMs,
      hasPendingPlanner,
      turnTerminal,
    };
  }

  // 6. 计算最近一次请求失败分类（优先使用本地 SQLite 最新一轮的 retryInfos 最终尝试）
  let requestError: RequestErrorInfo = classifyRequestError('');
  if (diag && diag.recentRequests.length > 0) {
    let latestTurnReq = null;
    for (const req of diag.recentRequests) {
      const earlier =
        userStepIndex !== null && req.lastStepIndex >= 0 && req.lastStepIndex < userStepIndex;
      if (!earlier) latestTurnReq = req;
    }
    if (latestTurnReq && latestTurnReq.retryErrorText) {
      requestError = visibleRequestError(
        classifyRequestError(latestTurnReq.retryErrorText),
        latestTurnReq.stepIndices,
        diag,
        steps,
      );
    }
  }
  if (requestError.kind === 'none' && rpcErrorCandidate && rpcErrorCandidate.error.kind !== 'none') {
    requestError = visibleRequestError(
      rpcErrorCandidate.error,
      rpcErrorCandidate.stepIndices,
      diag,
      steps,
    );
  }
  if (requestError.kind === 'none') {
    const rawLastStepErr = extractErrorString(resp.lastStepError);
    if (rawLastStepErr) {
      requestError = classifyRequestError(rawLastStepErr);
    }
  }

  return {
    isGenerating,
    lastResponseAtMs,
    turnMetrics,
    turnQueue,
    requestError: requestError.kind !== 'none' ? requestError : null,
  };
}
