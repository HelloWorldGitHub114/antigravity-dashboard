import { setAttr, setHidden } from '../../shared/dom.ts';
import type { PanelCardName, PanelDomContext } from './types.ts';

interface MotionEntry {
  anim: Animation;
  expanding: boolean;
  fullHeight: number;
}

export const panelMotion = new WeakMap<Element, MotionEntry>();

const reducedMotionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const MOTION_EASE = 'cubic-bezier(.2, .9, .3, 1)';
const EXPAND_DURATION_MS = 150;
const COLLAPSE_DURATION_MS = 120;
const CARD_SWAP_DURATION_MS = 140;

export function isMotionReduced(): boolean {
  return Boolean(
    reducedMotionQuery?.matches ||
      document.documentElement.classList.contains('motion-reduced') ||
      document.body.classList.contains('motion-reduced') ||
      document.querySelector('.widget')?.classList.contains('motion-reduced'),
  );
}

function clearMotionProps(el: HTMLElement): void {
  el.style.maxHeight = '';
  el.style.height = '';
  el.style.opacity = '';
  el.style.overflow = '';
}

export function setExpandedState(
  el: HTMLElement | null,
  expanded: boolean,
  animate = true,
  onSettled?: (cancelled: boolean) => void,
): void {
  if (!el) {
    onSettled?.(false);
    return;
  }
  const prev = panelMotion.get(el);
  const isVisible = !el.hidden && !(prev && !prev.expanding);
  if (!prev && isVisible === expanded) {
    onSettled?.(false);
    return;
  }

  // Batch all DOM geometry/style reads before any writes to avoid forced reflows.
  let fromHeight: number | null = null;
  let fromOpacity: number | null = null;
  let measuredHeight: number | null = null;
  if (prev) {
    fromHeight = el.getBoundingClientRect().height;
    fromOpacity = parseFloat(getComputedStyle(el).opacity);
  } else if (!expanded && !el.hidden) {
    measuredHeight = el.getBoundingClientRect().height;
  }

  if (prev) {
    prev.anim.cancel();
    clearMotionProps(el);
    panelMotion.delete(el);
    if (isVisible === expanded) {
      el.hidden = !expanded;
      onSettled?.(false);
      return;
    }
  }

  if (!animate || isMotionReduced() || typeof el.animate !== 'function') {
    el.hidden = !expanded;
    onSettled?.(false);
    return;
  }

  if (el.hidden) {
    el.hidden = false;
  }
  const fullHeight =
    measuredHeight !== null && measuredHeight > 0
      ? measuredHeight
      : expanded
        ? el.scrollHeight
        : (fromHeight ?? el.scrollHeight);
  if (fullHeight <= 0) {
    el.hidden = !expanded;
    onSettled?.(false);
    return;
  }

  const startHeight = fromHeight !== null ? fromHeight : expanded ? 0 : fullHeight;
  const endHeight = expanded ? fullHeight : 0;
  const startOpacity = fromOpacity !== null && Number.isFinite(fromOpacity) ? fromOpacity : expanded ? 0 : 1;
  const endOpacity = expanded ? 1 : 0;
  el.style.overflow = 'hidden';
  const anim = el.animate(
    [
      { maxHeight: `${startHeight}px`, opacity: startOpacity },
      { maxHeight: `${endHeight}px`, opacity: endOpacity },
    ],
    { duration: expanded ? EXPAND_DURATION_MS : COLLAPSE_DURATION_MS, easing: MOTION_EASE, fill: 'forwards' },
  );
  panelMotion.set(el, { anim, expanding: expanded, fullHeight });
  const settle = (cancelled: boolean) => {
    if (panelMotion.get(el)?.anim !== anim) return;
    panelMotion.delete(el);
    if (!cancelled && !expanded) el.hidden = true;
    clearMotionProps(el);
    if (!cancelled) anim.cancel();
    onSettled?.(cancelled);
  };
  anim.onfinish = () => settle(false);
  anim.oncancel = () => settle(true);
}

export function syncPinBottom(ctx: PanelDomContext): void {
  const widget = document.querySelector<HTMLElement>('.widget');
  if (!widget) return;
  const cardStage = ctx.$('card-stage');
  const stageClosing = cardStage ? panelMotion.get(cardStage)?.expanding === false : false;
  const subSection = ctx.$('subagents-section');
  const subToggle = ctx.$('subagents-toggle');
  const subContainer = ctx.$('subagents-container');
  const subClosing = subContainer ? panelMotion.get(subContainer)?.expanding === false : false;
  const subagentsOpen = Boolean(
    subSection && !subSection.hidden && (subToggle?.getAttribute('aria-expanded') === 'true' || subClosing),
  );
  const shouldPin = (Boolean(ctx.state.selectedCard) || stageClosing) && !subagentsOpen && !ctx.state.timelineEnabled;
  const nextVal = String(shouldPin);
  if (widget.dataset.pinBottom !== nextVal) widget.dataset.pinBottom = nextVal;
}

