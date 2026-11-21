import { join } from 'node:path';
import type { UsageAccountInfo, UsageRecord } from '../../contracts/usage.ts';
import { formatStatStamp } from '../../shared/atomic-fs.ts';
import { isErrno, sha256, validRow } from './helpers.ts';
import type { LedgerStorage } from './storage.ts';
import {
  GUID_RE,
  HASH_RE,
  LEDGER_FILE_RE,
  MAX_RECORD_FILE_BYTES,
  type KnownAccountInfo,
  type LedgerDocument,
  type OtherAccountsInspection,
  type UsageAccountsResult,
} from './types.ts';

async function readRawActiveLocalAccount(storage: LedgerStorage): Promise<string | null> {
  try {
    const raw = await storage.fs.readFile(storage.accountsFile(), 'utf8');
    if (raw.length > 2 * 1024 * 1024) return null;
    const parsed = JSON.parse(raw) as { activeLocalAccount?: unknown } | null;
    const value = parsed && typeof parsed === 'object' ? parsed.activeLocalAccount : null;
    return typeof value === 'string' && HASH_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

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
  options: { activeLocalAccount?: string | null } = {},
): Promise<void> {
  const file = storage.accountsFile();
  const hasExplicitActive = Object.hasOwn(options, 'activeLocalAccount');
  const activeLocalAccount = hasExplicitActive
    ? typeof options.activeLocalAccount === 'string' && HASH_RE.test(options.activeLocalAccount)
      ? options.activeLocalAccount
      : null
    : await readRawActiveLocalAccount(storage);
  storage.metaVersion++;
  const payload: Record<string, unknown> = { schema: 1, accounts: entries };
  if (activeLocalAccount) payload.activeLocalAccount = activeLocalAccount;
  await storage._atomicWrite(storage.directory, file, JSON.stringify(payload, null, 2));
  const st = await storage._stat(file).catch(() => null);
  const normalized = Object.fromEntries(
    Object.entries(entries || {}).filter(([k, v]) => HASH_RE.test(k) && Boolean(v) && typeof v === 'object'),
  );
  const stamp = formatStatStamp(st);
  storage.metaCache = stamp ? { stamp, value: normalized } : null;
  storage.revision++;
  storage.cache = null;
}

export async function getActiveLocalAccountHelper(storage: LedgerStorage): Promise<string | null> {
  return await readRawActiveLocalAccount(storage);
}

export function setActiveLocalAccountHelper(
  storage: LedgerStorage,
  scope: string | null,
): Promise<string | null> {
  if (scope !== null && (!scope || !HASH_RE.test(scope))) {
    return Promise.reject(new Error('Invalid account scope'));
  }
  return storage.enqueueWrite(async () => {
    const { value: current } = await loadAccountsMetaHelper(storage);
    await writeAccountsMetaHelper(storage, current, { activeLocalAccount: scope });
    return scope;
  });
}

export function createLocalAccountHelper(
  storage: LedgerStorage,
  input: { email?: string; name?: string; identifier?: string; activate?: boolean },
): Promise<UsageAccountInfo> {
  const rawIdentifier = typeof input?.identifier === 'string' ? input.identifier.trim() : '';
  const rawEmail = typeof input?.email === 'string' ? input.email.trim() : '';
  const rawName = typeof input?.name === 'string' ? input.name.trim() : '';
  const cleanText = (s: string, maxLen: number): string =>
    s.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, maxLen);

  let email: string | null = null;
  let name = cleanText(rawName, 120);
  const candidate = cleanText(rawEmail || rawIdentifier, 256);
  if (candidate) {
    if (candidate.includes('@') || candidate.startsWith('vertex:')) {
      email = candidate;
    } else if (!name) {
      name = candidate.slice(0, 120);
    }
  }
  if (!email && !name) {
    return Promise.reject(new Error('Account email or name is required'));
  }
  const scope = email ? sha256(email) : sha256(`local-account:${name.toLowerCase()}`);
  const displayName = name || email || `Account (${scope.slice(0, 8)})`;
  const activate = input?.activate !== false;

  return storage.enqueueWrite(async () => {
    const { value: current } = await loadAccountsMetaHelper(storage);
    const existing = current[scope] || storage.knownAccounts[scope] || {};
    const finalEmail = email || existing.email || null;
    const finalName = name || existing.name || finalEmail || displayName;
    const primary = existing.primary === true;
    current[scope] = {
      ...existing,
      email: finalEmail,
      name: finalName,
      primary,
      updatedAt: new Date().toISOString(),
    } as KnownAccountInfo;
    await writeAccountsMetaHelper(
      storage,
      current,
      activate ? { activeLocalAccount: scope } : {},
    );
    return {
      id: scope,
      name: finalName,
      email: finalEmail || finalName,
      primary,
      active: activate,
    };
  });
}

