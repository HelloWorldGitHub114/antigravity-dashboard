import { join } from 'node:path';
import type {
  UsageRequestCacheFilter,
  UsageRequestLogCostBucket,
  UsageRequestLogItem,
  UsageRequestLogModelOption,
  UsageRequestLogRequest,
  UsageRequestLogSnapshot,
  UsageRequestLogSummary,
  UsageRecord,
} from '../../contracts/index.ts';
import { formatStatStamp } from '../../shared/atomic-fs.ts';
import { isErrno, mapPool, recordSum, sha256, validRow } from './helpers.ts';
import type { UsageLedger } from './summary.ts';
import { dateKey } from './timezone.ts';
import {
  HASH_RE,
  LEDGER_FILE_RE,
  MAX_RECORD_FILE_BYTES,
  type KnownAccountInfo,
  type LedgerDocument,
} from './types.ts';

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_PAGE_SIZE = 50;
const MIN_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 200;
const HOT_CACHE_THRESHOLD = 0.7;
const WARM_CACHE_THRESHOLD = 0.2;
const SCOPE_CACHE_TTL_MS = 3000;
const MAX_CACHED_SCOPES = 2;

export interface RequestLogStoreLike {
  rawSummaries?: Record<string, unknown> | null;
}

export interface QueryUsageRequestLogsOptions {
  ledger: UsageLedger;
  store?: RequestLogStoreLike | null;
  activeScope?: string | null;
  input?: UsageRequestLogRequest | null;
  now?: number;
}

interface ConversationMetaSnippet {
  title?: string;
  projectName?: string;
}

interface IndexedLogRecord {
  id: string;
  at: number;
  date: string;
  accountKey: string;
  accountName: string;
  model: string;
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  inputTokens: number;
  output: number;
  total: number;
  cacheHitRate: number | null;
  ttftMs: number | null;
  streamMs: number | null;
  durationMs: number | null;
  tps: number | null;
  streamTps: number | null;
  source: 'local' | 'remote';
  fileHash: string;
  manualProjectName?: string;
  note?: string;
  partial?: boolean;
}

interface CachedFileEntry {
  stamp: string;
  doc: LedgerDocument | null;
}

interface CachedScopeIndex {
  revision: number;
  metaStamp: string;
  ownershipStamp: string;
  timeZone: string;
  builtAt: number;
  records: IndexedLogRecord[];
}

interface RequestLogLedgerCache {
  files: Map<string, CachedFileEntry>;
  scopes: Map<string, CachedScopeIndex>;
  projectMeta: { stamp: string; byHash: Map<string, ConversationMetaSnippet> } | null;
}

const cacheByLedger = new WeakMap<UsageLedger, RequestLogLedgerCache>();
const secondFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getLedgerCache(ledger: UsageLedger): RequestLogLedgerCache {
  let entry = cacheByLedger.get(ledger);
  if (!entry) {
    entry = {
      files: new Map(),
      scopes: new Map(),
      projectMeta: null,
    };
    cacheByLedger.set(ledger, entry);
  }
  return entry;
}

function getSecondFormatter(zone: string): Intl.DateTimeFormat {
  let dtf = secondFormatterCache.get(zone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    secondFormatterCache.set(zone, dtf);
  }
  return dtf;
}

function formatDateTimeSeconds(ms: number, zone: string): { date: string; timeText: string } {
  const parts = getSecondFormatter(zone).formatToParts(ms);
  let y = '1970';
  let m = '01';
  let d = '01';
  let hh = '00';
  let mm = '00';
  let ss = '00';
  for (const p of parts) {
    if (p.type === 'year') y = p.value;
    else if (p.type === 'month') m = p.value;
    else if (p.type === 'day') d = p.value;
    else if (p.type === 'hour') hh = p.value.padStart(2, '0');
    else if (p.type === 'minute') mm = p.value.padStart(2, '0');
    else if (p.type === 'second') ss = p.value.padStart(2, '0');
  }
  const date = `${y}-${m}-${d}`;
  return { date, timeText: `${date} ${hh}:${mm}:${ss}` };
}

