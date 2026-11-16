import type { TimelineLane, TimelineSwimlaneItem } from '../../contracts/timeline.ts';

const DEFAULT_CONTAINER_WIDTH_PX = 600;
const DEFAULT_MIN_PX_WIDTH = 1.5;
const DEFAULT_MAX_SEGMENTS = 128;
const MIN_WIDTH_RATIO = 0.01;
const MIN_LEFT_PCT = 0;
const MAX_LEFT_PCT = 98.5;
const MIN_WIDTH_PCT = 1.5;

export interface SwimlaneInputItem {
  index?: number;
  kind?: TimelineLane | string | null;
  model?: string | null;
  modelLabel?: string | null;
  label?: string | null;
  phase?: string | null;
  toolName?: string | null;
  startMs?: number | null;
  endMs?: number | null;
  startRatio?: number | null;
  widthRatio?: number | null;
  stepStart?: number | null;
  stepEnd?: number | null;
  stepCount?: number | null;
  calls?: number | null;
  hasError?: boolean | null;
}

export interface CoalesceSwimlanesInput {
  lanes: readonly SwimlaneInputItem[];
  totalStartMs?: number | null;
  spanMs?: number | null;
  minPxWidth?: number | null;
  containerWidthPx?: number | null;
  maxSegments?: number | null;
}

export interface CoalescedSwimlaneItem extends TimelineSwimlaneItem {
  index: number;
  modelLabel?: string;
  phase?: string;
  toolName?: string;
  leftPct: number;
  widthPct: number;
  stepCount?: number;
  hasError: boolean;
}

export interface SwimlaneKindCounts {
  plan: number;
  worker: number;
  tool: number;
  subagent: number;
  handoff: number;
}

export interface SwimlaneCoalesceSummary {
  inputCount: number;
  outputCount: number;
  mergedCount: number;
  totalCalls: number;
  errorCount: number;
  byKind: SwimlaneKindCounts;
}

export interface CoalesceSwimlanesOutput {
  lanes: CoalescedSwimlaneItem[];
  totalStartMs: number;
  spanMs: number;
  summary: SwimlaneCoalesceSummary;
}

interface WorkingLane {
  origIndex: number;
  item: CoalescedSwimlaneItem;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function round2(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const sign = v < 0 ? -1 : 1;
  const scaled = Math.round(Math.abs(v) * 100);
  return scaled === 0 ? 0 : (sign * scaled) / 100;
}

function cleanOptStr(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toNonNegInt(val: unknown): number | undefined {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) return undefined;
  return Math.floor(val);
}

function parseLaneKind(kind: unknown, phase: unknown): TimelineLane {
  for (const candidate of [kind, phase]) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (
      trimmed === 'plan' ||
      trimmed === 'worker' ||
      trimmed === 'tool' ||
      trimmed === 'subagent' ||
      trimmed === 'handoff'
    ) {
      return trimmed;
    }
  }
  return 'worker';
}

function trackRank(kind: TimelineLane): number {
  switch (kind) {
    case 'plan':
      return 0;
    case 'worker':
      return 1;
    case 'tool':
      return 2;
    case 'subagent':
      return 3;
    case 'handoff':
      return 4;
  }
}

function recomputeRatios(
  item: CoalescedSwimlaneItem,
  totalStartMs: number,
  spanMs: number,
): void {
  const startRatio = clamp01((item.startMs - totalStartMs) / spanMs);
  const rawWidth = clamp01((item.endMs - item.startMs) / spanMs);
  const widthRatio =
    item.endMs === item.startMs && item.kind === 'handoff'
      ? MIN_WIDTH_RATIO
      : Math.max(MIN_WIDTH_RATIO, rawWidth);
  const leftPct = round2(Math.min(MAX_LEFT_PCT, Math.max(MIN_LEFT_PCT, startRatio * 100)));
  const widthPct = round2(Math.min(100 - leftPct, Math.max(MIN_WIDTH_PCT, widthRatio * 100)));
  item.startRatio = startRatio;
  item.widthRatio = widthRatio;
  item.leftPct = leftPct;
  item.widthPct = widthPct;
}

