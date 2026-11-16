import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  platformPaths,
  instancePaths,
  allInstancePaths,
  appAsarCandidates,
  resolveAppAsar,
} from '../../../compat/platform.mjs';
import { PreferencesStore, validateLanguage } from '../../../compat/preferences.mjs';
import { SidecarOwner } from '../../../compat/sidecar-owner.mjs';
import {
  percent,
  rate,
  count,
  elapsed,
  countdown,
  resetDate,
} from '../format.mjs';
import { panelAppSource } from '../panel-source.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let esbuildPromise;
async function loadEsbuild() {
  if (!esbuildPromise) {
    esbuildPromise = import('esbuild').catch(() => null);
  }
  return esbuildPromise;
}

async function compileTsModule(t, entryRelPath) {
  const esbuild = await loadEsbuild();
  assert.ok(esbuild, 'esbuild must be available when this helper is called');
  const dir = await mkdtemp(join(tmpdir(), 'ag-stage3-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outfile = join(dir, 'bundle.mjs');
  await esbuild.build({
    entryPoints: [join(REPO, entryRelPath)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    packages: 'external',
  });
  return import(pathToFileURL(outfile).href);
}

function createMockDom() {
  const createEl = (tag, ns = 'http://www.w3.org/1999/xhtml') => {
    const attrs = new Map();
    const styleProps = new Map();
    return {
      nodeType: 1,
      localName: tag,
      namespaceURI: ns,
      children: [],
      textContent: '',
      hidden: false,
      style: {
        getPropertyValue: (k) => styleProps.get(k) ?? '',
        setProperty: (k, v) => {
          styleProps.set(k, String(v));
        },
      },
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      hasAttribute: (k) => attrs.has(k),
      removeAttribute: (k) => attrs.delete(k),
      append: function (...nodes) {
        this.children.push(...nodes);
      },
      replaceChildren: function (...nodes) {
        this.children = [...nodes];
      },
    };
  };
  const doc = {
    createDocumentFragment: () => ({
      nodeType: 11,
      children: [],
      append: function (...nodes) {
        this.children.push(...nodes);
      },
    }),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    createElement: (tag) => createEl(tag.toLowerCase()),
    createElementNS: (ns, tag) => createEl(tag, ns),
  };
  const target = {
    ownerDocument: doc,
    children: [],
    replaceChildren: function (...nodes) {
      this.children = nodes.flatMap((n) => (n?.nodeType === 11 ? n.children : [n]));
    },
  };
  return { doc, target };
}

test('compiled Stage 3 outputs have zero src/ or node_modules dependencies and valid panel format', async () => {
  const targets = [
    'compat/platform.mjs',
    'compat/preferences.mjs',
    'compat/sidecar-owner.mjs',
    'sidecars/panel/format.mjs',
  ];
  for (const rel of targets) {
    const text = await readFile(join(REPO, rel), 'utf8');
    assert.doesNotMatch(text, /from\s+['"][^'"]*src\//, `${rel} must not import src/`);
    assert.doesNotMatch(text, /from\s+['"](?!node:|\.)[^'"]+['"]/, `${rel} must only import node:* or relative`);
    assert.doesNotMatch(text, /node_modules/, `${rel} must not reference node_modules`);
  }

  const formatSrc = await readFile(join(REPO, 'sidecars/panel/format.mjs'), 'utf8');
  assert.doesNotMatch(formatSrc, /^\s*import\b/m, 'panel format.mjs must have zero imports');
  assert.doesNotMatch(formatSrc, /^\s*export\s*\{/m, 'panel format.mjs must have no trailing export block');
  for (const fn of ['percent', 'rate', 'count', 'elapsed', 'countdown', 'resetDate']) {
    assert.match(formatSrc, new RegExp(`^export function ${fn}\\(`, 'm'));
  }
  assert.ok(panelAppSource().includes('function percent('));
});

test('compiled runtime exports preserve formatting, preferences, ownership, and dual-instance paths', async (t) => {
  assert.equal(percent(0.834), '83.4%');
  assert.equal(percent(null), '—');
  assert.equal(rate(1234.56), '1,234.6');
  assert.equal(count(42000), '42,000');
  assert.equal(elapsed(12.345), '12.35 秒');
  assert.equal(elapsed(3665), '1小时1分5秒');
  const now = Date.parse('2026-10-06T08:00:00Z');
  assert.equal(countdown('2026-10-06T08:00:00Z', now), '等待刷新');
  assert.equal(countdown('2026-10-08T10:00:00Z', now, true), '2天 02:00');
  assert.match(resetDate('2026-10-06T08:00:00Z'), /^\d{2}\/\d{2}\s\d{2}:\d{2}$/);

  const home = await mkdtemp(join(tmpdir(), 'ag-dual-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vertexHome = join(home, '.antigravity-vertex', 'home');
  const vertexUserData = join(home, '.antigravity-vertex', 'user-data');
  await mkdir(vertexHome, { recursive: true });
  await mkdir(vertexUserData, { recursive: true });

  const isolated = platformPaths({ platform: 'win32', home: vertexHome, env: {} });
  assert.equal(isolated.isIsolatedVertex, true);
  assert.equal(isolated.profile, vertexUserData);

  const pro = instancePaths('pro', { platform: 'win32', home, env: { APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local') } });
  const vertex = instancePaths('vertex', { platform: 'win32', home, env: {} });
  assert.equal(pro.instance, 'pro');
  assert.equal(pro.isIsolatedVertex, false);
  assert.equal(vertex.instance, 'vertex');
  assert.equal(vertex.isIsolatedVertex, true);
  assert.equal(vertex.home, vertexHome);
  assert.equal(vertex.profile, vertexUserData);
  assert.equal(vertex.exists, true);
  assert.deepEqual(
    allInstancePaths({ platform: 'win32', home, env: {} }).map((p) => p.instance),
    ['pro', 'vertex'],
  );

  const asarFile = join(home, 'custom.asar');
  await writeFile(asarFile, 'asar');
  assert.deepEqual(appAsarCandidates({ platform: 'linux', home, env: { AG_PULSE_APP_ASAR: '~/custom.asar' } }), [asarFile]);
  assert.equal(resolveAppAsar({ platform: 'linux', home, env: { AG_PULSE_APP_ASAR: '~/custom.asar' } }), asarFile);

  assert.equal(validateLanguage('en'), 'en');
  assert.throws(() => validateLanguage('fr'), { message: 'Invalid language preference' });
  const store = new PreferencesStore({ file: join(home, 'prefs.json') });
  const saved = await store.set({ language: 'zh-CN', modelTimelineEnabled: true });
  assert.equal(saved.language, 'zh-CN');
  assert.equal(saved.modelTimelineEnabled, true);

  const owner = new SidecarOwner(join(home, 'owner'), { pid: process.pid, startedAt: 100, token: 'tok' });
  assert.equal(await owner.claim(), true);
  assert.equal(await owner.isOwner(), true);
  owner.stop();
});

test('src/shared/format.ts and src/shared/color.ts provide unified formatting and WCAG color helpers', async (t) => {
  const esbuild = await loadEsbuild();
  if (!esbuild) {
    t.skip('esbuild is absent in zero-dependency release environment');
    return;
  }
  const shared = await compileTsModule(t, 'src/shared/index.ts');

  assert.equal(shared.pct(0.5), '50.0%');
  assert.equal(shared.elapsed(5.1, 'en'), '5.10s');
  assert.equal(shared.elapsed(3665, 'en'), '1h 1m 5s');
  assert.equal(shared.countdown(Date.parse('2026-10-06T08:00:00Z'), Date.parse('2026-10-06T08:00:00Z'), false, 'en'), 'Waiting for refresh');
  assert.equal(shared.compact(1_500_000_000), '1.5B');
  assert.equal(shared.compact(1_500_000_000, { maxUnit: 'M' }), '1500M');
  assert.equal(shared.compact(null, { fallback: '--' }), '--');
  assert.equal(shared.compact(1234, { localeFallback: 'en-US' }), '1.2K');
  assert.equal(shared.compact(999, { localeFallback: 'en-US' }), '999');
  assert.equal(shared.percentage(45.67), '45.7%');
  assert.equal(shared.percentage(null), '--');
  assert.equal(shared.cliCountdown(null, 45), '<1m');
  assert.equal(shared.cliCountdown(null, 3660), '1h1m');
  assert.equal(shared.cliCountdown(null, 90000), '1d1h');

  assert.equal(shared.normalizeHexColor('#ABC'), '#aabbcc');
  assert.equal(shared.normalizeHexColor('#123456'), '#123456');
  assert.equal(shared.normalizeHexColor('var(--x)'), null);
  assert.deepEqual(
    shared.normalizeHostTheme({
      mode: 'dark',
      dark: { primary: '#ABC', background: 'url(x)', foregroundOverride: '#112233', extra: '#fff' },
      light: { primary: '#ffffff00' },
    }),
    { mode: 'dark', dark: { primary: '#aabbcc', foregroundOverride: '#112233' } },
  );

  assert.ok(shared.contrastRatio([255, 255, 255], [0, 0, 0]) > 20.9);
  assert.equal(shared.contrast([0, 0, 0], [0, 0, 0]), 1);
  assert.deepEqual(shared.mixRgb([0, 100, 200], [100, 200, 0], 0.5), [50, 150, 100]);
  assert.equal(shared.rgbToCss([10, 20, 30]), 'rgb(10 20 30)');

  const hsl = shared.rgbToHsl([51, 153, 204]);
  const roundtrip = shared.hslToRgb(hsl[0], hsl[1], hsl[2]);
  assert.ok(Math.abs(roundtrip[0] - 51) <= 1 && Math.abs(roundtrip[1] - 153) <= 1 && Math.abs(roundtrip[2] - 204) <= 1);

  const readable = shared.readableColor([80, 80, 80], [[70, 70, 70]], 4.5);
  const parts = readable.match(/\d+/g).map(Number);
  assert.ok(shared.contrastRatio(parts, [70, 70, 70]) >= 4.5);

  const accent = shared.buildAccentColor(210, 0.8, 0.25, [28, 29, 31], true, 3);
  const accentParts = accent.match(/\d+/g).map(Number);
  assert.ok(shared.contrastRatio(accentParts, [28, 29, 31]) >= 3);
});

test('src/shared/dom.ts enforces Trusted-Types allowlist, SVG namespace, and attribute rejection', async (t) => {
  const esbuild = await loadEsbuild();
  if (!esbuild) {
    t.skip('esbuild is absent in zero-dependency release environment');
    return;
  }
  const { setMarkup, escapeHtml, createEl, setText, setAttr, setStyle, setHidden } = await compileTsModule(t, 'src/shared/dom.ts');
  const { doc, target } = createMockDom();

  setMarkup(
    target,
    '<style>.a{color:red}</style><div data-k="a&amp;b"><svg viewBox="0 0 16 16"><path d="M0 0h16"/></svg><span>ok &lt;1&gt;</span></div>',
    doc,
  );
  assert.equal(target.children.length, 2);
  assert.equal(target.children[0].localName, 'style');
  assert.equal(target.children[0].textContent, '.a{color:red}');
  const div = target.children[1];
  assert.equal(div.getAttribute('data-k'), 'a&b');
  assert.equal(div.children[0].namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(div.children[0].children[0].namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(div.children[1].children[0].textContent, 'ok <1>');

  for (const bad of [
    '<script>alert(1)</script>',
    '<img src="x">',
    '<div onclick="alert(1)"></div>',
    '<span ONMOUSEOVER="x()"></span>',
    '<a href="javascript:void(0)"></a>',
    '<div src="x"></div>',
    '<div srcdoc="x"></div>',
    '<div><span></div>',
    '<style>.x{}',
  ]) {
    assert.throws(() => setMarkup(target, bad, doc));
  }

  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  const btn = createEl('button', { id: 'b1', disabled: true, skip: false, text: 'Go' }, doc);
  assert.equal(btn.getAttribute('id'), 'b1');
  assert.equal(btn.getAttribute('disabled'), '');
  assert.equal(btn.hasAttribute('skip'), false);
  assert.equal(btn.textContent, 'Go');
  setText(btn, 'Run');
  assert.equal(btn.textContent, 'Run');
  setAttr(btn, 'aria-label', 'Run');
  assert.equal(btn.getAttribute('aria-label'), 'Run');
  setAttr(btn, 'aria-label', null);
  assert.equal(btn.hasAttribute('aria-label'), false);
  setStyle(btn, '--pulse-accent', '#fff');
  assert.equal(btn.style.getPropertyValue('--pulse-accent'), '#fff');
  setHidden(btn, true);
  assert.equal(btn.hidden, true);
});

test('src/shared/atomic-fs.ts and src/shared/file-lock.ts handle atomic writes, stamps, and lock recovery', async (t) => {
  const esbuild = await loadEsbuild();
  if (!esbuild) {
    t.skip('esbuild is absent in zero-dependency release environment');
    return;
  }
  const {
    statStamp,
    readJsonSafe,
    readJsonSyncSafe,
    atomicWriteJson,
    atomicWriteJsonSync,
  } = await compileTsModule(t, 'src/shared/atomic-fs.ts');
  const {
    isPidAlive,
    withFileLock,
    withFileLockSync,
    acquireFileLock,
  } = await compileTsModule(t, 'src/shared/file-lock.ts');

  const dir = await mkdtemp(join(tmpdir(), 'ag-shared-fs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const missingFile = join(dir, 'missing.json');
  assert.equal(await statStamp(missingFile), null);
  assert.equal(await readJsonSafe(missingFile), null);
  assert.equal(readJsonSyncSafe(missingFile), null);

  const nested = join(dir, 'a', 'b', 'data.json');
  await atomicWriteJson(nested, { ok: 1 }, { fsync: true, trailingNewline: true });
  assert.ok(typeof (await statStamp(nested)) === 'string');
  assert.deepEqual(await readJsonSafe(nested), { ok: 1 });

  const syncFile = join(dir, 'sync.json');
  atomicWriteJsonSync(syncFile, { sync: true }, { fsync: true });
  assert.deepEqual(readJsonSyncSafe(syncFile), { sync: true });

  await writeFile(syncFile, '\uFEFF{"bom":true}', 'utf8');
  assert.deepEqual(readJsonSyncSafe(syncFile), { bom: true });
  assert.equal(readJsonSyncSafe(syncFile, { maxBytes: 4 }), null);

  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(-1), false);

  const lockPath = join(dir, 'test.lock');
  await writeFile(lockPath, JSON.stringify({ pid: 999999, token: 'dead' }), 'utf8');
  const inside = await withFileLock(
    lockPath,
    async (handle) => {
      assert.ok(existsSync(handle.lockPath));
      return 'locked';
    },
    { isAlive: () => false },
  );
  assert.equal(inside, 'locked');
  assert.equal(existsSync(lockPath), false);

  await writeFile(lockPath, '{corrupt', 'utf8');
  const oldTime = new Date(Date.now() - 20_000);
  await utimes(lockPath, oldTime, oldTime);
  const syncResult = withFileLockSync(lockPath, () => 42, { staleMs: 1000 });
  assert.equal(syncResult, 42);
  assert.equal(existsSync(lockPath), false);

  await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'held' }), 'utf8');
  await assert.rejects(
    acquireFileLock(lockPath, { timeoutMs: 30, pollIntervalMs: 5, isAlive: () => true, timeoutMessage: 'Timed out' }),
    { message: 'Timed out' },
  );
});