function cleanText(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

function workspaceBasename(uri: unknown): string {
  if (typeof uri !== 'string') return '';
  let out = uri.trim();
  if (!out || out === 'outside-of-project' || out === 'default-cli-project') return '';
  if (out.startsWith('file://')) {
    out = out.slice('file://'.length);
    if (out.startsWith('/') && /^\/[a-zA-Z](?:%3A|:)/.test(out)) out = out.slice(1);
    try {
      out = decodeURIComponent(out);
    } catch {
      // 忽略异常百分号编码，保留原始路径段
    }
  }
  out = out.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = out.lastIndexOf('/');
  const base = idx >= 0 ? out.slice(idx + 1) : out;
  return cleanText(base, 36);
}

function firstWorkspaceFromMeta(raw: unknown): string {
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const name = workspaceBasename(item);
      if (name) return name;
    }
    return '';
  }
  if (typeof raw === 'string' && raw.trim()) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed) as unknown;
        if (Array.isArray(arr)) return firstWorkspaceFromMeta(arr);
      } catch {
        // 退回按单条路径解析
      }
    }
    return workspaceBasename(trimmed.split(/[\r\n,]+/)[0]);
  }
  return '';
}

async function loadConversationMetaByHash(
  ledger: UsageLedger,
  store?: RequestLogStoreLike | null,
): Promise<Map<string, ConversationMetaSnippet>> {
  const cache = getLedgerCache(ledger);
  const metaFile = ledger.projectMetaFile();
  let diskMap: Map<string, ConversationMetaSnippet> | null = null;

  try {
    const st = await ledger._stat(metaFile);
    const stamp = formatStatStamp(st) ?? 'ENOENT';
    if (cache.projectMeta && cache.projectMeta.stamp === stamp) {
      diskMap = cache.projectMeta.byHash;
    } else {
      const next = new Map<string, ConversationMetaSnippet>();
      if (st && Number(st.size) <= MAX_RECORD_FILE_BYTES) {
        const text = await ledger.fs.readFile(metaFile, 'utf8');
        if (text.length <= MAX_RECORD_FILE_BYTES) {
          const parsed = JSON.parse(text) as { schema?: unknown; entries?: Record<string, unknown> };
          if (parsed?.schema === 1 && parsed.entries && typeof parsed.entries === 'object') {
            for (const [key, val] of Object.entries(parsed.entries)) {
              if (!val || typeof val !== 'object') continue;
              const obj = val as Record<string, unknown>;
              const cid = typeof obj.cid === 'string' && obj.cid.trim() ? obj.cid.trim() : key.trim();
              if (!cid) continue;
              const title = cleanText(obj.title, 56);
              const projectName = firstWorkspaceFromMeta(obj.workspaceUris);
              if (title || projectName) {
                next.set(sha256(cid.toLowerCase()), {
                  ...(title ? { title } : {}),
                  ...(projectName ? { projectName } : {}),
                });
              }
            }
          }
        }
      }
      cache.projectMeta = { stamp, byHash: next };
      diskMap = next;
    }
  } catch {
    diskMap = cache.projectMeta?.byHash ?? null;
  }

  const rawSummaries = store?.rawSummaries;
  if (!rawSummaries || typeof rawSummaries !== 'object') {
    return diskMap ?? new Map();
  }

  // 叠加内存中最新的会话摘要，保证刚发生的对话也能立刻显示标题和工作区
  const merged = new Map<string, ConversationMetaSnippet>(diskMap ?? undefined);
  for (const [cid, val] of Object.entries(rawSummaries)) {
    if (!cid || !val || typeof val !== 'object') continue;
    const obj = val as Record<string, unknown>;
    const title = cleanText(obj.summary, 56);
    let projectName = '';
    if (Array.isArray(obj.workspaces)) {
      for (const ws of obj.workspaces) {
        if (ws && typeof ws === 'object') {
          projectName = workspaceBasename((ws as Record<string, unknown>).workspaceFolderAbsoluteUri);
          if (projectName) break;
        }
      }
    }
    if (!title && !projectName) continue;
    const hash = sha256(cid.toLowerCase());
    const prev = merged.get(hash);
    merged.set(hash, {
      title: title || prev?.title,
      projectName: projectName || prev?.projectName,
    });
  }
  return merged;
}

