import type {
  ModelTimelineSnapshot,
  TimelineLane,
  TimelineNode,
  TimelineNodeKind,
  TimelineRole,
  TimelineSwimlaneItem,
  TimelineTokenCounts,
} from '../../contracts/timeline.ts';
import { formatModelName } from '../context.ts';
import { normalizeConversationId } from '../delegation/delegation.ts';
import { tokenCount } from '../metrics/index.ts';
import { clamp01, cleanStr, iso, parseTs, summarizeMeta } from './categorizer.ts';

export const MAX_TIMELINE_NODES = 400;
export const MAX_TIMELINE_BYTES = 192 * 1024;

export interface CompactTimelineOptions {
  maxNodes?: number;
  maxBytes?: number;
}

const VALID_KINDS = new Set<TimelineNodeKind>(['turn', 'phase', 'handoff', 'model_call', 'tool_group', 'subagent', 'error']);
const VALID_ROLES = new Set<TimelineRole>(['plan', 'worker', 'subagent', 'model']);
const VALID_LANES = new Set<TimelineLane>(['plan', 'worker', 'tool', 'subagent', 'handoff']);
const TOKEN_KEYS: ReadonlyArray<keyof TimelineTokenCounts> = ['inputTokens', 'outputTokens', 'thinkingTokens', 'cachedTokens', 'totalTokens'];

export function countTimelineNodes(nodes: unknown): number {
  if (!Array.isArray(nodes)) return 0;
  let count = 0;
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    count += 1 + countTimelineNodes((n as { children?: unknown }).children);
  }
  return count;
}

function sanitizeNode(n: unknown, idx = 0): TimelineNode | null {
  if (!n || typeof n !== 'object') return null;
  const raw = n as Record<string, unknown>;
  const kind: TimelineNodeKind = VALID_KINDS.has(raw.kind as TimelineNodeKind) ? (raw.kind as TimelineNodeKind) : 'model_call';
  const role: TimelineRole | null = VALID_ROLES.has(raw.role as TimelineRole) ? (raw.role as TimelineRole) : null;
  let tokens: TimelineTokenCounts | null = null;
  if (raw.tokens && typeof raw.tokens === 'object') {
    const rawTokens = raw.tokens as Record<string, unknown>;
    const t: TimelineTokenCounts = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0, totalTokens: 0 };
    for (const k of TOKEN_KEYS) t[k] = tokenCount(rawTokens[k]) ?? 0;
    tokens = t;
  }
  const children = Array.isArray(raw.children)
    ? raw.children.map((c, i) => sanitizeNode(c, i)).filter((c): c is TimelineNode => c !== null)
    : [];
  return {
    id: cleanStr(raw.id, 64) || `${kind}-${idx}`,
    kind,
    time: iso(parseTs(raw.time)),
    durationMs: typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) && raw.durationMs >= 0 ? Math.round(raw.durationMs) : 0,
    model: formatModelName(raw.model),
    role,
    event: cleanStr(raw.event, 48) || kind,
    meta: summarizeMeta(raw.meta),
    tokens,
    childConversationId: normalizeConversationId(raw.childConversationId) || null,
    children,
  };
}

function sanitizeSwimlane(s: unknown): TimelineSwimlaneItem | null {
  if (!s || typeof s !== 'object') return null;
  const raw = s as Record<string, unknown>;
  if (!VALID_LANES.has(raw.kind as TimelineLane)) return null;
  const kind = raw.kind as TimelineLane;
  const startMs = typeof raw.startMs === 'number' && Number.isFinite(raw.startMs) && raw.startMs >= 0 ? Math.round(raw.startMs) : 0;
  const endMs = typeof raw.endMs === 'number' && Number.isFinite(raw.endMs) && raw.endMs >= startMs ? Math.round(raw.endMs) : startMs;
  return {
    kind,
    model: formatModelName(raw.model),
    label: cleanStr(raw.label, 80) || kind,
    startMs,
    endMs,
    startRatio: clamp01(raw.startRatio),
    widthRatio: clamp01(raw.widthRatio),
    stepStart: tokenCount(raw.stepStart) ?? 0,
    stepEnd: tokenCount(raw.stepEnd) ?? 0,
    calls: tokenCount(raw.calls) ?? 0,
  };
}

