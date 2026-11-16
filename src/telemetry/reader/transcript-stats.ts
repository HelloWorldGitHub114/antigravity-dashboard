import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StringDecoder } from 'node:string_decoder';
import type { TranscriptReason, TranscriptStats, TranscriptStatus } from '../../contracts/metrics.ts';
import type { TrajectoryJson } from '../projector/trajectory-json.ts';

export interface BoundaryStep {
  type: string | null;
  time: number | null;
  quantum: number;
}

export interface TranscriptRow {
  index: number;
  type: string | null;
  time: number | null;
  quantum: number;
  userTokens: number;
  assistantTokens: number;
  toolTokens: number;
  systemTokens: number;
  compaction: number;
  image: number;
  unknown: boolean;
}

export interface Anchor {
  offset: number;
  length: number;
  hash: string;
}

export interface TranscriptFileState {
  identity: string;
  size: number;
  mtime: number;
  offset: number;
  rows: Map<number, TranscriptRow>;
  decoder: StringDecoder;
  parser: TrajectoryJson | null;
  lineStarted: boolean;
  badLine: boolean;
  invalid: boolean;
  eof: boolean;
  limit: boolean;
  anchors: Anchor[];
}

export interface TranscriptEntry {
  key: string;
  id: string;
  boundary?: { active: BoundaryStep[] } | null;
  state: TranscriptFileState | null;
  error: TranscriptReason | null;
  requested: boolean;
  continuing: boolean;
}

const TOKEN_FIELDS = ['userTokens', 'assistantTokens', 'toolTokens', 'systemTokens'] as const;
const STAT_FIELDS = [...TOKEN_FIELDS, 'matchedSteps', 'compactionMarkers', 'imageSteps'] as const;
const STATUSES: readonly TranscriptStatus[] = ['loading', 'ready', 'partial', 'unavailable'];
const REASONS: readonly TranscriptReason[] = [
  'reading',
  'missing',
  'unsafe-path',
  'invalid-boundary',
  'row-limit',
  'invalid-record',
  'unmatched-record',
  'incomplete-line',
  'io-error',
];
const genericHostTypes = new Set(['RUN_COMMAND', 'VIEW_FILE']);

export const isNonNegInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/**
 * Resolve the host's local `.gemini/antigravity{,-ide}/brain` transcript directory.
 */
export function transcriptBrainRoot(host = 'app'): string {
  if (host !== 'app' && host !== 'ide') throw new Error('Unsupported transcript host');
  return join(homedir(), '.gemini', host === 'ide' ? 'antigravity-ide' : 'antigravity', 'brain');
}

export function emptyStats(status: TranscriptStatus, reason: TranscriptReason | null): TranscriptStats {
  return {
    version: 1,
    status,
    reason,
    source: 'local-recorded-text',
    estimated: true,
    complete: false,
    userTokens: 0,
    assistantTokens: 0,
    toolTokens: 0,
    systemTokens: 0,
    matchedSteps: 0,
    compactionMarkers: 0,
    imageSteps: 0,
    totalTokens: 0,
  };
}

/**
 * Whitelist and normalize persisted or external transcript stats payloads.
 */
export function safeTranscriptStats(value: unknown): TranscriptStats | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!STATUSES.includes(v.status as TranscriptStatus) || (v.version !== undefined && v.version !== 1)) return null;
  const status = v.status as TranscriptStatus;
  const result: TranscriptStats = {
    version: 1,
    status,
    reason: REASONS.includes(v.reason as TranscriptReason) ? (v.reason as TranscriptReason) : null,
    source: 'local-recorded-text',
    estimated: true,
    complete: status === 'ready' && v.complete === true,
    userTokens: isNonNegInt(v.userTokens) ? v.userTokens : 0,
    assistantTokens: isNonNegInt(v.assistantTokens) ? v.assistantTokens : 0,
    toolTokens: isNonNegInt(v.toolTokens) ? v.toolTokens : 0,
    systemTokens: isNonNegInt(v.systemTokens) ? v.systemTokens : 0,
    matchedSteps: isNonNegInt(v.matchedSteps) ? v.matchedSteps : 0,
    compactionMarkers: isNonNegInt(v.compactionMarkers) ? v.compactionMarkers : 0,
    imageSteps: isNonNegInt(v.imageSteps) ? v.imageSteps : 0,
    totalTokens: 0,
  };
  result.totalTokens = result.userTokens + result.assistantTokens + result.toolTokens + result.systemTokens;
  if (!isNonNegInt(result.totalTokens)) return null;
  // Unknown/unavailable is not a measured zero, and malformed saved estimates
  // cannot claim complete coverage. Extra fields and arbitrary URLs are dropped.
  if (STAT_FIELDS.some((k) => !isNonNegInt(v[k]))) result.complete = false;
  if (result.matchedSteps > 8192 || result.compactionMarkers > result.matchedSteps || result.imageSteps > result.matchedSteps) {
    return null;
  }
  if (status === 'unavailable' || status === 'loading') {
    for (const k of STAT_FIELDS) result[k] = 0;
    result.totalTokens = 0;
    result.complete = false;
  }
  return result;
}