function mergeInto(
  prev: CoalescedSwimlaneItem,
  curr: CoalescedSwimlaneItem,
  totalStartMs: number,
  spanMs: number,
): void {
  if (curr.startMs < prev.startMs) prev.startMs = curr.startMs;
  if (curr.endMs > prev.endMs) prev.endMs = curr.endMs;
  prev.stepStart = Math.min(prev.stepStart, curr.stepStart);
  prev.stepEnd = Math.max(prev.stepEnd, curr.stepEnd);
  prev.calls += curr.calls;
  if (prev.stepCount !== undefined || curr.stepCount !== undefined) {
    prev.stepCount = (prev.stepCount ?? 0) + (curr.stepCount ?? 0);
  }
  prev.hasError = prev.hasError || curr.hasError;
  if (prev.model !== curr.model) {
    prev.model = null;
    prev.modelLabel = 'mixed';
    if (prev.kind !== 'tool') {
      prev.label = 'mixed';
    }
  } else if (prev.modelLabel === undefined && curr.modelLabel !== undefined) {
    prev.modelLabel = curr.modelLabel;
  }
  if (prev.phase !== curr.phase) {
    delete prev.phase;
  }
  if (prev.toolName !== undefined && curr.toolName !== undefined && prev.toolName !== curr.toolName) {
    prev.toolName = 'mixed';
  } else if (prev.toolName === undefined && curr.toolName !== undefined) {
    prev.toolName = curr.toolName;
  }
  if (
    prev.kind === 'tool' &&
    prev.label.endsWith(' tools') &&
    curr.label.endsWith(' tools')
  ) {
    prev.label = `${prev.calls} tools`;
  }
  recomputeRatios(prev, totalStartMs, spanMs);
}

/**
 * Pure-TS swimlane coalescer with 100% parity to `svg_compiler::coalesce_swimlanes`.
 */
