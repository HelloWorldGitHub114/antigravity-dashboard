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
    { duration: expanded ? 180 : 160, easing: 'cubic-bezier(.22,1,.36,1)' },
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

export function createCardSwitcher(ctx: PanelDomContext): (name: PanelCardName, animate?: boolean) => void {
  const chips = [...document.querySelectorAll<HTMLElement>('[data-card]')];
  const cardScroll = new Map<PanelCardName, number>();
  let cardMotion: Animation | null = null;

  const showCard = (name: PanelCardName, animate = false): void => {
    if (name !== 'speed' && name !== 'cache' && name !== 'context') return;
    const prev = ctx.state.selectedCard;
    const changed = prev !== name;
    if (changed) {
      const prevEl = ctx.$(`${prev}-card`);
      if (prevEl) cardScroll.set(prev, prevEl.scrollTop);
    }
    ctx.state.selectedCard = name;
    cardMotion?.cancel();
    cardMotion = null;
    for (const chip of chips) {
      const selected = chip.dataset.card === name;
      setAttr(chip, 'aria-selected', String(selected));
      chip.tabIndex = selected ? 0 : -1;
    }
    for (const key of ['speed', 'cache', 'context'] as const) {
      setHidden(ctx.$(`${key}-card`), name !== key);
    }
    const card = ctx.$(`${name}-card`);
    if (card && changed) card.scrollTop = cardScroll.get(name) ?? 0;
    if (changed && animate && !isMotionReduced() && card?.animate) {
      cardMotion = card.animate(
        [
          { opacity: 0.55, transform: 'translateY(4px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: 160, easing: 'cubic-bezier(.22,1,.36,1)' },
      );
    }
  };

  for (const chip of chips) {
    chip.addEventListener('click', (event) => showCard(chip.dataset.card as PanelCardName, event.detail > 0));
    chip.addEventListener('keydown', (event) => {
      const current = chips.indexOf(chip);
      let next: number | undefined;
      if (event.key === 'ArrowRight') next = (current + 1) % chips.length;
      else if (event.key === 'ArrowLeft') next = (current + chips.length - 1) % chips.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = chips.length - 1;
      else return;
      event.preventDefault();
      showCard(chips[next].dataset.card as PanelCardName, true);
      chips[next].focus();
    });
  }

  return showCard;
}
