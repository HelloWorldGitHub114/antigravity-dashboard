import type {
  TimelineNode,
  TimelineNodeMeta,
  TimelineRole,
  TimelineTokenCounts,
} from '../../contracts/timeline.ts';
import { formatModelName, isOrchestratorModel, normalizeModelId } from '../context.ts';
import { normalizeConversationId } from '../delegation/delegation.ts';
import {
  extractRequestIdentity,
  type GeneratorMetadataLike,
  type TrajectoryStepLike,
} from '../identity.ts';
import { resolveChatModelName, seconds, tokenCount } from '../metrics/index.ts';

export interface TimelineToolCallLike {
  name?: unknown;
  status?: unknown;
}

export interface TimelineStepLike extends TrajectoryStepLike {
  i?: unknown;
  status?: unknown;
  metadata?: TrajectoryStepLike['metadata'] & { toolCall?: { name?: unknown } | null };
  plannerResponse?: { response?: unknown; toolCalls?: readonly TimelineToolCallLike[] } | null;
  taskBoundary?: { mode?: unknown; Mode?: unknown } | null;
  invokeSubagent?: {
    conversationId?: unknown;
    results?: ReadonlyArray<{ conversationId?: unknown } | null | undefined>;
  } | null;
}

export interface TimelineGenerator {
  gi: number;
  idxs: number[];
  model: string | null;
  modelId: string | null;
  role: TimelineRole;
  tokens: TimelineTokenCounts | null;
  ttftMs: number | null;
  streamingMs: number | null;
  startMs: number | null;
  endMs: number | null;
  durationMs: number;
  placed: boolean;
}

export interface TimelineSubagentInput {
  id?: string | null;
  role?: string | null;
  startedAt?: string | number | null;
  endedAt?: string | number | null;
  durationMs?: number | null;
  model?: string | null;
  planModel?: string | null;
  activeModel?: string | null;
  depth?: number | null;
  status?: string | null;
  steps?: number | null;
  tps?: number | null;
  totalTokens?: number | null;
  requests?: number | null;
  tokens?: TimelineTokenCounts | null;
}

export interface TimelineRawInput {
  cascadeId?: string | null;
  trajectory?: {
    cascadeId?: string | null;
    steps?: readonly TimelineStepLike[];
    generatorMetadata?: readonly GeneratorMetadataLike[];
  } | null;
}

export interface BuildModelTimelineOptions {
  cascadeId?: string | null;
  metrics?: { planModel?: string | null; activeModel?: string | null } | null;
  subagentItems?: readonly TimelineSubagentInput[];
  maxNodes?: number;
  maxBytes?: number;
}

export interface InternalTimelineNode extends TimelineNode {
  _startMs?: number | null;
  _endMs?: number | null;
  children: InternalTimelineNode[];
}

const VALID_TB_MODES = /^(PLANNING|EXECUTION|VERIFICATION|RESEARCH|PLAN|IMPLEMENT|VERIFY)$/i;

const META_KEYS: ReadonlyArray<keyof TimelineNodeMeta> = [
  'round', 'stepIndex', 'stepStart', 'stepEnd', 'generatorIndex', 'ttftMs', 'streamingMs',
  'toolCount', 'tool', 'category', 'count', 'okCount', 'errorCount', 'calls', 'trigger',
  'fromModel', 'toModel', 'mode', 'role', 'depth', 'status', 'steps', 'tps', 'totalTokens',
  'requests', 'planModel', 'activeModel', 'stepType', 'compactedCalls', 'compactedChildren',
  'compactedTools',
];

export function cleanStr(v: unknown, max = 64): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max);
  return s || null;
}

export function cleanToolName(v: unknown): string | null {
  const s = cleanStr(v, 64);
  if (!s) return null;
  return /^[a-zA-Z0-9_.:/-]+$/.test(s) ? s : s.replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 64);
}

export function parseTs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export const iso = (ms: number | null): string | null =>
  ms !== null && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

export const clamp01 = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

export const zeroTokens = (): TimelineTokenCounts => ({
  inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0, totalTokens: 0,
});