export function coalesceSwimlanesFallback(
  input: CoalesceSwimlanesInput,
): CoalesceSwimlanesOutput {
  const rawLanes = Array.isArray(input?.lanes) ? input.lanes : [];
  const inputCount = rawLanes.length;
  const containerWidthPx =
    typeof input?.containerWidthPx === 'number' &&
    Number.isFinite(input.containerWidthPx) &&
    input.containerWidthPx > 0
      ? input.containerWidthPx
      : DEFAULT_CONTAINER_WIDTH_PX;
  const minPxWidth =
    typeof input?.minPxWidth === 'number' &&
    Number.isFinite(input.minPxWidth) &&
    input.minPxWidth >= 0
      ? input.minPxWidth
      : DEFAULT_MIN_PX_WIDTH;
  const minGapRatio = clamp01(minPxWidth / containerWidthPx);
  const maxSegments =
    typeof input?.maxSegments === 'number' &&
    Number.isFinite(input.maxSegments) &&
    input.maxSegments >= 1
      ? Math.floor(input.maxSegments)
      : DEFAULT_MAX_SEGMENTS;

  const normalized: WorkingLane[] = [];
  for (let origIndex = 0; origIndex < rawLanes.length; origIndex++) {
    const raw = rawLanes[origIndex] || {};
    const phase = cleanOptStr(raw.phase);
    const kind = parseLaneKind(raw.kind, phase);
    const model = cleanOptStr(raw.model) ?? null;
    const modelLabel = cleanOptStr(raw.modelLabel);
    const toolName = cleanOptStr(raw.toolName);
    const label = cleanOptStr(raw.label) ?? modelLabel ?? model ?? kind;
    const startMs =
      typeof raw.startMs === 'number' && Number.isFinite(raw.startMs) && raw.startMs >= 0
        ? raw.startMs
        : 0;
    const endMs =
      typeof raw.endMs === 'number' && Number.isFinite(raw.endMs) && raw.endMs >= startMs
        ? raw.endMs
        : startMs;
    const stepStart = toNonNegInt(raw.stepStart) ?? 0;
    const stepEnd = Math.max(stepStart, toNonNegInt(raw.stepEnd) ?? stepStart);
    const stepCount = toNonNegInt(raw.stepCount);
    const calls = toNonNegInt(raw.calls) ?? stepCount ?? 1;
    const hasError = raw.hasError === true;

    const item: CoalescedSwimlaneItem = {
      index: 0,
      kind,
      model,
      label,
      startMs,
      endMs,
      startRatio: 0,
      widthRatio: MIN_WIDTH_RATIO,
      leftPct: 0,
      widthPct: MIN_WIDTH_PCT,
      stepStart,
      stepEnd,
      calls,
      hasError,
    };
    if (modelLabel !== undefined) item.modelLabel = modelLabel;
    if (phase !== undefined) item.phase = phase;
    if (toolName !== undefined) item.toolName = toolName;
    if (stepCount !== undefined) item.stepCount = stepCount;

    normalized.push({
      origIndex: toNonNegInt(raw.index) ?? origIndex,
      item,
    });
  }

  let totalStartMs: number;
  if (typeof input?.totalStartMs === 'number' && Number.isFinite(input.totalStartMs)) {
    totalStartMs = input.totalStartMs;
  } else if (normalized.length === 0) {
    totalStartMs = 0;
  } else {
    totalStartMs = normalized[0].item.startMs;
    for (let i = 1; i < normalized.length; i++) {
      if (normalized[i].item.startMs < totalStartMs) totalStartMs = normalized[i].item.startMs;
    }
  }

  let spanMs: number;
  if (typeof input?.spanMs === 'number' && Number.isFinite(input.spanMs)) {
    spanMs = Math.max(1, input.spanMs);
  } else if (normalized.length === 0) {
    spanMs = 1;
  } else {
    let maxEnd = totalStartMs;
    for (const entry of normalized) {
      if (entry.item.endMs > maxEnd) maxEnd = entry.item.endMs;
    }
    spanMs = Math.max(1, maxEnd - totalStartMs);
  }

  const tracks: WorkingLane[][] = [[], [], [], [], []];
  for (const entry of normalized) {
    recomputeRatios(entry.item, totalStartMs, spanMs);
    tracks[trackRank(entry.item.kind)].push(entry);
  }

  const coalescedTracks: CoalescedSwimlaneItem[][] = [[], [], [], [], []];
  for (let ti = 0; ti < 5; ti++) {
    const track = tracks[ti];
    track.sort(
      (a, b) =>
        a.item.startMs - b.item.startMs ||
        a.item.endMs - b.item.endMs ||
        a.item.stepStart - b.item.stepStart ||
        a.origIndex - b.origIndex,
    );
    const outTrack = coalescedTracks[ti];
    const lastByKey = new Map<string, number>();
    for (const entry of track) {
      const key = JSON.stringify([entry.item.model, entry.item.phase ?? null]);
      const prevIdx = lastByKey.get(key);
      const canMerge =
        prevIdx !== undefined &&
        entry.item.startRatio -
          Math.min(1, outTrack[prevIdx].startRatio + outTrack[prevIdx].widthRatio) <=
          minGapRatio;
      if (canMerge && prevIdx !== undefined) {
        mergeInto(outTrack[prevIdx], entry.item, totalStartMs, spanMs);
      } else {
        lastByKey.set(key, outTrack.length);
        outTrack.push({ ...entry.item });
      }
    }
    outTrack.sort(
      (a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.stepStart - b.stepStart,
    );
  }

  for (;;) {
    let total = 0;
    for (const t of coalescedTracks) total += t.length;
    if (total <= maxSegments) break;

    let bestSame: { ti: number; idx: number; jdx: number; gap: number } | null = null;
    let bestAny: { ti: number; idx: number; gap: number } | null = null;

    for (let ti = 0; ti < 5; ti++) {
      const track = coalescedTracks[ti];
      for (let i = 0; i < track.length; i++) {
        const prev = track[i];
        for (let j = i + 1; j < track.length; j++) {
          const curr = track[j];
          if (prev.model === curr.model && prev.phase === curr.phase) {
            const gap = curr.startRatio - Math.min(1, prev.startRatio + prev.widthRatio);
            if (!bestSame || gap < bestSame.gap) {
              bestSame = { ti, idx: i, jdx: j, gap };
            }
            break;
          }
        }
        if (i + 1 < track.length) {
          const curr = track[i + 1];
          const gap = curr.startRatio - Math.min(1, prev.startRatio + prev.widthRatio);
          if (!bestAny || gap < bestAny.gap) {
            bestAny = { ti, idx: i, gap };
          }
        }
      }
    }

    if (bestSame) {
      const [curr] = coalescedTracks[bestSame.ti].splice(bestSame.jdx, 1);
      mergeInto(coalescedTracks[bestSame.ti][bestSame.idx], curr, totalStartMs, spanMs);
    } else if (bestAny) {
      const [curr] = coalescedTracks[bestAny.ti].splice(bestAny.idx + 1, 1);
      mergeInto(coalescedTracks[bestAny.ti][bestAny.idx], curr, totalStartMs, spanMs);
    } else {
      break;
    }
  }

  const out: CoalescedSwimlaneItem[] = coalescedTracks.flat();
  out.sort(
    (a, b) =>
      a.startMs - b.startMs ||
      trackRank(a.kind) - trackRank(b.kind) ||
      a.endMs - b.endMs ||
      a.stepStart - b.stepStart,
  );

  let totalCalls = 0;
  let errorCount = 0;
  const byKind: SwimlaneKindCounts = {
    plan: 0,
    worker: 0,
    tool: 0,
    subagent: 0,
    handoff: 0,
  };

  for (let idx = 0; idx < out.length; idx++) {
    const item = out[idx];
    item.index = idx;
    totalCalls += item.calls;
    if (item.hasError) errorCount += 1;
    byKind[item.kind] += 1;
  }

  return {
    lanes: out,
    totalStartMs,
    spanMs,
    summary: {
      inputCount,
      outputCount: out.length,
      mergedCount: Math.max(0, inputCount - out.length),
      totalCalls,
      errorCount,
      byKind,
    },
  };
}

export function coalesceSwimlanesFallbackJson(inputJson: string): string {
  const parsed = JSON.parse(inputJson) as CoalesceSwimlanesInput;
  return JSON.stringify(coalesceSwimlanesFallback(parsed));
}
