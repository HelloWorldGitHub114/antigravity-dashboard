import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  resolveFontScale,
  type FontScaleKey,
  type PreferencesSnapshot,
  type PreferencesState,
  type PreferencesUpdateInput,
} from '../../contracts/preferences.ts';

export const FONT_POPOVER_MIN_PCT = Math.round(FONT_SCALE_MIN * 100);
export const FONT_POPOVER_MAX_PCT = Math.round(FONT_SCALE_MAX * 100);
export const FONT_POPOVER_STEP_PCT = 5;
const FONT_POPOVER_DEFAULT_PCT = 100;

export interface FontPopoverRowSpec {
  key: FontScaleKey;
  labelZh: string;
  labelEn: string;
}

export const FONT_POPOVER_ROWS: readonly FontPopoverRowSpec[] = [
  { key: 'usageFontScale', labelZh: '统计页', labelEn: 'Usage modal' },
  { key: 'sidebarFontScale', labelZh: '侧边栏', labelEn: 'Sidebar' },
  { key: 'inlineFontScale', labelZh: '底部状态卡片', labelEn: 'Bottom card' },
] as const;

export const FONT_CONTROL_CSS = `
.font-popover-head{font-size:11px;font-weight:700;color:var(--pulse-muted);margin:0 0 8px;display:flex;align-items:center;justify-content:space-between}
.font-popover-rows{display:grid;gap:7px}
.font-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.font-row-label{font-size:12px;font-weight:600;color:var(--pulse-foreground);white-space:nowrap}
.font-stepper{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--pulse-border);border-radius:8px;background:var(--pulse-control,transparent)}
.font-step-btn{width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--pulse-foreground);font:700 13px/1 inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.font-step-btn:hover:not(:disabled){background:var(--pulse-surface)}
.font-step-btn:disabled{opacity:.4;cursor:default}
.font-input-wrap{display:inline-flex;align-items:center;gap:1px;padding:0 3px}
.font-pct-input{width:34px;height:20px;padding:0 2px;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--pulse-foreground);font:700 12px/1 var(--pulse-mono,ui-monospace,monospace);text-align:right;font-variant-numeric:tabular-nums;outline:none}
.font-pct-input:focus{border-color:var(--pulse-focus,var(--pulse-border));background:var(--pulse-background)}
.font-pct-unit{font:600 11px/1 var(--pulse-mono,ui-monospace,monospace);color:var(--pulse-muted)}
`.trim();

export const FONT_POPOVER_CSS = `
.font-trigger{min-width:30px;padding:0 6px;font:700 12px/1 var(--pulse-font,system-ui,-apple-system,sans-serif);letter-spacing:-.02em}
.font-popover{position:fixed;inset:auto;margin:0;padding:10px 12px;min-width:236px;max-width:calc(100vw - 16px);border:1px solid var(--pulse-border);border-radius:12px;background:var(--pulse-popover,var(--pulse-background));color:var(--pulse-foreground);box-shadow:0 12px 32px #0004;font:12px/1.35 var(--pulse-font,system-ui,-apple-system,sans-serif);z-index:20;box-sizing:border-box}
.font-popover:not(:popover-open){display:none}
${FONT_CONTROL_CSS}
`.trim();

export interface FontScaleValues {
  usageFontScale: number;
  sidebarFontScale: number;
  inlineFontScale: number;
}

export interface FontScaleControlsOptions {
  doc?: Document;
  mountRoot?: HTMLElement | ShadowRoot | null;
  getLanguage: () => string;
  initial?: Partial<PreferencesSnapshot> | null;
  onChange: (update: PreferencesUpdateInput, nextState: FontScaleValues) => void | Promise<void>;
}

export interface FontScaleControlsHandle {
  headElement: HTMLDivElement;
  rowsElement: HTMLDivElement;
  sync: (prefs?: Partial<PreferencesSnapshot> | null) => void;
  localize: () => void;
  syncInputs: () => void;
  values: () => FontScaleValues;
  titleText: () => string;
}

export interface FontPopoverOptions {
  trigger: HTMLButtonElement;
  mountRoot: HTMLElement | ShadowRoot;
  getLanguage: () => string;
  initial?: Partial<PreferencesSnapshot> | null;
  onChange: (update: PreferencesUpdateInput, nextState: FontScaleValues) => void | Promise<void>;
}

export interface FontPopoverHandle {
  element: HTMLDivElement;
  sync: (prefs?: Partial<PreferencesSnapshot> | null) => void;
  localize: () => void;
  close: () => void;
  dispose: () => void;
  values: () => FontScaleValues;
}

function clampPct(raw: number): number {
  if (!Number.isFinite(raw)) return FONT_POPOVER_DEFAULT_PCT;
  return Math.min(FONT_POPOVER_MAX_PCT, Math.max(FONT_POPOVER_MIN_PCT, Math.round(raw)));
}

