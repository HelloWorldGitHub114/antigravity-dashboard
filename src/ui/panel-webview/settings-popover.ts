import type { LanguageCode, PreferencesSnapshot, PreferencesUpdateInput } from '../../contracts/preferences.ts';
import { setAttr, setHidden, setText } from '../../shared/dom.ts';
import type { DashboardI18n } from '../i18n/index.ts';
import { createFontScaleControls, type FontScaleValues } from '../shared/font-popover.ts';

export interface DebugLaunchUiState {
  enabled: boolean;
  configured?: boolean;
  activePortPresent?: boolean;
  integrationState?: string | null;
  platform?: string | null;
  busy?: boolean;
  error?: string | null;
}

export interface SettingsPopoverOptions {
  trigger: HTMLButtonElement;
  mountRoot: HTMLElement;
  language: DashboardI18n;
  initialPreferences?: Partial<PreferencesSnapshot> | null;
  onFontChange: (update: PreferencesUpdateInput, nextState: FontScaleValues) => void | Promise<void>;
  onSelectLanguage: (lang: LanguageCode) => void | Promise<void>;
  onToggleDebugLaunch: (nextEnabled: boolean) => void | Promise<void>;
  onRefreshDebugLaunch?: () => void | Promise<void>;
}

export interface SettingsPopoverHandle {
  element: HTMLDivElement;
  syncPreferences: (prefs?: Partial<PreferencesSnapshot> | null) => void;
  syncDebugLaunch: (next: Partial<DebugLaunchUiState>) => void;
  syncLanguage: (lang?: LanguageCode, saveError?: boolean) => void;
  localize: () => void;
  close: () => void;
  dispose: () => void;
}

/**
 * Anchored gear-settings dropdown popover containing:
 * 1) Method 1 toggle (opt-in OS shortcut debug-flag injection, default OFF)
 * 2) Language selector (`zh-CN` / `en`)
 * 3) Font-size scale steppers (Usage modal, Sidebar, Bottom card)
 */