function normalizeCacheFilter(raw: unknown): UsageRequestCacheFilter {
  if (raw === 'hot' || raw === 'warm' || raw === 'miss') return raw;
  return 'all';
}

function matchesCacheFilter(hitRate: number | null, filter: UsageRequestCacheFilter): boolean {
  if (filter === 'all') return true;
  if (hitRate === null) return false;
  if (filter === 'hot') return hitRate >= HOT_CACHE_THRESHOLD;
  if (filter === 'warm') return hitRate >= WARM_CACHE_THRESHOLD && hitRate < HOT_CACHE_THRESHOLD;
  return hitRate < WARM_CACHE_THRESHOLD;
}

function normalizeDateBound(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return DATE_KEY_RE.test(trimmed) ? trimmed : null;
}

function buildAccountNameResolver(
  meta: Record<string, KnownAccountInfo>,
  knownAccounts: Record<string, KnownAccountInfo>,
): (scope: string) => string {
  return (scope: string): string => {
    const m = meta[scope] || knownAccounts[scope];
    return m?.email || m?.name || `Account (${scope.slice(0, 8)})`;
  };
}

function buildPrimaryPicker(
  meta: Record<string, KnownAccountInfo>,
  knownAccounts: Record<string, KnownAccountInfo>,
): (scopesList: string[]) => string | null {
  const knownKeys = Object.keys(knownAccounts);
  const primaryRank = (s: string): number => {
    const m = meta[s];
    const k = knownAccounts[s];
    if (m?.primary === true || k?.primary === true) return 0;
    if (m?.primary === false || k?.primary === false || m?.secondary === true || k?.secondary === true) return 2;
    if (k && knownKeys.indexOf(s) > 0) return 2;
    return 1;
  };
  return (scopesList: string[]): string | null => {
    if (!scopesList.length) return null;
    return [...scopesList].sort((a, b) => {
      const ra = primaryRank(a);
      const rb = primaryRank(b);
      if (ra !== rb) return ra - rb;
      const ta = meta[a]?.addedAt ?? meta[a]?.createdAt ?? Number.MAX_SAFE_INTEGER;
      const tb = meta[b]?.addedAt ?? meta[b]?.createdAt ?? Number.MAX_SAFE_INTEGER;
      if (ta !== tb) return ta - tb;
      const ia = knownKeys.indexOf(a);
      const ib = knownKeys.indexOf(b);
      if (ia !== -1 && ib !== -1 && ia !== ib) return ia - ib;
      return a.localeCompare(b);
    })[0];
  };
}

