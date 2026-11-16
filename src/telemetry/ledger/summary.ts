import { join } from 'node:path';
import type { ManualUsageInput, ManualUsageRecord, UsageSummarySnapshot } from '../../contracts/usage.ts';
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
