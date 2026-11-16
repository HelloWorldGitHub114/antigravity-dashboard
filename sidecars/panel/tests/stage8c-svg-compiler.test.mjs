import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nativeBridge from '../../../src/platform/native-bridge.ts';
import {
  coalesceSwimlanesFallback,
  coalesceSwimlanesFallbackJson,
} from '../../../src/telemetry/timeline/swimlane-coalesce.ts';
import {
  buildModelTimeline,
  coalesceSwimlanes,
} from '../../../src/telemetry/timeline/swimlane.ts';
import {
  countTimelineNodes,
  MAX_TIMELINE_BYTES,
  MAX_TIMELINE_NODES,
} from '../../../src/telemetry/timeline/compactor.ts';
import { compileCatmullRomSvgPathFallback } from '../../../src/ui/usage-modal/hourly-spline.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ADDON_PATH = process.env.PULSE_ACCEL_PATH
  ? resolve(process.env.PULSE_ACCEL_PATH)
  : join(ROOT, 'sidecars', 'panel', 'pulse-accel.node');

function loadRawAddon() {
  if (process.env.PULSE_DISABLE_NATIVE_ACCEL === '1') return null;
  if (!existsSync(ADDON_PATH)) return null;
  try {
    const req = createRequire(import.meta.url);
    return req(ADDON_PATH);
  } catch {
    return null;
  }
}

function withNativeDisabled(fn) {
  const prev = process.env.PULSE_DISABLE_NATIVE_ACCEL;
  process.env.PULSE_DISABLE_NATIVE_ACCEL = '1';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PULSE_DISABLE_NATIVE_ACCEL;
    else process.env.PULSE_DISABLE_NATIVE_ACCEL = prev;
  }
}

