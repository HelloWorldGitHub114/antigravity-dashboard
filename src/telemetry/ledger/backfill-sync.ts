import type { UsageRecord } from '../../contracts/usage.ts';
import {
  extractSqliteUsageRecords,
  isNativeAccelAvailable,
  readSqliteConversationMeta,
  readSqliteTrajectory,
} from '../../platform/native-bridge.ts';
import {
  conversationId,
  resolveLocalConversationDbPath,
  type DiscoverLocalConversationsResult,
} from '../reader/local-conversations.ts';
import { usageRecords } from './extractor.ts';
import { sha256 } from './helpers.ts';
import type { UsageLedger } from './summary.ts';
import type { BackfillEntry, BackfillHost } from './types.ts';

export interface ListedConversationSummary {
  id: string;
  stepCount?: number;
  modifiedAt?: string;
  status?: string;
  lastUserInputStepIndex?: number;
}

export interface DesktopUsageStore {
  identity: string | null;
  epoch: number;
  usagePersistenceError?: boolean;
  conversationsDir?: string | null;
  listConversations(includeArchive?: boolean): Promise<ListedConversationSummary[]>;
  client?: {
    conversationsDir?: string | null;
    trajectory(
      id: string,
      options?: { summary?: unknown; force?: boolean; isCurrent?: () => boolean },
    ): Promise<unknown>;
  };
}

export interface DesktopUsageOptions {
  host?: BackfillHost | null;
  conversationsDir?: string | null;
  discoverLocal?: (() => Promise<DiscoverLocalConversationsResult>) | null;
  owns?: () => boolean;
  now?: () => number;
  sliceMs?: number;
  continueDelay?: number;
}

export interface CandidateConversation {
  id: string;
  listed?: ListedConversationSummary;
  signature?: string;
  readSignature?: () => Promise<string | null>;
  dbPath?: string;
  sizeBytes?: number;
}

export type RunSyncResult =
  | { current: () => boolean; completed: false }
  | {
      current: () => boolean;
      completed: true;
      missing: number;
      confirmed: number;
      retrying: number;
      more: boolean;
    }
  | null;

export interface UnrefableTimer {
  unref?: () => void;
}

export function buildSyncCandidates(params: {
  scope: string;
  listed: readonly ListedConversationSummary[];
  local: DiscoverLocalConversationsResult;
  ownership: Record<string, string>;
  ownFiles: Set<string>;
  otherFiles: Map<string, string[]>;
  resolveFile: (scope: string, id: string) => string;
}): Map<string, CandidateConversation> {
  const { scope, listed, local, ownership, ownFiles, otherFiles, resolveFile } = params;
  const isForeign = (id: string): boolean => {
    if (ownership[id]) return ownership[id] !== scope;
    const fileName = resolveFile(scope, id).split(/[\\/]/).pop();
    if (fileName && ownFiles.has(fileName)) return false;
    return Boolean(fileName && otherFiles.get(fileName)?.length);
  };

  const candidates = new Map<string, CandidateConversation>();
  // Current conversations get priority over unloaded archives.
  for (const c of listed) {
    if (conversationId.test(c.id)) {
      const id = c.id.toLowerCase();
      if (!isForeign(id)) candidates.set(id, { id, listed: c });
    }
  }
  if (local.conversations?.length) {
    for (const c of local.conversations) {
      if (conversationId.test(c.id)) {
        const id = c.id.toLowerCase();
        if (!isForeign(id)) candidates.set(id, { ...candidates.get(id), ...c, id });
      }
    }
  }
  return candidates;
}

