// Privacy-safe structural model call timeline tree & swimlanes builder.
// Never extracts prompts, assistant prose, thinking text, paths, or tool args.
import { formatModelName, normalizeModelId, isOrchestratorModel } from './context.mjs';
import { normalizeConversationId } from './delegation.mjs';
import { extractPlanModel, resolveChatModelName, seconds, tokenCount } from './metrics.mjs';

export const MAX_TIMELINE_NODES = 400;
export const MAX_TIMELINE_BYTES = 192 * 1024;
const VALID_KINDS = new Set(['turn', 'phase', 'handoff', 'model_call', 'tool_group', 'subagent', 'error']);
const VALID_ROLES = new Set(['plan', 'worker', 'subagent', 'model']);
const VALID_LANES = new Set(['plan', 'worker', 'tool', 'subagent', 'handoff']);
const VALID_TB_MODES = /^(PLANNING|EXECUTION|VERIFICATION|RESEARCH|PLAN|IMPLEMENT|VERIFY)$/i;

const cleanStr = (v, max = 64) => (typeof v === 'string'
  ? v.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max) : '') || null;
const cleanToolName = (v) => {
  const s = cleanStr(v, 64);
  if (!s) return null;
  return /^[a-zA-Z0-9_.:/-]+$/.test(s) ? s : s.replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 64);
};
const parseTs = (v) => {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const zeroTokens = () => ({ inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0, totalTokens: 0 });

function addTokens(dst, src) {
  if (!src) return dst;
  dst.inputTokens += src.inputTokens || 0;
  dst.outputTokens += src.outputTokens || 0;
  dst.thinkingTokens += src.thinkingTokens || 0;
  dst.cachedTokens += src.cachedTokens || 0;
  dst.totalTokens += src.totalTokens || 0;
  return dst;
}

function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const uncached = tokenCount(usage.inputTokens) ?? 0;
  const cached = (usage.cacheReadTokens === undefined && usage.inputTokens !== undefined ? 0 : tokenCount(usage.cacheReadTokens)) ?? 0;
  const write = (usage.cacheWriteTokens === undefined && usage.inputTokens !== undefined ? 0 : tokenCount(usage.cacheWriteTokens)) ?? 0;
  const inputTokens = uncached + cached + write;
  const outputTokens = tokenCount(usage.outputTokens) ?? 0;
  const thinkingTokens = tokenCount(usage.thinkingOutputTokens) ?? 0;
  return { inputTokens, outputTokens, thinkingTokens, cachedTokens: cached, totalTokens: inputTokens + outputTokens };
}

export function toolCategory(toolName, stepType = '') {
  const name = String(toolName || stepType || '');
  if (/exit_plan_mode|enter_plan_mode|task_boundary|PLAN_MODE/i.test(name)) return 'plan';
  if (/^swarm|post_message|read_board|swarm_wait/i.test(name)) return 'swarm';
  if (/invoke_subagent|define_subagent|manage_subagents|SUBAGENT/i.test(name)) return 'subagent';
  if (/run_command|command_status|send_command_input|RUN_COMMAND|TERMINAL/i.test(name)) return 'command';
  if (/read_file|view_file|view_outline|view_code_item|list_dir|VIEW_FILE|READ/i.test(name)) return 'file_read';
  if (/write_file|edit_file|replace_file_content|multi_replace|WRITE|EDIT/i.test(name)) return 'file_write';
  if (/grep_search|find_by_name|search_web|read_url_content|SEARCH|FIND|GREP|BROWSE/i.test(name)) return 'search';
  if (/^mcp_|list_resources|read_resource/i.test(name)) return 'mcp';
  return 'other';
}

function stepToolFallback(stepType) {
  const s = String(stepType || '').replace(/^CORTEX_STEP_TYPE_/, '').toLowerCase();
  if (!s || s === 'generic' || s === 'planner_response' || s === 'user_input') return null;
  return s === 'view_file' ? 'read_file' : s;
}

const isToolStep = (step) => {
  const type = String(step?.type || '');
  if (/USER_INPUT|PLANNER_RESPONSE|SYSTEM_MESSAGE|ERROR_MESSAGE/.test(type)) return false;
  return Boolean(step?.metadata?.toolCall) || /SEARCH_WEB|BROWSE|RUN_COMMAND|COMMAND|READ|WRITE|EDIT|CODE_ACTION|TOOL|MCP|LIST|GREP|VIEW|FIND|TERMINAL|GENERIC/i.test(type);
};

