import { setAttr, setHidden, setStyle, setText } from '../../shared/dom.ts';
import type {
  ComposerMatch,
  PreferencesConnection,
  UpdateMenuHandle,
  UsageDashboardHandle,
  WidgetLanguage,
  WidgetThemeController,
  WidgetThemeFactory,
} from './types.ts';

type IconName = 'speed' | 'cache' | 'five' | 'week' | 'context';

function iconPath(name: IconName): string {
  switch (name) {
    case 'speed':
      return '<path d="M3 12a6 6 0 1 1 10 0M8 9l3-4"/>';
    case 'cache':
      return '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 2 10 2 10 0V4M3 8c0 2 10 2 10 0"/>';
    case 'five':
      return '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.7v3.6l2.3 1.4"/>';
    case 'week':
      return '<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M5 2v3m6-3v3M3 7h10"/>';
    case 'context':
      return '<circle cx="8" cy="8" r="5.6"/><path d="M8 2.4V8l4.8 2.8"/>';
  }
}

function svg(name: IconName): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true">${iconPath(name)}</svg>`;
}

export function buildWidgetShellMarkup(
  themeShadowCss: string,
  inlineCss: string,
  language: WidgetLanguage,
): string {
  const t = language.t;
  const speedRows = [
    ['modelTime', 'model-time'],
    ['toolTime', 'tool-time'],
    ['ttft', 'ttft'],
    ['sessionTps', 'session-rate'],
    ['latest', 'latest-rate'],
    ['tokens', 'tokens'],
  ]
    .map(([key, id]) => `<div><dt data-i18n="${key}">${t(key)}</dt><dd id="${id}">—</dd></div>`)
    .join('');

  const cacheRows = [
    ['cacheRate', 'cache-detail-rate'],
    ['cacheMiss', 'cache-miss'],
    ['cacheRead', 'cache-read'],
    ['cacheOutput', 'cache-output'],
    ['cacheWrite', 'cache-write'],
  ]
    .map(
      ([key, id]) =>
        `<div ${id === 'cache-write' ? 'id="cache-write-row" hidden' : ''}><dt data-i18n="${key}">${t(key)}</dt><dd id="${id}">—</dd></div>`,
    )
    .join('');

  const quotaSections = (['five', 'week'] as const)
    .map(
      (name) =>
        `<section class="quota-section" data-i18n-aria="${name}" aria-label="${t(name)}"><div class="quota-title"><span>${svg(name)}<span data-i18n="${name}">${t(name)}</span></span><strong id="${name}-balance">—</strong><span class="dim" data-i18n="remaining">remaining</span></div><div class="track" role="progressbar" data-i18n-aria="${name}" id="${name}-track"><i id="${name}-fill"></i></div><dl><div><dt data-i18n="resetIn">Resets in</dt><dd class="reset" id="${name}-countdown">—</dd></div><div><dt data-i18n="resetTime">Reset time (UTC+8)</dt><dd id="${name}-reset">—</dd></div></dl><p class="footnote" id="${name}-note" hidden></p></section>`,
    )
    .join('');

  return `<style>${themeShadowCss}\n${inlineCss}</style><div class="bar" data-i18n-aria="strip" aria-label="Dashboard statistics">
      <span class="dot" id="dot" title="Connecting"></span>
      <button class="chip" data-card="speed" data-i18n-aria="session" hidden aria-controls="speed-card" aria-expanded="false">${svg('speed')}<span class="rounds dim" id="rounds"></span><strong id="tps">—</strong><span>tok/s</span></button>
      <button class="chip" data-card="cache" data-i18n-aria="cacheTitle" hidden aria-controls="cache-card" aria-expanded="false">${svg('cache')}<span class="cache-total" id="cache-total">— tok</span><span class="dim">·</span><span data-i18n="cache">Cache hit</span><strong id="cache-rate">—</strong></button>
      <button class="chip" data-card="context" data-i18n-aria="context" hidden aria-controls="context-card" aria-expanded="false"><span class="context-ring" id="context-ring" aria-hidden="true"></span><span class="context-label" data-i18n="contextShort">Ctx</span><strong id="context-percent">—</strong></button>
    </div><section class="card" id="speed-card" role="region" data-i18n-aria="session" aria-label="Session statistics" hidden>
      <div class="heading"><span>${svg('speed')}<span data-i18n="session">Session statistics</span></span><span class="tag" id="samples">—</span></div>
      <dl>${speedRows}</dl><p class="footnote" id="rate-note" hidden>${t('responseBasis')}</p><div id="sidebar-entry"><button type="button" id="open-sidebar"><span id="sidebar-open-label"></span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg></button></div>
    </section><section class="card" id="cache-card" role="region" data-i18n-aria="cacheTitle" aria-label="Token cache" hidden>
      <div class="heading"><span>${svg('cache')}<span data-i18n="cacheTitle">Token cache</span></span><span class="tag" id="cache-coverage">—</span></div>
      <dl>${cacheRows}<div id="task-tokens-row" hidden><dt data-i18n="taskTotalTokens">${t('taskTotalTokens')}</dt><dd id="task-total-tokens">—</dd></div><div id="subagent-tokens-row" hidden><dt id="subagent-tokens-label" data-i18n="taskTokensSubagents">${t('taskTokensSubagents')}</dt><dd id="subagent-tokens">—</dd></div></dl><div id="model-mix-compact" class="model-mix-compact" data-signature="hidden" hidden><div class="model-mix-head"><span data-i18n="modelMixTitle">${t('modelMixTitle')}</span><span class="tag" id="model-mix-count"></span></div><div class="model-mix-body"><svg class="model-mix-svg" id="model-mix-svg" viewBox="0 0 36 36" aria-hidden="true"><circle class="model-mix-track" cx="18" cy="18" r="13"></circle></svg><div class="model-mix-legend" id="model-mix-legend"></div></div></div><p class="footnote" id="cache-note" hidden></p>
    </section><section class="card context-card" id="context-card" role="region" data-i18n-aria="context" hidden>
      <div class="heading"><span>${svg('context')}<span data-i18n="context">Context window</span></span></div>
      <strong id="context-summary">—</strong><p id="context-tokens">—</p>
      <div class="track" role="progressbar" data-i18n-aria="context" id="context-track"><i id="context-fill"></i></div>
      <dl><div><dt data-i18n="contextModel">Sampled model</dt><dd id="context-model">—</dd></div><div id="context-orchestrator-row" hidden><dt id="context-orchestrator-label" data-i18n="contextPlanner">${t('contextPlanner')}</dt><dd id="context-planner">—</dd><dd class="orchestrator-note" id="context-orchestrator-note"></dd></div></dl>
      <div class="heading quota-heading"><span data-i18n="group">Quota group</span><div class="toolbar"><button class="group-trigger" data-i18n-aria="group" aria-haspopup="listbox" aria-expanded="false">Quota ▾</button><div class="group-menu" role="listbox" data-i18n-aria="selectGroup" hidden></div><button class="refresh" data-i18n-aria="refresh" aria-label="Refresh quota" title="Refresh quota"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.8 6a5.1 5.1 0 1 0 .1 4M12.8 2.5V6H9.2"/></svg></button></div></div>
      <div class="quota-details">${quotaSections}</div>
    </section>`;
}

