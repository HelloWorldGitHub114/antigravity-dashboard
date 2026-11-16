import {
  buildDensityMotion,
  computeDensityBounds,
  DENSITY_INTERACTIVE_SELECTOR,
  snapshotDensityPieces,
  type ActiveDensityMotion,
  type DensitySnapshot,
} from './density-animate.ts';
import type { ComposerMatch, WidgetLanguage } from './types.ts';

interface DensityProbe {
  key: string;
  width: number;
}

export interface DensityFitContext {
  node: HTMLElement;
  root: ShadowRoot;
  composer: ComposerMatch;
  language: WidgetLanguage;
  lastConversation: string | null;
  isUsageOpen: boolean;
  reserveNativeSpace: () => void;
  nativeComfortable: () => boolean;
  hide: () => void;
  position: () => void;
  updateGuide: () => void;
}

const COLLISION_SELECTOR = `${DENSITY_INTERACTIVE_SELECTOR},[contenteditable="true"]`;

function canFitRibbon(
  node: HTMLElement,
  bar: HTMLElement,
  composer: ComposerMatch,
  nativeComfortable: () => boolean,
): boolean {
  const rect = node.getBoundingClientRect();
  const row = composer.row.getBoundingClientRect();
  const intersects = (other: DOMRect): boolean =>
    Math.min(rect.right, other.right) - Math.max(rect.left, other.left) > 1 &&
    Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top) > 1;
  if (
    bar.scrollWidth > bar.clientWidth + 2 ||
    rect.width <= 0 ||
    rect.left < -1 ||
    rect.right > innerWidth + 1 ||
    rect.top < -1 ||
    rect.bottom > innerHeight + 1 ||
    rect.left < row.left - 1 ||
    rect.right > row.right + 1
  ) {
    return false;
  }
  if (!nativeComfortable()) return false;
  if (composer.kind === 'subagent' && composer.anchor && intersects(composer.anchor.getBoundingClientRect())) {
    return false;
  }
  for (const control of document.querySelectorAll(COLLISION_SELECTOR)) {
    const other = control.getBoundingClientRect();
    if (other.width <= 0 || other.height <= 0 || !intersects(other)) continue;
    if (control.closest('[hidden],[inert]') || getComputedStyle(control).visibility === 'hidden') {
      continue;
    }
    // Scrolling messages can put clipped/covered links underneath the
    // fixed composer. Their rectangles alone are not a visible collision.
    // Always reserve local actions; other controls must actually paint at
    // the intersection (e.g. a floating jump-to-bottom button).
    if (composer.row.parentElement?.contains(control)) return false;
    const left = Math.max(rect.left, other.left);
    const right = Math.min(rect.right, other.right);
    const top = Math.max(rect.top, other.top);
    const bottom = Math.min(rect.bottom, other.bottom);
    for (const [x, y] of [
      [(left + right) / 2, (top + bottom) / 2],
      [left + 0.5, top + 0.5],
      [right - 0.5, top + 0.5],
      [left + 0.5, bottom - 0.5],
      [right - 0.5, bottom - 0.5],
    ] as const) {
      const hit = document.elementFromPoint(x, y);
      if (hit === control || control.contains(hit)) return false;
    }
  }
  return true;
}

export class DensityMotionController {
  private readonly media: MediaQueryList;
  private frame: DensitySnapshot | null = null;
  private motion: ActiveDensityMotion | null = null;
  private probe: DensityProbe | null = null;
  private readonly onMediaChange = (): void => {
    this.stop();
  };

  constructor() {
    this.media = matchMedia('(prefers-reduced-motion: reduce)');
    this.media.addEventListener('change', this.onMediaChange);
  }

  stop(node?: HTMLElement | null): void {
    const active = this.motion;
    this.motion = null;
    if (!active) return;
    for (const animation of active.animations) {
      animation.cancel();
    }
    active.stage.remove();
    if (node) {
      delete node.dataset.motion;
    }
  }

  reset(node?: HTMLElement | null): void {
    this.stop(node);
    this.frame = null;
    this.probe = null;
  }

  dispose(node?: HTMLElement | null): void {
    this.media.removeEventListener('change', this.onMediaChange);
    this.reset(node);
  }

