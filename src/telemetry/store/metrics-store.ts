import { dirname, join } from 'node:path';
import type { AccountsResponse, MetricsRequestInput, SwitchAccountResponse } from '../../contracts/ipc.ts';
import type {
  ConnectionStatus,
  ConversationSummary,
  MetricsSnapshot,
  QuotaGroup,
  SpeedMetrics,
  TaskUsageSummary,
} from '../../contracts/metrics.ts';
import type { ClearTimelineResult } from '../../contracts/timeline.ts';
import type { SessionDescriptorInput, SnapshotDiffOutput } from '../../platform/native-bridge.ts';
import { AntigravityClient } from '../client/index.ts';
import { DelegatedUsage, type DelegatedClientLike } from '../delegation/delegated-usage.ts';
import { TranscriptReader } from '../reader/transcript.ts';
import { diffSessionSnapshotsWithFallback, parseSummaryMtimeMs } from '../snapshot-diff.ts';
import { TimelineStore } from '../timeline/store.ts';
import { SessionHistory } from './history.ts';
import { executeQuotaRefresh, handleDelegatedUpdate, loadCachedSession, runSessionPoll } from './session-runner.ts';
import {
  findSessionEntryIn,
  mapConversationSummaries,
  refreshAncestorUsageIn,
  resolveRootIdFrom,
  resolveTaskUsageIn,
  selectRootConversationFrom,
  summaryMetaFrom,
} from './session-state.ts';
import {
  GUID,
  HASH,
  type MetricsStoreOptions,
  type RawSummaryRecord,
  type SessionEntry,
  type StoreClientLike,
  type StoreDelegatedLike,
  type StoreHistoryLike,
  type StoreTimelineStoreLike,
  type StoreTranscriptsLike,
  type SummarySnapshotState,
  type TrajectorySummaryMeta,
} from './types.ts';