export function toggleHidden(el: HTMLElement | null | undefined, hidden: boolean): void {
  setHidden(el as { hidden: boolean } | null | undefined, hidden);
}

export function cardVisibility(element: HTMLElement, visible: boolean): void {
  if (visible) {
    toggleHidden(element, false);
    if (element.hasAttribute('popover') && !element.matches(':popover-open')) {
      element.showPopover();
    }
  } else {
    if (element.hasAttribute('popover') && element.matches(':popover-open')) {
      element.hidePopover();
    }
    toggleHidden(element, true);
  }
}

export function positionGuidePopover(root: ShadowRoot | null): void {
  const tip = root?.getElementById('language-guide') as HTMLElement | null;
  const button = root?.querySelector<HTMLElement>('[data-card="context"]');
  if (!tip || tip.hidden || !button) return;
  const rect = button.getBoundingClientRect();
  const width = Math.min(244, innerWidth - 24);
  setStyle(tip, 'width', `${width}px`);
  const left = Math.max(12, Math.min(innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
  setStyle(tip, 'left', `${left}px`);
  setStyle(tip, '--guide-anchor', `${Math.max(16, Math.min(width - 16, rect.left + rect.width / 2 - left))}px`);
  const curHeight = tip.offsetHeight;
  const above = rect.top - 22;
  const below = innerHeight - rect.bottom - 22;
  const height = tip.scrollHeight + curHeight - tip.clientHeight;
  const useAbove = height <= above || above >= below;
  const maxH = Math.max(80, useAbove ? above : below);
  const nextMax = `${maxH}px`;
  const prevMax = tip.style.getPropertyValue('max-height');
  setStyle(tip, 'max-height', nextMax);
  const tipH = prevMax !== nextMax ? tip.offsetHeight : Math.min(height, maxH);
  setStyle(tip, 'top', `${Math.max(12, useAbove ? rect.top - tipH - 10 : rect.bottom + 10)}px`);
  setAttr(tip, 'data-side', useAbove ? 'above' : 'below');
}

export function positionCardPopover(root: ShadowRoot | null, cardName: string | null): void {
  positionGuidePopover(root);
  if (!root || !cardName) return;
  const button = root.querySelector<HTMLElement>(`[data-card="${cardName}"]`);
  const card = root.getElementById(`${cardName}-card`) as HTMLElement | null;
  if (!button || !card) return;
  const rect = button.getBoundingClientRect();
  const width = Math.min(310, window.innerWidth - 24);
  setStyle(card, 'width', `${width}px`);
  const roomAbove = rect.top - 21;
  const roomBelow = window.innerHeight - rect.bottom - 21;
  setStyle(card, 'overflow-y', 'auto');
  setStyle(
    card,
    'left',
    `${Math.min(window.innerWidth - width - 12, Math.max(12, rect.left + rect.width / 2 - width / 2))}px`,
  );
  // scrollHeight includes clipped content. Expanding maxHeight to measure it
  // on every poll used to reset scrollTop and then shrink the card again.
  const curHeight = card.offsetHeight;
  const height = card.scrollHeight + curHeight - card.clientHeight;
  const useAbove = height <= roomAbove || roomAbove >= roomBelow;
  const maxH = Math.max(80, useAbove ? roomAbove : roomBelow);
  const nextMax = `${maxH}px`;
  const prevMax = card.style.getPropertyValue('max-height');
  setStyle(card, 'max-height', nextMax);
  const cardH = prevMax !== nextMax ? card.offsetHeight : Math.min(height, maxH);
  setStyle(card, 'top', `${Math.max(12, useAbove ? rect.top - cardH - 9 : rect.bottom + 9)}px`);
}

export function localizeWidgetTree(
  root: ShadowRoot,
  node: HTMLElement,
  language: WidgetLanguage,
  preferences: PreferencesConnection,
  updateMenu: UpdateMenuHandle | null,
  updateGuide: () => void,
): void {
  const t = language.t;
  setAttr(node, 'lang', language.language);
  for (const e of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const value = t(e.dataset.i18n || '');
    if (e.textContent !== value) e.textContent = value;
  }
  for (const e of root.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    setAttr(e, 'aria-label', t(e.dataset.i18nAria || ''));
  }
  for (const e of root.querySelectorAll<HTMLElement>('[data-i18n-aria][title]')) {
    setAttr(e, 'title', t(e.dataset.i18nAria || ''));
  }
  for (const button of root.querySelectorAll<HTMLElement>('[data-language-choice]')) {
    setAttr(button, 'aria-pressed', button.dataset.languageChoice === language.language);
    setAttr(button, 'data-save-failed', preferences.error);
    setAttr(button, 'title', preferences.error ? t('languageSaveFailed') : button.textContent);
  }
  setText(root.getElementById('language-save-note'), preferences.error ? t('languageSaveFailed') : '');
  const zh = language.language === 'zh-CN';
  setText(root.getElementById('usage-today-label'), zh ? '今日用量' : 'Today');
  setText(root.getElementById('usage-month-label'), zh ? '本月用量' : 'This month');
  setText(root.getElementById('usage-open-label'), zh ? '查看用量统计' : 'View token usage');
  setText(root.getElementById('sidebar-open-label'), zh ? '打开侧边栏' : 'Open sidebar');
  updateMenu?.localize();
  updateGuide();
}

export function parkUsageModalNode(
  node: HTMLElement | null,
  usageDashboard: UsageDashboardHandle | null,
): boolean {
  if (!usageDashboard?.isOpen || !node) return false;
  if (!node.isConnected || !node.getClientRects().length) {
    node.dataset.layout = 'blocked';
    document.body.append(node);
    usageDashboard.restoreModal();
  }
  return true;
}

export function prepareComposerMatch(
  found: ComposerMatch,
  previous: ComposerMatch | null,
  captureNative: (f: ComposerMatch) => ComposerMatch['native'],
  nativeReserve: ((f: ComposerMatch) => number) | undefined,
): ComposerMatch {
  found.native =
    previous?.branch === found.branch && previous?.anchor === found.anchor
      ? previous.native
      : captureNative(found);
  if (found.kind === 'ide' && found.native && nativeReserve) {
    found.native.reserve = nativeReserve(found);
  }
  return found;
}

export function reattachWidgetNode(params: {
  node: HTMLElement;
  found: ComposerMatch;
  theme: WidgetThemeFactory;
  themeController: WidgetThemeController | null;
  hostTheme: Parameters<WidgetThemeController['setHostTheme']>[0];
  resetDensity: () => void;
  hideCards: () => void;
  observeComposer: () => void;
  fit: () => void;
  position: () => void;
}): WidgetThemeController {
  const { node, found, theme, themeController, hostTheme } = params;
  params.resetDensity();
  params.hideCards();
  found.row.insertBefore(node, found.branch.nextSibling);
  params.observeComposer();
  themeController?.dispose();
  const nextTheme = theme.attach(node, { embedded: true });
  if (hostTheme) nextTheme.setHostTheme(hostTheme);
  params.fit();
  params.position();
  return nextTheme;
}