export function countTimelineNodes(nodes) {
  let count = 0;
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || typeof n !== 'object') continue;
    count += 1 + countTimelineNodes(n.children);
  }
  return count;
}

function summarizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const out = {};
  for (const k of ['round', 'stepIndex', 'stepStart', 'stepEnd', 'generatorIndex', 'ttftMs', 'streamingMs',
    'toolCount', 'tool', 'category', 'count', 'okCount', 'errorCount', 'trigger', 'fromModel', 'toModel',
    'mode', 'role', 'depth', 'status', 'steps', 'tps', 'totalTokens', 'requests', 'planModel', 'activeModel',
    'stepType', 'compactedCalls', 'compactedChildren', 'compactedTools']) {
    if (meta[k] === undefined || meta[k] === null) continue;
    if (typeof meta[k] === 'number' && Number.isFinite(meta[k])) out[k] = meta[k];
    else if (typeof meta[k] === 'string') { const s = cleanStr(meta[k], 96); if (s) out[k] = s; }
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeNode(n, idx = 0) {
  if (!n || typeof n !== 'object') return null;
  const kind = VALID_KINDS.has(n.kind) ? n.kind : 'model_call';
  const role = VALID_ROLES.has(n.role) ? n.role : null;
  let tokens = null;
  if (n.tokens && typeof n.tokens === 'object') {
    const t = {};
    for (const k of ['inputTokens', 'outputTokens', 'thinkingTokens', 'cachedTokens', 'totalTokens']) {
      t[k] = tokenCount(n.tokens[k]) ?? 0;
    }
    tokens = t;
  }
  const children = Array.isArray(n.children) ? n.children.map((c, i) => sanitizeNode(c, i)).filter(Boolean) : [];
  return {
    id: cleanStr(n.id, 64) || `${kind}-${idx}`,
    kind,
    time: iso(parseTs(n.time)),
    durationMs: typeof n.durationMs === 'number' && Number.isFinite(n.durationMs) && n.durationMs >= 0 ? Math.round(n.durationMs) : 0,
    model: formatModelName(n.model),
    role,
    event: cleanStr(n.event, 48) || kind,
    meta: summarizeMeta(n.meta),
    tokens,
    childConversationId: normalizeConversationId(n.childConversationId) || null,
    children,
  };
}

function sanitizeSwimlane(s) {
  if (!s || typeof s !== 'object' || !VALID_LANES.has(s.kind)) return null;
  const startMs = typeof s.startMs === 'number' && Number.isFinite(s.startMs) && s.startMs >= 0 ? Math.round(s.startMs) : 0;
  const endMs = typeof s.endMs === 'number' && Number.isFinite(s.endMs) && s.endMs >= startMs ? Math.round(s.endMs) : startMs;
  return {
    kind: s.kind,
    model: formatModelName(s.model),
    label: cleanStr(s.label, 80) || s.kind,
    startMs,
    endMs,
    startRatio: clamp01(s.startRatio),
    widthRatio: clamp01(s.widthRatio),
    stepStart: tokenCount(s.stepStart) ?? 0,
    stepEnd: tokenCount(s.stepEnd) ?? 0,
    calls: tokenCount(s.calls) ?? 0,
  };
}

function foldNodeTools(node) {
  if (!Array.isArray(node.children) || !node.children.length) return false;
  const toolChildren = node.children.filter(c => c.kind === 'tool_group');
  if (toolChildren.length > 1) {
    let totalCount = 0, okCount = 0, errorCount = 0, dur = 0;
    for (const tc of toolChildren) {
      totalCount += tc.meta?.count || 1;
      okCount += tc.meta?.okCount || 0;
      errorCount += tc.meta?.errorCount || 0;
      dur += tc.durationMs || 0;
    }
    const merged = {
      ...toolChildren[0],
      id: `${node.id}-tools`,
      durationMs: dur,
      meta: { tool: 'mixed', category: 'mixed', count: totalCount, okCount, errorCount,
        stepStart: toolChildren[0].meta?.stepStart, stepEnd: toolChildren.at(-1).meta?.stepEnd },
    };
    const rest = node.children.filter(c => c.kind !== 'tool_group');
    node.children = [merged, ...rest];
    return true;
  }
  if (toolChildren.length === 1 && node.kind === 'model_call') {
    node.meta = { ...(node.meta || {}), compactedTools: (node.meta?.compactedTools || 0) + (toolChildren[0].meta?.count || 1) };
    node.children = node.children.filter(c => c.kind !== 'tool_group');
    return true;
  }
  return false;
}

function compactPass(nodes, target) {
  let count = countTimelineNodes(nodes);
  if (count <= target) return false;
  let changed = false;
  // Pass 1: collapse tool_groups from oldest turns forward, keeping newest turn last
  for (let ti = 0; ti < nodes.length && count > target; ti++) {
    const stack = [nodes[ti]];
    while (stack.length && count > target) {
      const cur = stack.shift();
      if (foldNodeTools(cur)) { changed = true; count = countTimelineNodes(nodes); }
      for (const ch of cur.children || []) stack.push(ch);
    }
  }
  // Pass 2: collapse oldest phase children into phase summary (preserve subagent/handoff if space)
  for (let ti = 0; ti < nodes.length && count > target; ti++) {
    const turn = nodes[ti];
    for (const ch of turn.children || []) {
      if (count <= target) break;
      if (ch.kind === 'phase' && ch.children.length) {
        ch.meta = { ...(ch.meta || {}), compactedCalls: (ch.meta?.compactedCalls || 0) + ch.children.length };
        ch.children = [];
        changed = true;
        count = countTimelineNodes(nodes);
      }
    }
  }
  // Pass 3: drop children on oldest turns, then trim oldest turns cleanly
  for (let ti = 0; ti < nodes.length && count > target; ti++) {
    if (nodes[ti].children.length) {
      nodes[ti].meta = { ...(nodes[ti].meta || {}), compactedChildren: nodes[ti].children.length };
      nodes[ti].children = [];
      changed = true;
      count = countTimelineNodes(nodes);
    }
  }
  while (nodes.length > 1 && count > target) {
    nodes.shift();
    changed = true;
    count = countTimelineNodes(nodes);
  }
  return changed;
}

export function compactTimeline(rawTimeline, { maxNodes = MAX_TIMELINE_NODES, maxBytes = MAX_TIMELINE_BYTES } = {}) {
  const safe = safeTimeline(rawTimeline);
  if (!safe) return null;
  let truncated = safe.truncated === true;
  if (countTimelineNodes(safe.nodes) > maxNodes) {
    if (compactPass(safe.nodes, maxNodes)) truncated = true;
  }
  safe.truncated = truncated;
  let text = JSON.stringify(safe);
  while (Buffer.byteLength(text, 'utf8') > maxBytes) {
    safe.truncated = true;
    const beforeNodes = countTimelineNodes(safe.nodes);
    if (beforeNodes > 4) {
      compactPass(safe.nodes, Math.max(1, Math.floor(beforeNodes * 0.7)));
    } else if (safe.swimlanes.length > 8) {
      safe.swimlanes = safe.swimlanes.filter(l => l.kind !== 'tool').slice(-16);
    } else if (safe.nodes.length > 1) {
      safe.nodes.shift();
    } else {
      if (safe.nodes[0]) safe.nodes[0].children = [];
      safe.swimlanes = safe.swimlanes.slice(0, 4);
      text = JSON.stringify(safe);
      break;
    }
    text = JSON.stringify(safe);
  }
  return safe;
}

export function safeTimeline(value, opts = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.enabled !== true) return null;
  const cascadeId = normalizeConversationId(value.cascadeId) || cleanStr(value.cascadeId, 64);
  if (!cascadeId) return null;
  const base = {
    enabled: true,
    cascadeId,
    planModel: formatModelName(value.planModel),
    activeModel: formatModelName(value.activeModel),
    startedAt: iso(parseTs(value.startedAt)),
    endedAt: iso(parseTs(value.endedAt)),
    durationMs: typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0 ? Math.round(value.durationMs) : 0,
    swimlanes: Array.isArray(value.swimlanes) ? value.swimlanes.map(sanitizeSwimlane).filter(Boolean).slice(0, 128) : [],
    nodes: Array.isArray(value.nodes) ? value.nodes.map((n, i) => sanitizeNode(n, i)).filter(Boolean) : [],
    truncated: value.truncated === true,
    savedAt: iso(parseTs(value.savedAt)),
  };
  return opts ? compactTimeline(base, opts) : base;
}