async function loadIndexedRecords(
  ledger: UsageLedger,
  resolvedScope: string,
  allScopes: string[],
  meta: Record<string, KnownAccountInfo>,
  metaStamp: string,
  ownership: Record<string, string>,
  ownershipStamp: string,
  timeZone: string,
  nowMs: number,
): Promise<IndexedLogRecord[]> {
  const cache = getLedgerCache(ledger);
  const existing = cache.scopes.get(resolvedScope);
  if (
    existing &&
    existing.revision === ledger.revision &&
    existing.metaStamp === metaStamp &&
    existing.ownershipStamp === ownershipStamp &&
    existing.timeZone === timeZone &&
    nowMs - existing.builtAt < SCOPE_CACHE_TTL_MS
  ) {
    return existing.records;
  }

  const startRevision = ledger.revision;
  const targetScopes =
    resolvedScope === 'all'
      ? allScopes.length
        ? allScopes
        : ledger.scope && HASH_RE.test(ledger.scope)
          ? [ledger.scope]
          : []
      : [resolvedScope];
  const targetSet = new Set(targetScopes);
  const scanScopes = allScopes.length > 1 ? [...new Set([...allScopes, ...targetScopes])] : targetScopes;

  const ownerByName = new Map<string, string>();
  for (const [convId, ownerScope] of Object.entries(ownership || {})) {
    if (!HASH_RE.test(ownerScope)) continue;
    try {
      const fileName = ledger.file(ownerScope, convId).split(/[\\/]/).pop();
      if (fileName) ownerByName.set(fileName, ownerScope);
    } catch {
      // 忽略非法历史会话 ID
    }
  }

  const parsedFiles: Array<{ scope: string; name: string; doc: LedgerDocument }> = [];
  const recordScopes = new Map<string, string[]>();
  const liveFileKeys = new Set<string>();

  for (const s of scanScopes) {
    let files: string[] = [];
    try {
      files = (await ledger.fs.readdir(join(ledger.directory, s))) as string[];
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) files = [];
    }
    const validFiles = files.filter((name) => LEDGER_FILE_RE.test(name));
    const slots = await mapPool(validFiles, 16, async (name) => {
      const relKey = `${s}/${name}`;
      liveFileKeys.add(relKey);
      const fullPath = join(ledger.directory, s, name);
      try {
        const st = await ledger._stat(fullPath);
        const stamp = formatStatStamp(st);
        if (!st || !stamp) return null;
        const cachedFile = cache.files.get(relKey);
        if (cachedFile && cachedFile.stamp === stamp) {
          return cachedFile.doc ? { name, doc: cachedFile.doc } : null;
        }
        if (Number(st.size) > MAX_RECORD_FILE_BYTES) {
          cache.files.set(relKey, { stamp, doc: null });
          return null;
        }
        const text = await ledger.fs.readFile(fullPath, 'utf8');
        if (text.length > MAX_RECORD_FILE_BYTES) {
          cache.files.set(relKey, { stamp, doc: null });
          return null;
        }
        const parsed = JSON.parse(text) as LedgerDocument;
        if (
          parsed.schema !== 1 ||
          parsed.account !== s ||
          !Array.isArray(parsed.records) ||
          !parsed.records.every(validRow)
        ) {
          cache.files.set(relKey, { stamp, doc: null });
          return null;
        }
        cache.files.set(relKey, { stamp, doc: parsed });
        return { name, doc: parsed };
      } catch {
        return null;
      }
    });

    for (const item of slots) {
      if (!item) continue;
      for (const r of item.doc.records) {
        let list = recordScopes.get(r.id);
        if (!list) {
          list = [];
          recordScopes.set(r.id, list);
        }
        if (!list.includes(s)) list.push(s);
      }
      if (targetSet.has(s)) {
        parsedFiles.push({ scope: s, name: item.name, doc: item.doc });
      }
    }
  }

  // 清理已删除的文件缓存，避免长期驻留内存
  for (const key of [...cache.files.keys()]) {
    const scopePrefix = key.split('/')[0];
    if (scanScopes.includes(scopePrefix) && !liveFileKeys.has(key)) {
      cache.files.delete(key);
    }
  }

  const getAccountName = buildAccountNameResolver(meta, ledger.knownAccounts);
  const pickPrimary = buildPrimaryPicker(meta, ledger.knownAccounts);
  const dedup = new Map<string, { item: IndexedLogRecord; sum: number }>();

  for (const { scope: s, name, doc } of parsedFiles) {
    const explicitOwner = ownerByName.get(name);
    const isRemote = doc.metadata?.source === 'remote-manual';
    const fileHash = name.slice(0, -5);
    const manualProjectName = isRemote ? cleanText(doc.metadata?.projectName, 36) : '';
    const manualNote = isRemote ? cleanText(doc.metadata?.note, 64) : '';

    for (const r of doc.records as UsageRecord[]) {
      if (typeof r.at !== 'number' || !Number.isFinite(r.at)) continue;
      const scopesForRecord = recordScopes.get(r.id) || [s];
      const isDuplicate = scopesForRecord.length > 1;
      const resolvedOwner = explicitOwner && scopesForRecord.includes(explicitOwner) ? explicitOwner : null;
      if (resolvedScope !== 'all') {
        if (resolvedOwner) {
          if (resolvedOwner !== s) continue;
        } else if (isDuplicate && pickPrimary(scopesForRecord) !== s) {
          continue;
        }
      }

      const sum = recordSum(r);
      const ttftMs = typeof r.ttftMs === 'number' && Number.isFinite(r.ttftMs) && r.ttftMs >= 0 ? r.ttftMs : null;
      const streamMs = typeof r.streamMs === 'number' && Number.isFinite(r.streamMs) && r.streamMs >= 0 ? r.streamMs : null;
      const streamTps = typeof r.tps === 'number' && Number.isFinite(r.tps) && r.tps > 0 ? r.tps : null;
      const hasTiming = ttftMs !== null || streamMs !== null || streamTps !== null;

      const prev = dedup.get(r.id);
      if (prev) {
        const prevHasTiming =
          prev.item.ttftMs !== null || prev.item.streamMs !== null || prev.item.streamTps !== null;
        if (
          sum < prev.sum ||
          (sum === prev.sum && prevHasTiming && !hasTiming) ||
          (sum === prev.sum && prevHasTiming === hasTiming && r.at <= prev.item.at)
        ) {
          continue;
        }
      }

      const uncached = r.uncached || 0;
      const cacheRead = r.cacheRead || 0;
      const cacheWrite = r.cacheWrite || 0;
      const inputTokens = uncached + cacheRead + cacheWrite;
      const output = r.output || 0;
      const total = inputTokens + output;
      const cacheHitRate = inputTokens > 0 ? cacheRead / inputTokens : null;
      const effectiveOwner = resolvedOwner || (isDuplicate ? pickPrimary(scopesForRecord) || s : s);
      const mergedTtftMs = ttftMs ?? prev?.item.ttftMs ?? null;
      const mergedStreamMs = streamMs ?? prev?.item.streamMs ?? null;
      const mergedStreamTps = streamTps ?? prev?.item.streamTps ?? null;
      const durationMs =
        mergedTtftMs !== null || mergedStreamMs !== null
          ? (mergedTtftMs ?? 0) + (mergedStreamMs ?? 0)
          : null;
      // 综合速度按「总输出 Token / 总耗时」计算，每条有耗时的请求均能稳定产出 TPS
      const overallTps =
        output > 0 && durationMs !== null && durationMs > 0
          ? Math.round((output / (durationMs / 1000)) * 10) / 10
          : null;

      dedup.set(r.id, {
        sum,
        item: {
          id: r.id,
          at: r.at,
          date: dateKey(r.at, timeZone),
          accountKey: effectiveOwner,
          accountName: getAccountName(effectiveOwner),
          model: r.model,
          uncached,
          cacheRead,
          cacheWrite,
          inputTokens,
          output,
          total,
          cacheHitRate,
          ttftMs: mergedTtftMs,
          streamMs: mergedStreamMs,
          durationMs,
          tps: overallTps,
          streamTps: mergedStreamTps,
          source: isRemote ? 'remote' : 'local',
          fileHash,
          ...(manualProjectName ? { manualProjectName } : {}),
          ...(manualNote ? { note: manualNote } : {}),
          ...(r.partial ? { partial: true } : {}),
        },
      });
    }
  }

  const records = [...dedup.values()]
    .map((entry) => entry.item)
    .sort((a, b) => (b.at !== a.at ? b.at - a.at : b.id.localeCompare(a.id)));

  if (ledger.revision === startRevision) {
    if (cache.scopes.size >= MAX_CACHED_SCOPES && !cache.scopes.has(resolvedScope)) {
      const oldestKey = cache.scopes.keys().next().value;
      if (oldestKey) cache.scopes.delete(oldestKey);
    }
    cache.scopes.set(resolvedScope, {
      revision: startRevision,
      metaStamp,
      ownershipStamp,
      timeZone,
      builtAt: nowMs,
      records,
    });
  }
  return records;
}

