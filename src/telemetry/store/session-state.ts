import type { ConversationSummary, SpeedMetrics, TaskUsageSummary } from '../../contracts/metrics.ts';
import { normalizeConversationId } from '../delegation/delegation.ts';
import type {
  AncestorResolutionHost,
  RawSummaryRecord,
  SessionEntry,
  TrajectorySummaryMeta,
} from './types.ts';

export function summaryMetaFrom(
  rawSummaries: Record<string, RawSummaryRecord> | null | undefined,
  readerSummaries: Record<string, RawSummaryRecord> | null | undefined,
  id: string,
): TrajectorySummaryMeta | null {
  const norm = normalizeConversationId(id);
  for (const map of [rawSummaries, readerSummaries]) {
    if (!map || typeof map !== 'object') continue;
    const direct = map[id] || (norm ? map[norm] : undefined);
    if (direct?.trajectoryMetadata && typeof direct.trajectoryMetadata === 'object') {
      return direct.trajectoryMetadata as TrajectorySummaryMeta;
    }
    if (norm) {
      for (const [k, v] of Object.entries(map)) {
        if (k.toLowerCase() === norm && v?.trajectoryMetadata && typeof v.trajectoryMetadata === 'object') {
          return v.trajectoryMetadata as TrajectorySummaryMeta;
        }
      }
    }
  }
  return null;
}

export function findSessionEntryIn(
  sessions: Map<string, SessionEntry>,
  normId: string | null,
): { key: string; entry: SessionEntry } | null {
  if (!normId) return null;
  const direct = sessions.get(normId);
  if (direct) return { key: normId, entry: direct };
  for (const [k, v] of sessions) {
    if (k.toLowerCase() === normId) return { key: k, entry: v };
  }
  return null;
}

export function resolveRootIdFrom(
  rawSummaries: Record<string, RawSummaryRecord> | null | undefined,
  readerSummaries: Record<string, RawSummaryRecord> | null | undefined,
  id: string | null,
  fallbackMeta: TrajectorySummaryMeta | null = null,
): string | null {
  const norm = normalizeConversationId(id);
  if (!norm) return null;
  let cur = norm;
  const seen = new Set([cur]);
  for (let i = 0; i < 64; i++) {
    const m = summaryMetaFrom(rawSummaries, readerSummaries, cur) || (i === 0 ? fallbackMeta : null);
    if (!m) break;
    const rootCid = normalizeConversationId(m.rootConversationId);
    const parentCid = normalizeConversationId(m.parentConversationId);
    if (rootCid && rootCid !== cur && !seen.has(rootCid)) { cur = rootCid; seen.add(cur); continue; }
    if (parentCid && parentCid !== cur && !seen.has(parentCid)) { cur = parentCid; seen.add(cur); continue; }
    break;
  }
  return cur !== norm ? cur : null;
}

export function selectRootConversationFrom(
  rawSummaries: Record<string, RawSummaryRecord> | null | undefined,
  readerSummaries: Record<string, RawSummaryRecord> | null | undefined,
  summaries: ConversationSummary[] = [],
  fallbackId: string | null = null,
): string | null {
  const list = Array.isArray(summaries) ? summaries : [];
  const candidate = list[0]?.id || fallbackId;
  if (!candidate) return null;
  const normCandidate = normalizeConversationId(candidate);
  const meta = summaryMetaFrom(rawSummaries, readerSummaries, candidate);
  const metaRoot = normalizeConversationId(meta?.rootConversationId);
  const metaParent = normalizeConversationId(meta?.parentConversationId);
  const isChild = !!(metaParent || (metaRoot && normCandidate && metaRoot !== normCandidate));
  if (!isChild) return candidate;
  const resolvedRoot = resolveRootIdFrom(rawSummaries, readerSummaries, candidate, meta);
  if (resolvedRoot) {
    const inSummaries = list.find((s) => normalizeConversationId(s.id) === resolvedRoot);
    if (inSummaries) return inSummaries.id;
    const rawMap = rawSummaries || readerSummaries || {};
    for (const key of Object.keys(rawMap)) {
      if (normalizeConversationId(key) === resolvedRoot) return key;
    }
  }
  const topRoot = list.find((s) => {
    const m = summaryMetaFrom(rawSummaries, readerSummaries, s.id);
    const mr = normalizeConversationId(m?.rootConversationId);
    const sid = normalizeConversationId(s.id);
    return !m?.parentConversationId && (!mr || mr === sid);
  });
  return topRoot?.id || candidate;
}

export function mapConversationSummaries(rawSummaries: Record<string, RawSummaryRecord>): ConversationSummary[] {
  const entries = Object.entries(rawSummaries);
  const rows: Array<{ ts: number; item: ConversationSummary }> = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const [id, value] = entries[i];
    const modifiedAt = typeof value.lastModifiedTime === 'string' ? value.lastModifiedTime : '';
    const ts = Date.parse(modifiedAt);
    rows[i] = {
      ts: Number.isFinite(ts) ? ts : 0,
      item: {
        id,
        title: typeof value.summary === 'string' && value.summary ? value.summary : '未命名会话',
        modifiedAt,
        status: typeof value.status === 'string' ? value.status : '',
        stepCount: typeof value.stepCount === 'number' ? value.stepCount : 0,
        lastUserInputStepIndex: typeof value.lastUserInputStepIndex === 'number' ? value.lastUserInputStepIndex : undefined,
      },
    };
  }
  rows.sort((a, b) => b.ts - a.ts);
  return rows.map((row) => row.item);
}

