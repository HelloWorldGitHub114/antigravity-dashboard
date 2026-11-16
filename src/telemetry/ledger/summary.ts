import { join } from 'node:path';
import type { ManualUsageInput, ManualUsageRecord, UsageSummarySnapshot } from '../../contracts/usage.ts';
import {
  isNativeAccelAvailable,
  queryUsageLedgerSummary,
  type LedgerTzTransition,
} from '../../platform/native-bridge.ts';
import { formatStatStamp, type FileStatLike } from '../../shared/atomic-fs.ts';
import {
  getAccountsHelper,
  inspectOtherAccountsHelper,
  loadAccountsMetaHelper,
  loadOwnershipHelper,
  otherScopeFilesHelper,
  registerAccountHelper,
  registerOwnershipHelper,
  writeAccountsMetaHelper,
  writeOwnershipHelper,
} from './accounts.ts';
import { buildSummarySnapshot, type ParsedLedgerFile } from './aggregator.ts';
import { usageRecords } from './extractor.ts';
import { isErrno, mapPool, uniqueRecordIds, validRow } from './helpers.ts';
import { addManualUsageHelper, deleteManualUsageHelper, listManualUsageHelper } from './manual.ts';
import { LedgerStorage } from './storage.ts';
import { dateKey } from './timezone.ts';
import {
  HASH_RE,
  LEDGER_FILE_RE,
  MAX_RECORD_FILE_BYTES,
  type FileIndexEntry,
  type KnownAccountInfo,
  type LedgerDocument,
  type OtherAccountsInspection,
  type UsageAccountsResult,
} from './types.ts';

interface TimeZoneSpec {
  fixedOffsetSecs: number | null;
  tzMinMs: number | null;
  tzMaxMs: number | null;
  tzTransitions: LedgerTzTransition[] | null;
}

const UTC_ZONES = new Set(['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT']);
const UTC8_MODERN_ZONES = new Set([
  'Asia/Shanghai',
  'Asia/Chongqing',
  'Asia/Harbin',
  'Asia/Taipei',
  'Asia/Hong_Kong',
  'Asia/Singapore',
]);
const UTC9_MODERN_ZONES = new Set(['Asia/Tokyo', 'Asia/Seoul']);
const MODERN_FIXED_MIN_MS = Date.UTC(1992, 0, 1);
const tzTransitionCache = new Map<string, TimeZoneSpec>();

function resolveTimeZoneSpec(zone: string, nowMs: number): TimeZoneSpec {
  if (UTC_ZONES.has(zone)) {
    return { fixedOffsetSecs: 0, tzMinMs: null, tzMaxMs: null, tzTransitions: null };
  }
  if (UTC8_MODERN_ZONES.has(zone)) {
    return { fixedOffsetSecs: 28800, tzMinMs: MODERN_FIXED_MIN_MS, tzMaxMs: null, tzTransitions: null };
  }
  if (UTC9_MODERN_ZONES.has(zone)) {
    return { fixedOffsetSecs: 32400, tzMinMs: MODERN_FIXED_MIN_MS, tzMaxMs: null, tzTransitions: null };
  }
  const nowYear = new Date(nowMs).getUTCFullYear();
  const minYear = Math.min(2020, nowYear - 2);
  const maxYear = Math.max(2031, nowYear + 2);
  const cacheKey = `${zone}:${minYear}:${maxYear}`;
  const cached = tzTransitionCache.get(cacheKey);
  if (cached) return cached;

  const minMs = Date.UTC(minYear, 0, 1);
  const maxMs = Date.UTC(maxYear, 0, 1);
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const offsetAt = (ms: number): number => {
    const parts = dtf.formatToParts(ms);
    let y = 1970;
    let m = 1;
    let d = 1;
    let h = 0;
    let min = 0;
    let s = 0;
    for (const p of parts) {
      if (p.type === 'year') y = Number.parseInt(p.value, 10);
      else if (p.type === 'month') m = Number.parseInt(p.value, 10);
      else if (p.type === 'day') d = Number.parseInt(p.value, 10);
      else if (p.type === 'hour') h = Number.parseInt(p.value, 10);
      else if (p.type === 'minute') min = Number.parseInt(p.value, 10);
      else if (p.type === 'second') s = Number.parseInt(p.value, 10);
    }
    const localSec = Math.floor(Date.UTC(y, m - 1, d, h, min, s) / 1000);
    const utcSec = Math.floor(ms / 1000);
    return localSec - utcSec;
  };

  const stepMs = 7 * 86400 * 1000;
  let curMs = minMs;
  let curOff = offsetAt(curMs);
  const transitions: LedgerTzTransition[] = [{ atMs: minMs, offsetSecs: curOff }];
  while (curMs < maxMs) {
    const nextMs = Math.min(maxMs, curMs + stepMs);
    const nextOff = offsetAt(nextMs);
    if (nextOff !== curOff) {
      let loSec = Math.floor(curMs / 1000);
      let hiSec = Math.floor(nextMs / 1000);
      while (loSec + 1 < hiSec) {
        const midSec = Math.floor((loSec + hiSec) / 2);
        if (offsetAt(midSec * 1000) === curOff) loSec = midSec;
        else hiSec = midSec;
      }
      curOff = nextOff;
      transitions.push({ atMs: hiSec * 1000, offsetSecs: curOff });
    }
    curMs = nextMs;
  }

  const spec: TimeZoneSpec = {
    fixedOffsetSecs: null,
    tzMinMs: minMs,
    tzMaxMs: maxMs,
    tzTransitions: transitions,
  };
  tzTransitionCache.set(cacheKey, spec);
  return spec;
}

