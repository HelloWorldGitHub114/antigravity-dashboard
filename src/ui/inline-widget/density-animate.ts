import type { ComposerMatch } from './types.ts';

export interface DensityPiece {
  rect: DOMRect;
  opacity: number;
  font: string;
  color: string;
  icon: boolean;
}

export interface DensitySnapshot {
  pieces: Map<Element, DensityPiece>;
  rect: DOMRect;
  model: HTMLElement | null;
  modelRect: DOMRect | undefined;
  row: HTMLElement;
}

export interface ActiveDensityMotion {
  stage: HTMLDivElement;
  animations: Animation[];
  pieces: Map<Element, HTMLElement>;
  sources: Map<Element, DensityPiece>;
}

const DENSITY_EASE = 'cubic-bezier(0.32,0.72,0,1)';
export const DENSITY_INTERACTIVE_SELECTOR = 'button,[role="button"],a[href],input,select';

export function snapshotDensityPieces(
  node: HTMLElement,
  root: ShadowRoot,
  composer: ComposerMatch,
  activeMotion: ActiveDensityMotion | null,
  previous?: DensitySnapshot | null,
): DensitySnapshot {
  const pieces = new Map<Element, DensityPiece>();
  for (const chip of root.querySelectorAll('.bar .chip')) {
    for (const element of chip.children) {
      if (!element.getClientRects().length) continue;
      const computed = getComputedStyle(element);
      pieces.set(element, {
        rect: element.getBoundingClientRect(),
        opacity: 1,
        font: computed.font,
        color: computed.color,
        icon: element.matches('svg,.context-ring'),
      });
    }
  }
  // Read interrupted copies before changing density. Reading them after the
  // final flex layout moves their parent would bake that shift into the new
  // start position and produce a visible jump on reversal.
  if (previous && activeMotion) {
    for (const [element, visual] of activeMotion.pieces) {
      const piece = pieces.get(element) ?? activeMotion.sources.get(element);
      if (piece) {
        pieces.set(element, {
          ...piece,
          rect: visual.getBoundingClientRect(),
          opacity: Number(getComputedStyle(visual).opacity),
        });
      }
    }
  }
  return {
    pieces,
    rect: node.getBoundingClientRect(),
    model: composer.model,
    modelRect:
      previous?.model === composer.model
        ? previous.modelRect
        : composer.model?.getBoundingClientRect(),
    row: composer.row,
  };
}

export function computeDensityBounds(
  next: DensitySnapshot,
  composer: ComposerMatch,
): { left: number; right: number } | null {
  const row = next.row.getBoundingClientRect();
  const target = next.rect;
  let left = Math.max(row.left, composer.anchor?.getBoundingClientRect().right || 0);
  let right = Math.min(row.right, innerWidth);
  for (const control of document.querySelectorAll(DENSITY_INTERACTIVE_SELECTOR)) {
    if (control === next.model || next.model?.contains(control) || control.contains(next.model)) {
      continue;
    }
    const r = control.getBoundingClientRect();
    if (
      r.width <= 0 ||
      r.height <= 0 ||
      Math.min(target.bottom, r.bottom) - Math.max(target.top, r.top) <= 1
    ) {
      continue;
    }
    if (control.closest('[hidden],[inert]') || getComputedStyle(control).visibility === 'hidden') {
      continue;
    }
    if (!next.row.parentElement?.contains(control)) {
      if (Math.min(right, r.right) - Math.max(left, r.left) <= 0) continue;
      const x = (Math.max(left, r.left) + Math.min(right, r.right)) / 2;
      const y = (Math.max(target.top, r.top) + Math.min(target.bottom, r.bottom)) / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit !== control && !control.contains(hit)) continue;
    }
    if (r.right <= target.left + 1) left = Math.max(left, r.right);
    else if (r.left >= target.right - 1) right = Math.min(right, r.left);
    else return null;
  }
  return right - left >= target.width - 2 ? { left, right } : null;
}