export type { MetricsStoreOptions } from './types.ts';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class MetricsStore {
  client: StoreClientLike;
  history: StoreHistoryLike;
  timelineStore: StoreTimelineStoreLike | null;
  modelTimelineEnabled: boolean;
  onTrajectory: ((scope: string, id: string, raw: unknown) => Promise<unknown> | unknown) | null;
  onAccount: ((scope: string, meta: { email: string; name: string }) => Promise<unknown> | unknown) | null;
  transcripts: StoreTranscriptsLike | null;
  delegated: StoreDelegatedLike | null;
  owns: () => boolean;
  quota: QuotaGroup[] | null = null;
  quotaAt = 0;
  quotaPending: Promise<void> | null = null;
  identity: string | null = null;
  registeredAccount: { identity: string; email: string; name: string } | null = null;
  serverPid: number | null = null;
  summaries: ConversationSummary[] = [];
  rawSummaries: Record<string, RawSummaryRecord> | null = null;
  summariesAt = 0;
  summaryStates = new Map<string, SummarySnapshotState>();
  dirtySessionIds = new Set<string>();
  newlySettledSessionIds = new Set<string>();
  runningSessionIds = new Set<string>();
  lastSummaryDiff: SnapshotDiffOutput | null = null;
  sessions = new Map<string, SessionEntry>();
  ancestorPending = new Map<string, Promise<void>>();
  ancestorRaws = new Map<string, WeakRef<object>>();
  persistenceError: string | null = null;
  usagePersistenceError = false;
  epoch = 0;
  lastActiveConversationId: string | null = null;

  constructor(
    client: StoreClientLike = new AntigravityClient(),
    {
      history = new SessionHistory(),
      timelineStore = undefined,
      dataDir = null,
      modelTimelineEnabled = false,
      onTrajectory = null,
      onAccount = null,
      transcripts = new TranscriptReader(),
      delegated = null,
      owns = () => true,
    }: MetricsStoreOptions = {},
  ) {
    this.client = client;
    this.history = history;
    this.timelineStore =
      timelineStore === null
        ? null
        : timelineStore ||
          new TimelineStore(
            dataDir ? join(dataDir, 'timeline-v1') : history?.directory ? join(dirname(history.directory), 'timeline-v1') : undefined,
          );
    this.modelTimelineEnabled = modelTimelineEnabled === true;
    this.onTrajectory = onTrajectory;
    this.onAccount = onAccount;
    this.transcripts = transcripts;
    this.owns = owns;
    this.client?.setModelTimelineEnabled?.(this.modelTimelineEnabled);
    this.delegated =
      delegated ||
      new DelegatedUsage(this.client as unknown as DelegatedClientLike, {
        owns: () => this.owns() === true,
        modelTimelineEnabled: this.modelTimelineEnabled,
        onSource: async (scope: string, id: string, raw: unknown) => {
          if (this.onTrajectory && scope) {
            try { await this.onTrajectory(scope, id, raw); } catch {}
          }
        },
        onUpdate: (scope: string, id: string, taskUsage: TaskUsageSummary, childIds: string[]) =>
          handleDelegatedUpdate(this, scope, id, taskUsage, childIds),
      });
    this.delegated?.setModelTimelineEnabled?.(this.modelTimelineEnabled);
  }

  setModelTimelineEnabled(enabled: boolean): boolean {
    const next = enabled === true;
    if (next === this.modelTimelineEnabled) return this.modelTimelineEnabled;
    this.modelTimelineEnabled = next;
    this.client?.setModelTimelineEnabled?.(next);
    this.delegated?.setModelTimelineEnabled?.(next);
    for (const entry of this.sessions.values()) {
      entry.updatedAt = 0;
      if (!next && entry.data) {
        entry.data = { ...entry.data, modelTimeline: null };
        entry.rawWeak = null; entry.rawRev = null; entry.withTimeline = false;
      }
    }
    return this.modelTimelineEnabled;
  }

  async clearTimeline(cascadeId: string | null = null): Promise<ClearTimelineResult> {
    const scope = this.identity;
    if (typeof cascadeId === 'string' && GUID.test(cascadeId)) {
      const norm = cascadeId.toLowerCase();
      for (const [key, entry] of this.sessions) {
        if (key.toLowerCase() === norm && entry.data) {
          entry.data = { ...entry.data, modelTimeline: null };
          entry.updatedAt = 0;
        }
      }
      if (scope && this.timelineStore) return await this.timelineStore.clear(scope, norm);
      return { cleared: true, scope: scope || null, cascadeId: norm };
    }
    return this.clearAllTimelines(scope ?? null);
  }

  async clearAllTimelines(scope: string | null = this.identity ?? null): Promise<ClearTimelineResult> {
    for (const entry of this.sessions.values()) {
      if (entry.data) entry.data = { ...entry.data, modelTimeline: null };
      entry.updatedAt = 0;
    }
    if (this.timelineStore) return await this.timelineStore.clearAll(scope);
    return { cleared: true, scope: scope || 'all' };
  }

  summaryMeta(id: string): TrajectorySummaryMeta | null {
    return summaryMetaFrom(this.rawSummaries, this.client?.reader?.summaries, id);
  }

  findSessionEntry(normId: string | null): { key: string; entry: SessionEntry } | null {
    return findSessionEntryIn(this.sessions, normId);
  }

  resolveRootId(id: string | null, fallbackMeta: TrajectorySummaryMeta | null = null): string | null {
    return resolveRootIdFrom(this.rawSummaries, this.client?.reader?.summaries, id, fallbackMeta);
  }

  selectRootConversation(summaries: ConversationSummary[] = [], fallbackId: string | null = null): string | null {
    return selectRootConversationFrom(this.rawSummaries, this.client?.reader?.summaries, summaries, fallbackId);
  }

  refreshAncestorUsage(scope: string, epoch: number, ancestorId: string, ancestorSaved: TaskUsageSummary | null, force: boolean): void {
    refreshAncestorUsageIn(this, scope, epoch, ancestorId, ancestorSaved, force);
  }

  resolveTaskUsage(
    scope: string | null,
    epoch: number,
    id: string,
    raw: unknown,
    options?: { existingData?: SpeedMetrics | null; force?: boolean; current?: () => boolean },
  ): Promise<{ taskUsage: TaskUsageSummary | null; delegatedConversations: string[] | undefined }> {
    return resolveTaskUsageIn(this, scope, epoch, id, raw, options);
  }

  cachedSession(id: string): Promise<SpeedMetrics | null> {
    return loadCachedSession(this, id, GUID);
  }

  async refreshQuota(force = false): Promise<void> {
    if (!force && this.quota && Date.now() - this.quotaAt < 60000) return;
    if (this.quotaPending) return this.quotaPending;
    this.quotaPending = executeQuotaRefresh(this).finally(() => { this.quotaPending = null; });
    return this.quotaPending;
  }

  getSummaryDiff(): SnapshotDiffOutput | null {
    return this.lastSummaryDiff;
  }

  private clearSummaryDiffState(): void {
    this.summaryStates.clear();
    this.dirtySessionIds.clear();
    this.newlySettledSessionIds.clear();
    this.runningSessionIds.clear();
    this.lastSummaryDiff = null;
  }

  async listConversations(force = false): Promise<ConversationSummary[]> {
    if (!force && Date.now() - this.summariesAt < 5000) return this.summaries;
    const scope = this.identity;
    const epoch = this.epoch;
    const response = await this.client.call('GetAllCascadeTrajectories');
    if (scope !== this.identity || epoch !== this.epoch) throw new Error('后台已重新连接，请等待刷新');
    const rawSummaries: Record<string, RawSummaryRecord> = response.trajectorySummaries || {};
    this.rawSummaries = rawSummaries;
    const now = Date.now();
    this.client?.reader?.seedSummaries?.(rawSummaries, now, this.client?.server);
    this.summaries = mapConversationSummaries(rawSummaries);
    this.summariesAt = now;

    const descriptors: SessionDescriptorInput[] = new Array(this.summaries.length);
    for (let i = 0; i < this.summaries.length; i++) {
      const item = this.summaries[i];
      const prev = this.summaryStates.get(item.id);
      descriptors[i] = {
        cascadeId: item.id,
        mtimeMs: parseSummaryMtimeMs(item.modifiedAt),
        sizeBytes: 0,
        stepCount: typeof item.stepCount === 'number' && Number.isFinite(item.stepCount) ? Math.trunc(item.stepCount) : 0,
        lastUserInputStepIndex:
          typeof item.lastUserInputStepIndex === 'number' && Number.isFinite(item.lastUserInputStepIndex)
            ? Math.trunc(item.lastUserInputStepIndex)
            : -1,
        status: item.status || '',
        prevFingerprint: prev?.fingerprint ?? null,
        prevSettled: prev ? prev.settled : null,
      };
    }
    const diff = diffSessionSnapshotsWithFallback(descriptors);
    this.lastSummaryDiff = diff;
    this.dirtySessionIds = new Set(diff.dirtyIds);
    this.newlySettledSessionIds = new Set(diff.newlySettledIds);
    this.runningSessionIds = new Set(diff.runningIds);
    const nextStates = new Map<string, SummarySnapshotState>();
    for (const item of diff.items) {
      const settled = item.statusKind === 'settled';
      nextStates.set(item.cascadeId, {
        fingerprint: item.fingerprint,
        settled,
        statusKind: item.statusKind,
        preferSqlite: item.preferSqlite,
      });
      const entry = this.sessions.get(item.cascadeId);
      if (entry) {
        entry.summaryFingerprint = item.fingerprint;
        entry.summaryStatusKind = item.statusKind;
        entry.summarySettled = settled;
      }
    }
    this.summaryStates = nextStates;

    return this.summaries;
  }

  async session(id: string, force = false): Promise<SpeedMetrics> {
    if (!GUID.test(id)) throw new Error('会话标识无效');
    let entry = this.sessions.get(id);
    if (entry?.pending) return entry.pending;
    const summaryState = this.summaryStates.get(id);
    const summaryChanged =
      Boolean(summaryState && entry?.polledSummaryFingerprint !== summaryState.fingerprint) ||
      this.newlySettledSessionIds.has(id);
    if (!force && !summaryChanged && entry?.data && Date.now() - (entry.updatedAt ?? 0) < 1800) {
      return entry.data;
    }
    if (!entry) { entry = {}; this.sessions.set(id, entry); }
    entry.pending = runSessionPoll(this, id, entry, force).finally(() => { entry!.pending = null; });
    return entry.pending;
  }

  async snapshot({ conversationId, force = false }: MetricsRequestInput = {}): Promise<MetricsSnapshot> {
    let connection: ConnectionStatus = 'live';
    let error: string | null = null;
    let speed: SpeedMetrics | null = null;
    let sessionError: string | null = null;
    try {
      const server = await this.client.discover();
      if (server.pid !== this.serverPid) {
        this.epoch++; this.delegated?.reset?.(); this.transcripts?.reset();
        this.quota = null; this.quotaAt = 0; this.sessions.clear(); this.ancestorPending.clear(); this.ancestorRaws.clear();
        this.identity = null; this.registeredAccount = null; this.summaries = []; this.rawSummaries = null; this.summariesAt = 0;
        this.clearSummaryDiffState();
        this.serverPid = server.pid; this.lastActiveConversationId = null;
      }
      try { await this.refreshQuota(force); } catch (e) { connection = this.quota ? 'stale' : 'offline'; error = errorMessage(e); }
      if (conversationId && GUID.test(conversationId)) this.lastActiveConversationId = conversationId;
      let summaries = this.summaries;
      // The inline composer already supplies its exact ID. Enumerating every
      // conversation first adds unrelated RPC latency to a route transition.
      if (!conversationId) {
        try { summaries = await this.listConversations(force); } catch (e) { connection = this.quota ? 'stale' : 'offline'; error ||= errorMessage(e); }
      }
      const selected = conversationId || this.selectRootConversation(summaries, this.lastActiveConversationId);
      if (selected) {
        try { speed = await this.session(selected, force); } catch (e) { sessionError = errorMessage(e); }
      }
    } catch (e) {
      connection = this.quota ? 'stale' : 'offline';
      error = errorMessage(e);
      const fallbackId = conversationId || this.selectRootConversation(this.summaries, this.lastActiveConversationId);
      if (fallbackId) speed = await this.cachedSession(fallbackId);
    }
    return {
      connection, error, sessionError,
      serverTime: new Date().toISOString(),
      quotaUpdatedAt: this.quotaAt ? new Date(this.quotaAt).toISOString() : null,
      groups: this.quota || [], speed, conversations: this.summaries,
      persistenceError: this.persistenceError, source: 'Antigravity local API',
    };
  }

  switchAccount(identity: string): SwitchAccountResponse {
    if (!identity || (identity !== 'all' && !HASH.test(identity))) throw new Error('Invalid account scope');
    return { success: true, active: identity, activeAccount: this.identity || identity };
  }

  async getAccounts(): Promise<AccountsResponse> {
    return {
      active: this.identity,
      accounts: this.identity ? [{ id: this.identity, name: `Account (${this.identity.slice(0, 8)})`, active: true }] : [],
    };
  }

  dispose(): void {
    this.epoch++;
    this.delegated?.dispose?.();
    this.transcripts?.dispose?.();
    this.sessions.clear();
    this.clearSummaryDiffState();
    this.ancestorPending.clear();
    this.ancestorRaws.clear();
  }
}