export function addTokens(dst: TimelineTokenCounts, src: TimelineTokenCounts | null | undefined): TimelineTokenCounts {
  if (!src) return dst;
  dst.inputTokens += src.inputTokens || 0;
  dst.outputTokens += src.outputTokens || 0;
  dst.thinkingTokens += src.thinkingTokens || 0;
  dst.cachedTokens += src.cachedTokens || 0;
  dst.totalTokens += src.totalTokens || 0;
  return dst;
}

export function usageTokens(usage: unknown): TimelineTokenCounts | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const uncached = tokenCount(u.inputTokens) ?? 0;
  const cached = (u.cacheReadTokens === undefined && u.inputTokens !== undefined ? 0 : tokenCount(u.cacheReadTokens)) ?? 0;
  const write = (u.cacheWriteTokens === undefined && u.inputTokens !== undefined ? 0 : tokenCount(u.cacheWriteTokens)) ?? 0;
  const inputTokens = uncached + cached + write;
  const outputTokens = tokenCount(u.outputTokens) ?? 0;
  const thinkingTokens = tokenCount(u.thinkingOutputTokens) ?? 0;
  return { inputTokens, outputTokens, thinkingTokens, cachedTokens: cached, totalTokens: inputTokens + outputTokens };
}

export function toolCategory(toolName: unknown, stepType = ''): string {
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

export function stepToolFallback(stepType: unknown): string | null {
  const s = String(stepType || '').replace(/^CORTEX_STEP_TYPE_/, '').toLowerCase();
  if (!s || s === 'generic' || s === 'planner_response' || s === 'user_input') return null;
  return s === 'view_file' ? 'read_file' : s;
}

export function isToolStep(step: TimelineStepLike | null | undefined): boolean {
  const type = String(step?.type || '');
  if (/USER_INPUT|PLANNER_RESPONSE|SYSTEM_MESSAGE|ERROR_MESSAGE/.test(type)) return false;
  return Boolean(step?.metadata?.toolCall) ||
    /SEARCH_WEB|BROWSE|RUN_COMMAND|COMMAND|READ|WRITE|EDIT|CODE_ACTION|TOOL|MCP|LIST|GREP|VIEW|FIND|TERMINAL|GENERIC/i.test(type);
}

export function extractTaskBoundaryMode(step: TimelineStepLike | null | undefined): string | null {
  const rawMode = step?.taskBoundary?.mode ?? step?.taskBoundary?.Mode;
  if (typeof rawMode !== 'string') return null;
  const trimmed = rawMode.trim();
  return VALID_TB_MODES.test(trimmed) ? trimmed.toUpperCase() : null;
}

export function summarizeMeta(meta: unknown): TimelineNodeMeta | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const raw = meta as Record<string, unknown>;
  const out: TimelineNodeMeta = {};
  for (const k of META_KEYS) {
    const val = raw[k];
    if (val === undefined || val === null) continue;
    if (typeof val === 'number' && Number.isFinite(val)) (out as Record<string, number | string>)[k] = val;
    else if (typeof val === 'string') {
      const s = cleanStr(val, 96);
      if (s) (out as Record<string, number | string>)[k] = s;
    }
  }
  return Object.keys(out).length ? out : null;
}

export function buildSubagentNode(item: TimelineSubagentInput, idx: number, roleOverride = 'subagent'): InternalTimelineNode {
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
      role, depth: item.depth ?? 1, status: item.status, steps: item.steps, tps: item.tps,
      totalTokens: item.totalTokens, requests: item.requests, planModel: item.planModel, activeModel: item.activeModel,
    }),
    tokens: item.tokens || null,
    childConversationId: normalizeConversationId(item.id) || null,
    children: [],
  };
}

