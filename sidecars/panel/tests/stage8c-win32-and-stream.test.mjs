import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProcesses } from '../discovery.mjs';
import { TranscriptReader } from '../transcript.mjs';
import * as nativeBridge from '../../../src/platform/native-bridge.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const SCOPE = 'a'.repeat(64);
const ts = (sec) => new Date(Date.UTC(2026, 10, 16, 0, 0, sec)).toISOString();

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    });
}

function makeRawBoundary(rows) {
  return {
    trajectory: {
      steps: rows.map((r) => ({
        type: r.type,
        metadata: { createdAt: r.created_at },
      })),
    },
  };
}

test('discovery.ts Win32 native fast-path parses processes/ports without spawning PowerShell', async () => {
  let runCalls = 0;
  const rows = await withEnv('PULSE_DISABLE_NATIVE_ACCEL', undefined, () =>
    discoverProcesses({
      platform: 'win32',
      nativeDiscover: () =>
        JSON.stringify({
          processes: [
            { pid: 4200, commandLine: 'language_server.exe --standalone --csrf_token=tok1', listenPorts: [42111, 42111, 0, 70000, 42112] },
            { pid: 4201, commandLine: 'language_server.exe --sidecar', listenPorts: [9999] },
            { pid: 4202, commandLine: 'language_server.exe --standalone=true --csrf_token=tok2', listenPorts: [] },
            { pid: -1, commandLine: 'language_server.exe --standalone', listenPorts: [1234] },
          ],
        }),
      run: async () => {
        runCalls++;
        return { stdout: '' };
      },
    }),
  );

  assert.equal(runCalls, 0);
  assert.deepEqual(rows, [
    { ProcessId: 4200, CommandLine: 'language_server.exe --standalone --csrf_token=tok1', Ports: [42111, 42112] },
    { ProcessId: 4202, CommandLine: 'language_server.exe --standalone=true --csrf_token=tok2', Ports: [] },
  ]);

  let emptyRunCalls = 0;
  const emptyRows = await withEnv('PULSE_DISABLE_NATIVE_ACCEL', undefined, () =>
    discoverProcesses({
      platform: 'win32',
      nativeDiscover: () => JSON.stringify({ processes: [] }),
      run: async () => {
        emptyRunCalls++;
        return { stdout: '' };
      },
    }),
  );
  assert.equal(emptyRunCalls, 0);
  assert.deepEqual(emptyRows, []);
});

test('discovery.ts falls back to PowerShell + netstat on native null, error, invalid JSON, or PULSE_DISABLE_NATIVE_ACCEL=1', async () => {
  const psFallbackRunner = (calls) => async (file) => {
    calls.push(file);
    if (file === 'powershell.exe') {
      return {
        stdout: JSON.stringify([
          { ProcessId: 77, CommandLine: 'language_server.exe --standalone --csrf_token=fallback' },
        ]),
      };
    }
    return { stdout: ' TCP 127.0.0.1:4567 0.0.0.0:0 LISTENING 77\n' };
  };

  for (const mode of ['null', 'throw', 'bad-json']) {
    const calls = [];
    const rows = await withEnv('PULSE_DISABLE_NATIVE_ACCEL', undefined, () =>
      discoverProcesses({
        platform: 'win32',
        nativeDiscover: () => {
          if (mode === 'null') return null;
          if (mode === 'throw') throw new Error('native probe boom');
          return '{broken json';
        },
        run: psFallbackRunner(calls),
      }),
    );
    assert.deepEqual(calls, ['powershell.exe', 'netstat.exe']);
    assert.deepEqual(rows, [
      { ProcessId: 77, CommandLine: 'language_server.exe --standalone --csrf_token=fallback', Ports: [4567] },
    ]);
  }

  const disabledCalls = [];
  let nativeCalled = false;
  const disabledRows = await withEnv('PULSE_DISABLE_NATIVE_ACCEL', '1', () =>
    discoverProcesses({
      platform: 'win32',
      nativeDiscover: () => {
        nativeCalled = true;
        return JSON.stringify({ processes: [{ pid: 99, commandLine: 'ls --standalone', listenPorts: [9999] }] });
      },
      run: psFallbackRunner(disabledCalls),
    }),
  );
  assert.equal(nativeCalled, false);
  assert.deepEqual(disabledCalls, ['powershell.exe', 'netstat.exe']);
  assert.equal(disabledRows[0].ProcessId, 77);

  if (typeof nativeBridge.tryDiscoverWin32ProcessesJson === 'function' && process.platform === 'win32') {
    const live = await withEnv('PULSE_DISABLE_NATIVE_ACCEL', undefined, () =>
      discoverProcesses({ platform: 'win32' }),
    );
    assert.ok(Array.isArray(live));
  }
});