export function recordAncestorRaw(ancestorRaws: Map<string, WeakRef<object>>, key: string, raw: unknown): void {
  for (const [k, ref] of ancestorRaws) {
    if (ref?.deref?.() === undefined) ancestorRaws.delete(k);
  }
  if (ancestorRaws.size >= 16) {
    const oldest = ancestorRaws.keys().next().value;
    if (oldest !== undefined) ancestorRaws.delete(oldest);
  }
  if (raw && typeof raw === 'object') ancestorRaws.set(key, new WeakRef(raw));
}

export function refreshAncestorUsageIn(
  host: AncestorResolutionHost,
  scope: string,
  epoch: number,
  ancestorId: string,
  ancestorSaved: TaskUsageSummary | null,
  force: boolean,
): void {
  if (!scope || !ancestorId || !host.client?.trajectory) return;
  const key = `${scope}:${ancestorId}`;
  if (host.ancestorPending.has(key)) return;
  const isStillCurrent = (): boolean => scope === host.identity && epoch === host.epoch;
  const p = Promise.resolve().then(async () => {
    const raw = await host.client.trajectory(ancestorId, { force, modelTimelineEnabled: host.modelTimelineEnabled === true });
    if (!isStillCurrent() || !raw || host.owns() !== true || !host.delegated) return;
    recordAncestorRaw(host.ancestorRaws, key, raw);
    const ancestorEntry = findSessionEntryIn(host.sessions, ancestorId)?.entry;
    const knownIds = ancestorEntry?.data?.delegatedConversations || [];
    const taskUsage = host.delegated.request(scope, ancestorId, raw, {
      saved: ancestorSaved || ancestorEntry?.data?.taskUsage || null,
      knownIds,
      force,
      isCurrent: isStillCurrent,
    });
    if (ancestorEntry) {
      if (!ancestorEntry.rawWeak?.deref?.() && raw && typeof raw === 'object') ancestorEntry.rawWeak = new WeakRef(raw);
      if (taskUsage && ancestorEntry.data) ancestorEntry.data = { ...ancestorEntry.data, taskUsage };
    }
  }).catch(() => {}).finally(() => {
    if (host.ancestorPending.get(key) === p) host.ancestorPending.delete(key);
  });
  host.ancestorPending.set(key, p);
}

export async function resolveTaskUsageIn(
  host: AncestorResolutionHost,
  scope: string | null,
  epoch: number,
  id: string,
  raw: any,
  {
    existingData = null,
    force = false,
    current = () => true,
  }: { existingData?: SpeedMetrics | null; force?: boolean; current?: () => boolean } = {},
): Promise<{ taskUsage: TaskUsageSummary | null; delegatedConversations: string[] | undefined }> {
  if (!scope || !host.delegated) {
    return { taskUsage: existingData?.taskUsage || null, delegatedConversations: existingData?.delegatedConversations ?? undefined };
  }
  let taskUsage: TaskUsageSummary | null = null;
  let delegatedConversations: string[] | undefined = existingData?.delegatedConversations ?? undefined;
  try {
    taskUsage = host.delegated.request(scope, id, raw, {
      saved: existingData?.taskUsage || null,
      knownIds: existingData?.delegatedConversations || [],
      force,
      isCurrent: current,
    });
    const norm = normalizeConversationId(id);
    const task = host.delegated.tasks?.get(id) || (norm ? host.delegated.tasks?.get(norm) : undefined);
    if (task?.children?.size) delegatedConversations = [...task.children];
  } catch {}
  if (!taskUsage && host.owns() === true) {
    const normId = normalizeConversationId(id);
    const meta = summaryMetaFrom(host.rawSummaries, host.client?.reader?.summaries, id) || raw?.trajectoryMetadata || null;
    const ancestorId =
      resolveRootIdFrom(host.rawSummaries, host.client?.reader?.summaries, normId, meta) ||
      normalizeConversationId(meta?.rootConversationId) ||
      normalizeConversationId(meta?.parentConversationId);
    if (ancestorId && normId && ancestorId !== normId) {
      const ancestorEntry = findSessionEntryIn(host.sessions, ancestorId)?.entry;
      let ancestorSaved = ancestorEntry?.data?.taskUsage || host.delegated.tasks?.get(ancestorId)?.result || null;
      let ancestorHistory: { metrics: SpeedMetrics } | null = null;
      if (!ancestorSaved && host.history?.load) {
        ancestorHistory = await host.history.load(scope, ancestorId).catch(() => null);
        if (!current()) return { taskUsage: null, delegatedConversations };
        ancestorSaved = ancestorHistory?.metrics?.taskUsage || null;
      }
      const ancestorRaw =
        ancestorEntry?.raw ||
        ancestorEntry?.rawWeak?.deref?.() ||
        host.ancestorRaws.get(`${scope}:${ancestorId}`)?.deref?.() ||
        host.client?.reader?.entries?.get?.(ancestorId)?.data ||
        null;
      if (ancestorRaw) {
        const knownIds = ancestorEntry?.data?.delegatedConversations || ancestorHistory?.metrics?.delegatedConversations || [];
        try {
          taskUsage = host.delegated.request(scope, ancestorId, ancestorRaw, {
            saved: ancestorSaved,
            knownIds,
            force,
            isCurrent: () => scope === host.identity && epoch === host.epoch,
          });
        } catch {}
      } else {
        if (ancestorSaved) taskUsage = ancestorSaved;
        refreshAncestorUsageIn(host, scope, epoch, ancestorId, ancestorSaved, force);
      }
    }
  }
  return { taskUsage, delegatedConversations };
}
