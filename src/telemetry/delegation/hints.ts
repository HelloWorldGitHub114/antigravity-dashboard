import type { SubagentItem } from '../../contracts/metrics.ts';
import { normalizeConversationId, type DelegatedHint } from './delegation.ts';

export interface ChildTimeRange {
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number;
}

export interface ResolvedTaskHint {
  role: string | null;
  parentId: string | null;
  depth: number;
  specRole: string | null;
  meta: Record<string, unknown> | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function extractChildTimeRange(raw: unknown): ChildTimeRange {
  const rawObj = isRecord(raw) ? raw : null;
  const traj = rawObj && isRecord(rawObj.trajectory) ? rawObj.trajectory : null;
  const steps = Array.isArray(traj?.steps) ? traj.steps : [];
  let minMs: number | null = null;
  let maxMs: number | null = null;

  for (const s of steps) {
    const m = isRecord(s) && isRecord(s.metadata) ? s.metadata : null;
    if (!m) continue;
    for (const rawTs of [m.createdAt, m.startedAt, m.completedAt]) {
      const t = typeof rawTs === 'string' ? Date.parse(rawTs) : NaN;
      if (Number.isFinite(t)) {
        if (minMs === null || t < minMs) minMs = t;
        if (maxMs === null || t > maxMs) maxMs = t;
      }
    }
  }

  const generators = Array.isArray(traj?.generatorMetadata) ? traj.generatorMetadata : [];
  for (const g of generators) {
    const chat = isRecord(g) && isRecord(g.chatModel) ? g.chatModel : null;
    const startMeta = chat && isRecord(chat.chatStartMetadata) ? chat.chatStartMetadata : null;
    const rawTs = startMeta?.createdAt;
    const t = typeof rawTs === 'string' ? Date.parse(rawTs) : NaN;
    if (Number.isFinite(t)) {
      if (minMs === null || t < minMs) minMs = t;
      if (maxMs === null || t > maxMs) maxMs = t;
    }
  }

  return {
    startedAt: minMs !== null ? new Date(minMs).toISOString() : null,
    endedAt: maxMs !== null ? new Date(maxMs).toISOString() : null,
    durationMs: minMs !== null && maxMs !== null ? Math.max(0, Math.round(maxMs - minMs)) : 0,
  };
}

export function findSummaryEntry(summaries: unknown, id: string): Record<string, unknown> {
  if (!isRecord(summaries)) return {};
  if (isRecord(summaries[id])) return summaries[id];
  for (const [key, val] of Object.entries(summaries)) {
    if (key.toLowerCase() === id && isRecord(val)) return val;
  }
  return {};
}

export function mergeTaskHint(
  hints: Map<string, DelegatedHint>,
  taskId: string,
  rawId: unknown,
  { role = null, parentId = null, depth = null }: Partial<DelegatedHint> = {},
): void {
  const cid = normalizeConversationId(rawId);
  if (!cid || cid === taskId) return;
  const prev = hints.get(cid) || { role: null, parentId: null, depth: null };
  const nextRole = typeof role === 'string' && role.trim() ? role.trim() : null;
  const nextParent = normalizeConversationId(parentId);
  const nextDepth = typeof depth === 'number' && Number.isInteger(depth) && depth >= 0 ? depth : null;
  hints.set(cid, {
    role: nextRole || prev.role || null,
    parentId: nextParent || prev.parentId || null,
    depth: nextDepth ?? prev.depth ?? null,
  });
}

export function seedTaskHints(
  hints: Map<string, DelegatedHint>,
  taskId: string,
  saved: unknown,
): void {
  const savedObj = isRecord(saved) ? saved : null;
  if (!Array.isArray(savedObj?.items)) return;
  for (const item of savedObj.items) {
    if (!isRecord(item)) continue;
    const cid = normalizeConversationId(item.id);
    if (!cid || cid === taskId) continue;
    const parentId = normalizeConversationId(item.parentId);
    const rawDepth =
      typeof item.depth === 'number' && Number.isInteger(item.depth) && item.depth >= 0
        ? item.depth
        : null;
    mergeTaskHint(hints, taskId, cid, {
      role: typeof item.role === 'string' && item.role.trim() ? item.role.trim() : null,
      parentId,
      depth: parentId || (rawDepth !== null && rawDepth > 1) ? rawDepth : null,
    });
  }
}

export function resolveTaskHint(
  task: {
    id: string;
    hints?: Map<string, DelegatedHint>;
    details?: Map<string, SubagentItem>;
  },
  id: string,
  summaries: unknown,
  raw: unknown = null,
): ResolvedTaskHint {
  const h = task.hints?.get(id);
  const summary = findSummaryEntry(summaries, id);
  const rawObj = isRecord(raw) ? raw : null;
  const meta =
    (isRecord(summary.trajectoryMetadata) ? summary.trajectoryMetadata : null) ||
    (rawObj && isRecord(rawObj.trajectoryMetadata) ? rawObj.trajectoryMetadata : null);
  const spec = meta && isRecord(meta.subagentSpec) ? meta.subagentSpec : null;
  const specRole =
    (typeof spec?.role === 'string' ? spec.role : '') ||
    (typeof spec?.typeName === 'string' ? spec.typeName : '') ||
    (typeof meta?.subagentRole === 'string' ? meta.subagentRole : '');
  const role = specRole.trim() || h?.role || (typeof summary.summary === 'string' ? summary.summary : null) || null;
  const parentId = normalizeConversationId(meta?.parentConversationId) || h?.parentId || null;
  const metaDepth =
    typeof meta?.nestingDepth === 'number' && Number.isInteger(meta.nestingDepth)
      ? meta.nestingDepth
      : typeof meta?.subagentDepth === 'number' && Number.isInteger(meta.subagentDepth)
        ? meta.subagentDepth
        : null;

  let depth: number | null = metaDepth;
  if (depth === null && parentId) {
    if (parentId === task.id) {
      depth = 1;
    } else {
      let cur: string | null = parentId;
      let hops = 1;
      let fallbackAncestorDepth: number | null = null;
      let fallbackHops = 0;
      const seen = new Set<string>([id, cur]);
      while (cur && hops < 64) {
        const psRaw: unknown = findSummaryEntry(summaries, cur).trajectoryMetadata;
        const ps: Record<string, unknown> | null = isRecord(psRaw) ? psRaw : null;
        const pd: SubagentItem | undefined = task.details?.get(cur);
        const ph: DelegatedHint | undefined = task.hints?.get(cur);
        const pNext: string | null =
          normalizeConversationId(ps?.parentConversationId) || ph?.parentId || pd?.parentId || null;
        const pMetaDepth =
          typeof ps?.nestingDepth === 'number' && Number.isInteger(ps.nestingDepth)
            ? ps.nestingDepth
            : typeof ps?.subagentDepth === 'number' && Number.isInteger(ps.subagentDepth)
              ? ps.subagentDepth
              : (ph?.depth ?? null);
        if (pNext === task.id) {
          depth = hops + 1;
          break;
        }
        if (fallbackAncestorDepth === null && pMetaDepth !== null && Number.isInteger(pMetaDepth)) {
          fallbackAncestorDepth = pMetaDepth;
          fallbackHops = hops;
        }
        if (!pNext || seen.has(pNext)) break;
        seen.add(pNext);
        cur = pNext;
        hops++;
      }
      if (depth === null && fallbackAncestorDepth !== null) {
        depth = fallbackAncestorDepth + fallbackHops;
      }
    }
  }
  if (depth === null) depth = h?.depth ?? 1;
  return { role, parentId, depth, specRole: specRole.trim() || null, meta };
}
