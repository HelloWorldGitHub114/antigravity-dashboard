import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXPORTER_PATH = join(ROOT, 'tools', 'export-opensource.mjs');
const ADDON_PATH = join(ROOT, 'sidecars', 'panel', 'pulse-accel.node');

function createFixtureTree(baseDir) {
  mkdirSync(join(baseDir, 'sidecars', 'panel', 'tests'), { recursive: true });
  mkdirSync(join(baseDir, 'src', 'telemetry', 'ledger'), { recursive: true });
  mkdirSync(join(baseDir, '.data'), { recursive: true });
  mkdirSync(join(baseDir, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(baseDir, 'nested', 'target'), { recursive: true });

  writeFileSync(join(baseDir, '.gitignore'), 'dist/\n');
  writeFileSync(join(baseDir, '.env'), 'SECRET=1\n');
  writeFileSync(join(baseDir, '.env.local'), 'SECRET=2\n');
  writeFileSync(join(baseDir, 'RULE.md'), 'private rule\n');
  writeFileSync(join(baseDir, '.data', 'local.json'), '{"user":"secret-fixture"}\n');
  writeFileSync(join(baseDir, 'node_modules', 'pkg', 'index.js'), 'secret-fixture\n');
  writeFileSync(join(baseDir, 'nested', 'target', 'out.txt'), 'secret-fixture\n');
  writeFileSync(join(baseDir, 'binary.node'), 'fake-node-addon');
  writeFileSync(join(baseDir, 'README.md'), 'Hello Open Source World\n中文Source\r');
  writeFileSync(join(baseDir, 'src', 'clean.ts'), 'export const value = 42;\n');
  writeFileSync(join(baseDir, 'src', 'invalid-utf8.txt'), Buffer.from([0xff, 0xfe, 0x61, 0x62]));
  writeFileSync(
    join(baseDir, 'sidecars', 'panel', 'usage.mjs'),
    'accounts.push({ id: "all", name: "\\u5168\\u90E8\\u8D26\\u53F7 (\\u6C47\\u603B)", email: "\\u5168\\u90E8\\u8D26\\u53F7 (\\u6C47\\u603B)", active: activeScope === "all" });\n',
  );
  writeFileSync(
    join(baseDir, 'src', 'telemetry', 'ledger', 'accounts.ts'),
    "accounts.push({ id: 'all', name: '全部账号 (汇总)', email: '全部账号 (汇总)', active: activeScope === 'all' });\n",
  );
  writeFileSync(
    join(baseDir, 'sidecars', 'panel', 'tests', 'multi-account-features.test.mjs'),
    "assert.equal(accounts[0].name, '全部账号 (汇总)');\n",
  );
}

test('Rust sanitizer matches pure-TS parity for file collection, transforms, pruning, and findings', async (t) => {
  if (!existsSync(EXPORTER_PATH)) {
    t.skip('tools/export-opensource.mjs not present in this tree');
    return;
  }

  const exporter = await import(pathToFileURL(EXPORTER_PATH).href);
  const src = mkdtempSync(join(tmpdir(), 'ag-stage8b-san-src-'));
  const dstNative = mkdtempSync(join(tmpdir(), 'ag-stage8b-san-native-'));
  const dstJs = mkdtempSync(join(tmpdir(), 'ag-stage8b-san-js-'));
  const prevDisable = process.env.PULSE_DISABLE_NATIVE_ACCEL;

  try {
    createFixtureTree(src);
    for (const dst of [dstNative, dstJs]) {
      mkdirSync(join(dst, '.git'), { recursive: true });
      writeFileSync(join(dst, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      mkdirSync(join(dst, 'stale-dir', 'sub'), { recursive: true });
      writeFileSync(join(dst, 'stale-dir', 'sub', 'old.txt'), 'remove me');
      writeFileSync(join(dst, 'stale-root.txt'), 'remove me');
    }

    const extraPatterns = [
      { regex: /Open Source/i, label: 'open source marker' },
      { regex: /\bSource\b/, label: 'word boundary marker' },
      { regex: /\r$/, label: 'trailing cr marker' },
    ];

    delete process.env.PULSE_DISABLE_NATIVE_ACCEL;
    const nativeCheck = exporter.exportOpenSource({ sourceDir: src, check: true, extraPatterns });
    const nativeExport = exporter.exportOpenSource({
      sourceDir: src,
      destDir: dstNative,
      skipTests: true,
      extraPatterns: [{ regex: /nonexistent_marker/, label: 'none' }],
    });

    process.env.PULSE_DISABLE_NATIVE_ACCEL = '1';
    const jsCheck = exporter.exportOpenSource({ sourceDir: src, check: true, extraPatterns });
    const jsExport = exporter.exportOpenSource({
      sourceDir: src,
      destDir: dstJs,
      skipTests: true,
      extraPatterns: [{ regex: /nonexistent_marker/, label: 'none' }],
    });

    assert.deepEqual(nativeCheck, jsCheck);
    assert.equal(nativeCheck.checked, 7);
    assert.deepEqual(nativeCheck.findings, [
      'README.md:1 (open source marker)',
      'README.md:1 (word boundary marker)',
      'README.md:2 (word boundary marker)',
      'README.md:2 (trailing cr marker)',
    ]);

    assert.equal(nativeExport.exported, jsExport.exported);
    assert.deepEqual(nativeExport.findings, jsExport.findings);
    assert.equal(nativeExport.exported, 7);

    // Stale pruning & .git preservation
    for (const dst of [dstNative, dstJs]) {
      assert.equal(existsSync(join(dst, '.git', 'HEAD')), true);
      assert.equal(existsSync(join(dst, 'stale-root.txt')), false);
      assert.equal(existsSync(join(dst, 'stale-dir')), false);
      assert.equal(existsSync(join(dst, '.env')), false);
      assert.equal(existsSync(join(dst, '.env.local')), false);
      assert.equal(existsSync(join(dst, 'RULE.md')), false);
      assert.equal(existsSync(join(dst, 'binary.node')), false);
      assert.equal(existsSync(join(dst, '.gitignore')), true);
    }

    // Exact transform parity
    for (const rel of [
      join('sidecars', 'panel', 'usage.mjs'),
      join('src', 'telemetry', 'ledger', 'accounts.ts'),
      join('sidecars', 'panel', 'tests', 'multi-account-features.test.mjs'),
    ]) {
      assert.equal(
        readFileSync(join(dstNative, rel), 'utf8'),
        readFileSync(join(dstJs, rel), 'utf8'),
        `Transform mismatch for ${rel}`,
      );
    }
  } finally {
    if (prevDisable === undefined) delete process.env.PULSE_DISABLE_NATIVE_ACCEL;
    else process.env.PULSE_DISABLE_NATIVE_ACCEL = prevDisable;
    rmSync(src, { recursive: true, force: true });
    rmSync(dstNative, { recursive: true, force: true });
    rmSync(dstJs, { recursive: true, force: true });
  }
});

test('Rust sync skips unchanged non-transform files matching (mtime, size) and refreshes on mtime change', async (t) => {
  if (!existsSync(EXPORTER_PATH) || !existsSync(ADDON_PATH)) {
    t.skip('tools/export-opensource.mjs or pulse-accel.node not present in this tree');
    return;
  }

  const exporter = await import(pathToFileURL(EXPORTER_PATH).href);
  const src = mkdtempSync(join(tmpdir(), 'ag-stage8b-mtime-src-'));
  const dst = mkdtempSync(join(tmpdir(), 'ag-stage8b-mtime-dst-'));
  const prevDisable = process.env.PULSE_DISABLE_NATIVE_ACCEL;

  try {
    delete process.env.PULSE_DISABLE_NATIVE_ACCEL;
    writeFileSync(join(src, 'note.txt'), 'original1234'); // 12 bytes

    exporter.exportOpenSource({ sourceDir: src, destDir: dst, skipTests: true });
    const srcStat = statSync(join(src, 'note.txt'));
    const dstNote = join(dst, 'note.txt');

    // Replace destination content with same byte length and restore exact source mtime
    writeFileSync(dstNote, 'SENTINEL1234'); // 12 bytes
    utimesSync(dstNote, srcStat.atime, srcStat.mtime);

    exporter.exportOpenSource({ sourceDir: src, destDir: dst, skipTests: true });
    assert.equal(readFileSync(dstNote, 'utf8'), 'SENTINEL1234', 'Expected (mtime, size) match to skip copy');

    // Shift mtime -> must recopy from source
    const older = new Date(srcStat.mtimeMs - 5000);
    utimesSync(dstNote, older, older);
    exporter.exportOpenSource({ sourceDir: src, destDir: dst, skipTests: true });
    assert.equal(readFileSync(dstNote, 'utf8'), 'original1234', 'Expected mtime mismatch to trigger copy');
  } finally {
    if (prevDisable === undefined) delete process.env.PULSE_DISABLE_NATIVE_ACCEL;
    else process.env.PULSE_DISABLE_NATIVE_ACCEL = prevDisable;
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('Unsupported JS regex lookahead (?!foo) falls back cleanly to pure TS', async (t) => {
  if (!existsSync(EXPORTER_PATH)) {
    t.skip('tools/export-opensource.mjs not present in this tree');
    return;
  }

  const exporter = await import(pathToFileURL(EXPORTER_PATH).href);
  const src = mkdtempSync(join(tmpdir(), 'ag-stage8b-fallback-src-'));
  const dst = mkdtempSync(join(tmpdir(), 'ag-stage8b-fallback-dst-'));
  const prevDisable = process.env.PULSE_DISABLE_NATIVE_ACCEL;

  try {
    delete process.env.PULSE_DISABLE_NATIVE_ACCEL;
    writeFileSync(join(src, 'sample.ts'), 'const a = "foobar";\nconst b = "foobaz";\n');
    const lookaheadPatterns = [{ regex: /foo(?!bar)/, label: 'js lookahead' }];

    const checkRes = exporter.exportOpenSource({
      sourceDir: src,
      check: true,
      extraPatterns: lookaheadPatterns,
    });
    assert.equal(checkRes.checked, 1);
    assert.deepEqual(checkRes.findings, ['sample.ts:2 (js lookahead)']);

    const syncRes = exporter.exportOpenSource({
      sourceDir: src,
      destDir: dst,
      skipTests: true,
      extraPatterns: lookaheadPatterns,
    });
    assert.equal(syncRes.exported, 1);
    assert.deepEqual(syncRes.findings, ['sample.ts:2 (js lookahead)']);
  } finally {
    if (prevDisable === undefined) delete process.env.PULSE_DISABLE_NATIVE_ACCEL;
    else process.env.PULSE_DISABLE_NATIVE_ACCEL = prevDisable;
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('tools/export-opensource.mjs --check CLI passes with native enabled and disabled', (t) => {
  if (!existsSync(EXPORTER_PATH)) {
    t.skip('tools/export-opensource.mjs not present in this tree');
    return;
  }
  const cleanEnv = { ...process.env };
  delete cleanEnv.PULSE_DISABLE_NATIVE_ACCEL;
  const nativeOut = execFileSync(process.execPath, [EXPORTER_PATH, '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanEnv,
  });
  const jsOut = execFileSync(process.execPath, [EXPORTER_PATH, '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...cleanEnv, PULSE_DISABLE_NATIVE_ACCEL: '1' },
  });
  assert.match(nativeOut, /Privacy check passed/);
  assert.equal(nativeOut.trim(), jsOut.trim());
});