test('transcript.ts native fast-path, fallback, and PULSE_DISABLE_NATIVE_ACCEL=1 maintain strict parity on large and malformed JSONL', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ag-stage8c-transcript-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, ID, '.system_generated', 'logs');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'transcript_full.jsonl');

  const bigArg = 'ARG_SECRET_'.repeat(1000);
  const rows = [
    { step_index: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', created_at: ts(0), content: '你好世界', media: ['m1'] },
    { step_index: 1, type: 'PLANNER_RESPONSE', created_at: ts(1), content: 'x'.repeat(20000), thinking: 'y'.repeat(8000), tool_calls: [{ name: 'read_file', arguments: bigArg }] },
    { step_index: 2, type: 'CHECKPOINT', created_at: ts(2), content: '# Resuming from a compaction\n' + 'z'.repeat(30000) },
    { step_index: 3, type: 'IMAGE_GENERATION', created_at: ts(3), content: 'img' },
    { step_index: 4, type: 'GENERIC', created_at: ts(4), content: 'abcd'.repeat(10000) },
  ];
  const malformedMiddle = 'NOT_JSON_LINE\n';
  const trailingPartial = `{"step_index":5,"type":"USER_INPUT","created_at":"${ts(5)}","content":"half`;
  await writeFile(
    file,
    rows.slice(0, 3).map((r) => JSON.stringify(r) + '\n').join('') +
      malformedMiddle +
      rows.slice(3).map((r) => JSON.stringify(r) + '\n').join('') +
      trailingPartial,
  );

  // Reference JS-only stats with PULSE_DISABLE_NATIVE_ACCEL=1
  const tsOnlyStats = await withEnv('PULSE_DISABLE_NATIVE_ACCEL', '1', async () => {
    const reader = new TranscriptReader({ root, bytesPerPass: 65536, passMs: 1000 });
    reader.request(SCOPE, ID, makeRawBoundary(rows));
    await reader.drain();
    return reader.peek(SCOPE, ID);
  });

  // Fallback when nativeScan throws or returns null
  const fallbackStats = await withEnv('PULSE_DISABLE_NATIVE_ACCEL', undefined, async () => {
    let calls = 0;
    const reader = new TranscriptReader({
      root,
      bytesPerPass: 65536,
      passMs: 1000,
      nativeScan: () => {
        calls++;
        if (calls === 1) throw new Error('simulated native error');
        return null;
      },
    });
    reader.request(SCOPE, ID, makeRawBoundary(rows));
    await reader.drain();
    assert.ok(calls >= 1);
    return reader.peek(SCOPE, ID);
  });
  assert.deepEqual(fallbackStats, tsOnlyStats);

  // Simulated/real native fast-path producing compact chunked scan results
  const tryNativeScan =
    nativeBridge.isNativeAccelAvailable() && typeof nativeBridge.tryScanTranscriptFileJson === 'function'
      ? nativeBridge.tryScanTranscriptFileJson
      : createReferenceChunkScanner();

  const nativeStats = await withEnv('PULSE_DISABLE_NATIVE_ACCEL', undefined, async () => {
    let scanCalls = 0;
    const reader = new TranscriptReader({
      root,
      bytesPerPass: 65536,
      passMs: 1000,
      nativeScan: (reqJson) => {
        scanCalls++;
        return tryNativeScan(reqJson);
      },
    });
    reader.request(SCOPE, ID, makeRawBoundary(rows));
    await reader.drain();
    assert.ok(scanCalls >= 2);
    return reader.peek(SCOPE, ID);
  });
  assert.deepEqual(nativeStats, tsOnlyStats);

  // Complete trailing line and verify rewrite invalidates anchors cleanly
  await appendFile(file, '"}\n');
  const completedReader = new TranscriptReader({
    root,
    bytesPerPass: 65536,
    passMs: 1000,
    nativeScan: tryNativeScan,
  });
  await withEnv('PULSE_DISABLE_NATIVE_ACCEL', undefined, async () => {
    const fullRows = [...rows, { step_index: 5, type: 'USER_INPUT', created_at: ts(5), content: 'half' }];
    completedReader.request(SCOPE, ID, makeRawBoundary(fullRows));
    await completedReader.drain();
    const afterComplete = completedReader.peek(SCOPE, ID);
    assert.equal(afterComplete.matchedSteps, 6);
    assert.equal(afterComplete.reason, 'invalid-record');

    // Rewrite file cleanly and ensure anchors reset stale rows
    const cleanRows = [{ step_index: 0, type: 'USER_INPUT', created_at: ts(0), content: 'abcdefgh' }];
    await writeFile(file, JSON.stringify(cleanRows[0]) + '\n');
    await utimes(file, new Date(), new Date(Date.now() + 1000));
    completedReader.request(SCOPE, ID, makeRawBoundary(cleanRows));
    await completedReader.drain();
    const afterRewrite = completedReader.peek(SCOPE, ID);
    assert.equal(afterRewrite.status, 'ready');
    assert.equal(afterRewrite.complete, true);
    assert.equal(afterRewrite.totalTokens, 2);
  });
});