function asFontState(prefs?: Partial<PreferencesSnapshot> | null): Partial<PreferencesState> | null {
  if (!prefs || typeof prefs !== 'object' || 'error' in prefs) return null;
  return prefs as Partial<PreferencesState>;
}

function pctToScale(pct: number): number {
  return Math.round(clampPct(pct)) / 100;
}

function scaleToPct(scale: unknown): number {
  return Math.round(resolveFontScale(scale) * 100);
}

/**
 * Builds reusable 3-row font-scale controls (usage modal, sidebar, bottom card)
 * with 5% steppers and editable percentage inputs (`80%`–`150%`).
 */
export function createFontScaleControls(options: FontScaleControlsOptions): FontScaleControlsHandle {
  const doc = options.doc ?? document;
  const { mountRoot, getLanguage, onChange } = options;
  const initial = asFontState(options.initial);
  const values: FontScaleValues = {
    usageFontScale: resolveFontScale(initial?.usageFontScale),
    sidebarFontScale: resolveFontScale(initial?.sidebarFontScale),
    inlineFontScale: resolveFontScale(initial?.inlineFontScale),
  };

  const head = doc.createElement('div');
  head.className = 'font-popover-head';
  const titleEl = doc.createElement('span');
  head.append(titleEl);

  const rowsWrap = doc.createElement('div');
  rowsWrap.className = 'font-popover-rows';

  const rowRefs = new Map<
    FontScaleKey,
    {
      labelEl: HTMLSpanElement;
      decBtn: HTMLButtonElement;
      incBtn: HTMLButtonElement;
      input: HTMLInputElement;
    }
  >();

  const syncRowDom = (key: FontScaleKey, pct: number): void => {
    const ref = rowRefs.get(key);
    if (!ref) return;
    const shadowActive = mountRoot && 'activeElement' in mountRoot ? (mountRoot as ShadowRoot).activeElement : null;
    if (doc.activeElement !== ref.input && shadowActive !== ref.input) {
      ref.input.value = String(pct);
    }
    ref.decBtn.disabled = pct <= FONT_POPOVER_MIN_PCT;
    ref.incBtn.disabled = pct >= FONT_POPOVER_MAX_PCT;
  };

  const commitKey = (key: FontScaleKey, nextPct: number): void => {
    const clampedPct = clampPct(nextPct);
    const nextScale = pctToScale(clampedPct);
    const prev = values[key];
    syncRowDom(key, clampedPct);
    if (nextScale === prev) return;
    values[key] = nextScale;
    void onChange({ [key]: nextScale } as PreferencesUpdateInput, { ...values });
  };

  for (const spec of FONT_POPOVER_ROWS) {
    const row = doc.createElement('div');
    row.className = 'font-row';
    row.dataset.fontKey = spec.key;

    const labelEl = doc.createElement('span');
    labelEl.className = 'font-row-label';

    const stepper = doc.createElement('div');
    stepper.className = 'font-stepper';

    const decBtn = doc.createElement('button');
    decBtn.type = 'button';
    decBtn.className = 'font-step-btn';
    decBtn.textContent = '−';
    decBtn.dataset.fontStep = String(-FONT_POPOVER_STEP_PCT);
    decBtn.addEventListener('click', () => {
      commitKey(spec.key, scaleToPct(values[spec.key]) - FONT_POPOVER_STEP_PCT);
    });

    const inputWrap = doc.createElement('span');
    inputWrap.className = 'font-input-wrap';

    const input = doc.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.className = 'font-pct-input';
    input.maxLength = 3;
    input.value = String(scaleToPct(values[spec.key]));
    input.dataset.fontInput = spec.key;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const parsed = Number.parseInt(input.value.replace(/[^\d]/g, ''), 10);
        if (Number.isFinite(parsed)) commitKey(spec.key, parsed);
        else input.value = String(scaleToPct(values[spec.key]));
        input.blur();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        commitKey(spec.key, scaleToPct(values[spec.key]) + FONT_POPOVER_STEP_PCT);
        input.value = String(scaleToPct(values[spec.key]));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        commitKey(spec.key, scaleToPct(values[spec.key]) - FONT_POPOVER_STEP_PCT);
        input.value = String(scaleToPct(values[spec.key]));
      }
    });
    input.addEventListener('blur', () => {
      const parsed = Number.parseInt(input.value.replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(parsed)) {
        const clamped = clampPct(parsed);
        input.value = String(clamped);
        commitKey(spec.key, clamped);
      } else {
        input.value = String(scaleToPct(values[spec.key]));
      }
    });

    const unit = doc.createElement('span');
    unit.className = 'font-pct-unit';
    unit.textContent = '%';
    inputWrap.append(input, unit);

    const incBtn = doc.createElement('button');
    incBtn.type = 'button';
    incBtn.className = 'font-step-btn';
    incBtn.textContent = '+';
    incBtn.dataset.fontStep = String(FONT_POPOVER_STEP_PCT);
    incBtn.addEventListener('click', () => {
      commitKey(spec.key, scaleToPct(values[spec.key]) + FONT_POPOVER_STEP_PCT);
    });

    stepper.append(decBtn, inputWrap, incBtn);
    row.append(labelEl, stepper);
    rowsWrap.append(row);
    rowRefs.set(spec.key, { labelEl, decBtn, incBtn, input });
  }

  const titleText = (): string => (getLanguage() === 'zh-CN' ? '字体大小' : 'Font size');

  const localize = (): void => {
    const zh = getLanguage() === 'zh-CN';
    titleEl.textContent = titleText();
    for (const spec of FONT_POPOVER_ROWS) {
      const ref = rowRefs.get(spec.key);
      if (!ref) continue;
      const name = zh ? spec.labelZh : spec.labelEn;
      ref.labelEl.textContent = name;
      ref.decBtn.setAttribute('aria-label', `${zh ? '缩小' : 'Decrease'} ${name}`);
      ref.incBtn.setAttribute('aria-label', `${zh ? '放大' : 'Increase'} ${name}`);
      ref.input.setAttribute('aria-label', `${name} ${zh ? '百分比' : 'percentage'}`);
    }
  };

  const syncInputs = (): void => {
    for (const spec of FONT_POPOVER_ROWS) {
      syncRowDom(spec.key, scaleToPct(values[spec.key]));
    }
  };

  const sync = (prefs?: Partial<PreferencesSnapshot> | null): void => {
    const state = asFontState(prefs);
    if (!state) return;
    for (const spec of FONT_POPOVER_ROWS) {
      const next = resolveFontScale(state[spec.key]);
      values[spec.key] = next;
      syncRowDom(spec.key, Math.round(next * 100));
    }
  };

  localize();
  sync(options.initial);

  return {
    headElement: head,
    rowsElement: rowsWrap,
    sync,
    localize,
    syncInputs,
    values: () => ({ ...values }),
    titleText,
  };
}

