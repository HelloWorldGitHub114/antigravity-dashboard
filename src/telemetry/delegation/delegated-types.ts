import type {
  ModelUsageSummary,
  SubagentItem,
  TaskUsageState,
  TaskUsageSummary,
} from '../../contracts/metrics.ts';
import type { DelegatedHint } from './delegation.ts';
import type { TaskModelRecord, TaskUsageRecord } from './task-usage.ts';

export interface DelegatedClientLike {
  reader?: { summaries?: Record<string, unknown> | null } | null;
  trajectory(
    id: string,
    options?: {
      summary?: Record<string, unknown>;
      force?: boolean;
      isCurrent?: () => boolean;
    },
  ): Promise<unknown>;
}

export interface DelegatedUsageOptions {
  onSource?: (
    scope: string,
    id: string,
    raw: unknown,
    context?: { isCurrent: () => boolean; guardKey: DelegatedTaskState },
  ) => Promise<void> | void;
  onUpdate?: (
    scope: string,
    id: string,
    result: TaskUsageSummary,
    children: string[],
  ) => Promise<void> | void;
  owns?: () => boolean | Promise<unknown>;
  now?: () => number;
  budgetBytes?: number;
  maxAgents?: number;
  maxEntries?: number;
  refreshMs?: number;
  modelTimelineEnabled?: boolean;
}

export interface DelegatedRequestOptions {
  saved?: unknown;
  knownIds?: unknown[];
  force?: boolean;
  isCurrent?: () => boolean;
}

export interface ChildTimelineSummary {
  id: string;
  role: string | null;
  parentId: string | null;
  depth: number;
  model: string | null;
  planModel: string | null;
  activeModel: string | null;
  requests: number;
  totalTokens: number;
  outputTokens: number;
  tokens: {
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    cachedTokens: number;
    totalTokens: number;
  } | null;
  tps: number | null;
  status: string | null;
  steps: number;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number;
  modelUsage: ModelUsageSummary | null;
}

export interface DelegatedTaskState {
  id: string;
  scope: string;
  children: Set<string>;
  hints: Map<string, DelegatedHint>;
  sources: Map<string, { rows: TaskUsageRecord[]; bytes: number }>;
  modelSources: Map<string, { rows: TaskModelRecord[]; bytes: number }>;
  details: Map<string, SubagentItem>;
  childTimelines: Map<string, ChildTimelineSummary>;
  failures: Map<string, { failures: number; retryAt: number }>;
  staleSources: Set<string>;
  attempted: Map<string, number>;
  order: number;
  bytes: number;
  lastAt: number;
  requested: boolean;
  force: boolean;
  collecting?: boolean;
  isCurrent?: () => boolean;
  raw?: WeakRef<object>;
  result: TaskUsageSummary | null;
  truncated: boolean;
  planModel: string | null;
  activeModel: string | null;
}

export type DelegatedResultFn = (task: DelegatedTaskState, state: TaskUsageState) => TaskUsageSummary;
