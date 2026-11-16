import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import {
  isNativeAccelAvailable,
  rotateLogTailNative,
} from '../../../src/platform/native-bridge.ts';
import { appendBoundedLogLine, rotateLogTail } from '../../../src/shared/logger.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function listTmpFiles(dir) {
  return readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

async function runWithNativeAndFallback(t, setupFn) {
  const dirNative = await mkdtemp(join(tmpdir(), 'ag-rot-native-'));
  const dirFallback = await mkdtemp(join(tmpdir(), 'ag-rot-ts-'));
  t.after(async () => {
    await rm(dirNative, { recursive: true, force: true });
    await rm(dirFallback, { recursive: true, force: true });
  });
  return { dirNative, dirFallback, ...(await setupFn(dirNative, dirFallback)) };
}

test('native availability matches PULSE_DISABLE_NATIVE_ACCEL env', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-rot-avail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sample = join(dir, 'sample.log');
  writeFileSync(sample, 'a\nb\nc\n');

  if (process.env.PULSE_DISABLE_NATIVE_ACCEL === '1') {
    assert.equal(isNativeAccelAvailable(), false);
    assert.equal(rotateLogTailNative(sample, 1, 1), null);
  } else if (existsSync(join(REPO, 'sidecars', 'panel', 'pulse-accel.node'))) {
    assert.equal(isNativeAccelAvailable(), true);
  } else {
    t.skip('native pulse-accel addon binary is not built in this workspace');
  }
});

test('rotateLogTail parity across missing, below-threshold, exact, CRLF, no-trailing-LF, and keepLines=0', async (t) => {
  const cases = [
    {
      name: 'below threshold',
      initial: Buffer.from('line1\nline2\n'),
      maxBytes: 12,
      keepLines: 1,
      expectedRotated: false,
      expectedBytes: Buffer.from('line1\nline2\n'),
    },
    {
      name: 'exact keepLines with trailing LF',
      initial: Buffer.from('l1\nl2\nl3\n'),
      maxBytes: 1,
      keepLines: 3,
      expectedRotated: false,
      expectedBytes: Buffer.from('l1\nl2\nl3\n'),
    },
    {
      name: 'truncate keeping 3 lines with trailing LF',
      initial: Buffer.from('l1\nl2\nl3\nl4\nl5\n'),
      maxBytes: 5,
      keepLines: 3,
      expectedRotated: true,
      expectedBytes: Buffer.from('l3\nl4\nl5\n'),
    },
    {
      name: 'CRLF preservation',
      initial: Buffer.from('a\r\nb\r\nc\r\nd\r\n'),
      maxBytes: 4,
      keepLines: 2,
      expectedRotated: true,
      expectedBytes: Buffer.from('c\r\nd\r\n'),
    },
    {
      name: 'no trailing newline',
      initial: Buffer.from('one\ntwo\nthree\nfour'),
      maxBytes: 4,
      keepLines: 2,
      expectedRotated: true,
      expectedBytes: Buffer.from('three\nfour'),
    },
    {
      name: 'keepLines=0 truncates to empty',
      initial: Buffer.from('alpha\nbeta\ngamma\n'),
      maxBytes: 1,
      keepLines: 0,
      expectedRotated: true,
      expectedBytes: Buffer.alloc(0),
    },
    {
      name: 'chunk seam boundary (64 KiB)',
      initial: Buffer.concat([
        Buffer.from(`${'x'.repeat(65530)}\n`),
        Buffer.from('seam-a\nseam-b\n'),
      ]),
      maxBytes: 100,
      keepLines: 2,
      expectedRotated: true,
      expectedBytes: Buffer.from('seam-a\nseam-b\n'),
    },
  ];

  await runWithNativeAndFallback(t, async (dirNative, dirFallback) => {
    assert.equal(rotateLogTail(join(dirNative, 'missing.log'), 100, 5, { allowNative: true }), false);
    assert.equal(rotateLogTail(join(dirFallback, 'missing.log'), 100, 5, { allowNative: false }), false);

    for (const [idx, c] of cases.entries()) {
      const fNative = join(dirNative, `case-${idx}.log`);
      const fFallback = join(dirFallback, `case-${idx}.log`);
      writeFileSync(fNative, c.initial);
      writeFileSync(fFallback, c.initial);

      const resNative = rotateLogTail(fNative, c.maxBytes, c.keepLines, { allowNative: true });
      const resFallback = rotateLogTail(fFallback, c.maxBytes, c.keepLines, { allowNative: false });

      assert.equal(resNative, c.expectedRotated, `${c.name} (native rotated)`);
      assert.equal(resFallback, c.expectedRotated, `${c.name} (fallback rotated)`);
      assert.deepEqual(readFileSync(fNative), c.expectedBytes, `${c.name} (native bytes)`);
      assert.deepEqual(readFileSync(fFallback), c.expectedBytes, `${c.name} (fallback bytes)`);
    }

    assert.deepEqual(listTmpFiles(dirNative), []);
    assert.deepEqual(listTmpFiles(dirFallback), []);
    return {};
  });
});