test('Stage 8C-1: hourly-spline.ts remains pure browser-safe without native-bridge or node:* imports', () => {
  const src = readFileSync(join(ROOT, 'src', 'ui', 'usage-modal', 'hourly-spline.ts'), 'utf8');
  assert.doesNotMatch(src, /native-bridge/);
  assert.doesNotMatch(src, /['"]node:/);
});

test('Stage 8C-1: coalesceSwimlanesFallback edge cases (empty, zero span, tiny segments, gap coalescing, cross-model)', () => {
  const empty = coalesceSwimlanesFallback({ lanes: [] });
  assert.deepEqual(empty.lanes, []);
  assert.equal(empty.totalStartMs, 0);
  assert.equal(empty.spanMs, 1);
  assert.equal(empty.summary.inputCount, 0);
  assert.equal(empty.summary.outputCount, 0);
  assert.equal(empty.summary.mergedCount, 0);

  const zeroSpan = coalesceSwimlanesFallback({
    totalStartMs: 5000,
    spanMs: 0,
    lanes: [
      { kind: 'worker', model: 'Gemini Flash', startMs: 5000, endMs: 5000, stepStart: 1, stepEnd: 1, calls: 1 },
      { kind: 'worker', model: 'Gemini Flash', startMs: 5000, endMs: 5000, stepStart: 2, stepEnd: 2, calls: 2 },
      { kind: 'handoff', model: 'Gemini Pro', label: 'Flash -> Pro', startMs: 5000, endMs: 5000, stepStart: 3, stepEnd: 3, calls: 1 },
    ],
  });
  assert.equal(zeroSpan.spanMs, 1);
  assert.equal(zeroSpan.lanes.length, 2);
  assert.equal(zeroSpan.lanes[0].kind, 'worker');
  assert.equal(zeroSpan.lanes[0].calls, 3);
  assert.equal(zeroSpan.lanes[0].leftPct, 0);
  assert.equal(zeroSpan.lanes[0].widthPct, 1.5);
  assert.equal(zeroSpan.lanes[1].kind, 'handoff');

  const mixed = coalesceSwimlanesFallback({
    totalStartMs: 0,
    spanMs: 10_000,
    minPxWidth: 1.5,
    containerWidthPx: 600,
    lanes: [
      {
        index: 0,
        kind: 'tool',
        model: 'Gemini Flash',
        modelLabel: 'Flash',
        label: '2 tools',
        phase: 'worker',
        toolName: 'read_file',
        startMs: 0,
        endMs: 5,
        stepStart: 1,
        stepEnd: 2,
        stepCount: 2,
        calls: 2,
        hasError: false,
      },
      {
        index: 1,
        kind: 'tool',
        model: 'Gemini Flash',
        modelLabel: 'Flash',
        label: '3 tools',
        phase: 'worker',
        toolName: 'edit_file',
        startMs: 40,
        endMs: 50,
        stepStart: 3,
        stepEnd: 4,
        stepCount: 3,
        calls: 3,
        hasError: true,
      },
      {
        index: 2,
        kind: 'tool',
        model: 'Gemini Pro',
        label: '1 tools',
        toolName: 'grep_search',
        startMs: 10,
        endMs: 20,
        stepStart: 5,
        stepEnd: 5,
        calls: 1,
      },
      {
        index: 3,
        kind: 'tool',
        model: 'Gemini Flash',
        label: '1 tools',
        phase: 'worker',
        toolName: 'read_file',
        startMs: 5000,
        endMs: 6000,
        stepStart: 10,
        stepEnd: 10,
        stepCount: 1,
        calls: 1,
      },
    ],
  });

  assert.equal(mixed.summary.inputCount, 4);
  assert.equal(mixed.summary.outputCount, 3);
  assert.equal(mixed.summary.mergedCount, 1);
  assert.equal(mixed.summary.totalCalls, 7);
  assert.equal(mixed.summary.errorCount, 1);
  assert.deepEqual(mixed.summary.byKind, { plan: 0, worker: 0, tool: 3, subagent: 0, handoff: 0 });

  assert.equal(mixed.lanes[0].index, 0);
  assert.equal(mixed.lanes[0].label, '5 tools');
  assert.equal(mixed.lanes[0].toolName, 'mixed');
  assert.equal(mixed.lanes[0].stepStart, 1);
  assert.equal(mixed.lanes[0].stepEnd, 4);
  assert.equal(mixed.lanes[0].stepCount, 5);
  assert.equal(mixed.lanes[0].calls, 5);
  assert.equal(mixed.lanes[0].hasError, true);
  assert.equal(mixed.lanes[1].model, 'Gemini Pro');
  assert.equal(mixed.lanes[2].startMs, 5000);
});

test('Stage 8C-1: coalesceSwimlanes native vs PULSE_DISABLE_NATIVE_ACCEL=1 TS fallback parity', () => {
  const payload = {
    totalStartMs: 1_700_000_000_000,
    spanMs: 120_000,
    minPxWidth: 1.5,
    containerWidthPx: 600,
    lanes: [
      {
        kind: 'plan',
        model: 'Orchestrator (Argon)',
        label: 'Orchestrator (Argon)',
        startMs: 1_700_000_000_000,
        endMs: 1_700_000_010_000,
        stepStart: 1,
        stepEnd: 4,
        calls: 2,
      },
      {
        kind: 'handoff',
        model: 'Gemini Flash',
        label: 'Orchestrator (Argon) -> Gemini Flash',
        startMs: 1_700_000_010_100,
        endMs: 1_700_000_010_100,
        stepStart: 5,
        stepEnd: 5,
        calls: 1,
      },
      ...Array.from({ length: 160 }, (_, idx) => ({
        kind: idx % 2 === 0 ? 'worker' : 'tool',
        model: 'Gemini Flash',
        label: idx % 2 === 0 ? 'Gemini Flash' : '2 tools',
        startMs: 1_700_000_011_000 + idx * 600,
        endMs: 1_700_000_011_250 + idx * 600,
        stepStart: 6 + idx,
        stepEnd: 6 + idx,
        calls: idx % 2 === 0 ? 1 : 2,
        hasError: idx === 17,
      })),
    ],
  };

  const payloadJson = JSON.stringify(payload);
  const tsParsed = JSON.parse(coalesceSwimlanesFallbackJson(payloadJson));
  const viaDisabledBridge = withNativeDisabled(() => coalesceSwimlanes(payload));
  assert.deepEqual(viaDisabledBridge, tsParsed);
  assert.ok(tsParsed.lanes.length <= 128, `expected bounded <= 128 lanes, got ${tsParsed.lanes.length}`);

  const addon = loadRawAddon();
  const nativeFn =
    nativeBridge.isNativeAccelAvailable() && typeof nativeBridge.tryCoalesceSwimlanesJson === 'function'
      ? nativeBridge.tryCoalesceSwimlanesJson
      : typeof addon?.coalesceSwimlanesJson === 'function'
        ? addon.coalesceSwimlanesJson
        : null;

  if (nativeFn && process.env.PULSE_DISABLE_NATIVE_ACCEL !== '1') {
    const nativeJson = nativeFn(payloadJson);
    assert.equal(typeof nativeJson, 'string');
    const nativeParsed = JSON.parse(nativeJson);
    assert.deepEqual(nativeParsed, tsParsed);
    assert.deepEqual(coalesceSwimlanes(payload), tsParsed);
  }
});

test('Stage 8C-1: buildModelTimeline integrates swimlane coalescing for >120 lanes without breaking compactor contracts', () => {
  const steps = [];
  const gens = [];
  for (let i = 0; i < 150; i++) {
    const sUser = i * 3;
    const sPlan = sUser + 1;
    const sTool = sUser + 2;
    steps.push({
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: new Date(1_700_000_000_000 + i * 2000).toISOString() },
    });
    steps.push({
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: new Date(1_700_000_000_100 + i * 2000).toISOString(), generatorModel: 'MODEL_PLACEHOLDER_M669' },
      plannerResponse: { response: 'ok', toolCalls: [{ name: 'read_file' }] },
    });
    steps.push({
      type: 'CORTEX_STEP_TYPE_VIEW_FILE',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: {
        startedAt: new Date(1_700_000_000_150 + i * 2000).toISOString(),
        completedAt: new Date(1_700_000_000_300 + i * 2000).toISOString(),
        toolCall: { name: 'read_file' },
      },
    });
    gens.push({
      stepIndices: [sPlan, sTool],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M669',
        streamingDuration: '0.2s',
        usage: { responseId: `g-${i}`, apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', inputTokens: '10', outputTokens: '5' },
      },
    });
  }

  const snap = withNativeDisabled(() =>
    buildModelTimeline({
      trajectory: {
        cascadeId: '11111111-1111-4111-8111-111111111111',
        steps,
        generatorMetadata: gens,
      },
    }),
  );
  assert.ok(snap);
  assert.equal(snap.enabled, true);
  assert.ok(snap.swimlanes.length > 0 && snap.swimlanes.length <= 128);
  assert.ok(countTimelineNodes(snap.nodes) <= MAX_TIMELINE_NODES);
  assert.ok(Buffer.byteLength(JSON.stringify(snap), 'utf8') <= MAX_TIMELINE_BYTES);
  for (const lane of snap.swimlanes) {
    assert.ok(['plan', 'worker', 'tool', 'subagent', 'handoff'].includes(lane.kind));
    assert.ok(lane.startRatio >= 0 && lane.startRatio <= 1);
    assert.ok(lane.widthRatio >= 0 && lane.widthRatio <= 1);
  }
});

