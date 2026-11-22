/**
 * Timestamp attribution basis for a recorded usage sample.
 */
export type UsageTimeBasis = 'request-start' | 'planner-created' | 'unknown';

/**
 * Single hashed request record stored in `UsageLedger`.
 */
export interface UsageRecord {
  id: string;
  at: number | null;
  model: string;
  uncached: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  partial: boolean;
  timeBasis: UsageTimeBasis;
  isLegacy?: boolean;
}

/**
 * Token fields stored inside a manual remote-usage entry.
 */
export interface ManualUsageTokens {
  prompt: number;
  candidates: number;
  total: number;
  cacheRead?: number;
  cache?: number;
}

/**
 * Input payload accepted by `UsageLedger.addManualUsage` and bridge callers.
 */
export interface ManualUsageInput {
  id?: string;
  scope?: string;
  source?: string;
  projectName?: string;
  timestamp?: number | string;
  at?: number;
  model?: string;
  tokens?: Partial<ManualUsageTokens>;
  prompt?: number;
  candidates?: number;
  output?: number;
  total?: number;
  promptTokens?: number;
  completionTokens?: number;
  cacheTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  note?: string;
}

/**
 * Normalized manual remote-usage entry returned by `UsageLedger`.
 */
export interface ManualUsageRecord {
  id: string;
  hash: string;
  file?: string;
  account?: string;
  timestamp: number;
  source: string;
  model: string;
  tokens: ManualUsageTokens;
  projectName: string;
  note: string;
}

/**
 * Account selector entry returned by `getAccounts`.
 */
export interface UsageAccountInfo {
  id: string;
  name: string;
  email?: string | null;
  primary?: boolean;
  active: boolean;
}

/**
 * Aggregated token and request counters for a model or user bucket.
 */
export interface UsageBucketCounts {
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
  requests: number;
}

/**
 * Per-user usage bucket inside a day or summary rollup.
 */
export interface UsageUserBucket extends UsageBucketCounts {
  name: string;
  userKey: string;
  isLegacy: boolean;
}

/**
 * Per-day usage rollup bucket.
 */
export interface UsageDayBucket {
  date: string;
  models: Record<string, UsageBucketCounts>;
  users: Record<string, UsageUserBucket>;
  hours: number[];
  legacyTokens: number;
}

/**
 * Display metadata for a user/account key in `UsageSummarySnapshot`.
 */
export interface UsageUserMeta {
  name: string;
  email: string;
  isLegacy: boolean;
}

/**
 * Sync status reported by `DesktopUsage.snapshot()`.
 */
export type DesktopUsageSyncStatus = 'waiting' | 'syncing' | 'partial' | 'ready' | 'offline';

/**
 * Per-window observed local token volume for an active quota window (`<groupId>:5h` or `<groupId>:weekly`).
 */
export interface QuotaWindowUsage {
  observedTokens: number;
  requests: number;
  usedFraction: number | null;
}

/**
 * Full usage summary snapshot returned by `UsageLedger.summary()` and `DesktopUsage.snapshot()`.
 */
export interface UsageSummarySnapshot {
  accountKey: string;
  viewScope: string;
  timeZone: string;
  today: string;
  todayHours: number[];
  days: UsageDayBucket[];
  models: string[];
  users: string[];
  userMeta: Record<string, UsageUserMeta>;
  usersSummary: Record<string, UsageUserBucket>;
  legacyTokens: number;
  todayTokens: number;
  weekTokens: number;
  monthTokens: number;
  totalTokens: number;
  unknownTokens: number;
  unknownRequests: number;
  partialRequests: number;
  unreadableFiles: number;
  manualEntries: ManualUsageRecord[];
  requests: number;
  firstDate: string | null;
  updatedAt: string;
  source: string;
  quotaWindows?: Record<string, QuotaWindowUsage>;
  activeAccount?: string;
  recordingAccount?: string | null;
  localAccountMode?: boolean;
  accounts?: UsageAccountInfo[];
  syncing?: boolean;
  status?: DesktopUsageSyncStatus;
  missingConversations?: number;
  confirmedMissingConversations?: number;
  retryingConversations?: number;
  persistenceError?: boolean;
}

export type ProjectKind = 'project' | 'conversations' | 'cli' | 'remote';

export interface ProjectUsageItem {
  projectKey: string;
  name: string;
  kind: ProjectKind;
  workspacePath?: string;
  conversationCount: number;
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
  requests: number;
}

export interface ProjectUsageDayBucket {
  date: string;
  projects: Record<string, UsageBucketCounts>;
}

export interface ProjectUsageOverview {
  accountKey: string;
  from: string;
  to: string;
  projects: ProjectUsageItem[];
  days: ProjectUsageDayBucket[];
  totalTokens: number;
  requests: number;
  updatedAt: string;
}

export interface ProjectConversationItem {
  id: string;
  title: string;
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
  requests: number;
  share: number;
  lastActiveAt: string | null;
  isSubagent: boolean;
  isRemote: boolean;
  parentId?: string | null;
  rootId?: string | null;
  rootTitle?: string | null;
  agentName?: string | null;
}

export interface ProjectConversationDetail {
  accountKey: string;
  projectKey: string;
  projectName: string;
  kind: ProjectKind;
  from: string;
  to: string;
  totalTokens: number;
  requests: number;
  conversations: ProjectConversationItem[];
  updatedAt: string;
}