  private clip(node: HTMLElement, next: DensitySnapshot, composer: ComposerMatch): void {
    if (!this.motion) return;
    const limits = computeDensityBounds(next, composer);
    if (!limits) {
      this.stop(node);
      return;
    }
    // The ribbon follows its parent 1:1 while dragging. Keep its existing
    // compositor animation and clock; only crop to current safe host bounds.
    const stage = this.motion.stage;
    const r = stage.getBoundingClientRect();
    stage.style.clipPath = `inset(0px ${Math.max(0, r.right - limits.right)}px 0px ${Math.max(0, limits.left - r.left)}px)`;
  }

  fit(ctx: DensityFitContext): void {
    const { node, root, composer } = ctx;
    if (!node.isConnected) return;
    // A modal owns input while open. Composer collision scans behind its
    // backdrop cannot improve its layout and can hide its hosting strip.
    if (ctx.isUsageOpen) {
      this.stop(node);
      return;
    }
    ctx.reserveNativeSpace();
    const bar = root.querySelector('.bar') as HTMLElement | null;
    if (!bar) return;
    const oldDensity = node.dataset.density;
    const oldReady = node.dataset.layout === 'ready';
    let previous = this.frame;
    if (['compact', 'narrow', 'context-only'].some((c) => node.classList.contains(c))) {
      node.classList.remove('compact', 'narrow', 'context-only');
    }

    const fits = (): boolean => canFitRibbon(node, bar, composer, ctx.nativeComfortable);
    let safe = fits();
    const rowWidth = composer.row.getBoundingClientRect().width;
    const dot = root.getElementById('dot');
    const probeKey = (): string =>
      node.style.cssText.replace(/--pulse-native-room:[^;]+;?/g, '') +
      '|' +
      ctx.language.language +
      '|' +
      ctx.lastConversation +
      '|' +
      bar.textContent +
      '|' +
      (dot?.className ?? '') +
      '|' +
      getComputedStyle(composer.row).gap +
      '|' +
      Array.from(composer.row.querySelectorAll(DENSITY_INTERACTIVE_SELECTOR))
        .filter((c) => c !== composer.model && !c.contains(composer.model))
        .map((c) => c.getBoundingClientRect().width)
        .join(',');

    if (oldDensity === 'icons') {
      const key = probeKey();
      // Twelve pixels of recovery headroom prevents threshold chatter. Shrinking
      // or scrolling in icon mode never toggles back to full just to measure it.
      if (!this.probe || key !== this.probe.key || rowWidth >= this.probe.width + 12) {
        previous = snapshotDensityPieces(node, root, composer, this.motion, previous);
        node.classList.remove('icons-only');
        safe = fits();
        if (!safe) {
          node.classList.add('icons-only');
          safe = fits();
          this.probe = { key, width: rowWidth };
        } else {
          this.probe = null;
        }
      }
    } else if (!safe) {
      previous = snapshotDensityPieces(node, root, composer, this.motion, previous);
      node.classList.add('icons-only');
      safe = fits();
      this.probe = { key: probeKey(), width: rowWidth };
    }

    node.dataset.density = node.classList.contains('icons-only') ? 'icons' : 'full';
    const state = safe ? 'ready' : 'blocked';
    if (node.dataset.layout !== state) {
      node.dataset.layout = state;
      node.inert = !safe;
      if (!safe) ctx.hide();
    }

    const changed = safe && oldReady && previous?.row === composer.row && oldDensity !== node.dataset.density;
    const next: DensitySnapshot = changed
      ? snapshotDensityPieces(node, root, composer, this.motion)
      : {
          pieces: new Map(),
          rect: node.getBoundingClientRect(),
          model: composer.model,
          modelRect: composer.model?.getBoundingClientRect(),
          row: composer.row,
        };

    if (changed && previous) {
      const interrupted = Boolean(this.motion);
      const modelOpacity = next.model ? getComputedStyle(next.model).opacity : '1';
      this.stop(node);
      const motion = buildDensityMotion({
        node,
        root,
        composer,
        previous,
        next,
        reduce: this.media.matches,
        interrupted,
        modelOpacity,
      });
      if (motion) {
        this.motion = motion;
        const finish = motion.animations.at(-1);
        if (finish) {
          finish.onfinish = () => {
            if (this.motion === motion) {
              this.stop(node);
              ctx.position();
            }
          };
        }
      }
    } else if (!safe || previous?.row !== composer.row || previous?.model !== composer.model) {
      this.stop(node);
    } else if (this.motion) {
      this.clip(node, next, composer);
    }

    this.frame = next;
    ctx.updateGuide();
  }
}
