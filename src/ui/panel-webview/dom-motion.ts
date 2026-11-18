import { setAttr, setHidden } from '../../shared/dom.ts';
import type { PanelCardName, PanelDomContext } from './types.ts';

interface MotionEntry {
  anim: Animation;
  expanding: boolean;
}

export const panelMotion = new WeakMap<Element, MotionEntry>();

const reducedMotionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

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

export function setExpandedState(el: HTMLElement | null, expanded: boolean, animate = true): void {
  if (!el) return;
  const prev = panelMotion.get(el);
  const isVisible = !el.hidden && !(prev && !prev.expanding);
  if (!prev && isVisible === expanded) return;

  let fromHeight: number | null = null;
  let fromOpacity: number | null = null;
  if (prev) {
    fromHeight = el.getBoundingClientRect().height;
    fromOpacity = parseFloat(getComputedStyle(el).opacity);
    prev.anim?.cancel();
    clearMotionProps(el);
    panelMotion.delete(el);
    if (isVisible === expanded) {
      el.hidden = !expanded;
      return;
    }
  }
  if (!animate || isMotionReduced() || typeof el.animate !== 'function') {
    el.hidden = !expanded;
    return;
  }
  el.hidden = false;
  const cssMax = parseFloat(getComputedStyle(el).maxHeight);
  const fullHeight = Number.isFinite(cssMax) && cssMax > 0 ? Math.min(el.scrollHeight, cssMax) : el.scrollHeight;
  if (fullHeight <= 0) {
    el.hidden = !expanded;
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
    { duration: expanded ? 220 : 180, easing: 'cubic-bezier(.22,1,.36,1)' },
  );
  panelMotion.set(el, { anim, expanding: expanded });
  const settle = (cancelled: boolean) => {
    if (panelMotion.get(el)?.anim !== anim) return;
    clearMotionProps(el);
    panelMotion.delete(el);
    if (!cancelled && !expanded) el.hidden = true;
  };
  anim.onfinish = () => settle(false);
  anim.oncancel = () => settle(true);
}

export function syncPinBottom(ctx: PanelDomContext): void {
  const widget = document.querySelector<HTMLElement>('.widget');
  if (!widget) return;
  const subSection = ctx.$('subagents-section');
  const subToggle = ctx.$('subagents-toggle');
  const subagentsOpen = Boolean(
    subSection && !subSection.hidden && subToggle?.getAttribute('aria-expanded') === 'true',
  );
  const shouldPin = Boolean(ctx.state.selectedCard) && !subagentsOpen && !ctx.state.timelineEnabled;
  widget.dataset.pinBottom = String(shouldPin);
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
    if (changed && prev) {
      const prevEl = ctx.$(`${prev}-card`);
      if (prevEl) cardScroll.set(prev, prevEl.scrollTop);
    }

    ctx.state.selectedCard = nextName;
    syncPinBottom(ctx);

    const cardStage = ctx.$('card-stage');
    const prevStageMotion = cardStage ? panelMotion.get(cardStage) : undefined;
    const wasHidden = !cardStage || cardStage.hidden || Boolean(prevStageMotion && !prevStageMotion.expanding);
    const startH = !cardStage || wasHidden ? 0 : cardStage.getBoundingClientRect().height;

    if (cardStage && prevStageMotion) {
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
      if (cardStage) setExpandedState(cardStage, false, animate);
      return;
    }

    for (const key of ['speed', 'cache', 'context'] as const) {
      setHidden(ctx.$(`${key}-card`), nextName !== key);
    }
    const card = ctx.$(`${nextName}-card`);
    if (card && changed) card.scrollTop = cardScroll.get(nextName) ?? 0;

    if (cardStage) {
      if (wasHidden) {
        setExpandedState(cardStage, true, animate);
      } else {
        cardStage.hidden = false;
        const endH = cardStage.getBoundingClientRect().height;
        if (animate && !isMotionReduced() && typeof cardStage.animate === 'function' && Math.abs(endH - startH) > 1) {
          cardStage.style.overflow = 'hidden';
          stageMorphAnim = cardStage.animate(
            [{ height: `${startH}px` }, { height: `${endH}px` }],
            { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' },
          );
          stageMorphAnim.onfinish = stageMorphAnim.oncancel = () => {
            cardStage.style.overflow = '';
            cardStage.style.height = '';
            stageMorphAnim = null;
          };
        }
      }
    }

    if (changed && animate && !isMotionReduced() && card?.animate) {
      cardMotion = card.animate(
        [
          { opacity: 0.45, transform: 'translateY(5px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: 180, easing: 'cubic-bezier(.22,1,.36,1)' },
      );
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
