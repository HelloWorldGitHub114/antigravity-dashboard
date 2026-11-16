import type {
  SpeedMetrics,
  TaskUsageSummary,
  TranscriptStats,
} from '../../contracts/metrics.ts';
import type { ClearTimelineResult, ModelTimelineSnapshot } from '../../contracts/timeline.ts';
import type { ChildTimelineSummary } from '../delegation/delegated-usage.ts';

export const GUID = /^(?:[a-zA-Z0-9_.-]+\/)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HASH = /^[a-f0-9]{64}$/;

export interface TrajectorySummaryMeta {
  rootConversationId?: string;
  parentConversationId?: string;
  [key: string]: unknown;
}

export interface RawSummaryRecord {
  summary?: unknown;
  lastModifiedTime?: string;
  status?: string;
  stepCount?: unknown;
  lastUserInputStepIndex?: unknown;
  trajectoryMetadata?: TrajectorySummaryMeta | Record<string, unknown>;
  [key: string]: unknown;
}

export interface SessionEntry {
  data?: SpeedMetrics;
  baseMetrics?: SpeedMetrics | null;
  rawWeak?: WeakRef<object> | null;
  rawRev?: number | null;
  withTimeline?: boolean;
  savedAt?: string | null;
  updatedAt?: number;
  pending?: Promise<SpeedMetrics> | null;
  raw?: unknown;
}

export interface StoreReaderEntryLike {
  data?: unknown;
  rev?: number;
}

export interface StoreClientLike {
  discover(): Promise<{ pid: number; [key: string]: unknown }>;
  call(method: string, body?: unknown): Promise<any>;
  trajectory(id: string, options?: { force?: boolean; modelTimelineEnabled?: boolean }): Promise<any>;
  reader?: {
    entries?: Map<string, StoreReaderEntryLike>;
    summaries?: Record<string, RawSummaryRecord> | null;
    seedSummaries?: (raw: Record<string, RawSummaryRecord> | null | undefined, now?: number, server?: Record<string, unknown> | null) => void;
  };
  server?: Record<string, unknown> | null;
  paths?: () => { profile?: string; log?: string; logCandidates?: string[] };
  setModelTimelineEnabled?: (enabled: boolean) => void;
  resetTrajectories?: () => void;
}

export interface StoreHistoryLike {
  directory?: string;
  load(scope: string, id: string): Promise<{ metrics: SpeedMetrics; savedAt?: string | null } | null>;
  save(scope: string, id: string, metrics: SpeedMetrics): Promise<{ savedAt?: string | null } | null>;
}

export interface StoreTimelineStoreLike {
  load(scope: string, id: string): Promise<ModelTimelineSnapshot | null>;
  save(scope: string, id: string, timeline: ModelTimelineSnapshot): Promise<ModelTimelineSnapshot | null>;
  clear(scope: string, id: string): Promise<ClearTimelineResult>;
  clearAll(scope: string | null): Promise<ClearTimelineResult>;
}

export interface StoreTranscriptsLike {
  request(scope: string, id: string, raw: unknown): TranscriptStats | null;
  reset(): void;
  dispose?: () => void;
}

export interface StoreDelegatedLike {
  tasks?: Map<string, { children?: Set<string>; result?: TaskUsageSummary | null }>;
  request(scope: string, id: string, raw: unknown, options?: Record<string, unknown>): TaskUsageSummary | null;
  getTimelineChildren?: (id: string) => ChildTimelineSummary[];
  setModelTimelineEnabled?: (enabled: boolean) => void;
  reset?: () => void;
  dispose?: () => void;
}

export interface AncestorResolutionHost {
  client: StoreClientLike;
  history: StoreHistoryLike;
  delegated: StoreDelegatedLike | null;
  sessions: Map<string, SessionEntry>;
  ancestorPending: Map<string, Promise<void>>;
  ancestorRaws: Map<string, WeakRef<object>>;
  rawSummaries: Record<string, RawSummaryRecord> | null;
  identity: string | null;
  epoch: number;
  modelTimelineEnabled: boolean;
  owns: () => boolean;
}

export interface MetricsStoreOptions {
  history?: StoreHistoryLike;
  timelineStore?: StoreTimelineStoreLike | null;
  dataDir?: string | null;
  modelTimelineEnabled?: boolean;
  onTrajectory?: ((scope: string, id: string, raw: unknown) => Promise<unknown> | unknown) | null;
  onAccount?: ((scope: string, meta: { email: string; name: string }) => Promise<unknown> | unknown) | null;
  transcripts?: StoreTranscriptsLike | null;
  delegated?: StoreDelegatedLike | null;
  owns?: () => boolean;
}
