import { join } from 'node:path';
import type {
  QuotaCycleGroupOption,
  QuotaCycleRecord,
  QuotaCycleSliceBucket,
  QuotaCycleUsageRequest,
  QuotaCycleUsageSnapshot,
  QuotaCycleWindow,
  QuotaGroup,
  UsageBucketCounts,
  UsageRecord,
} from '../../contracts/index.ts';
import {
  buildQuotaWindowSpecs,
  classifyQuotaGroupId,
  quotaRemaining,
  type QuotaWindowGroupInfo,
  type QuotaWindowSpec,
} from '../../shared/quota-forecast.ts';
import { isErrno, mapPool, recordSum, validRow } from './helpers.ts';
import type { UsageLedger } from './summary.ts';
import { dateKey, dateTimeParts } from './timezone.ts';
import { HASH_RE, LEDGER_FILE_RE, MAX_LEDGER_JSON_BYTES, MAX_RECORD_FILE_BYTES, type LedgerDocument } from './types.ts';

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const BOUNDARY_DEDUP_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_STORED_PER_SERIES = 120;
const MAX_INFERRED_WEEKLY_OFFSET = 104;
const MAX_INFERRED_5H_OFFSET = 200;
const CYCLES_FILENAME = 'quota-cycles.json';

interface PersistedQuotaCycle {
  groupId: string;
  groupName: string;
  window: QuotaCycleWindow;
  startAt: number;
  endAt: number;
}

interface QuotaCyclesDocument {
  schema: 1;
  account: string;
  updatedAt: string;
  cycles: PersistedQuotaCycle[];
}

interface QueryCacheEntry {
  revision: number;
  cycleSig: string;
  value: QuotaCycleUsageSnapshot;
}

const recordedSigByLedger = new WeakMap<UsageLedger, Map<string, string>>();
const queryCacheByLedger = new WeakMap<UsageLedger, Map<string, QueryCacheEntry>>();
const hmFormatterCache = new Map<string, Intl.DateTimeFormat>();

function durationForWindow(window: QuotaCycleWindow): number {
  return window === '5h' ? FIVE_HOUR_MS : WEEKLY_MS;
}

function getHmFormatter(zone: string): Intl.DateTimeFormat {
  let dtf = hmFormatterCache.get(zone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    hmFormatterCache.set(zone, dtf);
  }
  return dtf;
}

function dateHmParts(ms: number, zone: string): { date: string; hm: string; hour: number; minute: number } {
  const parts = getHmFormatter(zone).formatToParts(ms);
  let y = '1970';
  let m = '01';
  let d = '01';
  let hh = '00';
  let mm = '00';
  for (const p of parts) {
    if (p.type === 'year') y = p.value;
    else if (p.type === 'month') m = p.value;
    else if (p.type === 'day') d = p.value;
    else if (p.type === 'hour') hh = p.value.padStart(2, '0');
    else if (p.type === 'minute') mm = p.value.padStart(2, '0');
  }
  return {
    date: `${y}-${m}-${d}`,
    hm: `${hh}:${mm}`,
    hour: Number.parseInt(hh, 10) || 0,
    minute: Number.parseInt(mm, 10) || 0,
  };
}

function nextCalendarDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function createEmptyBucket(): UsageBucketCounts {
  return { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, requests: 0 };
}

function validPersistedCycle(item: unknown): item is PersistedQuotaCycle {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const c = item as Record<string, unknown>;
  return (
    typeof c.groupId === 'string' &&
    c.groupId.length > 0 &&
    typeof c.groupName === 'string' &&
    (c.window === 'weekly' || c.window === '5h') &&
    typeof c.startAt === 'number' &&
    Number.isFinite(c.startAt) &&
    typeof c.endAt === 'number' &&
    Number.isFinite(c.endAt) &&
    c.endAt > c.startAt
  );
}