function buildSubagentNode(item, idx, roleOverride = 'subagent') {
  const role = cleanStr(item.role, 64) || roleOverride;
  return {
    id: `subagent-${idx}-${String(item.id || idx).slice(0, 8)}`,
    kind: 'subagent',
    time: iso(parseTs(item.startedAt)),
    durationMs: item.durationMs || 0,
    model: formatModelName(item.activeModel || item.model),
    role: 'subagent',
    event: 'subagent',
    meta: summarizeMeta({
      role, depth: item.depth ?? 1, status: item.status, steps: item.steps,
      tps: item.tps, totalTokens: item.totalTokens, requests: item.requests,
      planModel: item.planModel, activeModel: item.activeModel,
    }),
    tokens: item.tokens || null,
    childConversationId: normalizeConversationId(item.id) || null,
    children: [],
  };
}

export function buildModelTimeline(raw, options = {}) {
  const trajectory = raw?.trajectory || {};
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
  const generators = Array.isArray(trajectory.generatorMetadata) ? trajectory.generatorMetadata : [];
  const cascadeId = normalizeConversationId(options.cascadeId || trajectory.cascadeId || raw?.cascadeId) || 'unknown';
  const planModel = options.metrics?.planModel ?? extractPlanModel(raw);
  const planId = planModel ? normalizeModelId(planModel) : null;

  // Deduplicate generators matching metrics.mjs identity contract
  const seenIds = new Set();
  const genList = [];
  for (const [gi, g] of generators.entries()) {
    const chat = g?.chatModel, u = chat?.usage;
    if (!chat) continue;
    const reqKey = u?.responseId ? `response:${u.apiProvider || ''}:${u.responseId}`
      : u?.messageId ? `message:${u.apiProvider || ''}:${u.messageId}` : `index:${gi}`;
    if (seenIds.has(reqKey)) continue;
    seenIds.add(reqKey);
    const idxs = (Array.isArray(g.stepIndices) ? g.stepIndices : []).filter(n => Number.isInteger(n) && n >= 0);
    const model = resolveChatModelName(chat);
    const durS = seconds(chat.streamingDuration), ttftS = seconds(chat.timeToFirstToken);
    const durMs = Math.round(((ttftS ?? 0) + (durS ?? 0)) * 1000);
    let minMs = parseTs(chat.chatStartMetadata?.createdAt), maxMs = null;
    for (const si of idxs) {
      const m = steps[si]?.metadata;
      for (const t of [parseTs(m?.startedAt), parseTs(m?.createdAt), parseTs(m?.completedAt)]) {
        if (t !== null) { if (minMs === null || t < minMs) minMs = t; if (maxMs === null || t > maxMs) maxMs = t; }
      }
    }
    if (minMs !== null && (maxMs === null || maxMs === minMs) && durMs > 0) maxMs = minMs + durMs;
    genList.push({
      gi, idxs, model, modelId: normalizeModelId(model), chat,
      tokens: usageTokens(u),
      ttftMs: ttftS !== null ? Math.round(ttftS * 1000) : null,
      streamingMs: durS !== null ? Math.round(durS * 1000) : null,
      startMs: minMs, endMs: maxMs ?? minMs,
      durationMs: minMs !== null && maxMs !== null && maxMs > minMs ? Math.round(maxMs - minMs) : durMs,
      placed: false,
    });
  }

  const distinctModels = new Set(genList.map(g => g.modelId).filter(Boolean));
  const hasHandoffMarkers = steps.some(s =>
    s?.systemMessage?.eventType === 'plan_mode_handoff' || s?.exitPlanMode ||
    (s?.plannerResponse?.toolCalls || []).some(tc => tc?.name === 'exit_plan_mode'));
  const isHybrid = distinctModels.size > 1 || hasHandoffMarkers ||
    genList.some(g => isOrchestratorModel(g.model)) || Boolean(planId && distinctModels.size > 0 && isOrchestratorModel(planModel));
  for (const g of genList) {
    const isPlan = isHybrid && ((planId && g.modelId === planId) || isOrchestratorModel(g.model));
    g.role = isHybrid ? (isPlan ? 'plan' : 'worker') : 'model';
  }

  const subagentItems = Array.isArray(options.subagentItems) ? options.subagentItems : [];
  const attachedChildren = new Set();
  const stepToGen = new Map();
  for (const g of genList) for (const si of g.idxs) if (!stepToGen.has(si)) stepToGen.set(si, g);

  const turns = [];
  let currentTurn = null, currentPhase = null, pendingHandoff = null;
  let lastModel = null, turnNum = 0, phaseNum = 0, callNum = 0, handoffNum = 0;

  const ensureTurn = (stepIdx, timeMs, turnPlan = planModel) => {
    if (currentTurn) return currentTurn;
    turnNum++;
    currentTurn = {
      id: `turn-${turnNum}`, kind: 'turn', time: iso(timeMs), durationMs: 0,
      model: turnPlan || null, role: isHybrid ? 'plan' : 'model', event: 'turn',
      meta: { round: turnNum, stepStart: stepIdx, stepEnd: stepIdx, ...(turnPlan ? { planModel: turnPlan } : {}) },
      tokens: zeroTokens(), childConversationId: null, children: [],
      _startMs: timeMs, _endMs: timeMs,
    };
    turns.push(currentTurn);
    currentPhase = null;
    return currentTurn;
  };

  const ensurePhase = (role, model, stepIdx, timeMs, tbMode = null) => {
    const t = ensureTurn(stepIdx, timeMs);
    if (currentPhase && currentPhase.role === role && currentPhase.model === model && (!tbMode || currentPhase.meta.mode === tbMode)) {
      return currentPhase;
    }
    phaseNum++;
    const event = role === 'plan' ? 'plan' : role === 'worker' ? 'worker' : 'phase';
    currentPhase = {
      id: `phase-${phaseNum}`, kind: 'phase', time: iso(timeMs), durationMs: 0,
      model: model || t.model, role, event,
      meta: { stepStart: stepIdx, stepEnd: stepIdx, calls: 0, ...(tbMode ? { mode: tbMode } : {}) },
      tokens: zeroTokens(), childConversationId: null, children: [],
      _startMs: timeMs, _endMs: timeMs,
    };
    t.children.push(currentPhase);
    return currentPhase;
  };

  const emitHandoff = (fromModel, toModel, trigger, stepIdx, timeMs) => {
    const t = ensureTurn(stepIdx, timeMs);
    handoffNum++;
    t.children.push({
      id: `handoff-${handoffNum}`, kind: 'handoff', time: iso(timeMs), durationMs: 0,
      model: toModel || fromModel, role: null,
      event: trigger === 'model_switch' ? 'model_switch' : 'handoff',
      meta: { stepIndex: stepIdx, trigger, fromModel, toModel },
      tokens: null, childConversationId: null, children: [],
      _startMs: timeMs, _endMs: timeMs,
    });
    currentPhase = null;
  };

  const appendToolToCall = (callNode, toolName, status, stepIdx, timeMs, durMs) => {
    const tool = cleanToolName(toolName) || 'tool';
    const cat = toolCategory(tool);
    const isErr = /ERROR|FAIL/.test(String(status || ''));
    const prev = callNode.children.at(-1);
    if (prev && prev.kind === 'tool_group' && prev.meta.tool === tool && prev.meta.category === cat) {
      prev.meta.count += 1;
      prev.meta.okCount += isErr ? 0 : 1;
      prev.meta.errorCount += isErr ? 1 : 0;
      prev.meta.stepEnd = Math.max(prev.meta.stepEnd, stepIdx);
      prev.durationMs += durMs;
      return;
    }
    callNode.children.push({
      id: `${callNode.id}-tg-${callNode.children.length + 1}`, kind: 'tool_group',
      time: iso(timeMs), durationMs: durMs, model: callNode.model, role: callNode.role,
      event: 'tool_group',
      meta: { tool, category: cat, count: 1, okCount: isErr ? 0 : 1, errorCount: isErr ? 1 : 0, stepStart: stepIdx, stepEnd: stepIdx },
      tokens: null, childConversationId: null, children: [],
    });
  };

  const placeGenerator = (g, stepIdxFallback) => {
    g.placed = true;
    const stepStart = g.idxs.length ? g.idxs[0] : stepIdxFallback;
    const stepEnd = g.idxs.length ? g.idxs.at(-1) : stepIdxFallback;
    const timeMs = g.startMs;
    if (pendingHandoff) {
      emitHandoff(pendingHandoff.fromModel, g.model, pendingHandoff.trigger, pendingHandoff.stepIndex, pendingHandoff.timeMs ?? timeMs);
      pendingHandoff = null;
    } else if (lastModel && g.model && lastModel !== g.model) {
      emitHandoff(lastModel, g.model, 'model_switch', stepStart, timeMs);
    }
    const phase = ensurePhase(g.role, g.model, stepStart, timeMs);
    callNum++;
    const callNode = {
      id: `call-${callNum}`, kind: 'model_call', time: iso(timeMs), durationMs: g.durationMs,
      model: g.model, role: g.role,
      event: g.role === 'plan' ? 'plan' : g.role === 'worker' ? 'worker' : 'model_call',
      meta: { generatorIndex: g.gi, stepStart, stepEnd, ttftMs: g.ttftMs, streamingMs: g.streamingMs, toolCount: 0 },
      tokens: g.tokens, childConversationId: null, children: [],
      _startMs: g.startMs, _endMs: g.endMs,
    };

    const assocSteps = g.idxs.map(idx => ({ idx, step: steps[idx] })).filter(x => x.step);
    const execSteps = assocSteps.filter(x => isToolStep(x.step));
    const plannerCalls = [];
    for (const { idx, step } of assocSteps) {
      if (/PLANNER_RESPONSE/.test(String(step.type || ''))) {
        for (const tc of step.plannerResponse?.toolCalls || []) {
          plannerCalls.push({ name: tc?.name || null, status: tc?.status || null, stepIdx: idx, meta: step.metadata });
        }
      }
    }
    const toolTotal = Math.max(plannerCalls.length, execSteps.length);
    callNode.meta.toolCount = toolTotal;
    let hasSwarmCall = false;
    for (let k = 0; k < toolTotal; k++) {
      const pc = plannerCalls[k], es = execSteps[k];
      const name = pc?.name || es?.step?.metadata?.toolCall?.name || stepToolFallback(es?.step?.type);
      const stIdx = es?.idx ?? pc?.stepIdx ?? stepStart;
      const sm = es?.step?.metadata || pc?.meta;
      const sMs = parseTs(sm?.startedAt) ?? parseTs(sm?.createdAt) ?? timeMs;
      const eMs = parseTs(sm?.completedAt);
      const dur = sMs !== null && eMs !== null && eMs >= sMs ? Math.round(eMs - sMs) : 0;
      const status = es?.step?.status || pc?.status || 'CORTEX_STEP_STATUS_DONE';
      if (name === 'swarm' || name === 'swarm_manage') hasSwarmCall = true;
      if (name === 'exit_plan_mode') {
        pendingHandoff = { stepIndex: stIdx, timeMs: eMs ?? sMs, trigger: 'exit_plan_mode', fromModel: g.model };
      }
      if (name) appendToolToCall(callNode, name, status, stIdx, sMs, dur);
    }
    for (const { idx, step } of assocSteps) {
      const inv = step.invokeSubagent;
      const convIds = [...new Set([inv?.conversationId, ...(inv?.results || []).map(r => r?.conversationId)].map(normalizeConversationId).filter(Boolean))];
      for (const cid of convIds) {
        attachedChildren.add(cid);
        const matched = subagentItems.find(x => normalizeConversationId(x.id) === cid) || { id: cid };
        callNode.children.push(buildSubagentNode(matched, callNode.children.length + 1));
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
    phase.meta.calls += 1;
    phase.meta.stepEnd = Math.max(phase.meta.stepEnd, stepEnd);
    addTokens(phase.tokens, g.tokens);
    currentTurn.meta.stepEnd = Math.max(currentTurn.meta.stepEnd, stepEnd);
    addTokens(currentTurn.tokens, g.tokens);
    lastModel = g.model || lastModel;
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const idx = Number.isInteger(step.i) ? step.i : i;
    const type = String(step.type || '');
    const sMs = parseTs(step.metadata?.startedAt) ?? parseTs(step.metadata?.createdAt);
    const eMs = parseTs(step.metadata?.completedAt) ?? sMs;
    if (/USER_INPUT/.test(type)) {
      currentTurn = null;
      currentPhase = null;
      const stepPlan = formatModelName(step.userInput?.userConfig?.plannerConfig?.planModel) || planModel;
      ensureTurn(idx, sMs, stepPlan);
      continue;
    }
    if (step.exitPlanMode) {
      pendingHandoff = { stepIndex: idx, timeMs: eMs ?? sMs, trigger: 'exit_plan_mode', fromModel: lastModel };
    } else if (/SYSTEM_MESSAGE/.test(type) && step.systemMessage?.eventType === 'plan_mode_handoff') {
      pendingHandoff = { stepIndex: idx, timeMs: eMs ?? sMs, trigger: 'plan_mode_handoff', fromModel: pendingHandoff?.fromModel || lastModel };
    }
    const tbMode = step.taskBoundary?.mode || step.taskBoundary?.Mode;
    if (typeof tbMode === 'string' && VALID_TB_MODES.test(tbMode.trim())) {
      const modeUpper = tbMode.trim().toUpperCase();
      if (currentPhase && currentPhase.meta?.mode && currentPhase.meta.mode !== modeUpper) {
        emitHandoff(lastModel, lastModel, 'task_boundary', idx, sMs);
      }
      ensurePhase(lastModel && isOrchestratorModel(lastModel) ? 'plan' : (isHybrid ? 'worker' : 'model'), lastModel, idx, sMs, modeUpper);
    }
    const gen = stepToGen.get(idx);
    if (gen && !gen.placed) placeGenerator(gen, idx);
    if (/ERROR_MESSAGE/.test(type) || /ERROR/.test(String(step.status || ''))) {
      const target = (currentPhase?.children.at(-1)?.kind === 'model_call' ? currentPhase.children.at(-1) : currentPhase) || ensureTurn(idx, sMs);
      target.children.push({
        id: `error-${idx}`, kind: 'error', time: iso(eMs ?? sMs), durationMs: 0,
        model: target.model, role: target.role, event: 'error',
        meta: { stepIndex: idx, stepType: cleanStr(type, 48) }, tokens: null, childConversationId: null, children: [],
      });
    }
  }
  for (const g of genList) if (!g.placed) placeGenerator(g, g.idxs[0] ?? 0);
  if (pendingHandoff) {
    emitHandoff(pendingHandoff.fromModel, options.metrics?.activeModel || lastModel, pendingHandoff.trigger, pendingHandoff.stepIndex, pendingHandoff.timeMs);
  }
  if (subagentItems.length) {
    const remaining = subagentItems.filter(x => { const cid = normalizeConversationId(x.id); return cid && !attachedChildren.has(cid); });
    if (remaining.length) {
      const target = currentTurn || ensureTurn(0, parseTs(remaining[0].startedAt), planModel);
      for (const item of remaining) target.children.push(buildSubagentNode(item, target.children.length + 1));
    }
  }

  // Compute global bounds & swimlanes cleanly
  const allTimes = [];
  for (const s of steps) for (const k of ['createdAt', 'startedAt', 'completedAt']) { const t = parseTs(s?.metadata?.[k]); if (t !== null) allTimes.push(t); }
  for (const g of genList) { if (g.startMs !== null) allTimes.push(g.startMs); if (g.endMs !== null) allTimes.push(g.endMs); }
  for (const c of subagentItems) { const s = parseTs(c.startedAt), e = parseTs(c.endedAt); if (s !== null) allTimes.push(s); if (e !== null) allTimes.push(e); }
  const startedAtMs = allTimes.length ? Math.min(...allTimes) : 0;
  const endedAtMs = allTimes.length ? Math.max(...allTimes) : Math.max(0, genList.length * 1000);
  const spanMs = Math.max(1, endedAtMs - startedAtMs);

  const swimlanes = [];
  let seqIdx = 0;
  for (const turn of turns) {
    let tMin = Infinity, tMax = -Infinity;
    for (const ch of turn.children) {
      if (ch.kind === 'phase') {
        const calls = ch.children.filter(c => c.kind === 'model_call');
        const cTimes = calls.flatMap(c => [c._startMs, c._endMs]).filter(x => x !== null && Number.isFinite(x));
        const sMs = cTimes.length ? Math.min(...cTimes) : (ch._startMs ?? startedAtMs + seqIdx * 1000);
        const eMs = cTimes.length ? Math.max(...cTimes) : Math.max(sMs, ch._endMs ?? sMs + (ch.durationMs || 1000));
        ch.durationMs = Math.max(0, Math.round(eMs - sMs));
        if (sMs < tMin) tMin = sMs; if (eMs > tMax) tMax = eMs;
        seqIdx++;
        swimlanes.push({
          kind: VALID_LANES.has(ch.role) ? ch.role : 'worker', model: ch.model,
          label: ch.model || ch.role || 'model', startMs: sMs, endMs: eMs,
          startRatio: clamp01((sMs - startedAtMs) / spanMs),
          widthRatio: Math.max(0.01, clamp01((eMs - sMs) / spanMs)),
          stepStart: ch.meta.stepStart, stepEnd: ch.meta.stepEnd, calls: ch.meta.calls || calls.length,
        });
        const toolCalls = calls.flatMap(c => c.children).filter(c => c.kind === 'tool_group');
        if (toolCalls.length) {
          const toolCount = toolCalls.reduce((sum, tg) => sum + (tg.meta?.count || 1), 0);
          swimlanes.push({
            kind: 'tool', model: ch.model, label: `${toolCount} tools`, startMs: sMs, endMs: eMs,
            startRatio: clamp01((sMs - startedAtMs) / spanMs),
            widthRatio: Math.max(0.01, clamp01((eMs - sMs) / spanMs)),
            stepStart: ch.meta.stepStart, stepEnd: ch.meta.stepEnd, calls: toolCount,
          });
        }
      } else if (ch.kind === 'handoff') {
        const hMs = ch._startMs ?? startedAtMs + seqIdx * 1000;
        if (hMs < tMin) tMin = hMs; if (hMs > tMax) tMax = hMs;
        swimlanes.push({
          kind: 'handoff', model: ch.meta?.toModel || ch.model,
          label: `${ch.meta?.fromModel || '?'} -> ${ch.meta?.toModel || '?'}`,
          startMs: hMs, endMs: hMs, startRatio: clamp01((hMs - startedAtMs) / spanMs), widthRatio: 0.01,
          stepStart: ch.meta?.stepIndex ?? 0, stepEnd: ch.meta?.stepIndex ?? 0, calls: 1,
        });
      }
    }
    if (Number.isFinite(tMin) && Number.isFinite(tMax)) turn.durationMs = Math.max(0, Math.round(tMax - tMin));
  }
  for (const item of subagentItems) {
    const sMs = parseTs(item.startedAt) ?? startedAtMs;
    const eMs = Math.max(sMs, parseTs(item.endedAt) ?? (sMs + (item.durationMs || 0)));
    swimlanes.push({
      kind: 'subagent', model: formatModelName(item.activeModel || item.model),
      label: cleanStr(item.role, 64) || 'subagent', startMs: sMs, endMs: eMs,
      startRatio: clamp01((sMs - startedAtMs) / spanMs),
      widthRatio: Math.max(0.01, clamp01((eMs - sMs) / spanMs)),
      stepStart: 0, stepEnd: item.steps || 0, calls: item.requests || 0,
    });
  }

  return compactTimeline({
    enabled: true,
    cascadeId,
    planModel,
    activeModel: options.metrics?.activeModel || lastModel || planModel || null,
    startedAt: allTimes.length ? iso(startedAtMs) : null,
    endedAt: allTimes.length ? iso(endedAtMs) : null,
    durationMs: allTimes.length ? Math.max(0, Math.round(endedAtMs - startedAtMs)) : 0,
    swimlanes,
    nodes: turns,
    truncated: false,
    savedAt: null,
  }, { maxNodes: options.maxNodes ?? MAX_TIMELINE_NODES, maxBytes: options.maxBytes ?? MAX_TIMELINE_BYTES });
}