export function reassignConversationOwnershipHelper(
  storage: LedgerStorage,
  rawConversationIds: string | readonly string[],
  targetScope: string,
): Promise<{ reassigned: number; targetScope: string; conversationIds: string[] }> {
  if (!targetScope || !HASH_RE.test(targetScope)) {
    return Promise.reject(new Error('Invalid target account scope'));
  }
  const inputList = Array.isArray(rawConversationIds) ? rawConversationIds : [rawConversationIds];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of inputList) {
    if (typeof item !== 'string') continue;
    const norm = item.trim().toLowerCase();
    if (!GUID_RE.test(norm) || seen.has(norm)) continue;
    seen.add(norm);
    ids.push(norm);
    if (ids.length >= 128) break;
  }
  if (!ids.length) {
    return Promise.reject(new Error('At least one valid conversation ID is required'));
  }

  return storage.enqueueWrite(async () => {
    const { value: ownership } = await loadOwnershipHelper(storage);
    const scopes = await storage.scopeDirectories();
    const otherScopes = scopes.filter((s) => s !== targetScope);
    let reassigned = 0;

    for (const cid of ids) {
      const fileName = `${sha256(cid)}.json`;
      const targetFile = join(storage.directory, targetScope, fileName);
      const mergedMap = new Map<string, UsageRecord>();
      let existingTargetDoc: LedgerDocument | null = null;

      try {
        const text = await storage.fs.readFile(targetFile, 'utf8');
        if (text.length <= MAX_RECORD_FILE_BYTES) {
          const parsed = JSON.parse(text) as Partial<LedgerDocument>;
          if (parsed.schema === 1 && parsed.account === targetScope && Array.isArray(parsed.records)) {
            existingTargetDoc = parsed as LedgerDocument;
            for (const row of parsed.records) {
              if (validRow(row)) mergedMap.set(row.id, row);
            }
          }
        }
      } catch (error) {
        if (!isErrno(error, 'ENOENT', 'ENOTDIR')) {
          // Ignore unreadable target file and let source records rebuild it cleanly.
        }
      }

      const sourceScopesWithFile: string[] = [];
      let movedRecords = 0;
      for (const oldScope of otherScopes) {
        const oldFile = join(storage.directory, oldScope, fileName);
        try {
          const text = await storage.fs.readFile(oldFile, 'utf8');
          sourceScopesWithFile.push(oldScope);
          if (text.length > MAX_RECORD_FILE_BYTES) continue;
          const parsed = JSON.parse(text) as Partial<LedgerDocument>;
          if (parsed.schema === 1 && parsed.account === oldScope && Array.isArray(parsed.records)) {
            for (const row of parsed.records) {
              if (validRow(row) && !mergedMap.has(row.id)) {
                mergedMap.set(row.id, row);
                movedRecords++;
              }
            }
          }
        } catch (error) {
          if (!isErrno(error, 'ENOENT', 'ENOTDIR')) {
            // Skip inaccessible file in unrelated scope.
          }
        }
      }

      const ownerChanged = ownership[cid] !== targetScope;
      if (sourceScopesWithFile.length > 0 && (mergedMap.size > 0 || !existingTargetDoc)) {
        const records = [...mergedMap.values()].sort(
          (a, b) => (a.at ?? 0) - (b.at ?? 0) || a.id.localeCompare(b.id),
        );
        const doc: LedgerDocument = {
          schema: 1,
          account: targetScope,
          records,
        };
        await storage._atomicWrite(join(storage.directory, targetScope), targetFile, JSON.stringify(doc));
        await storage._setFileIndexFromWrite(targetScope, fileName, targetFile, doc);

        for (const oldScope of sourceScopesWithFile) {
          const oldFile = join(storage.directory, oldScope, fileName);
          try {
            await storage.fs.unlink(oldFile);
          } catch (error) {
            if (!isErrno(error, 'ENOENT', 'ENOTDIR')) throw error;
          }
          storage.fileIndex.get(oldScope)?.delete(fileName);
          storage._bumpKeyVersion(oldScope, fileName);
          storage._markDirtyRelPath(oldScope, fileName);
        }
      }

      ownership[cid] = targetScope;
      if (ownerChanged || sourceScopesWithFile.length > 0 || movedRecords > 0) {
        reassigned++;
      }
    }

    await writeOwnershipHelper(storage, ownership);
    return { reassigned, targetScope, conversationIds: ids };
  });
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