export async function syncOneCandidate(params: {
  candidate: CandidateConversation;
  scope: string;
  forced: boolean;
  store: DesktopUsageStore;
  ledger: UsageLedger;
  current: () => boolean;
  conversationsDir?: string | null;
}): Promise<{ cancelled: boolean }> {
  const { candidate: c, scope, forced, store, ledger, current, conversationsDir } = params;
  const s = c.listed;
  const summary = s
    ? {
        stepCount: s.stepCount,
        lastModifiedTime: s.modifiedAt,
        status: s.status,
        lastUserInputStepIndex: s.lastUserInputStepIndex,
      }
    : {};
  const isRunning = Boolean(s?.status && /RUNNING|ACTIVE|GENERATING|WAITING|QUEUED/i.test(String(s.status)));
  const explicitDir = conversationsDir ?? store.conversationsDir ?? store.client?.conversationsDir ?? null;
  const dbPath = c.dbPath || (explicitDir ? resolveLocalConversationDbPath(c.id, explicitDir) : null);

  let rows: UsageRecord[] | null = null;
  if (!isRunning && dbPath && isNativeAccelAvailable()) {
    const expectedSteps = typeof s?.stepCount === 'number' && Number.isSafeInteger(s.stepCount) ? s.stepCount : 0;
    let freshEnough = true;
    if (expectedSteps > 0) {
      const meta = readSqliteConversationMeta(dbPath, c.id);
      freshEnough = typeof meta?.stepCount === 'number' && meta.stepCount >= expectedSteps;
    }
    if (freshEnough) {
      // 优先走轨迹读取再由 usageRecords 提取，保证历史回填同样携带首字时间、耗时与质检后 TPS
      const sqliteTraj = readSqliteTrajectory(dbPath, c.id, { modelTimelineEnabled: false });
      const sqliteRows = sqliteTraj
        ? usageRecords(sqliteTraj, c.id)
        : extractSqliteUsageRecords<UsageRecord>(dbPath, c.id);
      if (sqliteRows !== null && (sqliteRows.length > 0 || expectedSteps === 0)) {
        rows = sqliteRows;
      }
    }
  }

  if (rows === null) {
    try {
      const raw = (await store.client?.trajectory(c.id, {
        summary,
        force: forced || !!c.signature,
        isCurrent: current,
      })) as { trajectory?: { steps?: unknown[]; generatorMetadata?: unknown[] } } | null | undefined;
      if (!current()) return { cancelled: true };
      if (!raw?.trajectory || !Array.isArray(raw.trajectory.steps) || !Array.isArray(raw.trajectory.generatorMetadata)) {
        throw Error('Incomplete historical statistics');
      }
      if (!s && !raw.trajectory.steps.length && !raw.trajectory.generatorMetadata.length) {
        throw Error('History not yet readable');
      }
      rows = usageRecords(raw, c.id);
    } catch (rpcError) {
      if (!current()) return { cancelled: true };
      if (dbPath && isNativeAccelAvailable()) {
        const rescueTraj = readSqliteTrajectory(dbPath, c.id, { modelTimelineEnabled: false });
        const rescueRows = rescueTraj
          ? usageRecords(rescueTraj, c.id)
          : extractSqliteUsageRecords<UsageRecord>(dbPath, c.id);
        if (rescueRows && rescueRows.length > 0) {
          rows = rescueRows;
        } else {
          throw rpcError;
        }
      } else {
        throw rpcError;
      }
    }
  }

  if (!current()) return { cancelled: true };
  const other = await ledger.inspectOtherAccounts(scope, c.id);
  const filteredRows = other.recordIds.size ? rows.filter((r) => !other.recordIds.has(r.id)) : rows;
  if (filteredRows.length || !other.recordIds.size) {
    await ledger.ingestRows(scope, c.id, filteredRows);
    if (!current()) return { cancelled: true };
    if (other.owners.length === 0) await ledger.registerOwnership(c.id, scope);
  }
  const stable = !c.readSignature || (await c.readSignature()) === c.signature;
  if (!current()) return { cancelled: true };
  if (!stable) throw Error('History changed during import');
  return { cancelled: false };
}

export function buildRetryEntry(signature: string, failures: number, nowMs: number): BackfillEntry {
  return {
    signature,
    state: 'retry',
    failures,
    retryAt: nowMs + Math.min(30 * 60000, 30000 * 2 ** Math.min(failures - 1, 6)),
  };
}

export function candidateMark(listed: ListedConversationSummary | undefined): string {
  return JSON.stringify([listed?.stepCount, listed?.modifiedAt, listed?.status, listed?.lastUserInputStepIndex]);
}

// 当账本记录新增持久字段（如耗时与 TPS）时递增版本，触发已归档本地会话平滑补齐
const BACKFILL_RECORD_VERSION = 'v2-timing';

export function candidateSignature(listedSignature: string | undefined, mark: string): string {
  return listedSignature
    ? sha256(`${BACKFILL_RECORD_VERSION}:${listedSignature}${mark}`)
    : sha256(`${BACKFILL_RECORD_VERSION}:${mark}`);
}

export async function ingestConversationUsage(params: {
  scope: string;
  id: string;
  raw: unknown;
  ledger: UsageLedger;
  now: () => number;
}): Promise<void> {
  const { scope, id, raw, ledger, now } = params;
  const rows = usageRecords(raw, id);
  if (!rows.length) return;
  const norm = id.toLowerCase();
  const ownership = await ledger.ownership();
  const owner = ownership[norm];
  const other = await ledger.inspectOtherAccounts(scope, norm);
  const isForeign = Boolean((owner && owner !== scope) || (!owner && !other.inOwn && other.owners.length > 0));
  if (isForeign) {
    const container = (raw && typeof raw === 'object' ? raw : {}) as { trajectory?: { status?: unknown }; status?: unknown };
    const status = String(container.trajectory?.status || container.status || '');
    const isRunning = status.includes('RUNNING');
    const nowMs = typeof now === 'function' ? now() : Date.now();
    const filtered = rows.filter((r) => {
      if (other.recordIds.has(r.id)) return false;
      if (isRunning) return r.at === null || other.maxAt === 0 || r.at >= other.maxAt;
      return r.at !== null && Number.isFinite(r.at) && r.at > other.maxAt && nowMs - r.at <= 15 * 60 * 1000;
    });
    if (!filtered.length) return;
    await ledger.ingestRows(scope, id, filtered);
    return;
  }
  const filtered = other.recordIds.size ? rows.filter((r) => !other.recordIds.has(r.id)) : rows;
  if (!filtered.length) return;
  await ledger.ingestRows(scope, id, filtered);
  if (!owner && other.owners.length === 0) await ledger.registerOwnership(norm, scope);
}
