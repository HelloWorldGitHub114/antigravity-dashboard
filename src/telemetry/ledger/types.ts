import type { UsageAccountInfo, UsageRecord, UsageSummarySnapshot } from '../../contracts/usage.ts';
import type { FileStatLike } from '../../shared/atomic-fs.ts';

export const HASH_RE = /^[a-f0-9]{64}$/;
export const GUID_RE = /^(?:[a-zA-Z0-9_.-]+\/)*[a-f0-9-]{36}$/i;
export const LEDGER_FILE_RE = /^[a-f0-9]{64}\.json$/;
export const RECORD_KEYS = ['uncached', 'cacheRead', 'cacheWrite', 'output'] as const;
export const MAX_LEDGER_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_RECORD_FILE_BYTES = 16 * 1024 * 1024;

export type BackfillHost = 'app' | 'ide';

export interface KnownAccountInfo {
  email?: string | null;
  name?: string | null;
  primary?: boolean;
  secondary?: boolean;
  addedAt?: number;
  createdAt?: number;
}

export interface BackfillEntry {
  signature: string;
  state: 'complete' | 'retry';
  failures: number;
  retryAt: number;
}

export interface LedgerDocument {
  schema: number;
  account: string;
  id?: string;
  hash?: string;
  isLegacy?: boolean;
  metadata?: {
    source?: string;
    isLegacy?: boolean;
    timestamp?: number;
    model?: string;
    tokens?: { prompt: number; candidates: number; total: number };
    projectName?: string;
    note?: string;
    id?: string;
  };
  records: UsageRecord[];
}

export interface FileIndexEntry {
  stamp: string;
  unreadable: boolean;
  record: LedgerDocument | null;
  recordIds: string[] | null;
}

export interface LedgerFsOverrides {
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  writeFile?: (
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: BufferEncoding | null; mode?: number; flag?: string },
  ) => Promise<void>;
  mkdir?: (path: string, options?: { recursive?: boolean; mode?: number }) => Promise<string | undefined>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  readdir?: (path: string, options?: { withFileTypes?: boolean }) => Promise<unknown[]>;
  unlink?: (path: string) => Promise<void>;
  stat?: (path: string, options?: { bigint?: boolean }) => Promise<FileStatLike>;
}

export interface UsageLedgerOptions {
  timeZone?: string;
  source?: string;
  knownAccounts?: Record<string, KnownAccountInfo>;
  fs?: LedgerFsOverrides | null;
}

export interface OtherAccountsInspection {
  fileName: string;
  inOwn: boolean;
  owners: string[];
  recordIds: Set<string>;
  maxAt: number;
}

export interface SummaryCacheEntry {
  key: string;
  revision: number;
  metaStamp: string;
  ownershipStamp: string;
  value: UsageSummarySnapshot;
}

export interface StampCache<T> {
  stamp: string;
  value: T;
}

export interface DirentLike {
  name: string;
  isDirectory(): boolean;
}

export type UsageAccountsResult = UsageAccountInfo[] & {
  accounts?: UsageAccountInfo[];
  active?: string;
  activeAccount?: string;
};
