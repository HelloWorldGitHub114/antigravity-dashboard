import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let esbuildPromise;
async function loadEsbuild() {
  if (!esbuildPromise) {
    esbuildPromise = import('esbuild').catch(() => null);
  }
  return esbuildPromise;
}

async function loadHostAdapterModules(t) {
  const esbuild = await loadEsbuild();
  if (!esbuild) {
    t.skip('esbuild is absent in zero-dependency release environment');
    return null;
  }
  const outDir = mkdtempSync(join(tmpdir(), 'pulse-host-adapter-'));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  await esbuild.build({
    entryPoints: {
      'redux-sidebar': join(ROOT, 'src/ui/host-adapter/redux-sidebar.ts'),
      'react-fiber': join(ROOT, 'src/ui/host-adapter/react-fiber.ts'),
    },
    outdir: outDir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outExtension: { '.js': '.mjs' },
  });
  const reduxSidebar = await import(pathToFileURL(join(outDir, 'redux-sidebar.mjs')).href);
  const reactFiber = await import(pathToFileURL(join(outDir, 'react-fiber.mjs')).href);
  return { reduxSidebar, reactFiber };
}

function withDomGlobals(t, { search = '', rootFiber = null } = {}) {
  const keys = ['window', 'document', 'location', 'HTMLElement', 'MouseEvent'];
  const saved = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  t.after(() => {
    for (const [k, desc] of saved.entries()) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
  });

  class MockHTMLElement {}
  class MockMouseEvent {
    constructor(type, init) {
      this.type = type;
      this.init = init;
    }
  }

  const rootEl = { __reactFiber$test: rootFiber };
  const fakeWindow = {
    agPulseHost: null,
    addEventListener() {},
    removeEventListener() {},
  };
  const fakeDocument = {
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById(id) {
      return id === 'root' ? rootEl : null;
    },
    body: {
      firstElementChild: rootEl,
      append() {},
    },
    createElement() {
      return {
        href: '',
        style: {},
        setAttribute() {},
        dispatchEvent() {
          return true;
        },
        remove() {},
      };
    },
  };

  Object.defineProperties(globalThis, {
    window: { value: fakeWindow, configurable: true, writable: true },
    document: { value: fakeDocument, configurable: true, writable: true },
    location: { value: { search }, configurable: true, writable: true },
    HTMLElement: { value: MockHTMLElement, configurable: true, writable: true },
    MouseEvent: { value: MockMouseEvent, configurable: true, writable: true },
  });
}

function createHostFiber({ redesignEnabled, state = { sidePanelV2: {}, sidePanel: {} } } = {}) {
  const dispatched = [];
  const navCalls = [];
  const services = {
    extensibility: {
      resolveSidecarUrl(baseUrl, path) {
        return `${baseUrl}${path}`;
      },
      provider: {
        getState() {
          return [
            {
              sidecarId: 'antigravity-pulse/panel',
              baseUrl: 'http://127.0.0.1:4321',
              config: {
                uiConfig: {
                  displayName: 'Antigrative Dashboard',
                  views: [
                    {
                      entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
                      path: '/',
                      title: 'Antigrative Dashboard',
                    },
                  ],
                },
              },
            },
          ];
        },
      },
    },
    ...(typeof redesignEnabled === 'boolean'
      ? { auxPaneComponent: { redesignEnabled } }
      : {}),
  };

  const diFiber = {
    memoizedProps: {
      value: {
        store: {
          getState: () => state,
          dispatch: (action) => {
            dispatched.push(action);
            return action;
          },
        },
        get: (name) => services[name] ?? null,
        router: {
          state: { location: { pathname: '/' } },
          navigate(opts) {
            navCalls.push(opts);
            return Promise.resolve();
          },
        },
      },
    },
    return: null,
    child: null,
    sibling: null,
  };

  return { rootFiber: diFiber, dispatched, navCalls };
}

