import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ManualUsageInput, ManualUsageRecord } from '../../contracts/usage.ts';
import { cleanModel, isErrno, sha256 } from './helpers.ts';
import type { LedgerStorage } from './storage.ts';
import { HASH_RE, LEDGER_FILE_RE, type LedgerDocument } from './types.ts';

export function addManualUsageHelper(
  storage: LedgerStorage,
  scope: string,
  data: ManualUsageInput = {},
): Promise<ManualUsageRecord> {
  if (!scope || !HASH_RE.test(scope)) return Promise.reject(Error('Invalid usage scope'));
  return storage.enqueueWrite(async () => {
    const id = data.id || randomUUID();
    const fileHash = sha256(id);
    const timestamp =
      typeof data.timestamp === 'number' && Number.isSafeInteger(data.timestamp) && data.timestamp >= 0
        ? data.timestamp
        : typeof data.timestamp === 'string' && Number.isFinite(Date.parse(data.timestamp))
          ? Date.parse(data.timestamp)
          : Date.now();
    const model = cleanModel(data.model || 'manual-model');
    const prompt = Number.isSafeInteger(data.tokens?.prompt)
      ? (data.tokens!.prompt as number)
      : Number.isSafeInteger(data.prompt)
        ? (data.prompt as number)
        : 0;
    const candidates = Number.isSafeInteger(data.tokens?.candidates)
      ? (data.tokens!.candidates as number)
      : Number.isSafeInteger(data.candidates)
        ? (data.candidates as number)
        : Number.isSafeInteger(data.output)
          ? (data.output as number)
          : 0;
    const total = Number.isSafeInteger(data.tokens?.total)
      ? (data.tokens!.total as number)
      : Number.isSafeInteger(data.total)
        ? (data.total as number)
        : prompt + candidates;
    const tokens = { prompt, candidates, total };
    const projectName = String(data.projectName || '');
    const note = String(data.note || '');
    const metadata = { timestamp, source: 'remote-manual', model, tokens, projectName, note };
    let uncached = prompt;
    const output = candidates;
    if (uncached === 0 && output === 0 && total > 0) uncached = total;
    const records = [
      {
        id: fileHash,
        at: timestamp,
        model,
        uncached,
        cacheRead: Number.isSafeInteger(data.cacheRead) ? (data.cacheRead as number) : 0,
        cacheWrite: Number.isSafeInteger(data.cacheWrite) ? (data.cacheWrite as number) : 0,
        output,
        partial: false,
        timeBasis: 'request-start' as const,
      },
    ];
    const content: LedgerDocument = { schema: 1, account: scope, id, hash: fileHash, metadata, records };
    const dir = join(storage.directory, scope);
    const fileName = `${fileHash}.json`;
    const file = join(dir, fileName);
    await storage._atomicWrite(dir, file, JSON.stringify(content));
    await storage._setFileIndexFromWrite(scope, fileName, file, content);
    return { id, hash: fileHash, file: fileName, ...metadata };
  });
}

export function deleteManualUsageHelper(storage: LedgerStorage, scope: string, id: string): Promise<boolean> {
  if (!scope || !HASH_RE.test(scope)) return Promise.reject(Error('Invalid usage scope'));
  return storage.enqueueWrite(async () => {
    let deleted = false;
    const clean = typeof id === 'string' ? id.trim().replace(/\.json$/, '') : '';
    const targets = new Set<string>();
    if (clean) {
      if (HASH_RE.test(clean)) targets.add(clean);
      targets.add(sha256(clean));
    }
    const dir = join(storage.directory, scope);
    for (const h of targets) {
      const fileName = `${h}.json`;
      try {
        await storage.fs.unlink(join(dir, fileName));
        deleted = true;
        storage._bumpKeyVersion(scope, fileName);
        storage.fileIndex.get(scope)?.delete(fileName);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
    }
    if (!deleted) {
      try {
        const files = (await storage.fs.readdir(dir)) as string[];
        for (const name of files.filter((n) => LEDGER_FILE_RE.test(n))) {
          const file = join(dir, name);
          try {
            const data = JSON.parse(await storage.fs.readFile(file, 'utf8')) as Partial<LedgerDocument>;
            if (data.id === id || data.metadata?.id === id || data.hash === id || data.metadata?.projectName === id) {
              await storage.fs.unlink(file);
              deleted = true;
              storage._bumpKeyVersion(scope, name);
              storage.fileIndex.get(scope)?.delete(name);
              break;
            }
          } catch {
            // Skip malformed ledger files during fallback manual ID scan.
          }
        }
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
    }
    storage.revision++;
    storage.cache = null;
    return deleted;
  });
}

export async function listManualUsageHelper(storage: LedgerStorage, scope: string): Promise<ManualUsageRecord[]> {
  if (!scope || !HASH_RE.test(scope)) return [];
  const list: ManualUsageRecord[] = [];
  const dir = join(storage.directory, scope);
  try {
    const files = (await storage.fs.readdir(dir)) as string[];
    for (const name of files.filter((n) => LEDGER_FILE_RE.test(n))) {
      try {
        const doc = JSON.parse(await storage.fs.readFile(join(dir, name), 'utf8')) as Partial<LedgerDocument>;
        if (doc.metadata?.source === 'remote-manual') {
          list.push({
            id: doc.id || '',
            hash: name.replace(/\.json$/, ''),
            timestamp: doc.metadata.timestamp ?? 0,
            source: doc.metadata.source,
            model: doc.metadata.model ?? 'manual-model',
            tokens: doc.metadata.tokens ?? { prompt: 0, candidates: 0, total: 0 },
            projectName: doc.metadata.projectName ?? '',
            note: doc.metadata.note ?? '',
          });
        }
      } catch {
        // Ignore unreadable manual usage files.
      }
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  return list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}