async function readPersistedCycles(ledger: UsageLedger, accountScope: string): Promise<PersistedQuotaCycle[]> {
  if (!HASH_RE.test(accountScope)) return [];
  const file = join(ledger.directory, accountScope, CYCLES_FILENAME);
  try {
    const raw = await ledger.fs.readFile(file, 'utf8');
    if (raw.length > MAX_LEDGER_JSON_BYTES) return [];
    const parsed = JSON.parse(raw) as Partial<QuotaCyclesDocument>;
    if (parsed.schema !== 1 || parsed.account !== accountScope || !Array.isArray(parsed.cycles)) {
      return [];
    }
    return parsed.cycles.filter(validPersistedCycle);
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR') || error instanceof SyntaxError) return [];
    return [];
  }
}

function mergeCycleEntry(list: PersistedQuotaCycle[], incoming: PersistedQuotaCycle): boolean {
  const sameSeries = list.filter((c) => c.groupId === incoming.groupId && c.window === incoming.window);
  const existing = sameSeries.find((c) => Math.abs(c.endAt - incoming.endAt) <= BOUNDARY_DEDUP_TOLERANCE_MS);
  if (existing) {
    if (existing.groupName !== incoming.groupName && incoming.groupName) {
      existing.groupName = incoming.groupName;
      return true;
    }
    return false;
  }
  list.push({ ...incoming });
  // 按 (groupId, window) 裁剪最老条目，控制单文件体积在几 KB 以内
  const grouped = new Map<string, PersistedQuotaCycle[]>();
  for (const item of list) {
    const k = `${item.groupId}:${item.window}`;
    const arr = grouped.get(k) || [];
    arr.push(item);
    grouped.set(k, arr);
  }
  list.length = 0;
  for (const arr of grouped.values()) {
    arr.sort((a, b) => a.endAt - b.endAt);
    const trimmed = arr.length > MAX_STORED_PER_SERIES ? arr.slice(arr.length - MAX_STORED_PER_SERIES) : arr;
    list.push(...trimmed);
  }
  return true;
}

/**
 * 将已锁定的活跃额度周期边界（remaining < 1，resetAt 不再随当前时间滑动）轻量落盘，
 * 使未来翻看历史周期时能够保留每一次真实重置时刻。
 */
export async function recordQuotaCycleBoundaries(
  ledger: UsageLedger,
  accountScope: string | null | undefined,
  groups: ReadonlyArray<QuotaGroup> | null | undefined,
  precomputedSpecs?: ReadonlyArray<QuotaWindowSpec>,
): Promise<boolean> {
  if (!accountScope || !HASH_RE.test(accountScope)) return false;
  const groupList = Array.isArray(groups) ? groups : [];
  const specs = precomputedSpecs ? [...precomputedSpecs] : buildQuotaWindowSpecs(groupList).specs;
  const locked = specs.filter((s) => !s.idle && Number.isFinite(s.startAt) && Number.isFinite(s.endAt) && s.endAt > s.startAt);
  if (!locked.length) return false;

  const nameById = new Map<string, string>();
  for (const g of groupList) {
    if (g && typeof g.id === 'string') nameById.set(g.id, g.name || g.id);
  }

  // 内存签名防抖：已记录过相同分钟级边界时直接跳过磁盘 I/O
  const incomingSig = locked
    .map((s) => `${s.groupId}:${s.window}:${Math.floor(s.endAt / BOUNDARY_DEDUP_TOLERANCE_MS)}:${nameById.get(s.groupId) || s.groupId}`)
    .sort()
    .join('|');
  let sigMap = recordedSigByLedger.get(ledger);
  if (!sigMap) {
    sigMap = new Map();
    recordedSigByLedger.set(ledger, sigMap);
  }
  if (sigMap.get(accountScope) === incomingSig) return false;

  const changed = await ledger.enqueueWrite(async () => {
    const existing = await readPersistedCycles(ledger, accountScope);
    let dirty = false;
    for (const spec of locked) {
      const entry: PersistedQuotaCycle = {
        groupId: spec.groupId,
        groupName: nameById.get(spec.groupId) || spec.groupId,
        window: spec.window,
        startAt: spec.startAt,
        endAt: spec.endAt,
      };
      if (mergeCycleEntry(existing, entry)) dirty = true;
    }
    if (!dirty) return false;
    const dir = join(ledger.directory, accountScope);
    const file = join(dir, CYCLES_FILENAME);
    const doc: QuotaCyclesDocument = {
      schema: 1,
      account: accountScope,
      updatedAt: new Date().toISOString(),
      cycles: existing,
    };
    await ledger._atomicWrite(dir, file, JSON.stringify(doc));
    return true;
  });

  sigMap.set(accountScope, incomingSig);
  if (changed) {
    queryCacheByLedger.get(ledger)?.clear();
  }
  return changed;
}