/**
 * Attaches an `Aa` font-scale popover anchored cleanly below `trigger`,
 * containing 3 independent rows (usage modal, sidebar, bottom card) with `- / +`
 * 5% steppers and direct editable percentage inputs (`80%`–`150%`).
 */
export function createFontPopover(options: FontPopoverOptions): FontPopoverHandle {
  const { trigger, mountRoot, getLanguage, onChange } = options;
  const doc = trigger.ownerDocument;
  const popover = doc.createElement('div');
  popover.className = 'font-popover';
  popover.setAttribute('popover', 'manual');
  popover.setAttribute('role', 'dialog');

  const controls = createFontScaleControls({
    doc,
    mountRoot,
    getLanguage,
    initial: options.initial,
    onChange,
  });
  popover.append(controls.headElement, controls.rowsElement);
  mountRoot.append(popover);

  const isOpen = (): boolean => popover.matches(':popover-open');

  const positionPopover = (): void => {
    const r = trigger.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    const popW = popRect.width || 240;
    const popH = popRect.height || 140;
    const vw = doc.documentElement.clientWidth || window.innerWidth;
    const vh = doc.documentElement.clientHeight || window.innerHeight;
    const left = Math.max(8, Math.min(vw - popW - 8, r.right - popW));
    const top = Math.max(8, Math.min(vh - popH - 8, r.bottom + 6));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  };

  const close = (): void => {
    if (!isOpen()) return;
    try {
      popover.hidePopover();
    } catch {
      popover.style.display = 'none';
    }
    trigger.setAttribute('aria-expanded', 'false');
  };

  const localize = (): void => {
    controls.localize();
    const zh = getLanguage() === 'zh-CN';
    popover.setAttribute('aria-label', controls.titleText());
    trigger.title = zh ? '字体大小设置' : 'Font size settings';
    trigger.setAttribute('aria-label', trigger.title);
  };

  const open = (): void => {
    localize();
    controls.syncInputs();
    try {
      popover.showPopover();
    } catch {
      popover.style.display = 'block';
    }
    positionPopover();
    trigger.setAttribute('aria-expanded', 'true');
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

  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('click', onTriggerClick);
  doc.addEventListener('pointerdown', onDocPointerDown, true);
  doc.addEventListener('keydown', onDocKeyDown, true);
  window.addEventListener('resize', onViewportChange);

  localize();

  return {
    element: popover,
    sync: controls.sync,
    localize,
    close,
    values: controls.values,
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
