import type { RuntimeBridgeApi } from '../../contracts/ipc.ts';
import { findReactFiber, readDesktopConversationId, walkReactFibers } from './react-fiber.ts';
import type {
  OpenSidebarPanelOptions,
  ReactFiberNode,
  SidebarOpenMethod,
} from './types.ts';

const DEFAULT_SIDECAR_ID = 'antigravity-pulse/panel';
const DEFAULT_SIDECAR_URI = 'sidecar://antigravity-pulse/panel/';
const DEFAULT_DISPLAY_NAME = 'Antigrative Dashboard';

interface ReduxStateLike {
  sidePanelV2?: unknown;
  sidePanel?: unknown;
}

interface ReduxStoreLike {
  dispatch(action: { type: string; payload: Record<string, unknown> }): unknown;
  getState(): ReduxStateLike | null | undefined;
}

interface SidecarViewLike {
  entrypoint?: unknown;
  path?: string;
  title?: string;
}

interface SidecarRecordLike {
  sidecarId?: string;
  baseUrl?: string;
  config?: {
    uiConfig?: {
      displayName?: string;
      views?: SidecarViewLike[];
    };
  };
}

interface ExtensibilityLike {
  resolveSidecarUrl(baseUrl: string, path: string): string | null | undefined;
  provider?: {
    getState?: () => SidecarRecordLike[] | null | undefined;
  };
}

interface RouterLike {
  state?: { location?: unknown };
  navigate(options: Record<string, unknown>): unknown;
}

interface HostBridgeWindow {
  agPulseHost?: Pick<RuntimeBridgeApi, 'openSidebar'> | null;
}

function isReduxStore(value: unknown): value is ReduxStoreLike {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ReduxStoreLike>;
  if (typeof candidate.dispatch !== 'function' || typeof candidate.getState !== 'function') {
    return false;
  }
  try {
    const state = candidate.getState();
    return Boolean(state && (state.sidePanelV2 || state.sidePanel));
  } catch {
    return false;
  }
}

function isRouter(value: unknown): value is RouterLike {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RouterLike>;
  return typeof candidate.navigate === 'function' && Boolean(candidate.state?.location);
}

function probeReduxDependencies(startFiber: ReactFiberNode): {
  store: ReduxStoreLike | null;
  ext: ExtensibilityLike | null;
  router: RouterLike | null;
} {
  let store: ReduxStoreLike | null = null;
  let ext: ExtensibilityLike | null = null;
  let router: RouterLike | null = null;

  walkReactFibers(startFiber, (fiber) => {
    const props = fiber.memoizedProps;
    if (!props || typeof props !== 'object') return false;
    const valueProp = props.value as Record<string, unknown> | undefined;

    if (!store) {
      for (const candidate of [props.store, valueProp?.store]) {
        if (isReduxStore(candidate)) {
          store = candidate;
          break;
        }
      }
    }

    if (!ext && valueProp && typeof valueProp.get === 'function') {
      try {
        const svc = (valueProp.get as (name: string) => unknown)('extensibility') as
          | Partial<ExtensibilityLike>
          | null
          | undefined;
        if (svc && typeof svc.resolveSidecarUrl === 'function' && svc.provider?.getState) {
          ext = svc as ExtensibilityLike;
        }
      } catch {
        // Ignore unavailable DI service lookups.
      }
    }

    if (!router) {
      for (const candidate of [props.router, valueProp?.router, valueProp]) {
        if (isRouter(candidate)) {
          router = candidate;
          break;
        }
      }
    }

    return Boolean(store && ext && router);
  });

  return { store, ext, router };
}