test('openSidebarPanel dispatches 2.33.0 panelScope and legacy treeId on sidePanelV2', async (t) => {
  const mods = await loadHostAdapterModules(t);
  if (!mods) return;
  const { reduxSidebar } = mods;
  const cascadeId = '11111111-1111-1111-1111-111111111111';
  const { rootFiber, dispatched, navCalls } = createHostFiber({ redesignEnabled: true });
  withDomGlobals(t, { search: `?cascadeId=${cascadeId}&project=ignored`, rootFiber });

  const method = reduxSidebar.openSidebarPanel();
  assert.equal(method, 'redux');
  assert.equal(dispatched.length, 2);

  const expectedScope = { kind: 'cascadeId', cascadeId };
  assert.equal(dispatched[0].type, 'sidePanelV2/setContent');
  assert.deepEqual(dispatched[0].payload.panelScope, expectedScope);
  assert.deepEqual(dispatched[0].payload.treeId, expectedScope);
  assert.equal(dispatched[0].payload.tabId, 'sidecar__antigravity-pulse/panel__/');
  assert.equal(dispatched[0].payload.content.sidecarView.url, 'http://127.0.0.1:4321/');
  assert.equal(dispatched[0].payload.deferActivation, false);

  assert.equal(dispatched[1].type, 'sidePanel/setSidePanelOpen');
  assert.deepEqual(dispatched[1].payload.panelScope, expectedScope);
  assert.deepEqual(dispatched[1].payload.treeId, expectedScope);
  assert.equal(dispatched[1].payload.isOpen, true);

  assert.equal(navCalls.length, 1);
  assert.equal(navCalls[0].to, undefined);
  assert.deepEqual(navCalls[0].search({ cascadeId }), {
    cascadeId,
    tab: 'sidecar__antigravity-pulse/panel__/',
  });
  assert.equal(navCalls[0].replace, true);
});

test('openSidebarPanel respects auxPaneComponent.redesignEnabled === false and falls back to sidePanel', async (t) => {
  const mods = await loadHostAdapterModules(t);
  if (!mods) return;
  const { reduxSidebar } = mods;
  const { rootFiber, dispatched, navCalls } = createHostFiber({ redesignEnabled: false });
  withDomGlobals(t, { search: '', rootFiber });

  const method = reduxSidebar.openSidebarPanel();
  assert.equal(method, 'redux');
  assert.equal(dispatched.length, 2);

  const expectedScope = { kind: 'home' };
  assert.equal(dispatched[0].type, 'sidePanel/setContent');
  assert.deepEqual(dispatched[0].payload.panelScope, expectedScope);
  assert.deepEqual(dispatched[0].payload.treeId, expectedScope);
  assert.equal(dispatched[1].type, 'sidePanel/setSidePanelOpen');
  assert.deepEqual(dispatched[1].payload.panelScope, expectedScope);
  assert.deepEqual(dispatched[1].payload.treeId, expectedScope);
  assert.equal(dispatched[1].payload.isOpen, true);

  assert.equal(navCalls.length, 1);
  assert.equal(navCalls[0].to, '/');
  assert.deepEqual(navCalls[0].search({}), { tab: 'sidecar__antigravity-pulse/panel__/' });
});

test('openSidebarPanel uses newConversation scope when project query param is present', async (t) => {
  const mods = await loadHostAdapterModules(t);
  if (!mods) return;
  const { reduxSidebar } = mods;
  const { rootFiber, dispatched } = createHostFiber({ redesignEnabled: true });
  withDomGlobals(t, { search: '?project=demo-ws', rootFiber });

  const method = reduxSidebar.openSidebarPanel();
  assert.equal(method, 'redux');
  assert.deepEqual(dispatched[0].payload.panelScope, {
    kind: 'newConversation',
    projectId: 'demo-ws',
  });
  assert.deepEqual(dispatched[0].payload.treeId, {
    kind: 'newConversation',
    projectId: 'demo-ws',
  });
});

test('readDesktopConversationId reads ?cascadeId=<guid> and ignores invalid IDs', async (t) => {
  const mods = await loadHostAdapterModules(t);
  if (!mods) return;
  const { reactFiber } = mods;
  const cascadeId = '12345678-9abc-4def-8123-456789abcdef';
  withDomGlobals(t, { search: `?cascadeId=${cascadeId}` });
  assert.equal(reactFiber.readDesktopConversationId(null), cascadeId);

  withDomGlobals(t, { search: '?cascadeId=invalid-id' });
  assert.equal(reactFiber.readDesktopConversationId(null), null);
});