export function createSettingsPopover(options: SettingsPopoverOptions): SettingsPopoverHandle {
  const {
    trigger,
    mountRoot,
    language,
    onFontChange,
    onSelectLanguage,
    onToggleDebugLaunch,
    onRefreshDebugLaunch,
  } = options;
  const doc = trigger.ownerDocument;
  const t = language.t;

  const debugState: DebugLaunchUiState = {
    enabled: Boolean(
      options.initialPreferences &&
        !('error' in options.initialPreferences) &&
        'debugLaunchEnabled' in options.initialPreferences &&
        options.initialPreferences.debugLaunchEnabled === true,
    ),
    configured: false,
    activePortPresent: false,
    integrationState: null,
    platform: null,
    busy: false,
    error: null,
  };
  let languageSaveError = false;

  const popover = doc.createElement('div');
  popover.id = 'settings-popover';
  popover.className = 'settings-popover';
  popover.setAttribute('popover', 'manual');
  popover.setAttribute('role', 'dialog');

  // --- Section 1: Method 1 Bottom Bar Debug Launch Toggle ---
  const debugSection = doc.createElement('div');
  debugSection.className = 'settings-section settings-debug-section';

  const debugRow = doc.createElement('div');
  debugRow.className = 'settings-row';

  const debugCopy = doc.createElement('div');
  debugCopy.className = 'settings-copy';
  const debugTitle = doc.createElement('span');
  debugTitle.className = 'settings-row-title';
  const debugDesc = doc.createElement('span');
  debugDesc.className = 'settings-row-desc';
  debugCopy.append(debugTitle, debugDesc);

  const debugToggle = doc.createElement('button');
  debugToggle.id = 'debug-launch-toggle';
  debugToggle.type = 'button';
  debugToggle.className = 'settings-switch';
  debugToggle.setAttribute('role', 'switch');
  debugToggle.setAttribute('aria-checked', String(debugState.enabled));
  const thumb = doc.createElement('span');
  thumb.className = 'settings-switch-thumb';
  debugToggle.append(thumb);
  debugToggle.addEventListener('click', () => {
    if (debugState.busy) return;
    void onToggleDebugLaunch(!debugState.enabled);
  });

  debugRow.append(debugCopy, debugToggle);
  const debugStatusEl = doc.createElement('p');
  debugStatusEl.id = 'debug-launch-status';
  debugStatusEl.className = 'settings-debug-status';
  debugStatusEl.setAttribute('role', 'status');
  debugSection.append(debugRow, debugStatusEl);

  const div1 = doc.createElement('div');
  div1.className = 'settings-divider';

  // --- Section 2: Language Segmented Control ---
  const langSection = doc.createElement('div');
  langSection.className = 'settings-section';
  const langRow = doc.createElement('div');
  langRow.className = 'settings-row settings-lang-row';
  const langTitle = doc.createElement('span');
  langTitle.className = 'settings-row-title';

  const langGroup = doc.createElement('div');
  langGroup.id = 'language-selector';
  langGroup.className = 'lang-seg';
  langGroup.setAttribute('role', 'group');

  const btnZh = doc.createElement('button');
  btnZh.id = 'lang-opt-zh';
  btnZh.type = 'button';
  btnZh.className = 'lang-pill';
  btnZh.dataset.lang = 'zh-CN';
  btnZh.textContent = '简体中文';
  btnZh.addEventListener('click', () => {
    void onSelectLanguage('zh-CN');
  });

  const btnEn = doc.createElement('button');
  btnEn.id = 'lang-opt-en';
  btnEn.type = 'button';
  btnEn.className = 'lang-pill';
  btnEn.dataset.lang = 'en';
  btnEn.textContent = 'English';
  btnEn.addEventListener('click', () => {
    void onSelectLanguage('en');
  });

  langGroup.append(btnZh, btnEn);
  langRow.append(langTitle, langGroup);

  const langErrorEl = doc.createElement('p');
  langErrorEl.id = 'language-save-error';
  langErrorEl.className = 'settings-lang-error';
  langErrorEl.setAttribute('role', 'status');
  langErrorEl.hidden = true;
  langSection.append(langRow, langErrorEl);

  const div2 = doc.createElement('div');
  div2.className = 'settings-divider';

  // --- Section 3: Font Scale Steppers ---
  const fontSection = doc.createElement('div');
  fontSection.className = 'settings-section settings-font-section';
  const fontControls = createFontScaleControls({
    doc,
    mountRoot,
    getLanguage: () => language.language,
    initial: options.initialPreferences ?? null,
    onChange: onFontChange,
  });
  fontSection.append(fontControls.headElement, fontControls.rowsElement);

  popover.append(debugSection, div1, langSection, div2, fontSection);
  mountRoot.append(popover);

  const isOpen = (): boolean => popover.matches(':popover-open');

  const positionPopover = (): void => {
    const r = trigger.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    const popW = popRect.width || 276;
    const popH = popRect.height || 260;
    const vw = doc.documentElement.clientWidth || window.innerWidth;
    const vh = doc.documentElement.clientHeight || window.innerHeight;
    const left = Math.max(8, Math.min(vw - popW - 8, r.right - popW));
    const top = Math.max(8, Math.min(vh - popH - 8, r.bottom + 6));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  };

  const renderDebugStatus = (): void => {
    setAttr(debugToggle, 'aria-checked', String(debugState.enabled));
    debugToggle.disabled = Boolean(debugState.busy);
    debugToggle.title = t('debugLaunchTitle');
    setAttr(debugToggle, 'aria-label', t('debugLaunchTitle'));

    let tone = 'off';
    let msg = t('debugLaunchStatusOff');
    if (debugState.busy) {
      tone = 'saving';
      msg = t('debugLaunchSaving');
    } else if (debugState.error) {
      tone = 'error';
      msg = t('debugLaunchFailed');
    } else if (!debugState.enabled) {
      if (debugState.activePortPresent) {
        tone = 'ready';
        msg = t('debugLaunchStatusExternal');
      } else {
        tone = 'off';
        msg = t('debugLaunchStatusOff');
      }
    } else if (debugState.activePortPresent) {
      tone = 'ready';
      msg = t('debugLaunchStatusReady');
    } else if (debugState.platform === 'darwin') {
      tone = 'restart';
      msg = t('debugLaunchStatusRestartMac');
    } else {
      tone = 'restart';
      msg = t('debugLaunchStatusRestart');
    }

    debugStatusEl.dataset.tone = tone;
    setText(debugStatusEl, msg);
  };

  const syncLanguage = (lang: LanguageCode = language.language, saveError = languageSaveError): void => {
    languageSaveError = saveError;
    const isZh = lang === 'zh-CN';
    setAttr(btnZh, 'aria-pressed', String(isZh));
    setAttr(btnEn, 'aria-pressed', String(!isZh));
    btnZh.classList.toggle('is-active', isZh);
    btnEn.classList.toggle('is-active', !isZh);
    setHidden(langErrorEl, !saveError);
    if (saveError) setText(langErrorEl, t('languageSaveFailed'));
  };

  const localize = (): void => {
    const title = t('settingsButton');
    setAttr(popover, 'aria-label', title);
    trigger.title = title;
    setAttr(trigger, 'aria-label', title);
    setText(debugTitle, t('debugLaunchTitle'));
    setText(debugDesc, t('debugLaunchDesc'));
    setText(langTitle, t('languageSection'));
    setAttr(langGroup, 'aria-label', t('languageSection'));
    setText(btnZh, t('languageZhLabel'));
    setText(btnEn, t('languageEnLabel'));
    syncLanguage(language.language, languageSaveError);
    renderDebugStatus();
    fontControls.localize();
  };

  const syncPreferences = (prefs?: Partial<PreferencesSnapshot> | null): void => {
    if (!prefs || typeof prefs !== 'object' || 'error' in prefs) return;
    fontControls.sync(prefs);
    if ('debugLaunchEnabled' in prefs && typeof prefs.debugLaunchEnabled === 'boolean' && !debugState.busy) {
      debugState.enabled = prefs.debugLaunchEnabled;
      renderDebugStatus();
    }
  };

  const syncDebugLaunch = (next: Partial<DebugLaunchUiState>): void => {
    Object.assign(debugState, next);
    renderDebugStatus();
  };

  const close = (): void => {
    if (!isOpen()) return;
    try {
      popover.hidePopover();
    } catch {
      popover.style.display = 'none';
    }
    setAttr(trigger, 'aria-expanded', 'false');
  };

  const open = (): void => {
    localize();
    fontControls.syncInputs();
    try {
      popover.showPopover();
    } catch {
      popover.style.display = 'block';
    }
    positionPopover();
    setAttr(trigger, 'aria-expanded', 'true');
    void onRefreshDebugLaunch?.();
  };

  const onTriggerClick = (e: Event): void => {
    e.stopPropagation();
    if (isOpen()) close();
    else open();
  };

  const onDocPointerDown = (e: Event): void => {
    if (!isOpen()) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
    if (path.includes(popover) || path.includes(trigger)) return;
    close();
  };

  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && isOpen()) {
      e.stopPropagation();
      close();
      trigger.focus();
    }
  };

  const onViewportChange = (): void => {
    if (isOpen()) positionPopover();
  };

  setAttr(trigger, 'aria-haspopup', 'dialog');
  setAttr(trigger, 'aria-expanded', 'false');
  setAttr(trigger, 'aria-controls', popover.id);
  trigger.addEventListener('click', onTriggerClick);
  doc.addEventListener('pointerdown', onDocPointerDown, true);
  doc.addEventListener('keydown', onDocKeyDown, true);
  window.addEventListener('resize', onViewportChange);

  localize();
  syncPreferences(options.initialPreferences);

  return {
    element: popover,
    syncPreferences,
    syncDebugLaunch,
    syncLanguage,
    localize,
    close,
    dispose: () => {
      close();
      trigger.removeEventListener('click', onTriggerClick);
      doc.removeEventListener('pointerdown', onDocPointerDown, true);
      doc.removeEventListener('keydown', onDocKeyDown, true);
      window.removeEventListener('resize', onViewportChange);
      popover.remove();
    },
  };
}