function buildGroupOptions(
  liveGroups: ReadonlyArray<QuotaGroup>,
  persisted: ReadonlyArray<PersistedQuotaCycle>,
): { options: QuotaCycleGroupOption[]; groupInfos: QuotaWindowGroupInfo[] } {
  const byId = new Map<string, QuotaCycleGroupOption>();
  for (const g of liveGroups) {
    if (!g || typeof g.id !== 'string') continue;
    const weekly = g.windows?.weekly;
    const five = g.windows?.['5h'];
    const weeklyRem = quotaRemaining(weekly);
    const fiveRem = quotaRemaining(five);
    const weeklyReset = weekly?.available === true && typeof weekly.resetAt === 'string' ? weekly.resetAt : null;
    const fiveReset = five?.available === true && typeof five.resetAt === 'string' ? five.resetAt : null;
    byId.set(g.id, {
      id: g.id,
      name: g.name || g.id,
      hasWeekly: Boolean(weeklyReset && Number.isFinite(Date.parse(weeklyReset))),
      has5h: Boolean(fiveReset && Number.isFinite(Date.parse(fiveReset))),
      weeklyResetAt: weeklyReset,
      fiveHourResetAt: fiveReset,
      weeklyRemaining: weeklyRem,
      fiveHourRemaining: fiveRem,
    });
  }
  for (const c of persisted) {
    const cur = byId.get(c.groupId) || {
      id: c.groupId,
      name: c.groupName || c.groupId,
      hasWeekly: false,
      has5h: false,
      weeklyResetAt: null,
      fiveHourResetAt: null,
      weeklyRemaining: null,
      fiveHourRemaining: null,
    };
    if (c.window === 'weekly') cur.hasWeekly = true;
    if (c.window === '5h') cur.has5h = true;
    if (!cur.name && c.groupName) cur.name = c.groupName;
    byId.set(c.groupId, cur);
  }
  const options = [...byId.values()];
  const groupInfos: QuotaWindowGroupInfo[] = options.map((o) => ({ id: o.id, name: o.name }));
  return { options, groupInfos };
}

function pickSelectedGroup(
  options: ReadonlyArray<QuotaCycleGroupOption>,
  requestedGroupId: string | null | undefined,
  window: QuotaCycleWindow,
): QuotaCycleGroupOption | null {
  if (!options.length) return null;
  if (requestedGroupId) {
    const exact = options.find((o) => o.id === requestedGroupId);
    if (exact) return exact;
  }
  const hasTarget = (o: QuotaCycleGroupOption) => (window === 'weekly' ? o.hasWeekly : o.has5h);
  const isActiveUsed = (o: QuotaCycleGroupOption) => {
    const rem = window === 'weekly' ? o.weeklyRemaining : o.fiveHourRemaining;
    return typeof rem === 'number' && rem < 0.9995;
  };
  return (
    options.find((o) => hasTarget(o) && isActiveUsed(o)) ||
    options.find((o) => hasTarget(o)) ||
    options[0]
  );
}

