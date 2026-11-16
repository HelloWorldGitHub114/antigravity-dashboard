import type { ModelTimelineSnapshot, TimelineLane, TimelineRole, TimelineSwimlaneItem } from '../../contracts/timeline.ts';
import * as nativeBridge from '../../platform/native-bridge.ts';
import { formatModelName, isOrchestratorModel } from '../context.ts';
import { normalizeConversationId } from '../delegation/delegation.ts';
import { extractPlanModel } from '../metrics/index.ts';
import {
  addTokens, appendToolToCall, buildSubagentNode, clamp01, cleanStr,
  collectTimelineGenerators, extractTaskBoundaryMode, isToolStep, iso, parseTs,
  stepToolFallback, zeroTokens,
  type BuildModelTimelineOptions, type InternalTimelineNode, type TimelineGenerator,
  type TimelineRawInput, type TimelineStepLike, type TimelineSubagentInput,
} from './categorizer.ts';
import { compactTimeline, MAX_TIMELINE_BYTES, MAX_TIMELINE_NODES } from './compactor.ts';
import {
  coalesceSwimlanesFallback,
  type CoalesceSwimlanesInput,
  type CoalesceSwimlanesOutput,
} from './swimlane-coalesce.ts';

interface PendingHandoff {
  stepIndex: number;
  timeMs: number | null;
  trigger: string;
  fromModel: string | null;
}

interface TimelineBuildState {
  turn: InternalTimelineNode | null;
  phase: InternalTimelineNode | null;
  pendingHandoff: PendingHandoff | null;
  lastModel: string | null;
}

const VALID_LANES = new Set<TimelineLane>(['plan', 'worker', 'tool', 'subagent', 'handoff']);
const SWIMLANE_COALESCE_THRESHOLD = 120;

interface SwimlaneNativeBridge {
  tryCoalesceSwimlanesJson?: (inputJson: string) => string | null;
}

/**
 * Coalesces swimlane segments via the Rust `pulse-accel` N-API bridge when available,
 * transparently falling back to `coalesceSwimlanesFallback` on error, null, or when
 * `PULSE_DISABLE_NATIVE_ACCEL=1`.
 */
export function coalesceSwimlanes(input: CoalesceSwimlanesInput): CoalesceSwimlanesOutput {
  if (process.env.PULSE_DISABLE_NATIVE_ACCEL !== '1') {
    const tryCoalesceSwimlanesJson = (nativeBridge as SwimlaneNativeBridge).tryCoalesceSwimlanesJson;
    if (typeof tryCoalesceSwimlanesJson === 'function') {
      try {
        const raw = tryCoalesceSwimlanesJson(JSON.stringify(input));
        if (typeof raw === 'string' && raw.length > 0) {
          const parsed = JSON.parse(raw) as Partial<CoalesceSwimlanesOutput> | null;
          if (parsed && typeof parsed === 'object' && Array.isArray(parsed.lanes)) {
            return parsed as CoalesceSwimlanesOutput;
          }
        }
      } catch {
        // Fall back to pure-TS coalescer on native error.
      }
    }
  }
  return coalesceSwimlanesFallback(input);
}

