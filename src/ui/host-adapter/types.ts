import type { RuntimeBridgeApi } from '../../contracts/ipc.ts';

/**
 * Matches a valid Antigravity conversation / cascade GUID (with optional path prefix).
 */
export const GUID_PATTERN =
  /^(?:[a-zA-Z0-9_.-]+\/)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks whether a value is a non-empty valid conversation / cascade GUID string.
 */
export function isValidGuid(value: unknown): value is string {
  return typeof value === 'string' && GUID_PATTERN.test(value);
}

/**
 * Minimal composer DOM references needed by host-private adapters.
 */
export interface ComposerTarget {
  editor?: Element | null;
  box?: Element | null;
  row?: Element | null;
}

/**
 * Availability state of the active IDE conversation.
 */
export type ConversationStatus = 'active' | 'new' | 'unavailable';

/**
 * Conversation identity and status reported by the IDE Preact adapter.
 */
export interface ConversationState {
  id: string | null;
  status: ConversationStatus;
}

/**
 * Method used to open the Antigravity sidebar panel.
 */
export type SidebarOpenMethod = 'bridge' | 'submenu' | 'redux' | 'link' | 'none';

/**
 * Options for opening the plugin sidecar panel in the desktop host.
 */
export interface OpenSidebarPanelOptions {
  composer?: ComposerTarget | null;
  conversationId?: string | null;
  sidecarId?: string;
  uri?: string;
  displayName?: string;
  host?: Pick<RuntimeBridgeApi, 'openSidebar'> | null;
}

/**
 * Bounded React Fiber shape probed behind `react-fiber.ts`.
 */
export interface ReactFiberNode {
  memoizedProps?: Record<string, unknown> | null;
  return?: ReactFiberNode | null;
  child?: ReactFiberNode | null;
  sibling?: ReactFiberNode | null;
}

/**
 * Bounded Preact VNode shape probed behind `preact-vnode.ts`.
 */
export interface PreactVNode {
  type?: unknown;
  __e?: Element | null;
  __k?: PreactVNode[] | PreactVNode | null;
  __?: PreactVNode | null;
  props?: Record<string, unknown> | null;
}