function resolveTargetCycle(
  group: QuotaCycleGroupOption,
  liveGroups: ReadonlyArray<QuotaGroup>,
  persisted: ReadonlyArray<PersistedQuotaCycle>,
  window: QuotaCycleWindow,
  offset: number,
): QuotaCycleRecord | null {
  const durationMs = durationForWindow(window);
  const timeline: QuotaCycleRecord[] = [];

  // 索引 0：优先取实时活跃窗口
  const liveGroup = liveGroups.find((g) => g.id === group.id);
  const liveBucket = liveGroup?.windows?.[window];
  const liveResetMs =
    liveBucket && liveBucket.available === true && typeof liveBucket.resetAt === 'string'
      ? Date.parse(liveBucket.resetAt)
      : NaN;
  if (Number.isFinite(liveResetMs)) {
    const rem = quotaRemaining(liveBucket);
    timeline.push({
      groupId: group.id,
      groupName: group.name,
      window,
      startAt: liveResetMs - durationMs,
      endAt: liveResetMs,
      source: 'live',
      remaining: rem,
      idle: rem !== null && rem >= 0.9995,
    });
  }

  // 后续索引：按 endAt 降序拼接本地已记录的精确历史周期（排除与当期重复者）
  const recorded = persisted
    .filter((c) => c.groupId === group.id && c.window === window)
    .sort((a, b) => b.endAt - a.endAt);
  for (const item of recorded) {
    const latest = timeline[timeline.length - 1];
    if (latest && Math.abs(latest.endAt - item.endAt) <= BOUNDARY_DEDUP_TOLERANCE_MS) {
      continue;
    }
    if (latest && item.endAt >= latest.endAt) {
      continue;
    }
    timeline.push({
      groupId: group.id,
      groupName: item.groupName || group.name,
      window,
      startAt: item.startAt,
      endAt: item.endAt,
      source: 'recorded',
    });
  }

  if (!timeline.length) return null;

  const backSteps = Math.max(0, Math.trunc(-offset));
  if (backSteps < timeline.length) {
    return timeline[backSteps];
  }

  // 超出已记录历史条数时，从最老一条已知周期按固定周期时长往前推算
  const oldest = timeline[timeline.length - 1];
  const extraSteps = backSteps - (timeline.length - 1);
  const endAt = oldest.endAt - extraSteps * durationMs;
  const startAt = endAt - durationMs;
  return {
    groupId: group.id,
    groupName: group.name,
    window,
    startAt,
    endAt,
    source: 'inferred',
  };
}

function buildWeeklySlices(
  cycle: QuotaCycleRecord,
  records: ReadonlyArray<UsageRecord>,
  timeZone: string,
): { slices: QuotaCycleSliceBucket[]; hours: number[]; totalTokens: number; requests: number } {
  const startParts = dateHmParts(cycle.startAt, timeZone);
  const endParts = dateHmParts(Math.max(cycle.startAt, cycle.endAt - 1), timeZone);
  const exactEndParts = dateHmParts(cycle.endAt, timeZone);

  const sliceList: QuotaCycleSliceBucket[] = [];
  const byDate = new Map<string, QuotaCycleSliceBucket>();
  let cur = startParts.date;
  for (let guard = 0; guard < 12; guard++) {
    const isFirst = cur === startParts.date;
    const isLast = cur === endParts.date;
    let rangeLabel = cur;
    if (isFirst && isLast) {
      rangeLabel = `${cur} (${startParts.hm} – ${exactEndParts.hm})`;
    } else if (isFirst && startParts.hm !== '00:00') {
      rangeLabel = `${cur} (${startParts.hm}–24:00)`;
    } else if (isLast && exactEndParts.hm !== '00:00') {
      rangeLabel = `${cur} (00:00–${exactEndParts.hm})`;
    }
    const slice: QuotaCycleSliceBucket = {
      key: cur,
      date: cur,
      label: cur.slice(5),
      rangeLabel,
      startAt: isFirst ? cycle.startAt : 0,
      endAt: isLast ? cycle.endAt : 0,
      models: {},
    };
    sliceList.push(slice);
    byDate.set(cur, slice);
    if (cur >= endParts.date) break;
    cur = nextCalendarDate(cur);
  }

  const hours = Array<number>(24).fill(0);
  let totalTokens = 0;
  let requests = 0;

  for (const r of records) {
    if (typeof r.at !== 'number' || !Number.isFinite(r.at)) continue;
    const clampedAt = r.at === cycle.endAt ? Math.max(cycle.startAt, cycle.endAt - 1) : r.at;
    const parts = dateTimeParts(clampedAt, timeZone);
    const slice = byDate.get(parts.date) || sliceList[sliceList.length - 1];
    if (!slice) continue;
    const uncached = r.uncached || 0;
    const cacheRead = r.cacheRead || 0;
    const cacheWrite = r.cacheWrite || 0;
    const output = r.output || 0;
    const sum = uncached + cacheRead + cacheWrite + output;
    const bucket = (slice.models[r.model] ??= createEmptyBucket());
    bucket.uncached += uncached;
    bucket.cacheRead += cacheRead;
    bucket.cacheWrite += cacheWrite;
    bucket.output += output;
    bucket.total += sum;
    bucket.requests += 1;
    totalTokens += sum;
    requests += 1;
    if (parts.hour >= 0 && parts.hour < 24) hours[parts.hour] += sum;
  }

  return { slices: sliceList, hours, totalTokens, requests };
}

