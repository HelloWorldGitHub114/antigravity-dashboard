import { createDomNode } from './dom-shell.ts';
import { modelLabel, type UsagePalette } from './palette.ts';
import type { UsageDomContext, UsageTotalsResult } from './types.ts';

export interface TooltipController {
  show(bucket: UsageTotalsResult, target: Element, activeItem?: string | null): void;
  hide(): void;
  highlightItem(item: string | null): void;
  bindBucket(button: HTMLButtonElement, bucket: UsageTotalsResult, onSelect: (bucket: UsageTotalsResult) => void): void;
}

export function createTooltipController(ctx: UsageDomContext, palette: UsagePalette): TooltipController {
  const { $, dialog, state, w, full, compactNum } = ctx;
  let tipTarget: Element | null = null;
  let tipItem: string | null = null;

  const highlightItem = (item: string | null): void => {
    const plot = $('plot');
    if (!plot) return;
    if (item) plot.dataset.highlight = item;
    else delete plot.dataset.highlight;
    const attr = state.dimension === 'user' ? 'user' : 'model';
    for (const bar of plot.querySelectorAll<HTMLElement>('.bar-segment')) {
      if (item && bar.dataset[attr] === item) bar.dataset.highlight = 'true';
      else delete bar.dataset.highlight;
    }
  };

  const hide = (): void => {
    const tip = $('tip');
    if (tip) tip.hidden = true;
    tipTarget = null;
    tipItem = null;
    highlightItem(null);
  };

  const show = (bucket: UsageTotalsResult, target: Element, activeItem: string | null = null): void => {
    const tip = $('tip');
    if (!tip) return;
    if (!tip.hidden && tipTarget === target && tipItem === activeItem) return;
    tipTarget = target;
    tipItem = activeItem;
    highlightItem(activeItem);

    tip.replaceChildren(
      createDomNode('div', 'tip-title', bucket.from === bucket.to ? bucket.from : `${bucket.from} – ${bucket.to}`),
      createDomNode('strong', '', `${full(bucket.total)} Token`),
      createDomNode('div', 'muted', w(`${bucket.requests} 次请求`, `${bucket.requests} requests`)),
    );

    if (state.dimension === 'user') {
      for (const [u, r] of Object.entries(bucket.users || {}).sort((a, b) => b[1].total - a[1].total)) {
        const row = createDomNode('div', `tip-model${activeItem ? (activeItem === u ? ' active' : ' dimmed') : ''}`);
        const label = createDomNode('span');
        const dot = createDomNode('i', 'dot');
        dot.style.setProperty('--model-color', palette.userColor(u));
        if (u === 'legacy') dot.classList.add('legacy');
        label.append(dot, document.createTextNode(palette.userDisplayName(u, state.value, w)));
        const amount = createDomNode('span', '', compactNum(r.total));
        amount.append(createDomNode('span', 'model-share', bucket.total ? `${((r.total / bucket.total) * 100).toFixed(1)}%` : '0%'));
        row.append(label, amount);
        tip.append(row);
      }
    } else {
      for (const [model, r] of Object.entries(bucket.models || {}).sort((a, b) => b[1].total - a[1].total)) {
        const row = createDomNode('div', `tip-model${activeItem ? (activeItem === model ? ' active' : ' dimmed') : ''}`);
        const label = createDomNode('span');
        const dot = createDomNode('i', 'dot');
        dot.style.setProperty('--model-color', palette.modelColor(model, state.modelViewMode));
        label.append(dot, document.createTextNode(modelLabel(model, state.modelViewMode)));
        const amount = createDomNode('span', '', compactNum(r.total));
        amount.append(createDomNode('span', 'model-share', bucket.total ? `${((r.total / bucket.total) * 100).toFixed(1)}%` : '0%'));
        row.append(label, amount);
        tip.append(row);
      }
    }

    tip.hidden = false;
    const rect = target.getBoundingClientRect();
    const bounds = dialog.getBoundingClientRect();
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(bounds.right - r.width - 12, Math.max(bounds.left + 12, rect.left + rect.width / 2 - r.width / 2))}px`;
    tip.style.top = `${Math.max(bounds.top + 12, rect.top - r.height - 10)}px`;
  };

  const bindBucket = (
    button: HTMLButtonElement,
    bucket: UsageTotalsResult,
    onSelect: (selected: UsageTotalsResult) => void,
  ): void => {
    button.setAttribute('aria-label', `${bucket.from === bucket.to ? bucket.from : `${bucket.from} – ${bucket.to}`}: ${full(bucket.total)} Token`);
    button.addEventListener('pointerenter', () => show(bucket, button));
    button.addEventListener('pointerleave', hide);
    button.addEventListener('focus', () => show(bucket, button));
    button.addEventListener('blur', hide);
    button.addEventListener('pointermove', (event) => {
      const seg = (event.target as Element | null)?.closest?.('.bar-segment') as HTMLElement | null;
      const item = state.dimension === 'user' ? seg?.dataset.user || null : seg?.dataset.model || null;
      show(bucket, button, item);
    });
    button.addEventListener('click', () => onSelect(bucket));
  };

  return { show, hide, highlightItem, bindBucket };
}