function createReferenceChunkScanner() {
  // Synchronous JS mirror of transcript_scan.rs used only when native addon lacks the Wave 2 export yet.
  const fs = globalThis.process?.getBuiltinModule?.('node:fs');
  return (inputJson) => {
    if (!fs) return null;
    const req = JSON.parse(inputJson);
    const buf = fs.readFileSync(req.filePath);
    const offset = Math.min(req.offset ?? 0, buf.length);
    const endLimit = Math.min(buf.length, offset + (req.maxBytes ?? buf.length));
    const slice = buf.subarray(offset, endLimit);
    const lastNl = slice.lastIndexOf(0x0a);
    if (lastNl === -1 && endLimit < buf.length) {
      return JSON.stringify({
        nextOffset: offset,
        eof: false,
        needsChunkedFallback: true,
        incompleteTrailingLine: false,
        invalid: false,
        limit: false,
        anchors: [],
        rows: [],
      });
    }
    const committedEnd = lastNl === -1 ? endLimit : offset + lastNl + 1;
    const text = buf.subarray(offset, committedEnd).toString('utf8');
    const lines = text.split('\n');
    const hasTrailingPartial = lastNl === -1 && endLimit === buf.length && text.trim().length > 0;
    if (lastNl !== -1) lines.pop();
    else if (hasTrailingPartial) lines.pop();

    let invalid = false;
    let incompleteTrailingLine = hasTrailingPartial;
    if (hasTrailingPartial) {
      const tail = text.trim();
      if (!tail.startsWith('{')) invalid = true;
    }

    const outRows = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        invalid = true;
        continue;
      }
      if (!obj || typeof obj !== 'object' || !Number.isSafeInteger(obj.step_index) || obj.step_index < 0 || typeof obj.type !== 'string' || !obj.type) {
        invalid = true;
        continue;
      }
      const type = obj.type.replace(/^CORTEX_STEP_TYPE_/, '');
      const est = (v) => {
        if (typeof v !== 'string') return { tokens: 0, prefix: '' };
        const other = (v.match(/[^\x00-\x7f]/g) || []).length;
        return { tokens: Math.ceil((v.length - other) / 4 + other / 1.5), prefix: v.slice(0, 256) };
      };
      const c = est(obj.content);
      const th = est(obj.thinking);
      const compaction =
        type === 'COMPACTION' ||
        type === 'CONTEXT_COMPACTION' ||
        (type === 'CHECKPOINT' &&
          /^\s*(?:\[?context (?:summary|compaction)\]?|conversation (?:summary|checkpoint)|checkpoint summary|# Resuming from a compaction|<CONTEXT_SUMMARY>)/i.test(c.prefix))
          ? 1
          : 0;
      const row = {
        index: obj.step_index,
        type,
        createdAt: typeof obj.created_at === 'string' ? obj.created_at : null,
        userTokens: type === 'USER_INPUT' ? c.tokens : 0,
        assistantTokens: type === 'PLANNER_RESPONSE' ? c.tokens + th.tokens : 0,
        toolTokens: type === 'GENERIC' || type === 'TOOL_RESULT' || type === 'TOOL_OUTPUT' ? c.tokens : 0,
        systemTokens: type === 'SYSTEM_MESSAGE' || type === 'CHECKPOINT' || compaction ? c.tokens : 0,
        compaction,
        image: type === 'GENERATE_IMAGE' || type === 'IMAGE_GENERATION' ? 1 : 0,
        unknown: !['USER_INPUT', 'PLANNER_RESPONSE', 'SYSTEM_MESSAGE', 'CHECKPOINT', 'GENERIC', 'TOOL_RESULT', 'TOOL_OUTPUT'].includes(type) && !compaction && (c.tokens > 0 || th.tokens > 0),
      };
      outRows.push(row);
    }

    const anchors = [];
    const scanned = committedEnd - offset;
    if (scanned > 0) {
      const firstLen = Math.min(scanned, 65536);
      anchors.push({
        offset,
        length: firstLen,
        hash: createHash('sha256').update(buf.subarray(offset, offset + firstLen)).digest('hex'),
      });
    }

    return JSON.stringify({
      nextOffset: committedEnd,
      eof: committedEnd === buf.length,
      needsChunkedFallback: false,
      incompleteTrailingLine,
      invalid,
      limit: false,
      anchors,
      rows: outRows,
    });
  };
}
