import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PreferencesStore } from '../../../compat/preferences.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let esbuildPromise;
async function loadEsbuild() {
  if (!esbuildPromise) {
    esbuildPromise = import('esbuild').catch(() => null);
  }
  return esbuildPromise;
}

async function loadLifecycleModules(t) {
  const esbuild = await loadEsbuild();
  if (!esbuild) {
    t.skip('esbuild is absent in zero-dependency release environment');
    return null;
  }
  const outDir = mkdtempSync(join(tmpdir(), 'pulse-debug-launch-mod-'));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  await esbuild.build({
    entryPoints: {
      'debug-launch': join(ROOT, 'src/lifecycle/debug-launch.ts'),
      installer: join(ROOT, 'src/lifecycle/installer.ts'),
      paths: join(ROOT, 'src/platform/paths.ts'),
    },
    outdir: outDir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outExtension: { '.js': '.mjs' },
  });
  const debugLaunch = await import(pathToFileURL(join(outDir, 'debug-launch.mjs')).href);
  const installer = await import(pathToFileURL(join(outDir, 'installer.mjs')).href);
  const paths = await import(pathToFileURL(join(outDir, 'paths.mjs')).href);
  return { debugLaunch, installer, paths };
}

test('argument tokenization, appending, and stripping preserve user args', async (t) => {
  const mods = await loadLifecycleModules(t);
  if (!mods) return;
  const { debugLaunch } = mods;
  const { tokenizeArgs, hasDebugFlags, appendDebugFlags, stripDebugFlags, DEBUG_PORT_FLAG, DEBUG_ADDR_FLAG } = debugLaunch;

  assert.deepEqual(tokenizeArgs('--user-data-dir="C:\\My Folder\\data" --enable-features=Foo'), [
    '--user-data-dir="C:\\My Folder\\data"',
    '--enable-features=Foo',
  ]);
  assert.equal(hasDebugFlags('--foo --remote-debugging-port=9222'), true);
  assert.equal(hasDebugFlags('--foo'), false);

  const appended = appendDebugFlags('--user-data-dir="C:\\My Data"');
  assert.equal(appended.changed, true);
  assert.equal(hasDebugFlags(appended.next), true);
  assert.ok(appended.next.includes(DEBUG_PORT_FLAG));
  assert.ok(appended.next.includes(DEBUG_ADDR_FLAG));
  const idempotent = appendDebugFlags(appended.next);
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.next, appended.next);

  const stripped = stripDebugFlags(`--foo ${DEBUG_PORT_FLAG} ${DEBUG_ADDR_FLAG} --bar`);
  assert.equal(stripped.changed, true);
  assert.equal(stripped.next, '--foo --bar');
  assert.equal(hasDebugFlags(stripped.next), false);
});

