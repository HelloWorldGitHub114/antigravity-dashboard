import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { AntigravityClient } from './client.mjs';
import { quotaMetrics, trajectoryMetrics } from './metrics.mjs';
import { SessionHistory, usableMetrics, reconcileMetrics } from './history.mjs';
import { TranscriptReader } from './transcript.mjs';
import { DelegatedUsage } from './delegated-usage.mjs';
import { normalizeConversationId } from './delegation.mjs';
import { buildModelTimeline } from './timeline.mjs';
import { TimelineStore } from './timeline-store.mjs';

const GUID = /^(?:[a-zA-Z0-9_.-]+\/)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
export class MetricsStore {
  constructor(client = new AntigravityClient(), { history = new SessionHistory(), timelineStore = undefined, dataDir = null, modelTimelineEnabled = false, onTrajectory = null, onAccount = null, transcripts = new TranscriptReader(), delegated = null, owns = () => true } = {}) {
    this.client = client;
    this.history = history;
    this.timelineStore = timelineStore === null ? null : (timelineStore || new TimelineStore(
      dataDir ? join(dataDir, 'timeline-v1') : (history?.directory ? join(dirname(history.directory), 'timeline-v1') : undefined)
    ));
    this.modelTimelineEnabled = modelTimelineEnabled === true;
    this.onTrajectory = onTrajectory;
    this.onAccount = onAccount;
    this.transcripts = transcripts;
    this.owns = owns;
    this.client?.setModelTimelineEnabled?.(this.modelTimelineEnabled);
    this.delegated = delegated || new DelegatedUsage(this.client, {
      owns: () => this.owns() === true,
      modelTimelineEnabled: this.modelTimelineEnabled,
      onSource: async (scope, id, raw) => {
        if (this.onTrajectory && scope) {
          try { await this.onTrajectory(scope, id, raw); } catch {}
        }
      },
      onUpdate: async (scope, id, taskUsage, childIds) => {
        const entry = this.sessions.get(id);
        if (entry?.data && scope === this.identity) {
          let modelTimeline = this.modelTimelineEnabled && entry.rawRef
            ? buildModelTimeline(entry.rawRef, {
                cascadeId: id,
                metrics: entry.baseMetrics || entry.data,
                subagentItems: this.delegated?.getTimelineChildren?.(id) || [],
              })
            : (this.modelTimelineEnabled ? entry.data.modelTimeline || null : null);
          if (modelTimeline && this.timelineStore && this.owns() === true) {
            try { modelTimeline = (await this.timelineStore.save(scope, id, modelTimeline)) || modelTimeline; } catch {}
          }
          entry.data = { ...entry.data, taskUsage, modelTimeline };
          if (childIds?.length) entry.data.delegatedConversations = childIds;
          entry.updatedAt = Date.now();
          try {
            const saved = await this.history.save(scope, id, entry.data);
            if (saved) entry.savedAt = saved.savedAt;
          } catch {}
        }
        const normRoot = normalizeConversationId(id);
        if (normRoot && taskUsage && scope === this.identity) {
          for (const [sid, childEntry] of this.sessions) {
            if (normalizeConversationId(sid) === normRoot || !childEntry?.data) continue;
            if (childEntry.data.delegatedConversations?.length) continue;
            if (this.resolveRootId(sid) === normRoot) {
              childEntry.data = { ...childEntry.data, taskUsage };
            }
          }
        }
      }
    });
    this.delegated?.setModelTimelineEnabled?.(this.modelTimelineEnabled);
  }
  setModelTimelineEnabled(enabled) {
    const next = enabled === true;
    if (next === this.modelTimelineEnabled) return this.modelTimelineEnabled;
    this.modelTimelineEnabled = next;
    this.client?.setModelTimelineEnabled?.(next);
    this.delegated?.setModelTimelineEnabled?.(next);
    for (const entry of this.sessions.values()) {
      entry.updatedAt = 0;
      if (!next && entry.data) {
        entry.data = { ...entry.data, modelTimeline: null };
        entry.rawRef = null;
        entry.withTimeline = false;
      }
    }
    return this.modelTimelineEnabled;
  }
  async clearTimeline(cascadeId = null) {
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
  async clearAllTimelines(scope = this.identity ?? null) {
    for (const entry of this.sessions.values()) {
      if (entry.data) entry.data = { ...entry.data, modelTimeline: null };
      entry.updatedAt = 0;
    }
    if (this.timelineStore) return await this.timelineStore.clearAll(scope);
    return { cleared: true, scope: scope || 'all' };
  }
  quota = null;
  quotaAt = 0;
  quotaPending = null;
  identity = null;
  registeredAccount = null;
  serverPid = null;
  summaries = [];
  rawSummaries = null;
  summariesAt = 0;
  sessions = new Map();
  ancestorPending = new Map();
  ancestorRaws = new Map();
  persistenceError = null;
  epoch = 0;
  lastActiveConversationId = null;

  summaryMeta(id) {
    const norm = normalizeConversationId(id);
    const sources = [this.rawSummaries, this.client?.reader?.summaries];
    for (const map of sources) {
      if (!map || typeof map !== 'object') continue;
      const direct = map[id] || (norm && map[norm]);
      if (direct?.trajectoryMetadata) return direct.trajectoryMetadata;
      if (norm) {
        for (const [k, v] of Object.entries(map)) {
          if (k.toLowerCase() === norm && v?.trajectoryMetadata) return v.trajectoryMetadata;
        }
      }
    }
    return null;
  }

  findSessionEntry(normId) {
    if (!normId) return null;
    if (this.sessions.has(normId)) return { key: normId, entry: this.sessions.get(normId) };
    for (const [k, v] of this.sessions) {
      if (k.toLowerCase() === normId) return { key: k, entry: v };
    }
    return null;
  }

  resolveRootId(id, fallbackMeta = null) {
    const norm = normalizeConversationId(id);
    if (!norm) return null;
    let cur = norm;
    const seen = new Set([cur]);
    for (let i = 0; i < 64; i++) {
      const m = this.summaryMeta(cur) || (i === 0 ? fallbackMeta : null);
      if (!m) break;
      const rootCid = normalizeConversationId(m.rootConversationId);
      const parentCid = normalizeConversationId(m.parentConversationId);
      if (rootCid && rootCid !== cur && !seen.has(rootCid)) {
        cur = rootCid;
        seen.add(cur);
        continue;
      }
      if (parentCid && parentCid !== cur && !seen.has(parentCid)) {
        cur = parentCid;
        seen.add(cur);
        continue;
      }
      break;
    }
    return cur !== norm ? cur : null;
  }

  selectRootConversation(summaries = [], fallbackId = null) {
    const list = Array.isArray(summaries) ? summaries : [];
    const candidate = list[0]?.id || fallbackId;
    if (!candidate) return null;
    const normCandidate = normalizeConversationId(candidate);
    const meta = this.summaryMeta(candidate);
    const metaRoot = normalizeConversationId(meta?.rootConversationId);
    const metaParent = normalizeConversationId(meta?.parentConversationId);
    const isChild = !!(metaParent || (metaRoot && normCandidate && metaRoot !== normCandidate));
    if (!isChild) return candidate;
    const resolvedRoot = this.resolveRootId(candidate, meta);
    if (resolvedRoot) {
      const inSummaries = list.find(s => normalizeConversationId(s.id) === resolvedRoot);
      if (inSummaries) return inSummaries.id;
      const rawMap = this.rawSummaries || this.client?.reader?.summaries || {};
      for (const key of Object.keys(rawMap)) {
        if (normalizeConversationId(key) === resolvedRoot) return key;
      }
    }
    const topRoot = list.find(s => {
      const m = this.summaryMeta(s.id);
      const mr = normalizeConversationId(m?.rootConversationId);
      const sid = normalizeConversationId(s.id);
      return !m?.parentConversationId && (!mr || mr === sid);
    });
    return topRoot?.id || candidate;
  }

  refreshAncestorUsage(scope, epoch, ancestorId, ancestorSaved, force) {
    if (!scope || !ancestorId || !this.client?.trajectory) return;
    const key = `${scope}:${ancestorId}`;
    if (this.ancestorPending.has(key)) return;
    const isStillCurrent = () => scope === this.identity && epoch === this.epoch;
    const p = Promise.resolve().then(async () => {
      const raw = await this.client.trajectory(ancestorId, { force, modelTimelineEnabled: this.modelTimelineEnabled === true });
      if (!isStillCurrent() || !raw || this.owns() !== true || !this.delegated) return;
      if (this.ancestorRaws.size >= 16) this.ancestorRaws.delete(this.ancestorRaws.keys().next().value);
      this.ancestorRaws.set(key, raw);
      const ancestorEntry = this.findSessionEntry(ancestorId)?.entry;
      const knownIds = ancestorEntry?.data?.delegatedConversations || [];
      const taskUsage = this.delegated.request(scope, ancestorId, raw, {
        saved: ancestorSaved || ancestorEntry?.data?.taskUsage || null,
        knownIds,
        force,
        isCurrent: isStillCurrent,
      });
      if (ancestorEntry) {
        if (!ancestorEntry.rawRef) ancestorEntry.rawRef = raw;
        if (taskUsage && ancestorEntry.data) ancestorEntry.data = { ...ancestorEntry.data, taskUsage };
      }
    }).catch(() => {}).finally(() => {
      if (this.ancestorPending.get(key) === p) this.ancestorPending.delete(key);
    });
    this.ancestorPending.set(key, p);
  }

  async resolveTaskUsage(scope, epoch, id, raw, { existingData = null, force = false, current = () => true } = {}) {
    if (!scope || !this.delegated) {
      return { taskUsage: existingData?.taskUsage || null, delegatedConversations: existingData?.delegatedConversations };
    }
    let taskUsage = null;
    let delegatedConversations = existingData?.delegatedConversations;
    try {
      taskUsage = this.delegated.request(scope, id, raw, {
        saved: existingData?.taskUsage || null,
        knownIds: existingData?.delegatedConversations || [],
        force,
        isCurrent: current,
      });
      const task = this.delegated.tasks?.get(id) || this.delegated.tasks?.get(normalizeConversationId(id));
      if (task?.children?.size) delegatedConversations = [...task.children];
    } catch {}
    if (!taskUsage && this.owns() === true) {
      const normId = normalizeConversationId(id);
      const meta = this.summaryMeta(id) || raw?.trajectoryMetadata || null;
      const ancestorId = this.resolveRootId(normId, meta)
        || normalizeConversationId(meta?.rootConversationId)
        || normalizeConversationId(meta?.parentConversationId);
      if (ancestorId && normId && ancestorId !== normId) {
        const ancestorEntry = this.findSessionEntry(ancestorId)?.entry;
        let ancestorSaved = ancestorEntry?.data?.taskUsage
          || this.delegated.tasks?.get(ancestorId)?.result
          || null;
        let ancestorHistory = null;
        if (!ancestorSaved && this.history?.load) {
          ancestorHistory = await this.history.load(scope, ancestorId).catch(() => null);
          if (!current()) return { taskUsage: null, delegatedConversations };
          ancestorSaved = ancestorHistory?.metrics?.taskUsage || null;
        }
        const ancestorRaw = ancestorEntry?.raw
          || ancestorEntry?.rawRef
          || this.ancestorRaws.get(`${scope}:${ancestorId}`)
          || this.client?.reader?.entries?.get?.(ancestorId)?.data
          || null;
        if (ancestorRaw) {
          const knownIds = ancestorEntry?.data?.delegatedConversations
            || ancestorHistory?.metrics?.delegatedConversations
            || [];
          try {
            taskUsage = this.delegated.request(scope, ancestorId, ancestorRaw, {
              saved: ancestorSaved,
              knownIds,
              force,
              isCurrent: () => scope === this.identity && epoch === this.epoch,
            });
          } catch {}
        } else {
          if (ancestorSaved) taskUsage = ancestorSaved;
          this.refreshAncestorUsage(scope, epoch, ancestorId, ancestorSaved, force);
        }
      }
    }
    return { taskUsage, delegatedConversations };
  }

  async cachedSession(id) {
    if (!GUID.test(id) || !this.identity) return null;
    const scope = this.identity, epoch = this.epoch;
    const entry = this.sessions.get(id);
    if (usableMetrics(entry?.data)) {
      let modelTimeline = this.modelTimelineEnabled ? (entry.data.modelTimeline || null) : null;
      if (this.modelTimelineEnabled && !modelTimeline && this.timelineStore) {
        modelTimeline = await this.timelineStore.load(scope, id).catch(() => null);
      }
      return { ...entry.data, modelTimeline, transcriptRestoredFromHistory:!!entry.data.transcriptStats, restoredFromHistory: true, savedAt: entry.savedAt || null };
    }
    const saved = await this.history.load(scope,id);
    if (scope !== this.identity || epoch !== this.epoch) return null;
    if (!saved) return null;
    const modelTimeline = this.modelTimelineEnabled && this.timelineStore ? await this.timelineStore.load(scope, id).catch(() => null) : null;
    if (scope !== this.identity || epoch !== this.epoch) return null;
    const restored = { ...saved.metrics, modelTimeline };
    if (!this.sessions.has(id)) this.sessions.set(id,{data:restored,savedAt:saved.savedAt,updatedAt:0,withTimeline:this.modelTimelineEnabled});
    return {...restored,transcriptRestoredFromHistory:!!saved.metrics.transcriptStats,restoredFromHistory:true,savedAt:saved.savedAt};
  }

  async refreshQuota(force = false) {
    if (!force && this.quota && Date.now() - this.quotaAt < 60000) return;
    if (this.quotaPending) return this.quotaPending;
    const epoch = this.epoch;
    this.quotaPending = (async () => {
      const [userRes, quotaRes] = await Promise.allSettled([
        this.client.call('GetUserStatus'),
        this.client.call('RetrieveUserQuotaSummary'),
      ]);
      if (epoch !== this.epoch) throw new Error('后台已重新连接，请等待刷新');
      if (userRes.status === 'rejected') throw userRes.reason;
      const user = userRes.value;
      const email = user.userStatus?.email || (user.userStatus ? `vertex:${this.client.paths?.()?.profile || process.env.GOOGLE_CLOUD_PROJECT || process.env.USERPROFILE || 'local'}` : null);
      const identity = email ? createHash('sha256').update(email).digest('hex') : null;
      if (identity !== this.identity) {
        this.delegated?.reset?.();
        this.transcripts?.reset();
        this.client.resetTrajectories?.();
        this.quota = null;
        this.quotaAt = 0;
        this.sessions.clear();
        this.ancestorPending.clear();
        this.ancestorRaws.clear();
        this.summaries = [];
        this.rawSummaries = null;
        this.summariesAt = 0;
        this.registeredAccount = null;
      }
      this.identity = identity;
      const accountName = user.userStatus?.name || email;
      let accountPromise = null;
      if (identity && (this.registeredAccount?.identity !== identity || this.registeredAccount?.email !== email || this.registeredAccount?.name !== accountName)) {
        accountPromise = Promise.resolve()
          .then(() => this.onAccount?.(identity, { email, name: accountName }))
          .then(() => {
            if (epoch === this.epoch && identity === this.identity) {
              this.registeredAccount = { identity, email, name: accountName };
            }
          })
          .catch(() => {});
      }
      if (quotaRes.status === 'rejected') {
        if (accountPromise) await accountPromise;
        throw quotaRes.reason;
      }
      if (accountPromise) await accountPromise;
      if (epoch !== this.epoch || identity !== this.identity) throw new Error('后台已重新连接，请等待刷新');
      this.quota = quotaMetrics(quotaRes.value);
      this.quotaAt = Date.now();
    })().finally(() => { this.quotaPending = null; });
    return this.quotaPending;
  }

  async listConversations(force = false) {
    if (!force && Date.now() - this.summariesAt < 5000) return this.summaries;
    const scope = this.identity, epoch = this.epoch;
    const response = await this.client.call('GetAllCascadeTrajectories');
    if (scope !== this.identity || epoch !== this.epoch) throw new Error('后台已重新连接，请等待刷新');
    const rawSummaries = response.trajectorySummaries || {};
    this.rawSummaries = rawSummaries;
    const now = Date.now();
    this.client?.reader?.seedSummaries?.(rawSummaries, now, this.client?.server);
    const entries = Object.entries(rawSummaries);
    const rows = new Array(entries.length);
    for (let i = 0; i < entries.length; i++) {
      const [id, value] = entries[i];
      const ts = Date.parse(value.lastModifiedTime);
      rows[i] = {
        ts: Number.isFinite(ts) ? ts : 0,
        item: {
          id,
          title: value.summary || '未命名会话',
          modifiedAt: value.lastModifiedTime,
          status: value.status,
          stepCount: value.stepCount,
          lastUserInputStepIndex: value.lastUserInputStepIndex,
        },
      };
    }
    rows.sort((a, b) => b.ts - a.ts);
    this.summaries = rows.map(row => row.item);
    this.summariesAt = now;
    return this.summaries;
  }

  async session(id, force = false) {
    if (!GUID.test(id)) throw new Error('会话标识无效');
    const scope = this.identity, epoch = this.epoch;
    let entry = this.sessions.get(id);
    if (entry?.pending) return entry.pending;
    if (!force && entry?.data && Date.now() - entry.updatedAt < 1800) return entry.data;
    entry ||= {};
    this.sessions.set(id, entry);
    const current = () => scope === this.identity && epoch === this.epoch && this.sessions.get(id) === entry;
    entry.pending = (async () => {
      const timelineEnabled = this.modelTimelineEnabled === true;
      const savedPromise = (!entry.data && scope) ? this.history.load(scope, id).catch(() => null) : null;
      const trajectoryPromise = this.client.trajectory(id, { force, modelTimelineEnabled: timelineEnabled });
      let saved = null, raw;
      try {
        [saved, raw] = await Promise.all([savedPromise, trajectoryPromise]);
      } catch (error) {
        if (savedPromise && !entry.data) {
          saved = await savedPromise;
          if (current() && saved && !entry.data) { entry.data = { ...saved.metrics, modelTimeline: null }; entry.savedAt = saved.savedAt; }
        }
        throw error;
      }
      if (!current()) throw new Error('后台已重新连接，请等待刷新');
      if (saved && !entry.data) { entry.data = { ...saved.metrics, modelTimeline: null }; entry.savedAt = saved.savedAt; }
      const readerEntry = this.client?.reader?.entries?.get?.(id);
      const readerRev = readerEntry?.data === raw ? (readerEntry.rev || 0) : null;
      const sameRaw = !force && entry.withTimeline === timelineEnabled && readerRev !== null && entry.rawRef === raw && entry.rawRev === readerRev && entry.baseMetrics && entry.data && !entry.data.restoredFromHistory;
      if (sameRaw && !this.usagePersistenceError && !this.persistenceError) {
        const prev = entry.data;
        let nextTranscript = prev.transcriptStats;
        try { if (scope && this.transcripts) nextTranscript = this.transcripts.request(scope, id, raw); } catch {}
        const { taskUsage: nextTaskUsage, delegatedConversations: nextDelegated } = await this.resolveTaskUsage(scope, epoch, id, raw, { existingData: prev, force, current });
        if (!current()) throw new Error('后台已重新连接，请等待刷新');
        const sameTranscript = nextTranscript === prev.transcriptStats || (!nextTranscript && !prev.transcriptStats) || (nextTranscript && prev.transcriptStats && JSON.stringify(nextTranscript) === JSON.stringify(prev.transcriptStats));
        const sameTask = nextTaskUsage === prev.taskUsage || (!nextTaskUsage && !prev.taskUsage) || (nextTaskUsage && prev.taskUsage && JSON.stringify(nextTaskUsage) === JSON.stringify(prev.taskUsage));
        const sameDel = nextDelegated === prev.delegatedConversations || (!nextDelegated?.length && !prev.delegatedConversations?.length) || (nextDelegated?.length === prev.delegatedConversations?.length && nextDelegated.every((v, idx) => v === prev.delegatedConversations[idx]));
        if (sameTranscript && sameTask && sameDel) {
          entry.updatedAt = Date.now();
          return entry.data;
        }
        const fresh = { ...entry.baseMetrics };
        if (nextTranscript) fresh.transcriptStats = nextTranscript;
        if (nextTaskUsage) fresh.taskUsage = nextTaskUsage;
        if (nextDelegated) fresh.delegatedConversations = nextDelegated;
        let modelTimeline = timelineEnabled
          ? buildModelTimeline(raw, { cascadeId: id, metrics: entry.baseMetrics, subagentItems: this.delegated?.getTimelineChildren?.(id) || [] })
          : null;
        if (modelTimeline && scope && this.timelineStore && this.owns() === true) {
          try { modelTimeline = (await this.timelineStore.save(scope, id, modelTimeline)) || modelTimeline; } catch {}
        }
        entry.data = { ...reconcileMetrics(entry.data, fresh, entry.savedAt || null), conversationId: id, modelTimeline };
        entry.updatedAt = Date.now();
        try { const nextSaved = await this.history.save(scope, id, entry.data); if (nextSaved) entry.savedAt = nextSaved.savedAt; if (current()) this.persistenceError = null; }
        catch { this.persistenceError = '统计暂时无法保存到本地'; }
        if (!current()) throw new Error('后台已重新连接，请等待刷新');
        return entry.data;
      }
      if(this.onTrajectory&&scope){try{await this.onTrajectory(scope,id,raw);if(current())this.usagePersistenceError=false;}catch{if(current())this.usagePersistenceError=true;}}
      if (!current()) throw new Error('后台已重新连接，请等待刷新');
      const baseMetrics = trajectoryMetrics(raw);
      const fresh = { ...baseMetrics };
      // Optional background I/O cannot delay or fail the core metrics request.
      try { if(scope&&this.transcripts)fresh.transcriptStats=this.transcripts.request(scope,id,raw); } catch {}
      const { taskUsage, delegatedConversations } = await this.resolveTaskUsage(scope, epoch, id, raw, { existingData: entry.data, force, current });
      if (!current()) throw new Error('后台已重新连接，请等待刷新');
      if (taskUsage) fresh.taskUsage = taskUsage;
      if (delegatedConversations) fresh.delegatedConversations = delegatedConversations;
      let modelTimeline = timelineEnabled
        ? buildModelTimeline(raw, { cascadeId: id, metrics: baseMetrics, subagentItems: this.delegated?.getTimelineChildren?.(id) || [] })
        : null;
      if (modelTimeline && scope && this.timelineStore && this.owns() === true) {
        try { modelTimeline = (await this.timelineStore.save(scope, id, modelTimeline)) || modelTimeline; } catch {}
      }
      if (!current()) throw new Error('后台已重新连接，请等待刷新');
      entry.data = {...reconcileMetrics(entry.data,fresh,entry.savedAt || null),conversationId:id,modelTimeline}; entry.updatedAt = Date.now();
      entry.rawRef = readerRev !== null ? raw : null;
      entry.rawRev = readerRev;
      entry.withTimeline = timelineEnabled;
      entry.baseMetrics = readerRev !== null ? baseMetrics : null;
      try { const nextSaved = await this.history.save(scope,id,entry.data); if (nextSaved) entry.savedAt = nextSaved.savedAt; if (current()) this.persistenceError = null; }
      catch { this.persistenceError = '统计暂时无法保存到本地'; }
      if (!current()) throw new Error('后台已重新连接，请等待刷新');
      return entry.data;
    })().catch(async error => {
      if (current() && usableMetrics(entry.data)) {
        entry.updatedAt = Date.now();
        entry.rawRef = null;
        entry.rawRev = null;
        entry.baseMetrics = null;
        const updating = error?.message === '会话仍在更新，请等待下一次刷新';
        const status = updating ? 'CASCADE_RUN_STATUS_RUNNING' : entry.data.status;
        let modelTimeline = this.modelTimelineEnabled ? (entry.data.modelTimeline || null) : null;
        if (this.modelTimelineEnabled && !modelTimeline && scope && this.timelineStore) {
          modelTimeline = await this.timelineStore.load(scope, id).catch(() => null);
        }
        entry.data = {
          ...entry.data,
          modelTimeline,
          status,
          transcriptRestoredFromHistory: !!entry.data.transcriptStats,
          restoredFromHistory: true,
          savedAt: entry.savedAt || null,
        };
        return entry.data;
      }
      throw error;
    }).finally(() => { entry.pending = null; });
    return entry.pending;
  }

  async snapshot({ conversationId, force = false } = {}) {
    let connection = 'live', error = null, speed = null, sessionError = null;
    try {
      const server = await this.client.discover();
      if (server.pid !== this.serverPid) {
        this.epoch++; this.delegated?.reset?.(); this.transcripts?.reset(); this.quota = null; this.quotaAt = 0; this.sessions.clear(); this.ancestorPending.clear(); this.ancestorRaws.clear(); this.identity = null; this.registeredAccount = null; this.summaries = []; this.rawSummaries = null; this.summariesAt = 0; this.serverPid = server.pid; this.lastActiveConversationId = null;
      }
      try { await this.refreshQuota(force); }
      catch (e) { connection = this.quota ? 'stale' : 'offline'; error = e.message; }
      if (conversationId && GUID.test(conversationId)) {
        this.lastActiveConversationId = conversationId;
      }
      let summaries = this.summaries;
      // The inline composer already supplies its exact ID. Enumerating every
      // conversation first adds unrelated RPC latency to a route transition.
      if (!conversationId) {
        try { summaries = await this.listConversations(force); }
        catch (e) { connection = this.quota ? 'stale' : 'offline'; error ||= e.message; }
      }
      const selected = conversationId || this.selectRootConversation(summaries, this.lastActiveConversationId);
      if (selected) {
        try { speed = await this.session(selected, force); }
        catch (e) { sessionError = e.message; }
      }
    } catch (e) {
      connection = this.quota ? 'stale' : 'offline'; error = e.message;
      const fallbackId = conversationId || this.selectRootConversation(this.summaries, this.lastActiveConversationId);
      if (fallbackId) speed = await this.cachedSession(fallbackId);
    }
    return {
      connection, error, sessionError, serverTime: new Date().toISOString(),
      quotaUpdatedAt: this.quotaAt ? new Date(this.quotaAt).toISOString() : null,
      groups: this.quota || [], speed, conversations: this.summaries,
      persistenceError: this.persistenceError,
      source: 'Antigravity local API',
    };
  }

  switchAccount(identity) {
    if (!identity || (identity !== 'all' && !HASH.test(identity))) throw new Error('Invalid account scope');
    return { success: true, active: identity, activeAccount: this.identity || identity };
  }

  async getAccounts() {
    return {
      active: this.identity,
      accounts: this.identity ? [{ id: this.identity, name: `Account (${this.identity.slice(0, 8)})`, active: true }] : []
    };
  }

  dispose() {
    this.epoch++;
    this.delegated?.dispose?.();
    this.transcripts?.dispose?.();
    this.sessions.clear();
    this.ancestorPending.clear();
    this.ancestorRaws.clear();
  }
}
