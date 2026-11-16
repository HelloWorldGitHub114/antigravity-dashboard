import {
  isValidGuid,
  type ComposerTarget,
  type ConversationState,
  type PreactVNode,
} from './types.ts';

const MAX_VNODE_SEARCH = 12000;
const MAX_ANCESTOR_HOPS = 60;

interface PreactElement extends Element {
  __k?: PreactVNode | null;
}

function isVisibleElement(element: Element): boolean {
  return (
    element.isConnected &&
    !element.closest('[hidden],[inert]') &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== 'hidden'
  );
}

/**
 * Probes the IDE side-panel region and Preact VNode tree (`__k`, `__e`, `__`, `props.cascadeId`)
 * with bounded traversal to determine the composer's exact conversation state.
 */
export function readIdeConversationState(composer?: ComposerTarget | null): ConversationState {
  const unavailable: ConversationState = { id: null, status: 'unavailable' };
  try {
    if (!composer?.box?.isConnected) return unavailable;

    // The region that owns this exact input also owns its conversation.
    // Never read history/sidebar/subagent rows or another workbench window's ID.
    const region = composer.box.closest('[id="conversation"][role="region"]');
    if (!region) return unavailable;

    const ids = new Set<string>();
    for (const view of region.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]')) {
      if (!isVisibleElement(view)) continue;
      const candidate = (view as HTMLElement).dataset?.cascadeId ?? view.getAttribute('data-cascade-id');
      if (isValidGuid(candidate)) ids.add(candidate);
    }
    if (ids.size === 1) return { id: [...ids][0], status: 'active' };
    if (ids.size > 1) return unavailable;

    const panel = composer.box.closest('.antigravity-agent-side-panel') as PreactElement | null;
    const tree = panel?.__k;
    if (!tree || typeof tree !== 'object') return unavailable;

    const pending: PreactVNode[] = [tree];
    const seen = new Set<PreactVNode>();
    let match: PreactVNode | null = null;

    while (pending.length > 0 && seen.size < MAX_VNODE_SEARCH) {
      const vnode = pending.pop();
      if (!vnode || typeof vnode !== 'object' || seen.has(vnode)) continue;
      seen.add(vnode);
      if (typeof vnode.type === 'string' && vnode.__e === composer.box) {
        match = vnode;
        break;
      }
      if (Array.isArray(vnode.__k)) {
        pending.push(...vnode.__k);
      }
    }

    for (let hops = 0; match && hops < MAX_ANCESTOR_HOPS; hops++, match = match.__ ?? null) {
      const props = match.props;
      if (props && typeof props === 'object' && Object.hasOwn(props, 'cascadeId')) {
        const id = props.cascadeId;
        if (isValidGuid(id)) return { id, status: 'active' };
        // An explicitly empty native owner is a new conversation. A missing
        // or incompatible private API must not be labelled as a new chat.
        return id === null || id === undefined || id === ''
          ? { id: null, status: 'new' }
          : unavailable;
      }
      if (match === tree) break;
    }

    return unavailable;
  } catch {
    return unavailable;
  }
}

/**
 * Returns the active IDE conversation ID for a composer, or `null` when new/unavailable.
 */
export function readIdeConversationId(composer?: ComposerTarget | null): string | null {
  return readIdeConversationState(composer).id;
}