test('Windows shortcut injection patches matching .lnk targets and reverts cleanly on disable', async (t) => {
  const mods = await loadLifecycleModules(t);
  if (!mods) return;
  const { debugLaunch } = mods;
  const home = mkdtempSync(join(tmpdir(), 'pulse-win-lnk-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const appData = join(home, 'AppData', 'Roaming');
  const appRoot = join(home, 'LocalApp');
  const exe = join(appRoot, 'Antigravity.exe');
  const appAsar = join(appRoot, 'resources', 'app.asar');
  const shortcutPath = join(home, 'Desktop', 'Antigravity.lnk');
  mkdirSync(dirname(appAsar), { recursive: true });
  mkdirSync(dirname(shortcutPath), { recursive: true });
  mkdirSync(join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), { recursive: true });
  writeFileSync(exe, '');
  writeFileSync(appAsar, '');
  writeFileSync(shortcutPath, 'dummy');

  const store = new Map([[shortcutPath, { path: shortcutPath, targetPath: exe, arguments: '--custom-flag' }]]);
  const windowsDriver = {
    readShortcuts(paths) {
      return paths.map((p) => store.get(p) || { path: p, targetPath: '', arguments: '' });
    },
    writeShortcuts(updates) {
      for (const u of updates) {
        const prev = store.get(u.path) || { path: u.path, targetPath: exe, arguments: '' };
        store.set(u.path, {
          path: u.path,
          targetPath: u.targetPath || prev.targetPath,
          arguments: u.arguments,
        });
      }
    },
  };

  const env = { APPDATA: appData, LOCALAPPDATA: join(home, 'AppData', 'Local') };
  const onRes = debugLaunch.applyDebugLaunch(true, { platform: 'win32', home, env, appPath: appAsar, windowsDriver });
  assert.equal(onRes.enabled, true);
  assert.equal(onRes.configured, true);
  assert.deepEqual(onRes.patchedTargets, [shortcutPath]);
  assert.ok(store.get(shortcutPath).arguments.includes('--custom-flag'));
  assert.ok(store.get(shortcutPath).arguments.includes('--remote-debugging-port=0'));
  assert.ok(store.get(shortcutPath).arguments.includes('--remote-debugging-address=127.0.0.1'));
  assert.equal(debugLaunch.getDebugLaunchStatus({ platform: 'win32', home, env }).configured, true);

  const offRes = debugLaunch.applyDebugLaunch(false, { platform: 'win32', home, env, appPath: appAsar, windowsDriver });
  assert.equal(offRes.enabled, false);
  assert.equal(offRes.configured, false);
  assert.equal(store.get(shortcutPath).arguments, '--custom-flag');
});

test('Windows creates fallback shortcut when none exist and removes it when disabled', async (t) => {
  const mods = await loadLifecycleModules(t);
  if (!mods) return;
  const { debugLaunch } = mods;
  const home = mkdtempSync(join(tmpdir(), 'pulse-win-fallback-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const appData = join(home, 'AppData', 'Roaming');
  const appRoot = join(home, 'LocalApp');
  const exe = join(appRoot, 'Antigravity.exe');
  const appAsar = join(appRoot, 'resources', 'app.asar');
  mkdirSync(dirname(appAsar), { recursive: true });
  mkdirSync(join(home, 'Desktop'), { recursive: true });
  mkdirSync(join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), { recursive: true });
  writeFileSync(exe, '');
  writeFileSync(appAsar, '');

  const store = new Map();
  const windowsDriver = {
    readShortcuts(paths) {
      return paths.map((p) => store.get(p) || { path: p, targetPath: '', arguments: '' });
    },
    writeShortcuts(updates) {
      for (const u of updates) {
        store.set(u.path, { path: u.path, targetPath: u.targetPath || '', arguments: u.arguments });
        writeFileSync(u.path, 'lnk');
      }
    },
  };
  const env = { APPDATA: appData };
  const onRes = debugLaunch.applyDebugLaunch(true, { platform: 'win32', home, env, appPath: appAsar, windowsDriver });
  assert.equal(onRes.configured, true);
  assert.equal(onRes.createdTargets.length, 1);
  assert.equal(existsSync(onRes.createdTargets[0]), true);

  const offRes = debugLaunch.applyDebugLaunch(false, { platform: 'win32', home, env, appPath: appAsar, windowsDriver });
  assert.equal(offRes.enabled, false);
  assert.equal(existsSync(onRes.createdTargets[0]), false);
});

test('Linux .desktop override backs up existing entry and restores cleanly; macOS creates/removes .command script', async (t) => {
  const mods = await loadLifecycleModules(t);
  if (!mods) return;
  const { debugLaunch } = mods;

  // Linux test
  const linuxHome = mkdtempSync(join(tmpdir(), 'pulse-linux-dl-'));
  t.after(() => rmSync(linuxHome, { recursive: true, force: true }));
  const desktopFile = join(linuxHome, '.local', 'share', 'applications', 'antigravity.desktop');
  mkdirSync(dirname(desktopFile), { recursive: true });
  const originalDesktop = '[Desktop Entry]\nName=Antigravity\nExec=/usr/bin/antigravity %U\nType=Application\n';
  writeFileSync(desktopFile, originalDesktop, 'utf8');
  const linuxOn = debugLaunch.applyDebugLaunch(true, { platform: 'linux', home: linuxHome, env: { HOME: linuxHome } });
  assert.equal(linuxOn.configured, true);
  const patched = readFileSync(desktopFile, 'utf8');
  assert.ok(patched.includes('--remote-debugging-port=0'));
  assert.ok(patched.includes('%U'));
  debugLaunch.applyDebugLaunch(false, { platform: 'linux', home: linuxHome, env: { HOME: linuxHome } });
  assert.equal(readFileSync(desktopFile, 'utf8'), originalDesktop);

  // macOS test
  const macHome = mkdtempSync(join(tmpdir(), 'pulse-mac-dl-'));
  t.after(() => rmSync(macHome, { recursive: true, force: true }));
  mkdirSync(join(macHome, 'Desktop'), { recursive: true });
  const fakeApp = join(macHome, 'Antigravity.app');
  const fakeAsar = join(fakeApp, 'Contents', 'Resources', 'app.asar');
  mkdirSync(dirname(fakeAsar), { recursive: true });
  writeFileSync(fakeAsar, '');
  const macOn = debugLaunch.applyDebugLaunch(true, { platform: 'darwin', home: macHome, env: { HOME: macHome }, appPath: fakeAsar });
  assert.equal(macOn.configured, true);
  assert.equal(existsSync(macOn.launcherPath), true);
  const cmdBody = readFileSync(macOn.launcherPath, 'utf8');
  assert.ok(cmdBody.includes('--remote-debugging-port=0'));
  assert.ok(cmdBody.includes(JSON.stringify(fakeApp)));
  debugLaunch.applyDebugLaunch(false, { platform: 'darwin', home: macHome, env: { HOME: macHome }, appPath: fakeAsar });
  assert.equal(existsSync(macOn.launcherPath), false);
});

test('installDesktop leaves debug launch OFF by default and preferences/installer preserve opt-in and cleanup', async (t) => {
  const mods = await loadLifecycleModules(t);
  if (!mods) return;
  const { installer, paths } = mods;
  const home = mkdtempSync(join(tmpdir(), 'pulse-install-dl-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const appAsar = join(home, 'fake-app', 'resources', 'app.asar');
  const linuxBin = join(home, 'fake-app', 'antigravity');
  mkdirSync(dirname(appAsar), { recursive: true });
  writeFileSync(appAsar, '');
  writeFileSync(linuxBin, '');
  const desktopFile = join(home, '.local', 'share', 'applications', 'antigravity.desktop');

  installer.installDesktop({
    sourceRoot: ROOT,
    platform: 'linux',
    home,
    env: { HOME: home },
    appPath: appAsar,
    instance: 'pro',
  });
  assert.equal(existsSync(desktopFile), false, 'installer must keep Method 1 OFF by default');
  const stDefault = installer.statusDesktop({
    sourceRoot: ROOT,
    platform: 'linux',
    home,
    env: { HOME: home },
    appPath: appAsar,
    instance: 'pro',
  });
  assert.equal(stDefault.debugLaunch.enabled, false);

  const proPaths = paths.platformPaths({ platform: 'linux', home, env: { HOME: home } });
  const prefFile = join(dirname(proPaths.settings), 'preferences.json');
  const prefs = new PreferencesStore({ file: prefFile });
  await prefs.set({ debugLaunchEnabled: true });

  installer.installDesktop({
    sourceRoot: ROOT,
    platform: 'linux',
    home,
    env: { HOME: home },
    appPath: appAsar,
    instance: 'pro',
  });
  assert.equal(existsSync(desktopFile), true, 'saved opt-in persists across upgrades');

  installer.uninstallDesktop({
    sourceRoot: ROOT,
    platform: 'linux',
    home,
    env: { HOME: home },
    appPath: appAsar,
    instance: 'pro',
  });
  assert.equal(existsSync(desktopFile), false, 'uninstall removes managed debug launcher override');
});

test('manage.mjs debug-launch CLI status respects default OFF under isolated home', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pulse-cli-dl-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const out = execFileSync(process.execPath, [join(ROOT, 'manage.mjs'), 'debug-launch', 'status', '--home', home], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming') },
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.configured, false);
});
