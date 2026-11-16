import { join } from 'node:path';
import { formatStatStamp } from '../../shared/atomic-fs.ts';
import { sha256 } from './helpers.ts';
import type { LedgerStorage } from './storage.ts';
import {
  HASH_RE,
  LEDGER_FILE_RE,
  MAX_RECORD_FILE_BYTES,
  type KnownAccountInfo,
  type LedgerDocument,
  type OtherAccountsInspection,
  type UsageAccountsResult,
} from './types.ts';

export async function loadAccountsMetaHelper(
  storage: LedgerStorage,
): Promise<{ stamp: string; value: Record<string, KnownAccountInfo> }> {
  return await storage._loadStampCachedJson(
    storage.accountsFile(),
    () => storage.metaCache,
    (next) => {
      storage.metaCache = next;
    },
    () => storage.metaVersion,
    (val) => {
      const raw =
        val.accounts && typeof val.accounts === 'object' && !Array.isArray(val.accounts)
          ? (val.accounts as Record<string, unknown>)
          : val;
      return Object.fromEntries(
        Object.entries(raw).filter(([k, v]) => HASH_RE.test(k) && Boolean(v) && typeof v === 'object'),
      ) as Record<string, KnownAccountInfo>;
    },
  );
}

export async function writeAccountsMetaHelper(
  storage: LedgerStorage,
  entries: Record<string, KnownAccountInfo>,
): Promise<void> {
  const file = storage.accountsFile();
  storage.metaVersion++;
  await storage._atomicWrite(storage.directory, file, JSON.stringify({ schema: 1, accounts: entries }, null, 2));
  const st = await storage._stat(file).catch(() => null);
  const normalized = Object.fromEntries(
    Object.entries(entries || {}).filter(([k, v]) => HASH_RE.test(k) && Boolean(v) && typeof v === 'object'),
  );
  const stamp = formatStatStamp(st);
  storage.metaCache = stamp ? { stamp, value: normalized } : null;
  storage.revision++;
  storage.cache = null;
}

export function registerAccountHelper(storage: LedgerStorage, scope: string, meta: KnownAccountInfo = {}): Promise<void> {
  if (!scope || !HASH_RE.test(scope)) return Promise.resolve();
  return storage.enqueueWrite(async () => {
    const { value: current } = await loadAccountsMetaHelper(storage);
    const existing = current[scope] || storage.knownAccounts[scope] || {};
    const email = meta.email || existing.email || null;
    const name = meta.name || existing.name || email || `Account (${scope.slice(0, 8)})`;
    const primary = meta.primary !== undefined ? meta.primary : existing.primary !== undefined ? existing.primary : false;
    current[scope] = { ...existing, ...meta, email, name, primary };
    await writeAccountsMetaHelper(storage, current);
  });
}

export async function loadOwnershipHelper(
  storage: LedgerStorage,
): Promise<{ stamp: string; value: Record<string, string> }> {
  return await storage._loadStampCachedJson(
    storage.ownershipFile(),
    () => storage.ownershipCache,
    (next) => {
      storage.ownershipCache = next;
    },
    () => storage.ownershipVersion,
    (parsed) => {
      const raw =
        parsed.owners && typeof parsed.owners === 'object' && !Array.isArray(parsed.owners)
          ? (parsed.owners as Record<string, unknown>)
          : parsed;
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof k === 'string' && typeof v === 'string' && HASH_RE.test(v)) result[k.toLowerCase()] = v;
      }
      return result;
    },
  );
}

export async function writeOwnershipHelper(storage: LedgerStorage, entries: Record<string, string>): Promise<void> {
  const file = storage.ownershipFile();
  storage.ownershipVersion++;
  await storage._atomicWrite(storage.directory, file, JSON.stringify(entries));
  const st = await storage._stat(file).catch(() => null);
  const valid: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries || {})) {
    if (typeof k === 'string' && typeof v === 'string' && HASH_RE.test(v)) valid[k.toLowerCase()] = v;
  }
  const stamp = formatStatStamp(st);
  storage.ownershipCache = stamp ? { stamp, value: valid } : null;
  storage.revision++;
  storage.cache = null;
}

