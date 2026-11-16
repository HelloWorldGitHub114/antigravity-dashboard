export interface RawStepLike {
  i?: unknown;
  type?: unknown;
  status?: unknown;
  metadata?: {
    createdAt?: string;
    startedAt?: string;
    completedAt?: string;
    viewableAt?: string;
    finishedGeneratingAt?: string;
    generatorModel?: string;
    toolCall?: { name?: unknown } | boolean;
    toolCallOutputTokens?: unknown;
    modelApiContentId?: string;
    modelUsage?: Record<string, unknown>;
    modelInfo?: {
      modelName?: string;
      displayName?: string;
      maxTokens?: unknown;
      contextWindow?: unknown;
      maxInputTokens?: unknown;
    };
    requestedModel?: { model?: string };
    sourceTrajectoryStepInfo?: { stepIndex?: number };
  };
  invokeSubagent?: unknown;
  userInput?: { userConfig?: { plannerConfig?: { planModel?: unknown } } };
  systemMessage?: { eventType?: unknown };
  taskBoundary?: { mode?: unknown; Mode?: unknown };
  exitPlanMode?: unknown;
  enterPlanMode?: unknown;
  plannerResponse?: {
    response?: unknown;
    toolCalls?: Array<{ name?: unknown; status?: unknown }>;
  };
}

export interface ProjectedStep {
  i?: unknown;
  type?: unknown;
  status?: string;
  metadata: Record<string, unknown>;
  invokeSubagent?: unknown;
  userInput?: { userConfig: { plannerConfig: { planModel: string } } };
  systemMessage?: { eventType: string };
  taskBoundary?: { mode?: string; Mode?: string };
  exitPlanMode?: true;
  enterPlanMode?: true;
  plannerResponse?: { response: string; toolCalls?: Array<{ name?: string; status?: string }> };
}

export interface RawGeneratorMetadataLike {
  i?: unknown;
  stepIndices?: unknown[];
  plannerConfig?: { modelName?: string; planModel?: string; plannerModel?: string };
  chatModel?: {
    usage?: Record<string, unknown> & { responseId?: string; apiProvider?: string; model?: string };
    chatStartMetadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ContextWindowUsageLike {
  estimatedTokensUsed?: number | string;
  maxContextTokens?: number | string;
}

export interface RemoteUpdateLike {
  conversationId?: string;
  status?: string;
  planModel?: unknown;
  contextWindowUsage?: ContextWindowUsageLike;
  mainTrajectoryUpdate?: {
    stepsUpdate?: { steps?: RawStepLike[] };
    generatorMetadatasUpdate?: { generatorMetadatas?: RawGeneratorMetadataLike[] };
  };
}

export interface NormalizedRemoteSnapshot {
  cascadeId: string;
  planModel?: string;
  steps: ProjectedStep[];
  generatorMetadata: RawGeneratorMetadataLike[];
  contextWindowUsage?: ContextWindowUsageLike;
}

export interface NormalizeRemoteOptions {
  modelTimelineEnabled?: boolean;
}

export interface TrajectorySummaryLike {
  stepCount?: unknown;
  lastModifiedTime?: string;
  status?: string;
  lastUserInputStepIndex?: unknown;
  trajectoryMetadata?: {
    remoteControlDetails?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface TrajectoryResult {
  trajectory: {
    cascadeId: string;
    planModel?: string;
    steps: Array<ProjectedStep | undefined>;
    generatorMetadata: RawGeneratorMetadataLike[];
  };
  contextWindowUsage?: ContextWindowUsageLike;
  status?: string;
  numTotalSteps: number;
  numTotalGeneratorMetadata: number;
  isRemote?: boolean;
}

export interface TrajectoryCacheEntry {
  data: TrajectoryResult | null;
  bytes: number;
  withTimeline: boolean;
  pending?: Promise<TrajectoryResult> | null;
  summary?: TrajectorySummaryLike;
  mark?: string;
  rev?: number;
  verifiedAt?: number;
  pendingBackfillOffset?: number;
  backfillGen?: number;
  backfilling?: boolean;
}

export interface TrajectoryReaderClient {
  now(): number;
  server?: Record<string, unknown> | null;
  modelTimelineEnabled?: boolean;
  discover(): Promise<Record<string, unknown>>;
  call<T = Record<string, unknown>>(
    method: string,
    body?: Record<string, unknown>,
    retry?: boolean,
    options?: { modelTimelineEnabled?: boolean } | null,
  ): Promise<T>;
  readAgentStateSnapshot?: (
    conversationId: string,
    options?: {
      modelTimelineEnabled?: boolean;
      initialStepsPageBounds?: { startIndex: number; endIndexExclusive: number };
      initialGeneratorMetadatasPageBounds?: { startIndex: number; endIndexExclusive: number };
    },
    retry?: boolean,
  ) => Promise<RemoteUpdateLike>;
}

export interface RemoteReaderHost {
  client: TrajectoryReaderClient;
  budgetBytes: number;
  idleRecheckMs: number;
  entries: Map<string, TrajectoryCacheEntry>;
  epoch: number;
  cachedBytes: number;
  onTrajectory?: (id: string, data: TrajectoryResult) => void;
  trim(keep?: string): void;
}