function foldNodeTools(node: TimelineNode): boolean {
  if (!Array.isArray(node.children) || !node.children.length) return false;
  const toolChildren = node.children.filter((c) => c.kind === 'tool_group');
  if (toolChildren.length > 1) {
    let totalCount = 0, okCount = 0, errorCount = 0, dur = 0;
    for (const tc of toolChildren) {
      totalCount += tc.meta?.count || 1;
      okCount += tc.meta?.okCount || 0;
      errorCount += tc.meta?.errorCount || 0;
      dur += tc.durationMs || 0;
    }
    const merged: TimelineNode = {
      ...toolChildren[0],
      id: `${node.id}-tools`,
      durationMs: dur,
      meta: {
        tool: 'mixed', category: 'mixed', count: totalCount, okCount, errorCount,
        stepStart: toolChildren[0].meta?.stepStart, stepEnd: toolChildren.at(-1)?.meta?.stepEnd,
      },
    };
    node.children = [merged, ...node.children.filter((c) => c.kind !== 'tool_group')];
    return true;
  }
  if (toolChildren.length === 1 && node.kind === 'model_call') {
    node.meta = { ...(node.meta || {}), compactedTools: (node.meta?.compactedTools || 0) + (toolChildren[0].meta?.count || 1) };
    node.children = node.children.filter((c) => c.kind !== 'tool_group');
    return true;
  }
  return false;
}

function compactPass(nodes: TimelineNode[], target: number): boolean {
  let count = countTimelineNodes(nodes);
  if (count <= target) return false;
  let changed = false;
  // Pass 1: collapse tool_groups from oldest turns forward, keeping newest turn last
  for (let ti = 0; ti < nodes.length && count > target; ti++) {
    const stack: TimelineNode[] = [nodes[ti]];
    while (stack.length && count > target) {
      const cur = stack.shift()!;
      if (foldNodeTools(cur)) { changed = true; count = countTimelineNodes(nodes); }
      for (const ch of cur.children || []) stack.push(ch);
    }
  }
  // Pass 2: collapse oldest phase children into phase summary (preserve subagent/handoff if space)
  for (let ti = 0; ti < nodes.length && count > target; ti++) {
    for (const ch of nodes[ti].children || []) {
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

export function compactTimeline(
  rawTimeline: unknown,
  { maxNodes = MAX_TIMELINE_NODES, maxBytes = MAX_TIMELINE_BYTES }: CompactTimelineOptions = {},
): ModelTimelineSnapshot | null {
  const safe = safeTimeline(rawTimeline);
  if (!safe) return null;
  let truncated = safe.truncated === true;
  if (countTimelineNodes(safe.nodes) > maxNodes && compactPass(safe.nodes, maxNodes)) truncated = true;
  safe.truncated = truncated;
  let text = JSON.stringify(safe);
  while (Buffer.byteLength(text, 'utf8') > maxBytes) {
    safe.truncated = true;
    const beforeNodes = countTimelineNodes(safe.nodes);
    if (beforeNodes > 4) {
      compactPass(safe.nodes, Math.max(1, Math.floor(beforeNodes * 0.7)));
    } else if (safe.swimlanes.length > 8) {
      safe.swimlanes = safe.swimlanes.filter((l) => l.kind !== 'tool').slice(-16);
    } else if (safe.nodes.length > 1) {
      safe.nodes.shift();
    } else {
      if (safe.nodes[0]) safe.nodes[0].children = [];
      safe.swimlanes = safe.swimlanes.slice(0, 4);
      break;
    }
    text = JSON.stringify(safe);
  }
  return safe;
}

export function safeTimeline(value: unknown, opts: CompactTimelineOptions | null = null): ModelTimelineSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.enabled !== true) return null;
  const cascadeId = normalizeConversationId(raw.cascadeId) || cleanStr(raw.cascadeId, 64);
  if (!cascadeId) return null;
  const base: ModelTimelineSnapshot = {
    enabled: true,
    cascadeId,
    planModel: formatModelName(raw.planModel),
    activeModel: formatModelName(raw.activeModel),
    startedAt: iso(parseTs(raw.startedAt)),
    endedAt: iso(parseTs(raw.endedAt)),
    durationMs: typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) && raw.durationMs >= 0 ? Math.round(raw.durationMs) : 0,
    swimlanes: Array.isArray(raw.swimlanes) ? raw.swimlanes.map(sanitizeSwimlane).filter((s): s is TimelineSwimlaneItem => s !== null).slice(0, 128) : [],
    nodes: Array.isArray(raw.nodes) ? raw.nodes.map((n, i) => sanitizeNode(n, i)).filter((n): n is TimelineNode => n !== null) : [],
    truncated: raw.truncated === true,
    savedAt: iso(parseTs(raw.savedAt)),
  };
  return opts ? compactTimeline(base, opts) : base;
}