export function registerOwnershipHelper(
  storage: LedgerStorage,
  id: string,
  scope: string,
  { overwrite = false }: { overwrite?: boolean } = {},
): Promise<boolean> {
  if (!scope || !HASH_RE.test(scope) || !id) return Promise.resolve(false);
  const norm = String(id).toLowerCase();
  return storage.enqueueWrite(async () => {
    const { value: current } = await loadOwnershipHelper(storage);
    if (current[norm] && (!overwrite || current[norm] === scope)) return false;
    current[norm] = scope;
    await writeOwnershipHelper(storage, current);
    return true;
  });
}

export async function otherScopeFilesHelper(
  storage: LedgerStorage,
  scope: string,
): Promise<{ ownFiles: Set<string>; otherFiles: Map<string, string[]> }> {
  const ownFiles = new Set<string>();
  const otherFiles = new Map<string, string[]>();
  const scopes = await storage.scopeDirectories();
  for (const s of scopes) {
    try {
      const fls = (await storage.fs.readdir(join(storage.directory, s))) as string[];
      for (const f of fls) {
        if (!LEDGER_FILE_RE.test(f)) continue;
        if (s === scope) ownFiles.add(f);
        else {
          let arr = otherFiles.get(f);
          if (!arr) {
            arr = [];
            otherFiles.set(f, arr);
          }
          arr.push(s);
        }
      }
    } catch {
      // Ignore unreadable scope directories.
    }
  }
  return { ownFiles, otherFiles };
}

export async function inspectOtherAccountsHelper(
  storage: LedgerStorage,
  scope: string,
  id: string,
): Promise<OtherAccountsInspection> {
  const fileName = `${sha256(String(id).toLowerCase())}.json`;
  const scopes = await storage.scopeDirectories();
  const owners: string[] = [];
  const recordIds = new Set<string>();
  let maxAt = 0;
  let inOwn = false;
  for (const s of scopes) {
    try {
      const text = await storage.fs.readFile(join(storage.directory, s, fileName), 'utf8');
      if (text.length > MAX_RECORD_FILE_BYTES) continue;
      const doc = JSON.parse(text) as Partial<LedgerDocument>;
      if (doc.schema !== 1 || doc.account !== s || !Array.isArray(doc.records)) continue;
      if (s === scope) {
        inOwn = true;
        continue;
      }
      owners.push(s);
      for (const r of doc.records) {
        if (r?.id) recordIds.add(r.id);
        if (typeof r?.at === 'number' && Number.isSafeInteger(r.at) && r.at > maxAt) maxAt = r.at;
      }
    } catch {
      // Ignore missing or unreadable files in other scopes.
    }
  }
  return { fileName, inOwn, owners, recordIds, maxAt };
}

export async function getAccountsHelper(
  storage: LedgerStorage,
  meta: Record<string, KnownAccountInfo>,
  activeScope: string | null = null,
): Promise<UsageAccountsResult> {
  const allScopes = await storage.scopeDirectories();
  const accounts: UsageAccountsResult = [];
  accounts.push({ id: 'all', name: 'All Accounts (Aggregated)', email: 'All Accounts (Aggregated)', active: activeScope === 'all' });
  const scopes = new Set(allScopes);
  if (activeScope && HASH_RE.test(activeScope)) scopes.add(activeScope);
  for (const k of Object.keys(meta)) if (HASH_RE.test(k)) scopes.add(k);
  for (const k of Object.keys(storage.knownAccounts)) if (HASH_RE.test(k)) scopes.add(k);
  for (const scope of scopes) {
    const m = meta[scope] || storage.knownAccounts[scope] || {};
    const email = m.email || null;
    const name = m.name || email || `Account (${scope.slice(0, 8)})`;
    accounts.push({ id: scope, name, email: email || name, primary: !!m.primary, active: activeScope ? scope === activeScope : false });
  }
  accounts.accounts = accounts;
  accounts.active = activeScope || accounts.find((a) => a.id !== 'all')?.id || 'all';
  accounts.activeAccount = accounts.active;
  return accounts;
}
