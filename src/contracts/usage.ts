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
  ttftMs?: number | null;
  streamMs?: number | null;
  tps?: number | null;
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

export type QuotaCycleWindow = 'weekly' | '5h';
export type QuotaCycleSource = 'live' | 'recorded' | 'inferred';

/**
 * 额度重置周期的起止边界及元信息。
 */
export interface QuotaCycleRecord {
  groupId: string;
  groupName: string;
  window: QuotaCycleWindow;
  startAt: number;
  endAt: number;
  source: QuotaCycleSource;
  remaining?: number | null;
  idle?: boolean;
}

/**
 * 额度周期内按时间切片（周按天、5h 按小时）汇总的各模型四项细分 Token 桶。
 */
export interface QuotaCycleSliceBucket {
  key: string;
  date: string;
  label: string;
  rangeLabel: string;
  startAt: number;
  endAt: number;
  models: Record<string, UsageBucketCounts>;
}

/**
 * 可供选择的额度分组及其当前重置时间摘要。
 */
export interface QuotaCycleGroupOption {
  id: string;
  name: string;
  hasWeekly: boolean;
  has5h: boolean;
  weeklyResetAt: string | null;
  fiveHourResetAt: string | null;
  weeklyRemaining: number | null;
  fiveHourRemaining: number | null;
}

/**
 * 按额度重置周期查询本机账本用量的完整结果。
 */
export interface QuotaCycleUsageSnapshot {
  accountKey: string;
  requestedScope: string | null;
  timeZone: string;
  groups: QuotaCycleGroupOption[];
  selectedGroupId: string | null;
  selectedGroupName: string;
  window: QuotaCycleWindow;
  offset: number;
  hasOlder: boolean;
  cycle: QuotaCycleRecord | null;
  slices: QuotaCycleSliceBucket[];
  hours: number[];
  totalTokens: number;
  requests: number;
  updatedAt: string;
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

export type UsageRequestCacheFilter = 'all' | 'hot' | 'warm' | 'miss';

export interface UsageRequestLogModelOption {
  model: string;
  requests: number;
}

export interface UsageRequestLogCostBucket {
  date: string;
  model: string;
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
}

export interface UsageRequestLogItem {
  id: string;
  at: number;
  date: string;
  timeText: string;
  accountKey: string;
  accountName?: string;
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
  conversationTitle?: string;
  projectName?: string;
  note?: string;
  partial?: boolean;
}

export interface UsageRequestLogSummary {
  totalRequests: number;
  totalTokens: number;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  uncachedTokens: number;
  outputTokens: number;
  cacheHitRate: number | null;
  hotCount: number;
  warmCount: number;
  missCount: number;
  avgDurationMs: number | null;
  avgTtftMs: number | null;
  avgTps: number | null;
  timedRequests: number;
  tpsSamples: number;
  costBuckets: UsageRequestLogCostBucket[];
}

export interface UsageRequestLogSnapshot {
  accountKey: string;
  timeZone: string;
  today: string;
  from: string | null;
  to: string | null;
  models: UsageRequestLogModelOption[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  summary: UsageRequestLogSummary;
  items: UsageRequestLogItem[];
  updatedAt: string;
}
