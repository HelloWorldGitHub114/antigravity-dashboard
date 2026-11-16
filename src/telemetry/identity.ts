import { createHash } from 'node:crypto';
import type { UsageTimeBasis } from '../contracts/usage.ts';

export interface TrajectoryStepLike {
  type?: unknown;
  metadata?: {
    createdAt?: unknown;
    startedAt?: unknown;
    completedAt?: unknown;
    generatorModel?: unknown;
    toolCall?: unknown;
  } | null;
  plannerResponse?: {
    response?: unknown;
    toolCalls?: unknown;
  } | null;
  userInput?: {
    userConfig?: {
      plannerConfig?: {
        planModel?: unknown;
      } | null;
    } | null;
  } | null;
  systemMessage?: {
    eventType?: unknown;
  } | null;
  exitPlanMode?: unknown;
  invokeSubagent?: unknown;
  sendMessage?: unknown;
}

export interface GeneratorMetadataLike {
  stepIndices?: unknown;
  plannerConfig?: {
    planModel?: unknown;
  } | null;
  chatModel?: {
    model?: unknown;
    responseModel?: unknown;
    modelDisplayName?: unknown;
    streamingDuration?: unknown;
    timeToFirstToken?: unknown;
    retryInfos?: unknown;
    chatStartMetadata?: {
      createdAt?: unknown;
      contextWindowMetadata?: unknown;
    } | null;
    usage?: unknown;
  } | null;
}

export interface RequestIdentityOptions {
  index: number;
  conversationId?: string | null;
  steps?: readonly TrajectoryStepLike[];
  fallback?: 'index' | 'conversation';
}

export interface RequestIdentity {
  readonly key: string;
  readonly hash: string;
  readonly at: number | null;
  readonly requestStart: number | null;
  readonly timeBasis: UsageTimeBasis;
}

/**
 * Parse an ISO-8601 timestamp string (20XX-XX-XXT...) into epoch milliseconds.
 */
export function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^20\d\d-\d\d-\d\dT/.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Compute SHA-256 hex digest for a request identity key.
 */
export function hashRequestIdentity(identityKey: string): string {
  return createHash('sha256').update(identityKey).digest('hex');
}

/**
 * Extract unified request identity, timing attribution, and lazy SHA-256 hash
 * from a generatorMetadata entry.
 *
 * Replaces the duplicated Request ID extraction blocks across metrics,
 * task-usage, ledger, and timeline modules.
 */
export function extractRequestIdentity(
  generator: GeneratorMetadataLike | null | undefined,
  options: RequestIdentityOptions,
): RequestIdentity {
  const { index, conversationId, steps = [], fallback } = options;
  const chat = generator?.chatModel;
  const rawUsage = chat?.usage;
  const usage = rawUsage && typeof rawUsage === 'object' ? (rawUsage as Record<string, unknown>) : null;

  const requestStart = parseIsoTimestamp(chat?.chatStartMetadata?.createdAt);
  const rawIndices = Array.isArray(generator?.stepIndices) ? generator.stepIndices : null;

  let plannerEarliest: number | null = null;
  if (rawIndices && steps.length > 0) {
    for (const rawIndex of rawIndices) {
      if (!Number.isInteger(rawIndex) || rawIndex < 0) continue;
      const step = steps[rawIndex as number];
      if (!step || !/PLANNER_RESPONSE/.test(String(step.type || ''))) continue;
      const ts = parseIsoTimestamp(step.metadata?.createdAt);
      if (ts !== null && (plannerEarliest === null || ts < plannerEarliest)) {
        plannerEarliest = ts;
      }
    }
  }

  const at = requestStart ?? plannerEarliest;
  const timeBasis: UsageTimeBasis =
    requestStart !== null ? 'request-start' : at !== null ? 'planner-created' : 'unknown';

  const apiProvider = usage?.apiProvider ? String(usage.apiProvider) : '';
  const responseId = usage?.responseId ? String(usage.responseId) : '';
  const messageId = usage?.messageId ? String(usage.messageId) : '';

  let key: string;
  if (responseId) {
    key = `response:${apiProvider}:${responseId}`;
  } else if (messageId) {
    key = `message:${apiProvider}:${messageId}`;
  } else if (fallback === 'conversation' || (fallback !== 'index' && conversationId !== undefined)) {
    const indicesPart = JSON.stringify(generator?.stepIndices || [index]);
    key = `fallback:${conversationId}:${indicesPart}:${at ?? 'undated'}`;
  } else {
    key = `index:${index}`;
  }

  let cachedHash: string | null = null;
  return {
    key,
    get hash(): string {
      if (cachedHash === null) {
        cachedHash = hashRequestIdentity(key);
      }
      return cachedHash;
    },
    at,
    requestStart,
    timeBasis,
  };
}