export class UsageLedger extends LedgerStorage {
  _loadAccountsMeta(): Promise<{ stamp: string; value: Record<string, KnownAccountInfo> }> { return loadAccountsMetaHelper(this); }
  accountsMeta(): Promise<Record<string, KnownAccountInfo>> { return loadAccountsMetaHelper(this).then((r) => r.value); }
  _writeAccountsMeta(entries: Record<string, KnownAccountInfo>): Promise<void> { return writeAccountsMetaHelper(this, entries); }
  saveAccountsMeta(entries: Record<string, KnownAccountInfo>): Promise<void> { return this.enqueueWrite(() => writeAccountsMetaHelper(this, entries)); }
  registerAccount(scope: string, meta: KnownAccountInfo = {}): Promise<void> { return registerAccountHelper(this, scope, meta); }
  _loadOwnership(): Promise<{ stamp: string; value: Record<string, string> }> { return loadOwnershipHelper(this); }
  ownership(): Promise<Record<string, string>> { return loadOwnershipHelper(this).then((r) => r.value); }
  _writeOwnership(entries: Record<string, string>): Promise<void> { return writeOwnershipHelper(this, entries); }
  saveOwnership(entries: Record<string, string>): Promise<void> { return this.enqueueWrite(() => writeOwnershipHelper(this, entries)); }
  registerOwnership(id: string, scope: string, opts: { overwrite?: boolean } = {}): Promise<boolean> { return registerOwnershipHelper(this, id, scope, opts); }
  otherScopeFiles(scope: string): Promise<{ ownFiles: Set<string>; otherFiles: Map<string, string[]> }> { return otherScopeFilesHelper(this, scope); }
  inspectOtherAccounts(scope: string, id: string): Promise<OtherAccountsInspection> { return inspectOtherAccountsHelper(this, scope, id); }
  addManualUsage(scope: string, data: ManualUsageInput = {}): Promise<ManualUsageRecord> { return addManualUsageHelper(this, scope, data); }
  deleteManualUsage(scope: string, id: string): Promise<boolean> { return deleteManualUsageHelper(this, scope, id); }
  listManualUsage(scope: string): Promise<ManualUsageRecord[]> { return listManualUsageHelper(this, scope); }

  async getAccounts(activeScope: string | null = null): Promise<UsageAccountsResult> {
    const meta = await this.accountsMeta();
    return getAccountsHelper(this, meta, activeScope);
  }

  ingest(scope: string, id: string, raw: unknown): Promise<void> {
    if (!scope) return Promise.resolve();
    return this.ingestRows(scope, id, usageRecords(raw, id));
  }