function emptySummary(): UsageRequestLogSummary {
  return {
    totalRequests: 0,
    totalTokens: 0,
    inputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    uncachedTokens: 0,
    outputTokens: 0,
    cacheHitRate: null,
    hotCount: 0,
    warmCount: 0,
    missCount: 0,
    avgDurationMs: null,
    avgTtftMs: null,
    avgTps: null,
    timedRequests: 0,
    tpsSamples: 0,
    costBuckets: [],
  };
}

/**
 * 分页查询本机请求级账本日志，支持日期范围、模型、缓存命中状态筛选与多账号聚合，
 * 并返回匹配全集的汇总统计与按日-模型分桶的成本计算基础数据。
 */
export async function queryUsageRequestLogs(
  options: QueryUsageRequestLogsOptions,
): Promise<UsageRequestLogSnapshot> {
  const { ledger, store = null, activeScope = null, input = {}, now = Date.now() } = options;
  const timeZone = ledger.timeZone || 'Asia/Shanghai';
  const today = dateKey(now, timeZone);

  const requestedScope = typeof input?.scope === 'string' && input.scope.trim() ? input.scope.trim() : null;
  const from = normalizeDateBound(input?.from);
  const to = normalizeDateBound(input?.to);
  const modelFilter = typeof input?.model === 'string' && input.model.trim() ? input.model.trim() : null;
  const cacheFilter = normalizeCacheFilter(input?.cacheFilter);
  const rawPage = typeof input?.page === 'number' && Number.isFinite(input.page) ? Math.trunc(input.page) : 1;
  const rawPageSize =
    typeof input?.pageSize === 'number' && Number.isFinite(input.pageSize)
      ? Math.trunc(input.pageSize)
      : DEFAULT_PAGE_SIZE;
  const pageSize = Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, rawPageSize));

  const [{ stamp: metaStamp, value: meta }, { stamp: ownershipStamp, value: ownership }, allScopes] = await Promise.all([
    ledger._loadAccountsMeta(),
    ledger._loadOwnership(),
    ledger.scopeDirectories(),
  ]);

  const resolvedScope =
    requestedScope === 'all' || (requestedScope && HASH_RE.test(requestedScope))
      ? requestedScope
      : activeScope && HASH_RE.test(activeScope)
        ? activeScope
        : ledger.scope && HASH_RE.test(ledger.scope)
          ? ledger.scope
          : allScopes[0] || '';

  if (!resolvedScope) {
    return {
      accountKey: '',
      timeZone,
      today,
      from,
      to,
      models: [],
      page: 1,
      pageSize,
      totalCount: 0,
      totalPages: 1,
      summary: emptySummary(),
      items: [],
      updatedAt: new Date(now).toISOString(),
    };
  }

  const indexed = await loadIndexedRecords(
    ledger,
    resolvedScope,
    allScopes,
    meta,
    metaStamp,
    ownership,
    ownershipStamp,
    timeZone,
    now,
  );

  // 先按日期范围过滤，以生成当前日期范围内的可用模型下拉选项
  const modelCounts = new Map<string, number>();
  const matched: IndexedLogRecord[] = [];
  const summary = emptySummary();
  const costBucketMap = new Map<string, UsageRequestLogCostBucket>();
  let totalDurationMs = 0;
  let totalTtftMs = 0;
  let ttftCount = 0;
  let totalTpsOutput = 0;
  let totalTpsDurationMs = 0;

  for (const r of indexed) {
    if (from && r.date < from) continue;
    if (to && r.date > to) continue;

    modelCounts.set(r.model, (modelCounts.get(r.model) || 0) + 1);

    if (modelFilter && r.model !== modelFilter) continue;
    if (!matchesCacheFilter(r.cacheHitRate, cacheFilter)) continue;

    matched.push(r);
    summary.totalRequests += 1;
    summary.totalTokens += r.total;
    summary.inputTokens += r.inputTokens;
    summary.cachedTokens += r.cacheRead;
    summary.cacheWriteTokens += r.cacheWrite;
    summary.uncachedTokens += r.uncached;
    summary.outputTokens += r.output;
    if (r.cacheHitRate !== null) {
      if (r.cacheHitRate >= HOT_CACHE_THRESHOLD) summary.hotCount += 1;
      else if (r.cacheHitRate >= WARM_CACHE_THRESHOLD) summary.warmCount += 1;
      else summary.missCount += 1;
    }
    if (r.durationMs !== null) {
      totalDurationMs += r.durationMs;
      summary.timedRequests += 1;
    }
    if (r.ttftMs !== null) {
      totalTtftMs += r.ttftMs;
      ttftCount += 1;
    }
    if (r.tps !== null && r.durationMs !== null && r.durationMs > 0) {
      summary.tpsSamples += 1;
      totalTpsOutput += r.output;
      totalTpsDurationMs += r.durationMs;
    }

    const bucketKey = `${r.date}\0${r.model}`;
    let bucket = costBucketMap.get(bucketKey);
    if (!bucket) {
      bucket = {
        date: r.date,
        model: r.model,
        uncached: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        total: 0,
      };
      costBucketMap.set(bucketKey, bucket);
    }
    bucket.uncached += r.uncached;
    bucket.cacheRead += r.cacheRead;
    bucket.cacheWrite += r.cacheWrite;
    bucket.output += r.output;
    bucket.total += r.total;
  }

  summary.cacheHitRate = summary.inputTokens > 0 ? summary.cachedTokens / summary.inputTokens : null;
  summary.avgDurationMs = summary.timedRequests > 0 ? Math.round(totalDurationMs / summary.timedRequests) : null;
  summary.avgTtftMs = ttftCount > 0 ? Math.round(totalTtftMs / ttftCount) : null;
  if (totalTpsDurationMs > 0) {
    summary.avgTps = Math.round((totalTpsOutput / (totalTpsDurationMs / 1000)) * 10) / 10;
  }
  summary.costBuckets = [...costBucketMap.values()];

  const models: UsageRequestLogModelOption[] = [...modelCounts.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([model, requests]) => ({ model, requests }));

  const totalCount = matched.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = Math.max(1, Math.min(totalPages, rawPage));
  const startIdx = (page - 1) * pageSize;
  const pageSlice = matched.slice(startIdx, startIdx + pageSize);

  // 仅为当前页条目补充会话标题与精确到秒的本地时间文本
  const metaByHash = pageSlice.some((r) => r.source === 'local')
    ? await loadConversationMetaByHash(ledger, store)
    : new Map<string, ConversationMetaSnippet>();
  const includeAccountName = resolvedScope === 'all';

  const items: UsageRequestLogItem[] = pageSlice.map((r) => {
    const formatted = formatDateTimeSeconds(r.at, timeZone);
    const convMeta = r.source === 'local' ? metaByHash.get(r.fileHash) : undefined;
    const projectName = r.source === 'remote' ? r.manualProjectName : convMeta?.projectName;
    const conversationTitle = r.source === 'local' ? convMeta?.title : undefined;
    return {
      id: r.id,
      at: r.at,
      date: formatted.date,
      timeText: formatted.timeText,
      accountKey: r.accountKey,
      ...(includeAccountName ? { accountName: r.accountName } : {}),
      model: r.model,
      uncached: r.uncached,
      cacheRead: r.cacheRead,
      cacheWrite: r.cacheWrite,
      inputTokens: r.inputTokens,
      output: r.output,
      total: r.total,
      cacheHitRate: r.cacheHitRate,
      ttftMs: r.ttftMs,
      streamMs: r.streamMs,
      durationMs: r.durationMs,
      tps: r.tps,
      streamTps: r.streamTps,
      source: r.source,
      ...(conversationTitle ? { conversationTitle } : {}),
      ...(projectName ? { projectName } : {}),
      ...(r.note ? { note: r.note } : {}),
      ...(r.partial ? { partial: true } : {}),
    };
  });

  return {
    accountKey: resolvedScope,
    timeZone,
    today,
    from,
    to,
    models,
    page,
    pageSize,
    totalCount,
    totalPages,
    summary,
    items,
    updatedAt: new Date(now).toISOString(),
  };
}