test('multi-MiB log tail truncation parity (> 2.5 MiB)', async (t) => {
  await runWithNativeAndFallback(t, async (dirNative, dirFallback) => {
    const lines = [];
    for (let i = 0; i < 25000; i++) {
      lines.push(`line-${String(i).padStart(5, '0')}-${'0123456789abcdef'.repeat(6)}\n`);
    }
    const payload = Buffer.from(lines.join(''), 'utf8');
    assert.ok(payload.byteLength > 2.5 * 1024 * 1024);

    const fNative = join(dirNative, 'huge.log');
    const fFallback = join(dirFallback, 'huge.log');
    writeFileSync(fNative, payload);
    writeFileSync(fFallback, payload);

    const rotatedNative = rotateLogTail(fNative, 1024 * 1024, 500, { allowNative: true });
    const rotatedFallback = rotateLogTail(fFallback, 1024 * 1024, 500, { allowNative: false });

    assert.equal(rotatedNative, true);
    assert.equal(rotatedFallback, true);

    const outNative = readFileSync(fNative, 'utf8');
    const outFallback = readFileSync(fFallback, 'utf8');
    assert.equal(outNative, outFallback);

    const outLines = outNative.trimEnd().split('\n');
    assert.equal(outLines.length, 500);
    assert.ok(outLines[0].startsWith('line-24500-'));
    assert.ok(outLines[499].startsWith('line-24999-'));
    assert.deepEqual(listTmpFiles(dirNative), []);
    assert.deepEqual(listTmpFiles(dirFallback), []);
    return {};
  });
});

test('appendBoundedLogLine serializes concurrent writes and bounds size', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-rot-append-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const outputs = [];
  for (const allowNative of [true, false]) {
    const logFile = join(dir, 'nested', `concurrent-${allowNative ? 'native' : 'ts'}.log`);
    const tasks = [];
    for (let i = 0; i < 40; i++) {
      tasks.push(
        appendBoundedLogLine(
          logFile,
          `entry-${String(i).padStart(2, '0')}-${'z'.repeat(40)}\n`,
          { maxBytes: 400, keepLines: 5, allowNative },
        ),
      );
    }
    await Promise.all(tasks);

    const text = await readFile(logFile, 'utf8');
    const kept = text.trimEnd().split('\n');
    assert.ok(kept.length >= 5 && kept.length <= 8, `expected 5..8 kept lines, got ${kept.length}`);
    const firstIdx = 40 - kept.length;
    for (let j = 0; j < kept.length; j++) {
      assert.ok(
        kept[j].startsWith(`entry-${String(firstIdx + j).padStart(2, '0')}-`),
        `expected contiguous tail at index ${j}, got ${kept[j]}`,
      );
    }
    assert.ok(statSync(logFile).size <= 400);
    assert.deepEqual(listTmpFiles(dirname(logFile)), []);
    outputs.push(text);
  }
  assert.equal(outputs[0], outputs[1]);
});

test('compat/ipc-host.cjs CJS factory executes safely without import.meta.url or native addon loading', async (t) => {
  const ipcHostPath = join(REPO, 'compat', 'ipc-host.cjs');
  const code = readFileSync(ipcHostPath, 'utf8');
  assert.ok(
    code.startsWith('// Generated by tools/build.mjs from src/. Do not edit directly.\nmodule.exports = function installAgPulseIpc(...args) {'),
  );
  assert.doesNotMatch(code, /node_modules/);

  const tempHome = await mkdtemp(join(tmpdir(), 'ag-ipc-host-test-'));
  t.after(() => rm(tempHome, { recursive: true, force: true }));

  const hostReq = createRequire(import.meta.url);
  const shimmedRequire = (specifier) => {
    if (specifier === 'node:os') {
      return { ...nodeOs, homedir: () => tempHome };
    }
    return hostReq(specifier);
  };

  const mod = { exports: {} };
  const fn = new Script(`(function(module, exports, require) {\n${code}\n})`, {
    filename: 'compat/ipc-host.cjs',
  }).runInThisContext();
  fn(mod, mod.exports, shimmedRequire);
  assert.equal(typeof mod.exports, 'function');

  const onHandlers = new Map();
  const handleHandlers = new Map();
  const mockElectron = {
    ipcMain: {
      on: (ch, handler) => onHandlers.set(ch, handler),
      handle: (ch, handler) => handleHandlers.set(ch, handler),
    },
  };
  mod.exports(mockElectron, new Map());

  const diagHandler = onHandlers.get('ag-pulse:diagnostic');
  assert.equal(typeof diagHandler, 'function');

  const fakeEvent = {
    senderFrame: { url: 'http://127.0.0.1:41234/' },
    sender: { getURL: () => 'http://127.0.0.1:41234/' },
  };
  diagHandler(fakeEvent, {
    stage: 'mounted',
    hostFound: true,
    editorFound: true,
    composerFound: false,
  });

  const expectedLog = join(
    tempHome,
    '.gemini',
    'antigravity',
    'sidecar_data',
    'antigravity-pulse',
    'panel',
    'logs',
    'widget.log',
  );
  for (let i = 0; i < 40 && !existsSync(expectedLog); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(existsSync(expectedLog), 'widget.log should be created by ipc-host diagnostic handler');
  const logged = await readFile(expectedLog, 'utf8');
  assert.match(logged, /"stage":"mounted"/);
  assert.match(logged, /"hostFound":true/);
});
