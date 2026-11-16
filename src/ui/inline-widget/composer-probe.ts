import type { RuntimeBridgeApi } from '../../contracts/index.ts';
import { openSidebarPanel, readDesktopConversationId } from '../host-adapter/index.ts';
import {
  badgeTextRects,
  findFallbackMatches,
  findPrimaryMatches,
  findSubagentMatches,
  isElementVisible,
  WIDGET_CONTAINER_ID,
} from './composer-matchers.ts';
import type { ComposerMatch, NativeBaseline, WidgetSurface } from './types.ts';

export { WIDGET_CONTAINER_ID };

export function resolveConversationId(
  composer: ComposerMatch | null,
  surface: WidgetSurface | undefined,
): string | null {
  if (surface) return surface.conversationId(composer);
  return readDesktopConversationId(composer);
}

export function openHostSidebar(
  composer: ComposerMatch | null,
  conversationId: string | null,
  host: RuntimeBridgeApi | undefined,
): void {
  openSidebarPanel({
    composer,
    conversationId,
    sidecarId: 'antigravity-pulse/panel',
    uri: 'sidecar://antigravity-pulse/panel/',
    host: host ?? null,
  });
}

export function findComposer(
  previous: ComposerMatch | null,
  surface: WidgetSurface | undefined,
): ComposerMatch | null {
  if (surface) return surface.findComposer(previous);
  const semanticEditors = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="combobox"][contenteditable="true"],[role="textbox"][contenteditable="true"]',
    ),
  ).filter(isElementVisible);
  const editors = Array.from(
    new Set([
      ...semanticEditors,
      ...Array.from(document.querySelectorAll<HTMLElement>('[aria-label="Message input"]')).filter(isElementVisible),
    ]),
  );

  const pairs = findPrimaryMatches(editors);
  const ambiguousBoxes = findSubagentMatches(editors, pairs);
  if (!pairs.length) {
    findFallbackMatches(editors, ambiguousBoxes, pairs);
  }

  pairs.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
  if (!pairs.length) return null;
  const focused = pairs.filter(
    (pair) => pair.editor === document.activeElement || pair.editor.contains(document.activeElement),
  );
  if (focused.length === 1) return focused[0];
  const retained = pairs.filter(
    (pair) => pair.branch === previous?.branch && pair.editor === previous?.editor,
  );
  if (retained.length === 1) return retained[0];
  // Equally plausible visible composers must not place the strip arbitrarily.
  const closest = pairs.filter((pair) => pair.distance === pairs[0].distance);
  if (closest.length === 1) return closest[0];
  return (
    closest.find((pair) => pair.editor === document.activeElement) ??
    closest.find((pair) => pair.branch === previous?.branch && pair.editor === previous?.editor) ??
    null
  );
}

export function captureNative(found: ComposerMatch, surface: WidgetSurface | undefined): NativeBaseline {
  const branch = found.branch;
  const r = branch.getBoundingClientRect();
  const baseline: NativeBaseline = {
    height: r.height,
    icons: Array.from(branch.querySelectorAll('svg')).map((icon) => ({
      icon,
      width: icon.getBoundingClientRect().width,
    })),
    reserve: 0,
  };
  if (found.kind === 'ide' && surface) {
    baseline.reserve = surface.nativeReserve(found);
  }
  if (found.kind === 'subagent' && found.anchor) {
    const badge = found.anchor;
    const style = getComputedStyle(badge);
    // Summed glyph fragments recover intrinsic text width even if the host
    // is already wrapping the badge when we first attach.
    const textWidth = badgeTextRects(badge).reduce((sum, rect) => sum + rect.width, 0);
    const iconWidth = badge.querySelector('svg')?.getBoundingClientRect().width || 0;
    const natural =
      textWidth +
      Math.max(iconWidth, 12) +
      (parseFloat(style.columnGap) || 0) +
      (parseFloat(style.paddingLeft) || 0) +
      (parseFloat(style.paddingRight) || 0);
    baseline.reserve = Math.ceil(
      Math.max(badge.getBoundingClientRect().width, natural) +
        badge.getBoundingClientRect().left -
        r.left +
        (parseFloat(getComputedStyle(branch).paddingRight) || 0),
    );
  }
  return baseline;
}

export function nativeComfortable(composer: ComposerMatch): boolean {
  const baseline = composer.native;
  if (!baseline) return true;
  if (composer.branch.getBoundingClientRect().height > baseline.height + 1) return false;
  if (
    baseline.icons.some(
      ({ icon, width }) => icon.isConnected && icon.getBoundingClientRect().width < width - 0.5,
    )
  ) {
    return false;
  }
  if (composer.kind === 'ide' && composer.branch.getBoundingClientRect().width < baseline.reserve - 1) {
    return false;
  }
  if (composer.kind === 'subagent') {
    if (composer.branch.getBoundingClientRect().width < baseline.reserve - 1) return false;
    const lines = new Set(badgeTextRects(composer.anchor).map((r) => Math.round(r.top)));
    if (lines.size > 1) return false;
  }
  return true;
}

export function reserveNativeSpace(node: HTMLElement, composer: ComposerMatch): void {
  if (!['subagent', 'ide'].includes(composer.kind) || !composer.native) {
    if (node.style.getPropertyValue('--pulse-native-room')) {
      node.style.removeProperty('--pulse-native-room');
    }
    if (node.classList.contains('native-no-room')) {
      node.classList.remove('native-no-room');
    }
    return;
  }
  const row = composer.row;
  const style = getComputedStyle(row);
  const siblings = Array.from(row.children).filter(
    (e) => e !== node && e !== composer.branch && e.getClientRects().length,
  );
  const siblingsWidth = siblings.reduce((sum, e) => {
    const s = getComputedStyle(e);
    return sum + e.getBoundingClientRect().width + (parseFloat(s.marginLeft) || 0) + (parseFloat(s.marginRight) || 0);
  }, 0);
  const room =
    row.clientWidth -
    (parseFloat(style.paddingLeft) || 0) -
    (parseFloat(style.paddingRight) || 0) -
    composer.native.reserve -
    siblingsWidth -
    (parseFloat(style.columnGap) || 0) * (siblings.length + 1) -
    10;
  const width = `${Math.max(0, Math.floor(room))}px`;
  if (node.style.getPropertyValue('--pulse-native-room') !== width) {
    node.style.setProperty('--pulse-native-room', width);
  }
  // A hidden ribbon must release its flex space as well as its hit targets.
  // The budget is independent of our own rectangle, so it recovers directly
  // when the sidebar is closed, without probing the native badge each frame.
  node.classList.toggle('native-no-room', room < 76);
}
