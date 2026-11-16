import type {
  ManualUsageRecord,
  UsageBucketCounts,
  UsageDayBucket,
  UsageRecord,
  UsageSummarySnapshot,
  UsageUserBucket,
  UsageUserMeta,
} from '../../contracts/usage.ts';
import { recordSum } from './helpers.ts';
import { dateTimeParts, weekStart } from './timezone.ts';
import { HASH_RE, RECORD_KEYS, type KnownAccountInfo, type LedgerDocument } from './types.ts';

export interface ParsedLedgerFile {
  scope: string;
  name: string;
  record: LedgerDocument;
}

interface AttributedRecord extends UsageRecord {
  userKey: string;
  userName: string;
  account: string;
}

export interface BuildSummaryParams {
  scope: string;
  now: number;
  today: string;
  timeZone: string;
  source: string;
  meta: Record<string, KnownAccountInfo>;
  knownAccounts: Record<string, KnownAccountInfo>;
  ownership: Record<string, string>;
  recordScopes: Map<string, string[]>;
  parsedFiles: ParsedLedgerFile[];
  unreadable: number;
  resolveFile: (scope: string, convId: string) => string;
}

export function buildSummarySnapshot(params: BuildSummaryParams): UsageSummarySnapshot {
  const { scope, now, today, timeZone, source, meta, knownAccounts, ownership, recordScopes, parsedFiles, unreadable, resolveFile } = params;
  const getAccountName = (s: string): string => {
    const m = meta[s] || knownAccounts[s];
    return m?.email || m?.name || `Account (${s.slice(0, 8)})`;
  };
  const knownKeys = Object.keys(knownAccounts);
  const primaryRank = (s: string): number => {
    const m = meta[s];
    const k = knownAccounts[s];
    if (m?.primary === true || k?.primary === true) return 0;
    if (m?.primary === false || k?.primary === false || m?.secondary === true || k?.secondary === true) return 2;
    if (k && knownKeys.indexOf(s) > 0) return 2;
    return 1;
  };
  const pickPrimary = (scopesList: string[]): string | null => {
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

  const ownerByName = new Map<string, string>();
  for (const [convId, ownerScope] of Object.entries(ownership || {})) {
    if (HASH_RE.test(ownerScope)) {
      const fileName = resolveFile(ownerScope, convId).split(/[\\/]/).pop();
      if (fileName) ownerByName.set(fileName, ownerScope);
    }
  }

  const daily = new Map<string, UsageDayBucket>();
  const models = new Set<string>();
  const userKeys = new Set<string>();
  const seen = new Map<string, AttributedRecord>();
  const manualEntries: ManualUsageRecord[] = [];
  let unknownTokens = 0;
  let unknownRequests = 0;
  let partialRequests = 0;
  let legacyTokens = 0;

  for (const { scope: s, name, record } of parsedFiles) {
    if (record.metadata?.source === 'remote-manual') {
      manualEntries.push({
        id: record.id || '',
        hash: name.replace(/\.json$/, ''),
        account: s,
        timestamp: record.metadata.timestamp ?? 0,
        source: record.metadata.source,
        model: record.metadata.model ?? 'manual-model',
        tokens: record.metadata.tokens ?? { prompt: 0, candidates: 0, total: 0 },
        projectName: record.metadata.projectName ?? '',
        note: record.metadata.note ?? '',
      });
    }
    const explicitOwner = ownerByName.get(name);
    const fileMarkedLegacy = record.metadata?.isLegacy === true || record.isLegacy === true;
    for (const r of record.records) {
      const scopesForRecord = recordScopes.get(r.id) || [s];
      const isDuplicate = scopesForRecord.length > 1;
      const resolvedOwner = explicitOwner && scopesForRecord.includes(explicitOwner) ? explicitOwner : null;
      if (scope !== 'all') {
        if (resolvedOwner) {
          if (resolvedOwner !== s) continue;
        } else if (isDuplicate && pickPrimary(scopesForRecord) !== s) {
          continue;
        }
      }
      const effectiveOwner = resolvedOwner || (isDuplicate ? null : s);
      const isLegacy = (!effectiveOwner && isDuplicate) || (!resolvedOwner && fileMarkedLegacy);
      const userKey = scope === 'all' && isLegacy ? 'legacy' : effectiveOwner || s;
      const userName = userKey === 'legacy' ? '早期历史未区分用量' : getAccountName(userKey);
      const previous = seen.get(r.id);
      if (!previous || recordSum(r) > recordSum(previous)) {
        seen.set(r.id, { ...r, isLegacy: isLegacy || r.isLegacy === true, userKey, userName, account: userKey === 'legacy' ? s : userKey });
      } else if (previous && recordSum(r) === recordSum(previous) && effectiveOwner === s && previous.isLegacy) {
        seen.set(r.id, { ...r, isLegacy: false, userKey: s, userName: getAccountName(s), account: s });
      }
    }
  }

  for (const r of seen.values()) {
    models.add(r.model);
    userKeys.add(r.userKey);
    const tokenSum = recordSum(r);
    if (r.isLegacy) legacyTokens += tokenSum;
    if (r.partial) partialRequests++;
    if (r.at === null) {
      unknownTokens += tokenSum;
      unknownRequests++;
      continue;
    }
    const { date, hour } = dateTimeParts(r.at, timeZone);
    let day = daily.get(date);
    if (!day) {
      day = { date, models: {}, users: {}, hours: Array<number>(24).fill(0), legacyTokens: 0 };
      daily.set(date, day);
    }
    if (hour >= 0 && hour < 24) day.hours[hour] += tokenSum;
    if (r.isLegacy) day.legacyTokens += tokenSum;

    const bucket: UsageBucketCounts = (day.models[r.model] ||= { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, requests: 0 });
    for (const key of RECORD_KEYS) bucket[key] += r[key] ?? 0;
    bucket.total += tokenSum;
    bucket.requests++;

    const uBucket: UsageUserBucket = (day.users[r.userKey] ||= { name: r.userName, userKey: r.userKey, isLegacy: !!r.isLegacy, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, requests: 0 });
    for (const key of RECORD_KEYS) uBucket[key] += r[key] ?? 0;
    uBucket.total += tokenSum;
    uBucket.requests++;
  }

  const days = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  const dayTotal = (day: UsageDayBucket): number => Object.values(day.models).reduce((n, r) => n + r.total, 0);
  const todayDay = daily.get(today);
  const todayHours = todayDay ? [...todayDay.hours] : Array<number>(24).fill(0);
  const usersSummary: Record<string, UsageUserBucket> = {};
  for (const day of days) {
    for (const [uKey, uData] of Object.entries(day.users)) {
      const target = (usersSummary[uKey] ||= { name: uData.name, userKey: uKey, isLegacy: uData.isLegacy, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, requests: 0 });
      for (const key of RECORD_KEYS) target[key] += uData[key] ?? 0;
      target.total += uData.total;
      target.requests += uData.requests;
    }
  }
  const userMeta: Record<string, UsageUserMeta> = Object.fromEntries(
    [...userKeys].map((k) => [
      k,
      {
        name: k === 'legacy' ? '早期历史未区分用量' : getAccountName(k),
        email: k === 'legacy' ? '早期历史未区分用量' : meta[k]?.email || knownAccounts[k]?.email || getAccountName(k),
        isLegacy: k === 'legacy',
      },
    ]),
  );

  return {
    accountKey: scope,
    viewScope: scope,
    timeZone,
    today,
    todayHours,
    days,
    models: [...models].sort(),
    users: [...userKeys],
    userMeta,
    usersSummary,
    legacyTokens,
    todayTokens: days.filter((d) => d.date === today).reduce((n, d) => n + dayTotal(d), 0),
    weekTokens: days.filter((d) => d.date >= weekStart(today) && d.date <= today).reduce((n, d) => n + dayTotal(d), 0),
    monthTokens: days.filter((d) => d.date.slice(0, 7) === today.slice(0, 7) && d.date <= today).reduce((n, d) => n + dayTotal(d), 0),
    totalTokens: days.reduce((n, d) => n + dayTotal(d), 0) + unknownTokens,
    unknownTokens,
    unknownRequests,
    partialRequests,
    unreadableFiles: unreadable,
    manualEntries: manualEntries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)),
    requests: seen.size,
    firstDate: days[0]?.date || null,
    updatedAt: new Date(now).toISOString(),
    source,
  };
}