function buildSwimlanes(
  turns: InternalTimelineNode[],
  steps: readonly TimelineStepLike[],
  genList: readonly TimelineGenerator[],
  subagentItems: readonly TimelineSubagentInput[],
): { swimlanes: TimelineSwimlaneItem[]; startedAt: string | null; endedAt: string | null; durationMs: number } {
  const allTimes: number[] = [];
  for (const s of steps) {
    for (const k of ['createdAt', 'startedAt', 'completedAt'] as const) {
      const t = parseTs(s?.metadata?.[k]);
      if (t !== null) allTimes.push(t);
    }
  }
  for (const g of genList) {
    if (g.startMs !== null) allTimes.push(g.startMs);
    if (g.endMs !== null) allTimes.push(g.endMs);
  }
  for (const c of subagentItems) {
    const s = parseTs(c.startedAt), e = parseTs(c.endedAt);
    if (s !== null) allTimes.push(s);
    if (e !== null) allTimes.push(e);
  }
  const startedAtMs = allTimes.length ? Math.min(...allTimes) : 0;
  const endedAtMs = allTimes.length ? Math.max(...allTimes) : Math.max(0, genList.length * 1000);
  const spanMs = Math.max(1, endedAtMs - startedAtMs);
  const swimlanes: TimelineSwimlaneItem[] = [];
  const pushLane = (
    kind: TimelineLane, model: string | null, label: string,
    startMs: number, endMs: number, stepStart: number, stepEnd: number, calls: number,
  ): void => {
    swimlanes.push({
      kind, model, label, startMs, endMs,
      startRatio: clamp01((startMs - startedAtMs) / spanMs),
      widthRatio: endMs === startMs && kind === 'handoff' ? 0.01 : Math.max(0.01, clamp01((endMs - startMs) / spanMs)),
      stepStart, stepEnd, calls,
    });
  };
  let seqIdx = 0;

  for (const turn of turns) {
    let tMin = Infinity, tMax = -Infinity;
    for (const ch of turn.children) {
      if (ch.kind === 'phase') {
        const calls = ch.children.filter((c) => c.kind === 'model_call');
        const cTimes = calls.flatMap((c) => [c._startMs, c._endMs]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
        const sMs = cTimes.length ? Math.min(...cTimes) : (ch._startMs ?? startedAtMs + seqIdx * 1000);
        const eMs = cTimes.length ? Math.max(...cTimes) : Math.max(sMs, ch._endMs ?? sMs + (ch.durationMs || 1000));
        ch.durationMs = Math.max(0, Math.round(eMs - sMs));
        if (sMs < tMin) tMin = sMs;
        if (eMs > tMax) tMax = eMs;
        seqIdx++;
        const laneKind: TimelineLane = ch.role && VALID_LANES.has(ch.role as TimelineLane) ? (ch.role as TimelineLane) : 'worker';
        pushLane(laneKind, ch.model, ch.model || ch.role || 'model', sMs, eMs, ch.meta?.stepStart ?? 0, ch.meta?.stepEnd ?? 0, ch.meta?.calls || calls.length);
        const toolCalls = calls.flatMap((c) => c.children).filter((c) => c.kind === 'tool_group');
        if (toolCalls.length) {
          const toolCount = toolCalls.reduce((sum, tg) => sum + (tg.meta?.count || 1), 0);
          pushLane('tool', ch.model, `${toolCount} tools`, sMs, eMs, ch.meta?.stepStart ?? 0, ch.meta?.stepEnd ?? 0, toolCount);
        }
      } else if (ch.kind === 'handoff') {
        const hMs = ch._startMs ?? startedAtMs + seqIdx * 1000;
        if (hMs < tMin) tMin = hMs;
        if (hMs > tMax) tMax = hMs;
        pushLane('handoff', ch.meta?.toModel || ch.model, `${ch.meta?.fromModel || '?'} -> ${ch.meta?.toModel || '?'}`, hMs, hMs, ch.meta?.stepIndex ?? 0, ch.meta?.stepIndex ?? 0, 1);
      }
    }
    if (Number.isFinite(tMin) && Number.isFinite(tMax)) turn.durationMs = Math.max(0, Math.round(tMax - tMin));
  }

  for (const item of subagentItems) {
    const sMs = parseTs(item.startedAt) ?? startedAtMs;
    const eMs = Math.max(sMs, parseTs(item.endedAt) ?? sMs + (item.durationMs || 0));
    pushLane('subagent', formatModelName(item.activeModel || item.model), cleanStr(item.role, 64) || 'subagent', sMs, eMs, 0, item.steps || 0, item.requests || 0);
  }

  const finalSwimlanes: TimelineSwimlaneItem[] =
    swimlanes.length > SWIMLANE_COALESCE_THRESHOLD
      ? coalesceSwimlanes({ lanes: swimlanes, totalStartMs: startedAtMs, spanMs }).lanes.map(
          ({ kind, model, label, startMs, endMs, startRatio, widthRatio, stepStart, stepEnd, calls }) => ({
            kind, model, label, startMs, endMs, startRatio, widthRatio, stepStart, stepEnd, calls,
          }),
        )
      : swimlanes;

  return {
    swimlanes: finalSwimlanes,
    startedAt: allTimes.length ? iso(startedAtMs) : null,
    endedAt: allTimes.length ? iso(endedAtMs) : null,
    durationMs: allTimes.length ? Math.max(0, Math.round(endedAtMs - startedAtMs)) : 0,
  };
}

export function buildModelTimeline(
  raw: unknown,
  options: BuildModelTimelineOptions = {},
): ModelTimelineSnapshot | null {
  const input = (raw && typeof raw === 'object' ? raw : null) as TimelineRawInput | null;
  const trajectory = input?.trajectory ?? {};
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
  const rawGenerators = Array.isArray(trajectory.generatorMetadata) ? trajectory.generatorMetadata : [];
  const cascadeId = normalizeConversationId(options.cascadeId || trajectory.cascadeId || input?.cascadeId) || 'unknown';
  const planModel = options.metrics?.planModel ?? extractPlanModel(input);
  const { generators: genList, isHybrid } = collectTimelineGenerators(rawGenerators, steps, planModel);

  const subagentItems = Array.isArray(options.subagentItems) ? options.subagentItems : [];
  const attachedChildren = new Set<string>();
  const stepToGen = new Map<number, TimelineGenerator>();
  for (const g of genList) for (const si of g.idxs) if (!stepToGen.has(si)) stepToGen.set(si, g);

  const turns: InternalTimelineNode[] = [];
  const state: TimelineBuildState = { turn: null, phase: null, pendingHandoff: null, lastModel: null };
  let turnNum = 0, phaseNum = 0, callNum = 0, handoffNum = 0;

  const ensureTurn = (stepIdx: number, timeMs: number | null, turnPlan: string | null = planModel): InternalTimelineNode => {
    if (state.turn) return state.turn;
    turnNum++;
    state.turn = {
      id: `turn-${turnNum}`, kind: 'turn', time: iso(timeMs), durationMs: 0, model: turnPlan || null,
      role: isHybrid ? 'plan' : 'model', event: 'turn',
      meta: { round: turnNum, stepStart: stepIdx, stepEnd: stepIdx, ...(turnPlan ? { planModel: turnPlan } : {}) },
      tokens: zeroTokens(), childConversationId: null, children: [], _startMs: timeMs, _endMs: timeMs,
    };
    turns.push(state.turn);
    state.phase = null;
    return state.turn;
  };

  const ensurePhase = (role: TimelineRole, model: string | null, stepIdx: number, timeMs: number | null, tbMode: string | null = null): InternalTimelineNode => {
    const t = ensureTurn(stepIdx, timeMs);
    if (state.phase && state.phase.role === role && state.phase.model === model && (!tbMode || state.phase.meta?.mode === tbMode)) return state.phase;
    phaseNum++;
    const event = role === 'plan' ? 'plan' : role === 'worker' ? 'worker' : 'phase';
    state.phase = {
      id: `phase-${phaseNum}`, kind: 'phase', time: iso(timeMs), durationMs: 0, model: model || t.model, role, event,
      meta: { stepStart: stepIdx, stepEnd: stepIdx, calls: 0, ...(tbMode ? { mode: tbMode } : {}) },
      tokens: zeroTokens(), childConversationId: null, children: [], _startMs: timeMs, _endMs: timeMs,
    };
    t.children.push(state.phase);
    return state.phase;
  };

  const emitHandoff = (fromModel: string | null, toModel: string | null, trigger: string, stepIdx: number, timeMs: number | null): void => {
    const t = ensureTurn(stepIdx, timeMs);
    handoffNum++;
    t.children.push({
      id: `handoff-${handoffNum}`, kind: 'handoff', time: iso(timeMs), durationMs: 0, model: toModel || fromModel, role: null,
      event: trigger === 'model_switch' ? 'model_switch' : 'handoff',
      meta: { stepIndex: stepIdx, trigger, fromModel: fromModel ?? undefined, toModel: toModel ?? undefined },
      tokens: null, childConversationId: null, children: [], _startMs: timeMs, _endMs: timeMs,
    });
    state.phase = null;
  };

  const placeGenerator = (g: TimelineGenerator, stepIdxFallback: number): void => {
    g.placed = true;
    const stepStart = g.idxs.length ? g.idxs[0] : stepIdxFallback;
    const stepEnd = g.idxs.length ? g.idxs[g.idxs.length - 1] : stepIdxFallback;
    const timeMs = g.startMs;
    if (state.pendingHandoff) {
      emitHandoff(state.pendingHandoff.fromModel, g.model, state.pendingHandoff.trigger, state.pendingHandoff.stepIndex, state.pendingHandoff.timeMs ?? timeMs);
      state.pendingHandoff = null;
    } else if (state.lastModel && g.model && state.lastModel !== g.model) {
      emitHandoff(state.lastModel, g.model, 'model_switch', stepStart, timeMs);
    }
    const phase = ensurePhase(g.role, g.model, stepStart, timeMs);
    callNum++;
    const callNode: InternalTimelineNode = {
      id: `call-${callNum}`, kind: 'model_call', time: iso(timeMs), durationMs: g.durationMs, model: g.model, role: g.role,
      event: g.role === 'plan' ? 'plan' : g.role === 'worker' ? 'worker' : 'model_call',
      meta: { generatorIndex: g.gi, stepStart, stepEnd, ttftMs: g.ttftMs ?? undefined, streamingMs: g.streamingMs ?? undefined, toolCount: 0 },
      tokens: g.tokens, childConversationId: null, children: [], _startMs: g.startMs, _endMs: g.endMs,
    };
    const assocSteps = g.idxs.map((idx) => ({ idx, step: steps[idx] })).filter((x): x is { idx: number; step: TimelineStepLike } => Boolean(x.step));
    const execSteps = assocSteps.filter((x) => isToolStep(x.step));
    const plannerCalls: Array<{ name: unknown; status: unknown; stepIdx: number; meta: TimelineStepLike['metadata'] }> = [];
    for (const { idx, step } of assocSteps) {
      if (/PLANNER_RESPONSE/.test(String(step.type || ''))) {
        for (const tc of step.plannerResponse?.toolCalls || []) plannerCalls.push({ name: tc?.name || null, status: tc?.status || null, stepIdx: idx, meta: step.metadata });
      }
    }
    const toolTotal = Math.max(plannerCalls.length, execSteps.length);
    callNode.meta!.toolCount = toolTotal;
    let hasSwarmCall = false;
    for (let k = 0; k < toolTotal; k++) {
      const pc = plannerCalls[k], es = execSteps[k];
      const name = pc?.name || es?.step?.metadata?.toolCall?.name || stepToolFallback(es?.step?.type);
      const stIdx = es?.idx ?? pc?.stepIdx ?? stepStart;
      const sm = es?.step?.metadata || pc?.meta;
      const sMs = parseTs(sm?.startedAt) ?? parseTs(sm?.createdAt) ?? timeMs, eMs = parseTs(sm?.completedAt);
      const dur = sMs !== null && eMs !== null && eMs >= sMs ? Math.round(eMs - sMs) : 0;
      const status = es?.step?.status || pc?.status || 'CORTEX_STEP_STATUS_DONE';
      if (name === 'swarm' || name === 'swarm_manage') hasSwarmCall = true;
      if (name === 'exit_plan_mode') state.pendingHandoff = { stepIndex: stIdx, timeMs: eMs ?? sMs, trigger: 'exit_plan_mode', fromModel: g.model };
      if (name) appendToolToCall(callNode, name, status, stIdx, sMs, dur);
    }
    for (const { step } of assocSteps) {
      const inv = step.invokeSubagent;
      const convIds = [...new Set([inv?.conversationId, ...(inv?.results || []).map((r) => r?.conversationId)].map(normalizeConversationId).filter((cid): cid is string => Boolean(cid)))];
      for (const cid of convIds) {
        attachedChildren.add(cid);
        callNode.children.push(buildSubagentNode(subagentItems.find((x) => normalizeConversationId(x.id) === cid) || { id: cid }, callNode.children.length + 1));
      }
    }
    if (hasSwarmCall && subagentItems.length) {
      for (const item of subagentItems) {
        const cid = normalizeConversationId(item.id);
        if (!cid || attachedChildren.has(cid)) continue;
        const cMs = parseTs(item.startedAt);
        if (cMs === null || timeMs === null || (cMs >= timeMs - 5000 && cMs <= (g.endMs ?? timeMs) + 120000)) {
          attachedChildren.add(cid);
          callNode.children.push(buildSubagentNode(item, callNode.children.length + 1));
        }
      }
    }
    phase.children.push(callNode);
    phase.meta!.calls = (phase.meta!.calls ?? 0) + 1;
    phase.meta!.stepEnd = Math.max(phase.meta!.stepEnd ?? stepEnd, stepEnd);
    addTokens(phase.tokens!, g.tokens);
    state.turn!.meta!.stepEnd = Math.max(state.turn!.meta!.stepEnd ?? stepEnd, stepEnd);
    addTokens(state.turn!.tokens!, g.tokens);
    state.lastModel = g.model || state.lastModel;
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const idx = typeof step.i === 'number' && Number.isInteger(step.i) ? step.i : i;
    const type = String(step.type || '');
    const sMs = parseTs(step.metadata?.startedAt) ?? parseTs(step.metadata?.createdAt);
    const eMs = parseTs(step.metadata?.completedAt) ?? sMs;
    if (/USER_INPUT/.test(type)) {
      state.turn = null;
      state.phase = null;
      ensureTurn(idx, sMs, formatModelName(step.userInput?.userConfig?.plannerConfig?.planModel) || planModel);
      continue;
    }
    if (step.exitPlanMode) state.pendingHandoff = { stepIndex: idx, timeMs: eMs ?? sMs, trigger: 'exit_plan_mode', fromModel: state.lastModel };
    else if (/SYSTEM_MESSAGE/.test(type) && step.systemMessage?.eventType === 'plan_mode_handoff') {
      state.pendingHandoff = { stepIndex: idx, timeMs: eMs ?? sMs, trigger: 'plan_mode_handoff', fromModel: state.pendingHandoff?.fromModel || state.lastModel };
    }
    const modeUpper = extractTaskBoundaryMode(step);
    if (modeUpper) {
      if (state.phase && state.phase.meta?.mode && state.phase.meta.mode !== modeUpper) emitHandoff(state.lastModel, state.lastModel, 'task_boundary', idx, sMs);
      ensurePhase(state.lastModel && isOrchestratorModel(state.lastModel) ? 'plan' : isHybrid ? 'worker' : 'model', state.lastModel, idx, sMs, modeUpper);
    }
    const gen = stepToGen.get(idx);
    if (gen && !gen.placed) placeGenerator(gen, idx);
    if (/ERROR_MESSAGE/.test(type) || /ERROR/.test(String(step.status || ''))) {
      const lastChild = state.phase?.children.at(-1);
      const target = (lastChild?.kind === 'model_call' ? lastChild : state.phase) || ensureTurn(idx, sMs);
      target.children.push({
        id: `error-${idx}`, kind: 'error', time: iso(eMs ?? sMs), durationMs: 0, model: target.model, role: target.role, event: 'error',
        meta: { stepIndex: idx, stepType: cleanStr(type, 48) ?? undefined }, tokens: null, childConversationId: null, children: [],
      });
    }
  }
  for (const g of genList) if (!g.placed) placeGenerator(g, g.idxs[0] ?? 0);
  if (state.pendingHandoff) {
    emitHandoff(state.pendingHandoff.fromModel, options.metrics?.activeModel || state.lastModel, state.pendingHandoff.trigger, state.pendingHandoff.stepIndex, state.pendingHandoff.timeMs);
  }
  if (subagentItems.length) {
    const remaining = subagentItems.filter((x) => { const cid = normalizeConversationId(x.id); return cid && !attachedChildren.has(cid); });
    if (remaining.length) {
      const target = state.turn || ensureTurn(0, parseTs(remaining[0].startedAt), planModel);
      for (const item of remaining) target.children.push(buildSubagentNode(item, target.children.length + 1));
    }
  }
  const { swimlanes, startedAt, endedAt, durationMs } = buildSwimlanes(turns, steps, genList, subagentItems);
  return compactTimeline({
    enabled: true, cascadeId, planModel, activeModel: options.metrics?.activeModel || state.lastModel || planModel || null,
    startedAt, endedAt, durationMs, swimlanes, nodes: turns, truncated: false, savedAt: null,
  }, { maxNodes: options.maxNodes ?? MAX_TIMELINE_NODES, maxBytes: options.maxBytes ?? MAX_TIMELINE_BYTES });
}