export function buildDensityMotion(params: {
  node: HTMLElement;
  root: ShadowRoot;
  composer: ComposerMatch;
  previous: DensitySnapshot;
  next: DensitySnapshot;
  reduce: boolean;
  interrupted: boolean;
  modelOpacity: string;
}): ActiveDensityMotion | null {
  const { node, root, composer, previous, next, reduce, interrupted, modelOpacity } = params;
  if (!Element.prototype.animate) return null;
  const limits = computeDensityBounds(next, composer);
  if (!limits) return null;
  const { left, right } = limits;
  const target = next.rect;
  const duration = reduce ? 120 : 240;
  const stage = document.createElement('div');
  stage.className = 'density-stage';
  stage.inert = true;
  stage.setAttribute('aria-hidden', 'true');
  stage.style.cssText = `left:${left - target.left}px;top:0;width:${right - left}px;height:${target.height}px`;
  root.append(stage);

  const motion: ActiveDensityMotion = {
    stage,
    animations: [],
    pieces: new Map(),
    sources: new Map([...previous.pieces, ...next.pieces]),
  };
  node.dataset.motion = 'density';

  const play = (
    element: Element,
    frames: Keyframe[],
    options: KeyframeAnimationOptions = {},
  ): Animation => {
    const animation = element.animate(frames, { duration, easing: DENSITY_EASE, ...options });
    motion.animations.push(animation);
    return animation;
  };

  for (const element of new Set([...previous.pieces.keys(), ...next.pieces.keys()])) {
    const from = previous.pieces.get(element);
    const to = next.pieces.get(element);
    const piece = to ?? from;
    if (!piece) continue;
    const visual = element.cloneNode(true) as HTMLElement;
    const end = to?.rect ?? from?.rect ?? piece.rect;
    for (const part of [visual, ...visual.querySelectorAll('*')]) {
      for (const attr of [...part.attributes]) {
        if (attr.name === 'id' || attr.name.startsWith('data-') || attr.name.startsWith('aria-')) {
          part.removeAttribute(attr.name);
        }
      }
    }
    const endX = Math.max(left, Math.min(right - end.width, end.left));
    const endY = end.top - target.top;
    visual.classList.add('density-piece');
    visual.style.cssText += `;position:absolute;left:${endX - left}px;top:${endY}px;width:${end.width}px;height:${end.height}px;font:${piece.font};color:${piece.color};margin:0;pointer-events:none;display:block`;
    stage.append(visual);
    motion.pieces.set(element, visual);
    const start = from?.rect ?? end;
    const startX = Math.max(left, Math.min(right - start.width, start.left));
    const dx = reduce ? 0 : startX - endX;
    const dy = reduce ? 0 : start.top - end.top;
    const startOpacity = from?.opacity ?? 0;
    const endOpacity = to ? 1 : 0;
    play(
      visual,
      [
        { transform: `translate(${dx}px,${dy}px)`, opacity: startOpacity },
        { transform: 'translate(0,0)', opacity: endOpacity },
      ],
      { fill: 'both', ...(piece.icon ? {} : { duration: to ? duration : 80 }) },
    );
    if (to) {
      play(element, [{ opacity: 0 }, { opacity: 0 }], { fill: 'both' });
    }
  }

  // The host model name often goes from a caret to a full label as space is
  // returned. Let the outgoing labels leave before revealing that name.
  if (
    next.model &&
    previous.model === next.model &&
    (Math.abs((next.modelRect?.width ?? 0) - (previous.modelRect?.width ?? 0)) > 8 ||
      (interrupted && Number(modelOpacity) < 0.999))
  ) {
    play(
      next.model,
      [{ opacity: interrupted ? Number(modelOpacity) : 0 }, { opacity: 1 }],
      {
        delay: reduce || interrupted ? 0 : 100,
        duration: reduce ? 120 : interrupted ? 240 : 140,
        fill: 'backwards',
      },
    );
  }

  play(stage, [{ opacity: 1 }, { opacity: 1 }]);
  return motion;
}