  async summary(scope: string, now: number = Date.now()): Promise<UsageSummarySnapshot | null> {
    if (!scope || (!HASH_RE.test(scope) && scope !== 'all')) return null;
    const startRevision = this.revision;
    const today = dateKey(now, this.timeZone);
    if (!this.hasCustomFs && isNativeAccelAvailable()) {
      const dirtySnapshot = [...this.dirtyRelPaths];
      const tzSpec = resolveTimeZoneSpec(this.timeZone, now);
      const nativeSummary = queryUsageLedgerSummary<UsageSummarySnapshot>({
        directory: this.directory,
        scope,
        nowMs: now,
        today,
        timeZone: this.timeZone,
        source: this.source,
        knownAccounts: this.knownAccounts,
        fallbackScope: this.scope ?? null,
        ...tzSpec,
        dirtyRelPaths: dirtySnapshot,
      });
      if (nativeSummary) {
        const prefix = scope === 'all' ? null : `${scope}/`;
        for (const rel of dirtySnapshot) {
          if (prefix === null || rel.startsWith(prefix)) {
            this.dirtyRelPaths.delete(rel);
          }
        }
        return nativeSummary;
      }
    }
    const cacheKey = `${scope}:${this.timeZone}:${today}`;
    const [{ stamp: metaStamp, value: meta }, { stamp: ownershipStamp, value: ownership }, allScopes] = await Promise.all([
      this._loadAccountsMeta(),
      this._loadOwnership(),
      this.scopeDirectories(),
    ]);
    const targetScopes = scope === 'all' ? (allScopes.length ? allScopes : this.scope ? [this.scope] : []) : [scope];
    const targetSet = new Set(targetScopes);
    const scanScopes = allScopes.length > 1 ? [...new Set([...allScopes, ...targetScopes])] : targetScopes;

    let anyFileChanged = false;
    let hadTransientError = false;
    const allScopeSet = new Set(allScopes);
    for (const cachedScope of [...this.fileIndex.keys()]) {
      if (!allScopeSet.has(cachedScope) && !targetSet.has(cachedScope)) {
        this.fileIndex.delete(cachedScope);
        anyFileChanged = true;
      }
    }

    const recordScopes = new Map<string, string[]>();
    const parsedFiles: ParsedLedgerFile[] = [];
    let unreadable = 0;

    for (const s of scanScopes) {
      let files: string[] = [];
      try {
        files = (await this.fs.readdir(join(this.directory, s))) as string[];
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
      const validFiles = files.filter((name) => LEDGER_FILE_RE.test(name)).sort();
      const validSet = new Set(validFiles);
      let scopeMap = this.fileIndex.get(s);
      if (!scopeMap) {
        scopeMap = new Map<string, FileIndexEntry>();
        this.fileIndex.set(s, scopeMap);
      }
      for (const oldName of [...scopeMap.keys()]) {
        if (!validSet.has(oldName)) {
          scopeMap.delete(oldName);
          anyFileChanged = true;
        }
      }
      const slots = await mapPool(validFiles, 16, async (name) => {
        const fullPath = join(this.directory, s, name);
        const key = `${s}/${name}`;
        const verBefore = this.keyVersions.get(key) || 0;
        let st: FileStatLike | null;
        try {
          st = await this._stat(fullPath);
        } catch {
          anyFileChanged = true;
          hadTransientError = true;
          return { name, transientUnreadable: true as const };
        }
        const stamp = formatStatStamp(st);
        if (!st || !stamp) {
          if (scopeMap.delete(name)) anyFileChanged = true;
          return null;
        }
        const cached = scopeMap.get(name);
        if (cached && cached.stamp === stamp) return { name, entry: cached };
        anyFileChanged = true;
        let entry: FileIndexEntry | null = null;
        let transientUnreadable = false;
        try {
          if (Number(st.size) > MAX_RECORD_FILE_BYTES) throw Error('Ledger too large');
          const text = await this.fs.readFile(fullPath, 'utf8');
          if (text.length > MAX_RECORD_FILE_BYTES) throw Error('Ledger too large');
          const record = JSON.parse(text) as LedgerDocument;
          if (record.schema !== 1 || record.account !== s || !Array.isArray(record.records) || !record.records.every(validRow)) {
            throw Error('Invalid ledger');
          }
          entry = { stamp, unreadable: false, record, recordIds: uniqueRecordIds(record.records) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : '';
          const deterministic = error instanceof SyntaxError || msg === 'Ledger too large' || msg === 'Invalid ledger';
          if (deterministic) entry = { stamp, unreadable: true, record: null, recordIds: null };
          else {
            transientUnreadable = true;
            hadTransientError = true;
          }
        }
        if (entry && (this.keyVersions.get(key) || 0) === verBefore) scopeMap.set(name, entry);
        return transientUnreadable ? { name, transientUnreadable: true as const } : { name, entry };
      });
      for (const item of slots) {
        if (!item) continue;
        if ('transientUnreadable' in item || item.entry?.unreadable || !item.entry?.record || !item.entry.recordIds) {
          if (targetSet.has(s)) unreadable++;
          continue;
        }
        for (const rid of item.entry.recordIds) {
          let list = recordScopes.get(rid);
          if (!list) {
            list = [];
            recordScopes.set(rid, list);
          }
          if (!list.includes(s)) list.push(s);
        }
        if (targetSet.has(s)) parsedFiles.push({ scope: s, name: item.name, record: item.entry.record });
      }
    }

    if (
      !anyFileChanged &&
      !hadTransientError &&
      this.cache?.key === cacheKey &&
      this.cache.revision === startRevision &&
      this.cache.revision === this.revision &&
      this.cache.metaStamp === metaStamp &&
      this.cache.ownershipStamp === ownershipStamp
    ) {
      return this.cache.value;
    }

    const value = buildSummarySnapshot({
      scope,
      now,
      today,
      timeZone: this.timeZone,
      source: this.source,
      meta,
      knownAccounts: this.knownAccounts,
      ownership,
      recordScopes,
      parsedFiles,
      unreadable,
      resolveFile: (sc, cid) => this.file(sc, cid),
    });
    if (!hadTransientError && this.revision === startRevision) {
      this.cache = { key: cacheKey, revision: startRevision, metaStamp, ownershipStamp, value };
    }
    return value;
  }
}

export async function addManualUsage(
  scope: string,
  data?: ManualUsageInput,
  ledger: UsageLedger = new UsageLedger(),
): Promise<ManualUsageRecord> {
  return await ledger.addManualUsage(scope, data);
}

export async function deleteManualUsage(
  scope: string,
  id: string,
  ledger: UsageLedger = new UsageLedger(),
): Promise<boolean> {
  return await ledger.deleteManualUsage(scope, id);
}