test('Stage 8C-1: compileCatmullRomSvgPathFallback parity across 0, 1, 2, 10, and 24 points (plus native when available)', () => {
  const padL = 40;
  const padT = 15;
  const wPlot = 560;
  const hPlot = 90;
  const baselineY = padT + hPlot;

  const makePoints = (values) => {
    const maxVal = Math.max(1, ...values);
    const denom = Math.max(1, values.length - 1);
    return values.map((val, idx) => ({
      x: padL + (idx / denom) * wPlot,
      y: baselineY - (val / maxVal) * hPlot,
      val,
    }));
  };

  const cases = [
    { name: '0 points', points: [], baselineY, tension: 0.5 },
    { name: '1 point', points: [{ x: 40, y: 60, val: 50 }], baselineY, tension: 0.5 },
    { name: '2 points', points: makePoints([0, 100]), baselineY, tension: 0.5, minY: padT },
    { name: '10 points with zero valleys and plateau', points: makePoints([0, 25, 100, 100, 0, 0, 40, 80, 10, 0]), baselineY, tension: 0.5, minY: padT },
    {
      name: '24 hourly points',
      points: makePoints([
        0, 0, 120, 450, 980, 1200, 1200, 0,
        30, 540, 890, 1110, 760, 0, 0, 210,
        640, 990, 430, 120, 45, 0, 15, 5,
      ]),
      baselineY,
      tension: 0.5,
      minY: padT,
    },
    {
      name: '24 all-zero hourly points',
      points: makePoints(Array(24).fill(0)),
      baselineY,
      tension: 0.5,
      minY: padT,
    },
  ];

  // 0 points
  const res0 = compileCatmullRomSvgPathFallback(cases[0].points, cases[0].baselineY, cases[0].tension);
  assert.deepEqual(res0, { pathD: '', areaD: '' });

  // 1 point
  const res1 = compileCatmullRomSvgPathFallback(cases[1].points, cases[1].baselineY, cases[1].tension);
  assert.equal(res1.pathD, 'M 40.0,60.0');
  assert.equal(res1.areaD, 'M 40.0,60.0 L 40.0,105.0 L 40.0,105.0 Z');

  // 2 points
  const res2 = compileCatmullRomSvgPathFallback(cases[2].points, cases[2].baselineY, cases[2].tension, cases[2].minY);
  assert.equal(res2.pathD, 'M 40.0,105.0 C 133.3,105.0 506.7,30.0 600.0,15.0');
  assert.equal(res2.areaD, `${res2.pathD} L 600.0,105.0 L 40.0,105.0 Z`);

  // 10 & 24 points clamping invariants
  for (const c of cases.slice(3)) {
    const out = compileCatmullRomSvgPathFallback(c.points, c.baselineY, c.tension, c.minY);
    assert.ok(out.pathD.startsWith('M '), `${c.name} starts with M`);
    assert.ok(out.areaD.endsWith(' Z'), `${c.name} ends with Z`);
    const yValues = [...out.pathD.matchAll(/,(-?\d+\.\d+)/g)].map((m) => Number(m[1]));
    for (const y of yValues) {
      assert.ok(y >= padT && y <= baselineY, `${c.name} y=${y} within [${padT}, ${baselineY}]`);
    }
  }

  // Native parity check when compiled into addon
  const addon = loadRawAddon();
  const nativeSplineFn =
    nativeBridge.isNativeAccelAvailable() && typeof nativeBridge.compileCatmullRomSvgPathJson === 'function'
      ? nativeBridge.compileCatmullRomSvgPathJson
      : typeof addon?.compileCatmullRomSvgPathJson === 'function'
        ? addon.compileCatmullRomSvgPathJson
        : null;

  if (nativeSplineFn && process.env.PULSE_DISABLE_NATIVE_ACCEL !== '1') {
    for (const c of cases) {
      const browserRes = compileCatmullRomSvgPathFallback(c.points, c.baselineY, c.tension, c.minY);
      const nativeJson = nativeSplineFn(
        JSON.stringify({
          points: c.points,
          baselineY: c.baselineY,
          tension: c.tension,
          ...(c.minY !== undefined ? { minY: c.minY } : {}),
        }),
      );
      assert.equal(typeof nativeJson, 'string');
      assert.deepEqual(JSON.parse(nativeJson), browserRes, `native/browser spline parity for ${c.name}`);
    }
  }
});
