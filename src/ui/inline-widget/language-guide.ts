import type { PreferencesSnapshot, PreferencesUpdateInput, QuotaGroup } from '../../contracts/index.ts';
import { setText } from '../../shared/dom.ts';
import { cardVisibility, positionGuidePopover } from './cards.ts';
import type { ComposerMatch, PreferencesConnection, WidgetLanguage } from './types.ts';

export function localGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function localSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage quota/privacy rejections in restricted frames.
  }
}

export function connectWidgetPreferences(params: {
  language: WidgetLanguage;
  guide: LanguageGuideController;
  getPreferences: () => Promise<PreferencesSnapshot>;
  setPreferences: (input: PreferencesUpdateInput) => Promise<PreferencesSnapshot>;
  onApplied: () => void;
  onReady: () => void;
}): PreferencesConnection {
  const { language, guide, getPreferences, setPreferences, onApplied, onReady } = params;
  const preferences = language.connectPreferences({
    read: async () => {
      const value = await getPreferences();
      guide.sync(value);
      return value;
    },
    write: async (input) => {
      const value = await setPreferences(input);
      guide.sync(value);
      return value;
    },
    cache: (value) => localSet('ag-pulse-language', value),
    changed: onApplied,
  });
  void preferences.ready.then(() => {
    guide.guideReady = !preferences.error;
    onReady();
  });
  return preferences;
}

export function observeComposerElements(
  resizeObserver: ResizeObserver | null,
  scheduleLayout: () => void,
  node: HTMLElement | null,
  composer: ComposerMatch | null,
): ResizeObserver {
  resizeObserver?.disconnect();
  const observer = resizeObserver ?? new ResizeObserver(scheduleLayout);
  if (composer) {
    for (const element of new Set([
      node,
      composer.row,
      composer.row.parentElement,
      composer.branch,
      composer.editor,
    ])) {
      if (element) observer.observe(element);
    }
  }
  return observer;
}

export type ActiveQuotaGroup = QuotaGroup | undefined;

export interface GuideControllerDeps {
  getRoot: () => ShadowRoot | null;
  getNode: () => HTMLElement | null;
  getComposer: () => ComposerMatch | null;
  getCardName: () => string | null;
  isDisposed: () => boolean;
  onSyncUsageGuide: () => void;
  onSavePreferences: (input: PreferencesUpdateInput) => Promise<PreferencesSnapshot>;
  onSyncPreferences: (value: PreferencesSnapshot) => void;
}

export class LanguageGuideController {
  guideReady = false;
  guideDismissed = false;
  guideOpened = false;
  usageGuideDismissed = false;
  private guideSaving = false;
  private guideError = false;
  private readonly deps: GuideControllerDeps;

  constructor(deps: GuideControllerDeps) {
    this.deps = deps;
  }

  sync(value: unknown): void {
    const prefs = value as { languageGuideDismissed?: unknown; usageGuideDismissed?: unknown } | null | undefined;
    if (prefs?.languageGuideDismissed === true) this.guideDismissed = true;
    if (prefs?.usageGuideDismissed === true) {
      this.usageGuideDismissed = true;
      this.deps.onSyncUsageGuide();
    }
  }

  update(): void {
    const root = this.deps.getRoot();
    const node = this.deps.getNode();
    const composer = this.deps.getComposer();
    const tip = root?.getElementById('language-guide') as HTMLElement | null;
    if (!tip || !root) return;
    const visible =
      !this.deps.isDisposed() &&
      this.guideReady &&
      !this.guideDismissed &&
      !this.guideOpened &&
      !this.deps.getCardName() &&
      Boolean(node?.isConnected) &&
      ['main', 'ide'].includes(composer?.kind ?? '') &&
      node?.dataset.layout === 'ready' &&
      node.style.visibility !== 'hidden';
    const entering = visible && tip.hidden;
    cardVisibility(tip, visible);
    const button = root.querySelector<HTMLElement>('[data-card="context"]');
    if (button) {
      if (visible) button.setAttribute('aria-describedby', 'language-guide');
      else button.removeAttribute('aria-describedby');
    }
    setText(
      root.getElementById('guide-save-note'),
      this.guideError ? 'Could not save. Please retry. / 未能保存，请重试。' : '',
    );
    const guideClose = root.getElementById('guide-close') as HTMLButtonElement | null;
    if (guideClose) guideClose.disabled = this.guideSaving;
    positionGuidePopover(root);
    if (entering && typeof tip.animate === 'function') {
      tip.animate(
        [
          { opacity: 0, transform: `translateY(${tip.dataset.side === 'above' ? '4' : '-4'}px)` },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: 160, easing: 'cubic-bezier(0.23,1,0.32,1)' },
      );
    }
  }

  async dismiss(): Promise<void> {
    if (this.guideSaving) return;
    this.guideSaving = true;
    this.guideError = false;
    this.update();
    try {
      const value = await this.deps.onSavePreferences({ languageGuideDismissed: true });
      if (!('languageGuideDismissed' in value) || value.languageGuideDismissed !== true) {
        throw new Error('Guide not saved');
      }
      this.sync(value);
      this.deps.onSyncPreferences(value);
    } catch {
      this.guideError = true;
    } finally {
      this.guideSaving = false;
      this.update();
    }
  }
}