function buildFiveHourSlices(
  cycle: QuotaCycleRecord,
  records: ReadonlyArray<UsageRecord>,
  timeZone: string,
): { slices: QuotaCycleSliceBucket[]; hours: number[]; totalTokens: number; requests: number } {
  const sliceList: QuotaCycleSliceBucket[] = [];
  const hourMs = 60 * 60 * 1000;
  let cursor = cycle.startAt;
  let prevDate = '';
  for (let guard = 0; guard < 8 && cursor < cycle.endAt; guard++) {
    const nextHourBoundary = Math.floor(cursor / hourMs + 1) * hourMs;
    const sliceEnd = Math.min(cycle.endAt, nextHourBoundary);
    const sParts = dateHmParts(cursor, timeZone);
    const eParts = dateHmParts(sliceEnd, timeZone);
    const crossDay = prevDate !== '' && prevDate !== sParts.date;
    prevDate = sParts.date;
    const label = crossDay ? `${sParts.date.slice(5)} ${sParts.hm}` : sParts.hm;
    const endHmDisplay = eParts.date !== sParts.date && eParts.hm === '00:00' ? '24:00' : eParts.hm;
    const rangeLabel = `${sParts.date} ${sParts.hm} – ${endHmDisplay}`;
    sliceList.push({
      key: `${sParts.date}T${sParts.hm}`,
      date: sParts.date,
      label,
      rangeLabel,
      startAt: cursor,
      endAt: sliceEnd,
      models: {},
    });
    cursor = sliceEnd;
  }

  const hours = Array<number>(24).fill(0);
  let totalTokens = 0;
  let requests = 0;

  for (const r of records) {
    if (typeof r.at !== 'number' || !Number.isFinite(r.at)) continue;
    let slice = sliceList[sliceList.length - 1];
    for (let i = 0; i < sliceList.length; i++) {
      const cand = sliceList[i];
      const isLast = i === sliceList.length - 1;
      if (r.at >= cand.startAt && (isLast ? r.at <= cand.endAt : r.at < cand.endAt)) {
        slice = cand;
        break;
      }
    }
    if (!slice) continue;
    const uncached = r.uncached || 0;
    const cacheRead = r.cacheRead || 0;
    const cacheWrite = r.cacheWrite || 0;
    const output = r.output || 0;
    const sum = uncached + cacheRead + cacheWrite + output;
    const bucket = (slice.models[r.model] ??= createEmptyBucket());
    bucket.uncached += uncached;
    bucket.cacheRead += cacheRead;
    bucket.cacheWrite += cacheWrite;
    bucket.output += output;
    bucket.total += sum;
    bucket.requests += 1;
    totalTokens += sum;
    requests += 1;
    const parts = dateTimeParts(r.at === cycle.endAt ? Math.max(cycle.startAt, cycle.endAt - 1) : r.at, timeZone);
    if (parts.hour >= 0 && parts.hour < 24) hours[parts.hour] += sum;
  }

  return { slices: sliceList, hours, totalTokens, requests };
}

