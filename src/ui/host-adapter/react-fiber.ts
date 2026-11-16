import { isValidGuid, type ComposerTarget, type ReactFiberNode } from './types.ts';

const DEFAULT_FIBER_PREFIXES = ['__reactFiber$', '__reactContainer$'] as const;
const EDITOR_FIBER_PREFIXES = ['__reactFiber'] as const;
const CONVERSATION_PROP_KEYS = ['cascadeId', 'conversationId', 'effectiveCascadeId'] as const;

const DEFAULT_MAX_EDITOR_DEPTH = 50;
const DEFAULT_MAX_ANCESTOR_HOPS = 2000;
const DEFAULT_MAX_TREE_NODES = 2500;

/**
 * Finds the React Fiber or Container node attached to a DOM element.
 */
export function findReactFiber(
  element: Element | null | undefined,
  prefixes: readonly string[] = DEFAULT_FIBER_PREFIXES,
): ReactFiberNode | null {
  if (!element) return null;
  try {
    const record = element as unknown as Record<string, unknown>;
    const key = Object.keys(record).find((name) =>
      prefixes.some((prefix) => name.startsWith(prefix)),
    );
    if (!key) return null;
    const candidate = record[key];
    return candidate && typeof candidate === 'object' ? (candidate as ReactFiberNode) : null;
  } catch {
    return null;
  }
}

/**
 * Walks up a composer editor's React Fiber chain (bounded) to extract a cascade/conversation ID.
 */
export function readFiberConversationId(
  editor: Element | null | undefined,
  maxDepth = DEFAULT_MAX_EDITOR_DEPTH,
): string | null {
  if (!editor) return null;
  try {
    let fiber = findReactFiber(editor, EDITOR_FIBER_PREFIXES);
    let depth = 0;
    while (fiber && depth++ < maxDepth) {
      const props = fiber.memoizedProps;
      if (props && typeof props === 'object') {
        for (const propKey of CONVERSATION_PROP_KEYS) {
          const value = props[propKey];
          if (isValidGuid(value)) return value;
        }
      }
      fiber = fiber.return ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Extracts the conversation ID owned by a desktop composer without reading sidebar/global IDs.
 */
export function readDesktopConversationId(composer?: ComposerTarget | null): string | null {
  try {
    const owner = (composer?.box || composer?.row)?.closest('[data-cascade-id]');
    if (owner) {
      const id = owner.getAttribute('data-cascade-id');
      return isValidGuid(id) ? id : null;
    }
  } catch {
    return null;
  }

  try {
    const decodedPath = decodeURIComponent(location.pathname);
    const fromPath = decodedPath.match(/\/c\/((?:[a-zA-Z0-9_.-]+\/)*[0-9a-f-]{36})/i)?.[1];
    if (isValidGuid(fromPath)) return fromPath;
  } catch {
    // Ignore malformed pathname encoding and continue to query/fiber lookup.
  }

  try {
    const params = new URLSearchParams(location.search);
    const fromSearch = params.get('conversationId') || params.get('c');
    if (isValidGuid(fromSearch)) return fromSearch;
  } catch {
    // Ignore invalid location search access.
  }

  return readFiberConversationId(composer?.editor);
}

/**
 * Visits fibers from `startFiber` upward, then performs a bounded BFS from the root fiber.
 * Stops immediately once `visitor` returns `true`.
 */
export function walkReactFibers(
  startFiber: ReactFiberNode | null | undefined,
  visitor: (fiber: ReactFiberNode) => boolean,
  maxTreeNodes = DEFAULT_MAX_TREE_NODES,
  maxAncestorHops = DEFAULT_MAX_ANCESTOR_HOPS,
): void {
  if (!startFiber) return;
  try {
    let cursor: ReactFiberNode | null = startFiber;
    let hostRoot: ReactFiberNode = startFiber;
    let hops = 0;
    const ancestorSeen = new Set<ReactFiberNode>();

    while (cursor && hops++ < maxAncestorHops && !ancestorSeen.has(cursor)) {
      ancestorSeen.add(cursor);
      hostRoot = cursor;
      if (visitor(cursor)) return;
      cursor = cursor.return ?? null;
    }

    const queue: ReactFiberNode[] = [hostRoot];
    const seen = new Set<ReactFiberNode>();
    while (queue.length > 0 && seen.size < maxTreeNodes) {
      const current = queue.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      if (visitor(current)) return;
      if (current.child) queue.push(current.child);
      if (current.sibling) queue.push(current.sibling);
    }
  } catch {
    // Host fiber structure changed; leave caller to handle missing targets.
  }
}