function dispatchSidecarOpen(
  store: ReduxStoreLike,
  ext: ExtensibilityLike | null,
  router: RouterLike | null,
  options: {
    sidecarId: string;
    displayName: string;
    conversationId: string | null;
  },
): boolean {
  const { sidecarId, displayName, conversationId } = options;
  const sidecars = ext?.provider?.getState?.() || [];
  const sidecar = sidecars.find(
    (entry) =>
      entry?.sidecarId === sidecarId ||
      entry?.sidecarId?.endsWith?.(`/${sidecarId}`) ||
      (entry?.sidecarId?.endsWith?.('/panel') &&
        entry?.config?.uiConfig?.displayName === displayName),
  );
  const views = sidecar?.config?.uiConfig?.views || [];
  const view =
    views.find(
      (item) => item?.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE' || item?.entrypoint === 1,
    ) ||
    views[0] || { path: '/', title: displayName };
  const path = view.path || '/';
  const url =
    (sidecar?.baseUrl && ext?.resolveSidecarUrl
      ? ext.resolveSidecarUrl(sidecar.baseUrl, path)
      : null) ||
    document
      .querySelector(`[data-sidecar-id="${sidecarId}"][data-sidecar-url]`)
      ?.getAttribute('data-sidecar-url');

  if (!url) return false;

  const projectId = new URLSearchParams(location.search).get('project');
  const treeId = conversationId
    ? { kind: 'cascadeId', cascadeId: conversationId }
    : projectId
      ? { kind: 'newConversation', projectId }
      : { kind: 'home' };
  const resolvedId = sidecar?.sidecarId || sidecarId;
  const title = view.title || sidecar?.config?.uiConfig?.displayName || displayName;
  const content = {
    type: 'sidecarView',
    sidecarView: { sidecarId: resolvedId, path, url, title },
  };
  const tabId = `sidecar__${resolvedId}__${path}`;
  const state = store.getState();

  if (state?.sidePanelV2) {
    store.dispatch({
      type: 'sidePanelV2/setContent',
      payload: {
        treeId,
        content,
        tabId,
        keepOpen: false,
        background: false,
        deferActivation: false,
      },
    });
  } else if (state?.sidePanel) {
    store.dispatch({
      type: 'sidePanel/setContent',
      payload: { treeId, content, tabId, keepOpen: false, background: false },
    });
  }
  if (state?.sidePanel) {
    store.dispatch({
      type: 'sidePanel/setSidePanelOpen',
      payload: { treeId, isOpen: true },
    });
  }

  if (router?.navigate) {
    try {
      const opts = {
        search: (prev: Record<string, unknown> | undefined) => ({ ...(prev || {}), tab: tabId }),
        replace: true,
      };
      Promise.resolve(
        conversationId ? router.navigate(opts) : router.navigate({ to: '/', ...opts }),
      ).catch(() => {});
    } catch {
      // Router sync is best-effort after Redux sidePanel dispatch.
    }
  }
  return true;
}

function triggerSidecarProtocolLink(uri: string): SidebarOpenMethod {
  try {
    const link = document.createElement('a');
    link.href = uri;
    link.setAttribute('aria-hidden', 'true');
    link.style.display = 'none';
    const preventUnhandled = (event: Event) => {
      if (event.target === link) event.preventDefault();
    };
    window.addEventListener('click', preventUnhandled, { once: true });
    document.body.append(link);
    try {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    } finally {
      link.remove();
      setTimeout(() => window.removeEventListener('click', preventUnhandled), 0);
    }
    return 'link';
  } catch {
    return 'none';
  }
}

/**
 * Opens the plugin sidebar panel via host bridge, Redux sidePanel dispatch, or sidecar URI fallback.
 */
export function openSidebarPanel(options: OpenSidebarPanelOptions = {}): SidebarOpenMethod {
  const sidecarId = options.sidecarId ?? DEFAULT_SIDECAR_ID;
  const uri = options.uri ?? DEFAULT_SIDECAR_URI;
  const displayName = options.displayName ?? DEFAULT_DISPLAY_NAME;
  const host = options.host ?? (window as unknown as HostBridgeWindow).agPulseHost;

  if (typeof host?.openSidebar === 'function') {
    Promise.resolve(host.openSidebar({ sidecarId, uri })).catch(() => {});
    return 'bridge';
  }

  try {
    const existing = document.querySelector(
      `[data-testid="plugins-submenu-item"][data-sidecar-id="${sidecarId}"]`,
    );
    if (existing instanceof HTMLElement) {
      existing.click();
      return 'submenu';
    }

    let startFiber: ReactFiberNode | null = null;
    for (const el of [
      options.composer?.box,
      document.getElementById('root'),
      document.body?.firstElementChild,
    ]) {
      startFiber = findReactFiber(el);
      if (startFiber) break;
    }

    if (startFiber) {
      const { store, ext, router } = probeReduxDependencies(startFiber);
      if (store) {
        const conversationId =
          options.conversationId !== undefined
            ? options.conversationId
            : readDesktopConversationId(options.composer);
        if (
          dispatchSidecarOpen(store, ext, router, {
            sidecarId,
            displayName,
            conversationId,
          })
        ) {
          return 'redux';
        }
      }
    }
  } catch {
    // Fall back to the sidecar protocol link when host Redux/Fiber internals are absent.
  }

  return triggerSidecarProtocolLink(uri);
}
