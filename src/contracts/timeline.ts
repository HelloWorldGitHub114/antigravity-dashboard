/**
 * Structural node categories produced by `buildModelTimeline`.
 */
export type TimelineNodeKind =
  | 'turn'
  | 'phase'
  | 'handoff'
  | 'model_call'
  | 'tool_group'
  | 'subagent'
  | 'error';

/**
 * Execution roles assigned to timeline nodes.
 */
export type TimelineRole = 'plan' | 'worker' | 'subagent' | 'model';

/**
 * Swimlane track categories for timeline visualization.
 */
export type TimelineLane = 'plan' | 'worker' | 'tool' | 'subagent' | 'handoff';

/**
 * Token breakdown attached to timeline nodes.
 */
export interface TimelineTokenCounts {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

/**
 * Bounded structural metadata attached to a `TimelineNode`.
 */
export interface TimelineNodeMeta {
  round?: number;
  stepIndex?: number;
  stepStart?: number;
  stepEnd?: number;
  generatorIndex?: number;
  ttftMs?: number;
  streamingMs?: number;
  toolCount?: number;
  tool?: string;
  category?: string;
  count?: number;
  okCount?: number;
  errorCount?: number;
  calls?: number;
  trigger?: string;
  fromModel?: string;
  toModel?: string;
  mode?: string;
  role?: string;
  depth?: number;
  status?: string;
  steps?: number;
  tps?: number;
  totalTokens?: number;
  requests?: number;
  planModel?: string;
  activeModel?: string;
  stepType?: string;
  compactedCalls?: number;
  compactedChildren?: number;
  compactedTools?: number;
}

/**
 * Tree node in a structural model call timeline.
 */
export interface TimelineNode {
  id: string;
  kind: TimelineNodeKind;
  time: string | null;
  durationMs: number;
  model: string | null;
  role: TimelineRole | null;
  event: string;
  meta: TimelineNodeMeta | null;
  tokens: TimelineTokenCounts | null;
  childConversationId: string | null;
  children: TimelineNode[];
}

/**
 * Normalized horizontal bar segment in the timeline swimlane view.
 */
export interface TimelineSwimlaneItem {
  kind: TimelineLane;
  model: string | null;
  label: string;
  startMs: number;
  endMs: number;
  startRatio: number;
  widthRatio: number;
  stepStart: number;
  stepEnd: number;
  calls: number;
}

/**
 * Persisted or live bounded structural model call timeline snapshot.
 */
export interface ModelTimelineSnapshot {
  enabled: boolean;
  cascadeId: string;
  planModel: string | null;
  activeModel: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number;
  swimlanes: TimelineSwimlaneItem[];
  nodes: TimelineNode[];
  truncated: boolean;
  savedAt: string | null;
}

/**
 * Result returned by timeline cache-clear operations.
 */
export interface ClearTimelineResult {
  cleared: boolean;
  scope?: string | null;
  cascadeId?: string;
  error?: string;
}
