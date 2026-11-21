import type { UsageAccountInfo } from '../../contracts/index.ts';
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

export interface RecordingAccountUiState {
  active: string | null;
  selected: string | null;
  localMode?: boolean;
  accounts: UsageAccountInfo[];
  busy?: boolean;
  error?: string | null;
  notice?: string | null;
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
  onSelectRecordingAccount?: (scope: string | null) => void | Promise<void>;
  onAddRecordingAccount?: (identifier: string) => void | Promise<void>;
}

export interface SettingsPopoverHandle {
  element: HTMLDivElement;
  syncPreferences: (prefs?: Partial<PreferencesSnapshot> | null) => void;
  syncDebugLaunch: (next: Partial<DebugLaunchUiState>) => void;
  syncRecordingAccount: (next: Partial<RecordingAccountUiState>) => void;
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
    onSelectRecordingAccount,
    onAddRecordingAccount,
  } = options;
  const doc = trigger.ownerDocument;
  const t = language.t;

  const accountState: RecordingAccountUiState = {
    active: null,
    selected: null,
    localMode: false,
    accounts: [],
    busy: false,
    error: null,
    notice: null,
  };

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

  // --- Section 1b: Recording Account Selector & Add Account ---
  const accountSection = doc.createElement('div');
  accountSection.className = 'settings-section settings-account-section';

  const accountCopy = doc.createElement('div');
  accountCopy.className = 'settings-copy';
  const accountTitle = doc.createElement('span');
  accountTitle.className = 'settings-row-title';
  const accountDesc = doc.createElement('span');
  accountDesc.className = 'settings-row-desc';
  accountCopy.append(accountTitle, accountDesc);

  const accountControls = doc.createElement('div');
  accountControls.className = 'settings-account-controls';

  const accountSelect = doc.createElement('select');
  accountSelect.id = 'recording-account-select';
  accountSelect.className = 'settings-account-select';
  accountSelect.addEventListener('change', () => {
    if (accountState.busy) return;
    const val = accountSelect.value;
    void onSelectRecordingAccount?.(val === 'auto' || !val ? null : val);
  });

  const accountAddToggle = doc.createElement('button');
  accountAddToggle.id = 'recording-account-add-toggle';
  accountAddToggle.type = 'button';
  accountAddToggle.className = 'settings-account-btn';

  const accountAddForm = doc.createElement('div');
  accountAddForm.id = 'recording-account-add-form';
  accountAddForm.className = 'settings-account-add-form';
  accountAddForm.hidden = true;

  const accountInput = doc.createElement('input');
  accountInput.id = 'recording-account-input';
  accountInput.type = 'text';
  accountInput.className = 'settings-account-input';
  accountInput.autocomplete = 'off';

  const accountAddActions = doc.createElement('div');
  accountAddActions.className = 'settings-account-add-actions';

  const accountCancelBtn = doc.createElement('button');
  accountCancelBtn.id = 'recording-account-cancel-btn';
  accountCancelBtn.type = 'button';
  accountCancelBtn.className = 'settings-account-btn';

  const accountSaveBtn = doc.createElement('button');
  accountSaveBtn.id = 'recording-account-save-btn';
  accountSaveBtn.type = 'button';
  accountSaveBtn.className = 'settings-account-btn is-primary';

  const submitNewAccount = (): void => {
    if (accountState.busy) return;
    const raw = accountInput.value.trim();
    if (!raw) {
      accountInput.focus();
      return;
    }
    void Promise.resolve(onAddRecordingAccount?.(raw)).then(() => {
      accountInput.value = '';
      accountAddForm.hidden = true;
    });
  };

  accountAddToggle.addEventListener('click', () => {
    accountAddForm.hidden = !accountAddForm.hidden;
    if (!accountAddForm.hidden) accountInput.focus();
  });
  accountCancelBtn.addEventListener('click', () => {
    accountInput.value = '';
    accountAddForm.hidden = true;
  });
  accountSaveBtn.addEventListener('click', submitNewAccount);
  accountInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitNewAccount();
    }
  });

  accountAddActions.append(accountCancelBtn, accountSaveBtn);
  accountAddForm.append(accountInput, accountAddActions);
  accountControls.append(accountSelect, accountAddToggle);

  const accountStatusEl = doc.createElement('p');
  accountStatusEl.id = 'recording-account-status';
  accountStatusEl.className = 'settings-debug-status';
  accountStatusEl.setAttribute('role', 'status');

  accountSection.append(accountCopy, accountControls, accountAddForm, accountStatusEl);

  const divAccount = doc.createElement('div');
  divAccount.className = 'settings-divider';

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

  popover.append(debugSection, div1, accountSection, divAccount, langSection, div2, fontSection);
  mountRoot.append(popover);

  const isOpen = (): boolean => popover.matches(':popover-open') || popover.dataset.open === 'true';
  const supportsAnchor = (): boolean =>
    typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('position-area', 'block-end');
  let resizeRaf: number | null = null;
  let lastSyncedFontSig: string | null = null;

  const positionPopover = (): void => {
    if (supportsAnchor()) return;
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

  const renderRecordingAccount = (): void => {
    accountSelect.disabled = Boolean(accountState.busy);
    accountAddToggle.disabled = Boolean(accountState.busy);
    accountSaveBtn.disabled = Boolean(accountState.busy);
    accountCancelBtn.disabled = Boolean(accountState.busy);
    accountInput.disabled = Boolean(accountState.busy);

    const realAccounts = (accountState.accounts || []).filter((a) => a && a.id && a.id !== 'all');
    const selectedKey = accountState.selected || 'auto';
    const sig = `${language.language}|${selectedKey}|${realAccounts
      .map((a) => `${a.id}:${a.email || a.name}:${Boolean(a.primary)}`)
      .join(',')}`;
    if (accountSelect.dataset.sig !== sig) {
      accountSelect.dataset.sig = sig;
      const autoOpt = doc.createElement('option');
      autoOpt.value = 'auto';
      autoOpt.textContent = t('recordingAccountAuto');
      autoOpt.selected = selectedKey === 'auto';
      const opts = [autoOpt];
      for (const acc of realAccounts) {
        const opt = doc.createElement('option');
        opt.value = acc.id;
        const label = acc.email || acc.name || `Account (${acc.id.slice(0, 8)})`;
        const primarySuffix = acc.primary
          ? language.language === 'zh-CN'
            ? ' (主)'
            : ' (Primary)'
          : '';
        opt.textContent = `${label}${primarySuffix}`;
        opt.selected = acc.id === selectedKey;
        opts.push(opt);
      }
      accountSelect.replaceChildren(...opts);
    } else if (accountSelect.value !== selectedKey) {
      accountSelect.value = selectedKey;
    }

    const activeId = accountState.active || accountState.selected || null;
    const matched = activeId ? realAccounts.find((a) => a.id === activeId) : null;
    const activeLabel =
      matched?.email ||
      matched?.name ||
      (activeId ? `Account (${activeId.slice(0, 8)})` : '—');

    let tone = 'ready';
    let msg = accountState.selected
      ? t('recordingAccountStatusPinned', { account: activeLabel })
      : t('recordingAccountStatusAuto', { account: activeLabel });
    if (accountState.busy) {
      tone = 'saving';
      msg = t('debugLaunchSaving');
    } else if (accountState.error) {
      tone = 'error';
      msg = accountState.error;
    } else if (accountState.notice) {
      tone = 'ready';
      msg = accountState.notice;
    }
    accountStatusEl.dataset.tone = tone;
    setText(accountStatusEl, msg);
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
    setText(accountTitle, t('recordingAccountTitle'));
    setText(accountDesc, t('recordingAccountDesc'));
    setAttr(accountSelect, 'aria-label', t('recordingAccountTitle'));
    setText(accountAddToggle, t('recordingAccountAddBtn'));
    accountInput.placeholder = t('recordingAccountInputPlaceholder');
    setAttr(accountInput, 'aria-label', t('recordingAccountInputPlaceholder'));
    setText(accountSaveBtn, t('recordingAccountSaveBtn'));
    setText(accountCancelBtn, t('recordingAccountCancelBtn'));
    setText(langTitle, t('languageSection'));
    setAttr(langGroup, 'aria-label', t('languageSection'));
    setText(btnZh, t('languageZhLabel'));
    setText(btnEn, t('languageEnLabel'));
    syncLanguage(language.language, languageSaveError);
    renderDebugStatus();
    renderRecordingAccount();
    fontControls.localize();
  };

  const syncPreferences = (prefs?: Partial<PreferencesSnapshot> | null): void => {
    if (!prefs || typeof prefs !== 'object' || 'error' in prefs) return;
    const p = prefs as Partial<{
      usageFontScale: unknown;
      sidebarFontScale: unknown;
      inlineFontScale: unknown;
      debugLaunchEnabled: unknown;
    }>;
    const fontSig = `${p.usageFontScale ?? ''}|${p.sidebarFontScale ?? ''}|${p.inlineFontScale ?? ''}`;
    if (fontSig !== lastSyncedFontSig) {
      lastSyncedFontSig = fontSig;
      fontControls.sync(prefs);
    }
    if ('debugLaunchEnabled' in prefs && typeof prefs.debugLaunchEnabled === 'boolean' && !debugState.busy) {
      if (debugState.enabled !== prefs.debugLaunchEnabled) {
        debugState.enabled = prefs.debugLaunchEnabled;
        renderDebugStatus();
      }
    }
  };

  const syncDebugLaunch = (next: Partial<DebugLaunchUiState>): void => {
    let changed = false;
    for (const key of Object.keys(next) as Array<keyof DebugLaunchUiState>) {
      const value = next[key];
      if (!Object.is(debugState[key], value)) {
        (debugState as unknown as Record<string, unknown>)[key] = value;
        changed = true;
      }
    }
    if (changed) renderDebugStatus();
  };

  const syncRecordingAccount = (next: Partial<RecordingAccountUiState>): void => {
    for (const key of Object.keys(next) as Array<keyof RecordingAccountUiState>) {
      (accountState as unknown as Record<string, unknown>)[key] = next[key];
    }
    renderRecordingAccount();
  };

  const cancelResizeRaf = (): void => {
    if (resizeRaf !== null) {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = null;
    }
  };

  const close = (): void => {
    cancelResizeRaf();
    if (!isOpen()) return;
    delete popover.dataset.open;
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
      popover.dataset.open = 'true';
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
    if (!isOpen() || supportsAnchor() || resizeRaf !== null) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      if (isOpen()) positionPopover();
    });
  };

  setAttr(trigger, 'aria-haspopup', 'dialog');
  setAttr(trigger, 'aria-expanded', 'false');
  setAttr(trigger, 'aria-controls', popover.id);
  trigger.addEventListener('click', onTriggerClick);
  doc.addEventListener('pointerdown', onDocPointerDown, true);
  doc.addEventListener('keydown', onDocKeyDown, true);
  window.addEventListener('resize', onViewportChange, { passive: true });

  localize();
  syncPreferences(options.initialPreferences);

  return {
    element: popover,
    syncPreferences,
    syncDebugLaunch,
    syncRecordingAccount,
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