export function appendToolToCall(
  callNode: InternalTimelineNode, toolName: unknown, status: unknown,
  stepIdx: number, timeMs: number | null, durMs: number,
): void {
  const tool = cleanToolName(toolName) || 'tool';
  const cat = toolCategory(tool);
  const isErr = /ERROR|FAIL/.test(String(status || ''));
  const prev = callNode.children.at(-1);
  if (prev && prev.kind === 'tool_group' && prev.meta?.tool === tool && prev.meta?.category === cat) {
    prev.meta.count = (prev.meta.count ?? 0) + 1;
    prev.meta.okCount = (prev.meta.okCount ?? 0) + (isErr ? 0 : 1);
    prev.meta.errorCount = (prev.meta.errorCount ?? 0) + (isErr ? 1 : 0);
    prev.meta.stepEnd = Math.max(prev.meta.stepEnd ?? stepIdx, stepIdx);
    prev.durationMs += durMs;
    return;
  }
  callNode.children.push({
    id: `${callNode.id}-tg-${callNode.children.length + 1}`, kind: 'tool_group',
    time: iso(timeMs), durationMs: durMs, model: callNode.model, role: callNode.role, event: 'tool_group',
    meta: { tool, category: cat, count: 1, okCount: isErr ? 0 : 1, errorCount: isErr ? 1 : 0, stepStart: stepIdx, stepEnd: stepIdx },
    tokens: null, childConversationId: null, children: [],
  });
}

export function collectTimelineGenerators(
  generators: readonly GeneratorMetadataLike[],
  steps: readonly TimelineStepLike[],
  planModel: string | null,
): { generators: TimelineGenerator[]; isHybrid: boolean } {
  const planId = planModel ? normalizeModelId(planModel) : null;
  const seenIds = new Set<string>();
  const genList: TimelineGenerator[] = [];
  for (const [gi, g] of generators.entries()) {
    const chat = g?.chatModel;
    if (!chat) continue;
    const { key: reqKey } = extractRequestIdentity(g, { index: gi, fallback: 'index' });
    if (seenIds.has(reqKey)) continue;
    seenIds.add(reqKey);
    const idxs = (Array.isArray(g.stepIndices) ? g.stepIndices : [])
      .filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0);
    const model = resolveChatModelName(chat);
    const durS = seconds(chat.streamingDuration), ttftS = seconds(chat.timeToFirstToken);
    const durMs = Math.round(((ttftS ?? 0) + (durS ?? 0)) * 1000);
    let minMs = parseTs(chat.chatStartMetadata?.createdAt), maxMs: number | null = null;
    for (const si of idxs) {
      const m = steps[si]?.metadata;
      for (const t of [parseTs(m?.startedAt), parseTs(m?.createdAt), parseTs(m?.completedAt)]) {
        if (t !== null) { if (minMs === null || t < minMs) minMs = t; if (maxMs === null || t > maxMs) maxMs = t; }
      }
    }
    if (minMs !== null && (maxMs === null || maxMs === minMs) && durMs > 0) maxMs = minMs + durMs;
    genList.push({
      gi, idxs, model, modelId: normalizeModelId(model), role: 'model', tokens: usageTokens(chat.usage),
      ttftMs: ttftS !== null ? Math.round(ttftS * 1000) : null,
      streamingMs: durS !== null ? Math.round(durS * 1000) : null,
      startMs: minMs, endMs: maxMs ?? minMs,
      durationMs: minMs !== null && maxMs !== null && maxMs > minMs ? Math.round(maxMs - minMs) : durMs,
      placed: false,
    });
  }
  const distinctModels = new Set(genList.map((g) => g.modelId).filter((id): id is string => Boolean(id)));
  const hasHandoff = steps.some((s) =>
    s?.systemMessage?.eventType === 'plan_mode_handoff' || Boolean(s?.exitPlanMode) ||
    (Array.isArray(s?.plannerResponse?.toolCalls) && s.plannerResponse.toolCalls.some((tc) => tc?.name === 'exit_plan_mode')));
  const isHybrid = distinctModels.size > 1 || hasHandoff ||
    genList.some((g) => isOrchestratorModel(g.model)) || Boolean(planId && distinctModels.size > 0 && isOrchestratorModel(planModel));
  for (const g of genList) {
    const isPlan = isHybrid && ((planId !== null && g.modelId === planId) || isOrchestratorModel(g.model));
    g.role = isHybrid ? (isPlan ? 'plan' : 'worker') : 'model';
  }
  return { generators: genList, isHybrid };
}
