import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function runNode(scriptRel, args = [], extraEnv = {}) {
  return execFileSync(process.execPath, [join(ROOT, scriptRel), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

function readZipCentralDirectory(zipPath) {
  const bytes = readFileSync(zipPath);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  assert.notEqual(eocdOffset, -1, `Expected EOCD in ${zipPath}`);
  const count = bytes.readUInt16LE(eocdOffset + 10);
  let cursor = bytes.readUInt32LE(eocdOffset + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10);
    const compSize = bytes.readUInt32LE(cursor + 20);
    const uncompSize = bytes.readUInt32LE(cursor + 24);
    const nameLen = bytes.readUInt16LE(cursor + 28);
    const extraLen = bytes.readUInt16LE(cursor + 30);
    const commentLen = bytes.readUInt16LE(cursor + 32);
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    entries.set(name, {
      readText() {
        assert.equal(bytes.readUInt32LE(localHeaderOffset), 0x04034b50);
        const lNameLen = bytes.readUInt16LE(localHeaderOffset + 26);
        const lExtraLen = bytes.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
        const payload = bytes.subarray(dataStart, dataStart + compSize);
        const raw = method === 0 ? payload : inflateRawSync(payload);
        assert.equal(raw.length, uncompSize);
        return raw.toString('utf8');
      },
    });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function buildMinimalAsar(contentBytes) {
  const headerJson = Buffer.from(
    JSON.stringify({ files: { 'index.js': { size: contentBytes.length, offset: '0' } } }),
    'utf8',
  );
  const pad = (4 - (headerJson.length % 4)) % 4;
  const headerPadded = Buffer.concat([headerJson, Buffer.alloc(pad)]);
  const meta = Buffer.alloc(16);
  meta.writeUInt32LE(4, 0);
  meta.writeUInt32LE(headerPadded.length + 8, 4);
  meta.writeUInt32LE(headerPadded.length + 4, 8);
  meta.writeUInt32LE(headerJson.length, 12);
  return Buffer.concat([meta, headerPadded, contentBytes]);
}

test('SSOT manifest stays aligned with Python fallback inventories', () => {
  const manifestSrc = readFileSync(join(ROOT, 'src', 'platform', 'manifest.ts'), 'utf8');
  const managePy = readFileSync(join(ROOT, 'manage.py'), 'utf8');
  const idePkgPy = readFileSync(join(ROOT, 'ide', 'package.py'), 'utf8');
  const exportPyPath = join(ROOT, 'tools', 'export-opensource.py');

  assert.match(managePy, /'manage\.mjs'/);
  assert.match(idePkgPy, /'manage\.mjs'/);
  if (existsSync(exportPyPath)) {
    const exportPy = readFileSync(exportPyPath, 'utf8');
    assert.match(exportPy, /'tools\/export-opensource\.mjs'/);
  }
  assert.match(manifestSrc, /'manage\.mjs'/);
  assert.match(manifestSrc, /'ide\/manage\.mjs'/);
  assert.match(manifestSrc, /'tools\/export-opensource\.mjs'/);
});

test('manage.mjs dual-instance install, toggle, status, and legacy ASAR uninstall', async () => {
  const { platformPaths } = await import(pathToFileURL(join(ROOT, 'compat', 'platform.mjs')).href);
  const home = mkdtempSync(join(tmpdir(), 'ag-stage7-desktop-'));
  const testEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
  };
  try {
    mkdirSync(join(home, '.antigravity-vertex', 'home'), { recursive: true });
    mkdirSync(join(home, '.antigravity-vertex', 'user-data'), { recursive: true });
    const appAsar = join(home, 'app.asar');
    const originalAsar = buildMinimalAsar(Buffer.from('console.log("clean");'));
    const patchedAsar = buildMinimalAsar(Buffer.from('// AG_PULSE_INLINE_V1\nconsole.log("legacy");'));
    writeFileSync(appAsar, patchedAsar);

    const backupDir = join(platformPaths({ home, env: testEnv }).backups, '20260101-000000');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, 'app.asar'), originalAsar);
    writeFileSync(
      join(backupDir, 'patch.json'),
      JSON.stringify({
        originalSha256: createHash('sha256').update(originalAsar).digest('hex'),
        patchedSha256: createHash('sha256').update(patchedAsar).digest('hex'),
      }),
    );

    runNode('manage.mjs', ['install', '--home', home, '--app-path', appAsar], testEnv);
    assert.deepEqual(readFileSync(appAsar), originalAsar);
    assert.ok(existsSync(join(home, '.gemini', 'config', 'plugins', 'antigravity-pulse', 'plugin.json')));
    assert.ok(existsSync(join(home, '.antigravity-vertex', 'home', '.gemini', 'config', 'plugins', 'antigravity-pulse', 'plugin.json')));

    runNode('manage.mjs', ['disable', '--home', home, '--app-path', appAsar], testEnv);
    let status = JSON.parse(runNode('manage.mjs', ['status', '--home', home, '--app-path', appAsar], testEnv));
    assert.equal(status.enabled, false);
    assert.equal(status.vertex.enabled, false);

    runNode('manage.mjs', ['enable', '--home', home, '--app-path', appAsar], testEnv);
    status = JSON.parse(runNode('manage.mjs', ['status', '--home', home, '--app-path', appAsar], testEnv));
    assert.equal(status.enabled, true);
    assert.equal(status.vertex.enabled, true);

    // Also verify uninstall restores verified legacy ASAR when present
    writeFileSync(appAsar, patchedAsar);
    runNode('manage.mjs', ['uninstall', '--home', home, '--app-path', appAsar], testEnv);
    assert.deepEqual(readFileSync(appAsar), originalAsar);
    assert.equal(existsSync(join(home, '.gemini', 'config', 'plugins', 'antigravity-pulse')), false);
    assert.equal(existsSync(join(home, '.antigravity-vertex', 'home', '.gemini', 'config', 'plugins', 'antigravity-pulse')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('manage.mjs CLI adapter install, compiled statusline execution, and uninstall restore', () => {
  const home = mkdtempSync(join(tmpdir(), 'ag-stage7-cli-'));
  try {
    const cliDir = join(home, '.gemini', 'antigravity-cli');
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(
      join(cliDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo prior' } }),
    );

    runNode('manage.mjs', ['--home', home, 'install-cli', '--node', process.execPath, '--language', 'zh-CN']);
    const status = JSON.parse(runNode('manage.mjs', ['--home', home, 'status-cli']));
    assert.equal(status.installed, true);
    assert.equal(status.configured, true);

    const installedScript = join(cliDir, 'antigrative-dashboard', 'cli', 'statusline.mjs');
    const renderedJson = execFileSync(process.execPath, [installedScript, '--json'], {
      input: JSON.stringify({ model: { display_name: 'Gemini Flash' }, context_window: { context_window_size: 100000, used_percentage: 25 } }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    const parsed = JSON.parse(renderedJson);
    assert.equal(parsed.model, 'Gemini Flash');
    assert.equal(parsed.context.usedPercentage, 25);

    runNode('manage.mjs', ['--home', home, 'uninstall-cli']);
    const restored = JSON.parse(readFileSync(join(cliDir, 'settings.json'), 'utf8'));
    assert.deepEqual(restored.statusLine, { type: 'command', command: 'echo prior' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('manage.mjs package and ide/package.mjs build valid ZIP/VSIX archives with SHA256 sidecars', () => {
  const tmpDist = mkdtempSync(join(tmpdir(), 'ag-stage7-pkg-'));
  try {
    const pluginVersion = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8')).version;
    const zipOut = join(tmpDist, `antigrative-dashboard-${pluginVersion}.zip`);
    const vsixOut = join(tmpDist, `antigrative-dashboard-ide-${pluginVersion}.vsix`);

    runNode('manage.mjs', ['package', '--output', zipOut]);
    runNode('ide/package.mjs', ['--output', vsixOut]);

    assert.ok(existsSync(zipOut));
    assert.ok(existsSync(join(tmpDist, `antigrative-dashboard-${pluginVersion}.zip.sha256`)));
    assert.ok(existsSync(vsixOut));
    assert.ok(existsSync(join(tmpDist, `antigrative-dashboard-ide-${pluginVersion}.vsix.sha256`)));

    const zipEntries = readZipCentralDirectory(zipOut);
    assert.equal(
      JSON.parse(zipEntries.get('antigrative-dashboard/plugin.json').readText()).version,
      pluginVersion,
    );
    assert.ok(zipEntries.has('antigrative-dashboard/manage.mjs'));

    const vsixEntries = readZipCentralDirectory(vsixOut);
    assert.ok(vsixEntries.has('extension.vsixmanifest'));
    assert.ok(vsixEntries.has('extension/ide/manage.mjs'));
    assert.equal(
      JSON.parse(vsixEntries.get('extension/package.json').readText()).version,
      pluginVersion,
    );
  } finally {
    rmSync(tmpDist, { recursive: true, force: true });
  }
});

test('tools/export-opensource.mjs --check passes, enforces privacy patterns, and strips local/private files on export', async (t) => {
  const exporterPath = join(ROOT, 'tools', 'export-opensource.mjs');
  if (!existsSync(exporterPath)) {
    t.skip('export-opensource.mjs is excluded in exported open-source trees');
    return;
  }
  const checkOut = runNode('tools/export-opensource.mjs', ['--check']);
  assert.match(checkOut, /Privacy check passed/);

  const exporter = await import(pathToFileURL(exporterPath).href);
  const patterns = exporter.buildForbiddenPatterns(ROOT);
  assert.ok(patterns.length >= 6, 'Must include generic secret pattern plus local forbidden patterns');

  const exportDest = mkdtempSync(join(tmpdir(), 'ag-stage7-oss-'));
  try {
    runNode('tools/export-opensource.mjs', ['--dest', exportDest, '--skip-tests']);
    assert.equal(existsSync(join(exportDest, 'tools', 'export-opensource.mjs')), false);
    assert.equal(existsSync(join(exportDest, 'tools', 'export-opensource.py')), false);
    assert.equal(existsSync(join(exportDest, '.data')), false);
    assert.ok(existsSync(join(exportDest, 'manage.mjs')));
    assert.ok(existsSync(join(exportDest, 'sidecars', 'panel', 'usage.mjs')));
  } finally {
    rmSync(exportDest, { recursive: true, force: true });
  }
});

test('publishRelease stages as private draft, rejects public overwrite, and leaves draft on upload error', async () => {
  const { publishRelease } = await import(pathToFileURL(join(ROOT, 'tools', 'publish-release.mjs')).href);
  const tmpDir = mkdtempSync(join(tmpdir(), 'ag-stage7-rel-'));
  try {
    const asset1 = join(tmpDir, 'bundle.zip');
    const asset2 = join(tmpDir, 'bundle.zip.sha256');
    writeFileSync(asset1, 'checked-zip');
    writeFileSync(asset2, 'checked-sha');
    const uploads = [
      { path: asset1, name: 'bundle.zip', contentType: 'application/zip' },
      { path: asset2, name: 'bundle.zip.sha256', contentType: 'text/plain; charset=utf-8' },
    ];

    function makeClient({ failUpload = false, isPublic = false } = {}) {
      const state = {
        id: 1,
        tag_name: 'v0.11.0-beta.1',
        draft: !isPublic,
        assets: [
          { id: 10, name: 'bundle.zip' },
          { id: 11, name: 'bundle.zip.sha256' },
        ],
        upload_url: 'https://uploads.github.com/repos/test/test/releases/1/assets{?name,label}',
        html_url: 'https://github.com/test/test/releases/tag/v0.11.0-beta.1',
        publications: 0,
      };
      return {
        state,
        async find() {
          return state;
        },
        async request(method, url, body) {
          if (method === 'DELETE') {
            const id = Number(url.split('/').pop());
            state.assets = state.assets.filter((a) => a.id !== id);
          } else if (method === 'POST' && url.includes('?name=')) {
            if (failUpload) throw new Error('upload failed');
            const name = decodeURIComponent(url.split('?name=')[1]);
            state.assets.push({ id: 20 + state.assets.length, name });
          } else if (method === 'PATCH') {
            if (body && body.draft === false) state.publications += 1;
            Object.assign(state, body);
          }
          return state;
        },
      };
    }

    const okClient = makeClient();
    const res = await publishRelease(okClient, 'v0.11.0-beta.1', 'sha123', 'release notes', uploads);
    assert.ok(res.htmlUrl.endsWith('/v0.11.0-beta.1'));
    assert.equal(okClient.state.publications, 1);
    assert.equal(okClient.state.draft, false);
    assert.equal(okClient.state.target_commitish, 'sha123');
    assert.deepEqual(
      new Set(okClient.state.assets.map((a) => a.name)),
      new Set(['bundle.zip', 'bundle.zip.sha256']),
    );

    const failClient = makeClient({ failUpload: true });
    await assert.rejects(
      () => publishRelease(failClient, 'v0.11.0-beta.1', 'sha123', 'notes', uploads),
      /upload failed/,
    );
    assert.equal(failClient.state.draft, true);
    assert.equal(failClient.state.publications, 0);

    const publicClient = makeClient({ isPublic: true });
    await assert.rejects(
      () => publishRelease(publicClient, 'v0.11.0-beta.1', 'sha123', 'notes', uploads),
      /already public/,
    );
    assert.equal(publicClient.state.publications, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ui-runner ScopedBrowser isolates per-test contexts and all check-*.mjs parse cleanly', async () => {
  const uiRunner = await import(pathToFileURL(join(ROOT, 'tools', 'ui-runner.mjs')).href);
  let closedShared = false;
  const closedContexts = [];
  const closedPages = [];
  let ctxCounter = 0;

  const fakeBrowser = {
    async newContext() {
      const id = ++ctxCounter;
      return {
        async newPage() {
          return {
            contextId: id,
            async close() {
              closedPages.push(id);
            },
          };
        },
        async close() {
          closedContexts.push(id);
        },
      };
    },
    async close() {
      closedShared = true;
    },
  };

  await uiRunner.withSharedBrowser(fakeBrowser, async () => {
    const [b1, b2] = await Promise.all([uiRunner.launchTestBrowser(), uiRunner.launchTestBrowser()]);
    assert.equal(b1.isScoped, true);
    assert.equal(b2.isScoped, true);
    const p1 = await b1.newPage();
    const p2 = await b2.newPage();
    assert.notEqual(p1.contextId, p2.contextId);
    await p1.close();
    await b1.close();
    await b2.close();
  });

  assert.equal(closedShared, false, 'ScopedBrowser must never close the shared browser');
  assert.deepEqual(closedPages, [1]);
  assert.deepEqual(new Set(closedContexts), new Set([1, 2]));

  for (const name of readdirSync(join(ROOT, 'tools')).filter((f) => f.startsWith('check-') && f.endsWith('.mjs'))) {
    execFileSync(process.execPath, ['--check', join(ROOT, 'tools', name)], { stdio: 'ignore' });
  }
});