const timestamp = (value: unknown): number | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const timeQuantum = (value: unknown): number =>
  typeof value === 'string' ? 10 ** Math.max(0, 3 - (value.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1].length || 0)) : 1000;
const stepType = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= 128 ? value.replace(/^CORTEX_STEP_TYPE_/, '') : null;

export function buildBoundary(raw: unknown, maxRows: number): { active: BoundaryStep[] } | null {
  const r = raw as { trajectory?: { steps?: unknown }; steps?: unknown } | null | undefined;
  const steps = r?.trajectory?.steps ?? r?.steps;
  if (!Array.isArray(steps) || steps.length > maxRows) return null;
  return {
    active: steps.map((s) => {
      const step = s as { type?: unknown; metadata?: { createdAt?: unknown } } | null | undefined;
      return { type: stepType(step?.type), time: timestamp(step?.metadata?.createdAt), quantum: timeQuantum(step?.metadata?.createdAt) };
    }),
  };
}

export function summarizeTranscriptRecord(record: Record<string, unknown>): TranscriptRow | null {
  if (!isNonNegInt(record.step_index) || typeof record.type !== 'string' || !record.type.length || record.type.length > 128) return null;
  const type = stepType(record.type);
  const contentObj = record.content as { tokens?: unknown; prefix?: unknown } | undefined;
  const thinkingObj = record.thinking as { tokens?: unknown } | undefined;
  const content = contentObj?.tokens ?? 0;
  const thinking = thinkingObj?.tokens ?? 0;
  if (!isNonNegInt(content) || !isNonNegInt(thinking) || !isNonNegInt(content + thinking)) return null;
  const compaction =
    type === 'COMPACTION' ||
    type === 'CONTEXT_COMPACTION' ||
    (type === 'CHECKPOINT' &&
      typeof contentObj?.prefix === 'string' &&
      /^\s*(?:\[?context (?:summary|compaction)\]?|conversation (?:summary|checkpoint)|checkpoint summary|# Resuming from a compaction|<CONTEXT_SUMMARY>)/i.test(contentObj.prefix))
      ? 1
      : 0;
  const row: TranscriptRow = {
    index: record.step_index,
    type,
    time: timestamp(record.created_at),
    quantum: timeQuantum(record.created_at),
    userTokens: 0,
    assistantTokens: 0,
    toolTokens: 0,
    systemTokens: 0,
    compaction,
    image: type === 'GENERATE_IMAGE' || type === 'IMAGE_GENERATION' ? 1 : 0,
    unknown: false,
  };
  if (type === 'USER_INPUT') row.userTokens = content;
  else if (type === 'PLANNER_RESPONSE') row.assistantTokens = content + thinking;
  else if (type === 'SYSTEM_MESSAGE' || type === 'CHECKPOINT' || row.compaction) row.systemTokens = content;
  else if (type === 'GENERIC' || type === 'TOOL_RESULT' || type === 'TOOL_OUTPUT') row.toolTokens = content;
  else row.unknown = content > 0 || thinking > 0;
  return row;
}

export function aggregateTranscriptEntry(entry: Partial<TranscriptEntry>): TranscriptStats {
  if (!entry.boundary) return emptyStats('unavailable', 'invalid-boundary');
  if (entry.error) return emptyStats('unavailable', entry.error);
  if (!entry.state) return emptyStats('loading', 'reading');
  const s = entry.state;
  const out = emptyStats('partial', 'reading');
  let partial = s.invalid;
  let unmatched = false;
  for (const row of s.rows.values()) {
    const active = entry.boundary.active[row.index];
    if (!active) continue;
    const typeMatches = active.type === row.type || (row.type === 'GENERIC' && active.type !== null && genericHostTypes.has(active.type));
    const quantum = Math.max(active.quantum, row.quantum);
    const timeMatches = active.time === null || (row.time !== null && Math.floor(active.time / quantum) === Math.floor(row.time / quantum));
    if (!typeMatches || !timeMatches) { unmatched = true; continue; }
    if (active.time === null || row.time === null || active.quantum !== row.quantum || active.type !== row.type || row.unknown) partial = true;
    out.matchedSteps++;
    out.userTokens += row.userTokens;
    out.assistantTokens += row.assistantTokens;
    out.toolTokens += row.toolTokens;
    out.systemTokens += row.systemTokens;
    out.compactionMarkers += row.compaction;
    out.imageSteps += row.image;
  }
  out.totalTokens = out.userTokens + out.assistantTokens + out.toolTokens + out.systemTokens;
  const covered = out.matchedSteps === entry.boundary.active.length;
  if (s.limit) { out.reason = 'row-limit'; partial = true; }
  else if (unmatched || !covered) { out.reason = 'unmatched-record'; partial = true; }
  else if (s.invalid) { out.reason = 'invalid-record'; }
  else if (s.eof && s.lineStarted) { out.reason = 'incomplete-line'; partial = true; }
  else if (s.eof) { out.reason = null; }
  out.complete = s.eof && !s.lineStarted && !partial && covered;
  out.status = out.complete ? 'ready' : 'partial';
  return out;
}