export function createDomLookup(): <T extends HTMLElement = HTMLElement>(id: string) => T | null {
  const domCache = new Map<string, HTMLElement>();
  return <T extends HTMLElement = HTMLElement>(id: string): T | null => {
    let el = domCache.get(id);
    if (!el || !el.isConnected) {
      el = document.getElementById(id) ?? undefined;
      if (el) domCache.set(id, el);
    }
    return (el as T | undefined) ?? null;
  };
}

export function createCardSwitcher(
  ctx: PanelDomContext,
): (name: PanelCardName | null, animate?: boolean, allowToggle?: boolean) => void {
  const chips = [...document.querySelectorAll<HTMLElement>('[data-card]')];
  const cardScroll = new Map<PanelCardName, number>();
  let cardMotion: Animation | null = null;
  let stageMorphAnim: Animation | null = null;

  const showCard = (name: PanelCardName | null, animate = false, allowToggle = false): void => {
    if (name !== null && name !== 'speed' && name !== 'cache' && name !== 'context') return;
    const prev = ctx.state.selectedCard;
    const nextName: PanelCardName | null = allowToggle && prev === name ? null : name;
    const changed = prev !== nextName;

    // Batch all DOM reads BEFORE any writes to avoid forced synchronous layouts.
    const prevEl = changed && prev ? ctx.$(`${prev}-card`) : null;
    const prevScrollTop = prevEl ? prevEl.scrollTop : null;
    const cardStage = ctx.$('card-stage');
    const prevStageMotion = cardStage ? panelMotion.get(cardStage) : undefined;
    const wasHidden = !cardStage || cardStage.hidden || Boolean(prevStageMotion && !prevStageMotion.expanding);
    const shouldAnimate = Boolean(animate && !isMotionReduced() && typeof cardStage?.animate === 'function');
    const startH =
      cardStage && !wasHidden && shouldAnimate && nextName !== null && changed
        ? cardStage.getBoundingClientRect().height
        : 0;

    if (prev && prevScrollTop !== null) {
      cardScroll.set(prev, prevScrollTop);
    }

    ctx.state.selectedCard = nextName;

    if (cardStage && prevStageMotion && nextName !== null && !wasHidden) {
      prevStageMotion.anim.cancel();
      clearMotionProps(cardStage);
      panelMotion.delete(cardStage);
    }
    stageMorphAnim?.cancel();
    stageMorphAnim = null;
    cardMotion?.cancel();
    cardMotion = null;

    for (const chip of chips) {
      const selected = chip.dataset.card === nextName;
      setAttr(chip, 'aria-selected', String(selected));
      chip.tabIndex = selected || (!nextName && chip.dataset.card === (name ?? 'speed')) ? 0 : -1;
    }

    if (!nextName) {
      if (cardStage) {
        // Defer flipping data-pin-bottom until collapse settles so lower sections don't snap upward on frame 0.
        setExpandedState(cardStage, false, animate, () => syncPinBottom(ctx));
      } else {
        syncPinBottom(ctx);
      }
      return;
    }

    syncPinBottom(ctx);

    for (const key of ['speed', 'cache', 'context'] as const) {
      setHidden(ctx.$(`${key}-card`), nextName !== key);
    }
    const card = ctx.$(`${nextName}-card`);
    if (card && changed) card.scrollTop = cardScroll.get(nextName) ?? 0;

    if (cardStage) {
      if (wasHidden) {
        setExpandedState(cardStage, true, animate, () => syncPinBottom(ctx));
      } else {
        cardStage.hidden = false;
        if (shouldAnimate && changed && startH > 0) {
          const endH = cardStage.getBoundingClientRect().height;
          if (Math.abs(endH - startH) > 1) {
            cardStage.style.overflow = 'hidden';
            stageMorphAnim = cardStage.animate(
              [{ height: `${startH}px` }, { height: `${endH}px` }],
              { duration: EXPAND_DURATION_MS, easing: MOTION_EASE },
            );
            stageMorphAnim.onfinish = stageMorphAnim.oncancel = () => {
              cardStage.style.overflow = '';
              cardStage.style.height = '';
              stageMorphAnim = null;
            };
          }
        }
      }
    }

    if (changed && animate && !isMotionReduced() && card?.animate) {
      cardMotion = card.animate(
        [
          { opacity: 0.25, transform: 'translateY(4px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: CARD_SWAP_DURATION_MS, easing: MOTION_EASE },
      );
      cardMotion.onfinish = cardMotion.oncancel = () => {
        cardMotion = null;
      };
    }
  };

  for (const chip of chips) {
    chip.addEventListener('click', (event) => showCard(chip.dataset.card as PanelCardName, event.detail > 0, true));
    chip.addEventListener('keydown', (event) => {
      const current = chips.indexOf(chip);
      let next: number | undefined;
      if (event.key === 'ArrowRight') next = (current + 1) % chips.length;
      else if (event.key === 'ArrowLeft') next = (current + chips.length - 1) % chips.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = chips.length - 1;
      else return;
      event.preventDefault();
      showCard(chips[next].dataset.card as PanelCardName, true, false);
      chips[next].focus();
    });
  }

  return showCard;
}