export interface QueryQuotaCycleUsageOptions {
  ledger: UsageLedger;
  liveGroups?: ReadonlyArray<QuotaGroup> | null;
  activeScope?: string | null;
  input?: QuotaCycleUsageRequest | null;
}

/**
 * 按指定额度分组与重置周期（weekly / 5h）从本机请求级账本中精确聚合用量，
 * 返回各时间切片的四项细分 Token、24 小时分布与可翻页边界状态。
 */
export async function queryQuotaCycleUsage(options: QueryQuotaCycleUsageOptions): Promise<QuotaCycleUsageSnapshot> {
  const { ledger, liveGroups = [], activeScope = null, input = {} } = options;
  const requestedScope = typeof input?.scope === 'string' && input.scope.trim() ? input.scope.trim() : null;
  const window: QuotaCycleWindow = input?.window === '5h' ? '5h' : 'weekly';
  const maxBack = window === '5h' ? MAX_INFERRED_5H_OFFSET : MAX_INFERRED_WEEKLY_OFFSET;
  const rawOffset = typeof input?.offset === 'number' && Number.isFinite(input.offset) ? Math.trunc(input.offset) : 0;
  const offset = Math.max(-maxBack, Math.min(0, rawOffset));
  const timeZone = ledger.timeZone || 'Asia/Shanghai';

  // 汇总视角下默认取当前活跃单账号，因为不同账号的额度重置周期彼此独立
  const resolvedScope =
    requestedScope && HASH_RE.test(requestedScope)
      ? requestedScope
      : activeScope && HASH_RE.test(activeScope)
        ? activeScope
        : ledger.scope && HASH_RE.test(ledger.scope)
          ? ledger.scope
          : null;

  const emptySnapshot = (accountKey: string): QuotaCycleUsageSnapshot => ({
    accountKey,
    requestedScope,
    timeZone,
    groups: [],
    selectedGroupId: null,
    selectedGroupName: '',
    window,
    offset,
    hasOlder: false,
    cycle: null,
    slices: [],
    hours: Array<number>(24).fill(0),
    totalTokens: 0,
    requests: 0,
    updatedAt: new Date().toISOString(),
  });

  if (!resolvedScope) return emptySnapshot('');

  // 仅当目标账号就是当前在线活跃账号时，才关联实时额度重置时间，避免张冠李戴
  const canUseLive = !activeScope || !HASH_RE.test(activeScope) || resolvedScope === activeScope;
  const scopedLiveGroups = canUseLive && Array.isArray(liveGroups) ? liveGroups : [];
  const persisted = await readPersistedCycles(ledger, resolvedScope);

  const { options: groupOptions, groupInfos } = buildGroupOptions(scopedLiveGroups, persisted);
  const selectedGroup = pickSelectedGroup(groupOptions, input?.groupId ?? null, window);
  if (!selectedGroup) {
    return emptySnapshot(resolvedScope);
  }

  const cycle = resolveTargetCycle(selectedGroup, scopedLiveGroups, persisted, window, offset);
  if (!cycle) {
    return {
      ...emptySnapshot(resolvedScope),
      groups: groupOptions,
      selectedGroupId: selectedGroup.id,
      selectedGroupName: selectedGroup.name,
    };
  }

  const cycleSig = [
    resolvedScope,
    requestedScope || '',
    selectedGroup.id,
    window,
    offset,
    cycle.startAt,
    cycle.endAt,
    cycle.source,
    cycle.remaining ?? '',
    groupOptions.map((g) => `${g.id}:${g.weeklyResetAt || ''}:${g.fiveHourResetAt || ''}:${g.weeklyRemaining ?? ''}:${g.fiveHourRemaining ?? ''}`).join(','),
  ].join('|');

  let ledgerCache = queryCacheByLedger.get(ledger);
  if (!ledgerCache) {
    ledgerCache = new Map();
    queryCacheByLedger.set(ledger, ledgerCache);
  }
  const cacheSlotKey = `${resolvedScope}:${selectedGroup.id}:${window}:${offset}`;
  const cached = ledgerCache.get(cacheSlotKey);
  if (cached && cached.revision === ledger.revision && cached.cycleSig === cycleSig) {
    return cached.value;
  }

  const startRevision = ledger.revision;
  const scopeDir = join(ledger.directory, resolvedScope);
  let files: string[] = [];
  try {
    files = (await ledger.fs.readdir(scopeDir)) as string[];
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) files = [];
  }
  const validFiles = files.filter((name) => LEDGER_FILE_RE.test(name));

  // 请求级去重，与主账本和 quota-windows 口径完全一致
  const dedup = new Map<string, { row: UsageRecord; sum: number }>();
  let hasOlderData = false;

  await mapPool(validFiles, 16, async (name) => {
    const fullPath = join(scopeDir, name);
    let doc: LedgerDocument | null = null;
    try {
      const st = await ledger.fs.stat(fullPath);
      if (!st) return;
      const mtimeMs = Number(st.mtimeMs ?? 0);
      if (Number.isFinite(mtimeMs) && mtimeMs > 0 && mtimeMs < cycle.startAt - 120000) {
        hasOlderData = true;
        return;
      }
      if (Number(st.size) > MAX_RECORD_FILE_BYTES) return;
      const text = await ledger.fs.readFile(fullPath, 'utf8');
      if (text.length > MAX_RECORD_FILE_BYTES) return;
      const parsed = JSON.parse(text) as LedgerDocument;
      if (
        parsed.schema !== 1 ||
        parsed.account !== resolvedScope ||
        !Array.isArray(parsed.records) ||
        !parsed.records.every(validRow)
      ) {
        return;
      }
      doc = parsed;
    } catch {
      return;
    }
    if (!doc) return;
    for (const r of doc.records) {
      if (typeof r.at !== 'number' || !Number.isFinite(r.at)) continue;
      if (r.at < cycle.startAt) {
        hasOlderData = true;
        continue;
      }
      if (r.at > cycle.endAt) continue;
      const sum = recordSum(r);
      const prev = dedup.get(r.id);
      if (!prev || sum > prev.sum) {
        dedup.set(r.id, { row: r, sum });
      }
    }
  });

  // 按额度池过滤归属模型
  const matchedRecords: UsageRecord[] = [];
  for (const { row } of dedup.values()) {
    const gid = classifyQuotaGroupId(groupInfos, row.model);
    if (gid === selectedGroup.id) matchedRecords.push(row);
  }

  const aggregated =
    window === '5h'
      ? buildFiveHourSlices(cycle, matchedRecords, timeZone)
      : buildWeeklySlices(cycle, matchedRecords, timeZone);

  const hasOlder = offset > -maxBack && hasOlderData;

  const result: QuotaCycleUsageSnapshot = {
    accountKey: resolvedScope,
    requestedScope,
    timeZone,
    groups: groupOptions,
    selectedGroupId: selectedGroup.id,
    selectedGroupName: selectedGroup.name,
    window,
    offset,
    hasOlder,
    cycle,
    slices: aggregated.slices,
    hours: aggregated.hours,
    totalTokens: aggregated.totalTokens,
    requests: aggregated.requests,
    updatedAt: new Date().toISOString(),
  };

  if (ledger.revision === startRevision) {
    if (ledgerCache.size > 24) ledgerCache.clear();
    ledgerCache.set(cacheSlotKey, { revision: startRevision, cycleSig, value: result });
  }
  return result;
}
