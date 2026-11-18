import type { PreferencesSnapshot, RuntimeBridgeApi } from '../../contracts/index.ts';
import { resolveFontScale } from '../../contracts/preferences.ts';
import { setAttr, setHidden, setMarkup, setText } from '../../shared/dom.ts';
import createDashboardI18n from '../i18n/index.ts';
import { FONT_CONTROL_CSS } from '../shared/font-popover.ts';
import createAgPulseTheme from '../theme/index.ts';
import createUsageDashboard, { type UsageDashboardHandle } from '../usage-modal/index.ts';
import { createCardSwitcher, createDomLookup, syncPinBottom } from './dom-motion.ts';
import { bindModelMixEvents, renderModelMix } from './model-mix.ts';
import { createPanelController } from './polling.ts';
import { renderQuotaAndSpeedSections, updateCountdowns } from './quota-section.ts';
import { createSettingsPopover } from './settings-popover.ts';
import { bindSubagentEvents, renderSubagentsSection } from './subagent-tree.ts';
import { focusTimelineNodeByStep, renderTimeline, showSwimlaneTip } from './swimlane-timeline.ts';
import type { PanelDomContext, PanelState, PanelWindow } from './types.ts';

function initPanel(): void {
  const panelWin = window as PanelWindow;
  if (!document.querySelector('.widget') || panelWin.__agPulsePanelInstalled) return;
  panelWin.__agPulsePanelInstalled = true;

  const theme = createAgPulseTheme();
  let themeController = theme.attach(document.documentElement);

  const localGet = (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const localSet = (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // ignore storage errors in constrained webviews
    }
  };

  const language = createDashboardI18n(localGet('ag-pulse-language'));
  const t = language.t;
  const host = panelWin.sidecar;
  if (!host) document.body.classList.add('standalone');

  const applySidebarFontScale = (scale: unknown): void => {
    document.documentElement.style.setProperty('--pulse-sidebar-font-scale', String(resolveFontScale(scale)));
  };
  applySidebarFontScale(localGet('ag-pulse-sidebar-font-scale'));
  if (!document.getElementById('ag-pulse-font-popover-style')) {
    const styleEl = document.createElement('style');
    styleEl.id = 'ag-pulse-font-popover-style';
    styleEl.textContent = FONT_CONTROL_CSS;
    document.head.append(styleEl);
  }

  const state: PanelState = {
    snapshot: null,
    selectedGroup: localGet('ag-pulse-group'),
    group: null,
    pending: false,
    timer: null,
    serverOffset: 0,
    lastExpiredRefresh: 0,
    selectedCard: 'speed',
    lastQuotaSig: null,
    refreshRequest: null,
    manualRequest: null,
    syncingFromRefresh: false,
    lastThemeKey: null,
    lastLocalizedKey: null,
    mixMetric: 'total',
    mixScope: 'session',
    mixScopeManual: false,
    mixActiveId: null,
    mixHoverId: null,
    lastMixSig: null,
    mixDisplayModels: [],
    timelineEnabled: false,
    timelineEpoch: 0,
    timelineBusy: false,
    timelineNoticeKey: null,
    timelineNoticeIsError: false,
    lastTimelineSig: null,
    lastTimelineRender: [],
    lastTimelineClearAt: 0,
    pinnedSwimlaneIdx: -1,
    lastTaskId: null,
    lastSubagentsSig: null,
    treeState: new Map(),
    detailState: new Set(),
    timelineToggled: new Map(),
  };

  let ctx!: PanelDomContext;
  let controller!: ReturnType<typeof createPanelController>;
  let localUsage: UsageDashboardHandle | null = null;
  let usageThemeController: ReturnType<typeof theme.attach> | null = null;

  const render = (): void => {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const speed = snapshot.speed;

    renderQuotaAndSpeedSections(ctx, snapshot);

    const activeConvId = speed?.modelTimeline?.cascadeId || speed?.conversationId || snapshot.conversationId || null;
    if (activeConvId && activeConvId !== state.lastTaskId) {
      state.treeState.clear();
      state.detailState.clear();
      state.timelineToggled.clear();
      state.mixScopeManual = false;
      state.mixActiveId = null;
      state.mixHoverId = null;
      state.lastTaskId = activeConvId;
      state.lastSubagentsSig = null;
      state.lastMixSig = null;
      state.lastTimelineSig = null;
    }

    renderModelMix(ctx, speed);
    renderSubagentsSection(ctx, snapshot);
    renderTimeline(ctx, speed);

    setHidden(ctx.$('cache-note'), true);
    const dot = ctx.$('connection-dot');
    const dotClass = `connection-dot ${snapshot.connection}`;
    if (dot && dot.className !== dotClass) dot.className = dotClass;
    setAttr(dot, 'title', t(snapshot.connection === 'live' ? 'live' : snapshot.connection === 'stale' ? 'stale' : 'offline'));

    const timestamp = snapshot.quotaUpdatedAt
      ? new Date(snapshot.quotaUpdatedAt).toLocaleTimeString(language.language, { hour12: false })
      : null;
    const healthNote = ctx.$('health-note');
    setText(
      healthNote,
      language.errorMessage(snapshot.error || snapshot.sessionError) ||
        (timestamp ? t('health', { time: timestamp }) : t('firstUpdate')),
    );
    healthNote?.classList.toggle('warning', snapshot.connection !== 'live' || Boolean(snapshot.sessionError));

    const integration = snapshot.integration;
    const activePortPresent = Boolean(integration?.activePortPresent);
    const debugEnabled =
      integration?.debugLaunchEnabled ??
      (snapshot.preferences && !('error' in snapshot.preferences) ? snapshot.preferences.debugLaunchEnabled : false);
    let integrationMsg = '';
    if (integration && !['mounted', 'disabled'].includes(integration.state)) {
      if (activePortPresent) {
        integrationMsg =
          language.language === 'zh-CN'
            ? '内嵌栏正在自动重连；此面板仍可查看统计。'
            : 'Inline widget is reconnecting automatically; statistics remain available in this panel.';
      } else if (debugEnabled) {
        integrationMsg = t('integrationRestartHint');
      }
    }
    setText(ctx.$('integration-note'), integrationMsg);
    handleUpdateCountdowns();
    if (localUsage?.isOpen) localUsage.update(snapshot.usage);
  };

  const handleUpdateCountdowns = (): void => {
    updateCountdowns(ctx, () => {
      setTimeout(() => void controller.refresh(true), 0);
    });
  };

  ctx = {
    state,
    language,
    preferences: null as never,
    themeController,
    setThemeController: (next) => {
      themeController = next;
      ctx.themeController = next;
    },
    setPreferences: (next) => { ctx.preferences = next; },
    host,
    $: createDomLookup(),
    localGet,
    localSet,
  };

  controller = createPanelController(ctx, {
    render,
    updateCountdowns: handleUpdateCountdowns,
    onTheme: (hostTheme) => {
      usageThemeController?.setHostTheme(hostTheme ?? null);
    },
    onUsage: (usage) => {
      if (localUsage?.isOpen) localUsage.update(usage);
    },
  });
  ctx.preferences = controller.connectPreferences();

  const showCard = createCardSwitcher(ctx);
  bindSubagentEvents(ctx);
  bindModelMixEvents(ctx, render);

  const quotaPill = ctx.$('quota-rings-pill');
  const quotaPopover = ctx.$('quota-popover');
  let quotaCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let quotaPinned = false;
  const positionQuotaPopoverFallback = (): void => {
    if (!quotaPill || !quotaPopover || CSS.supports('position-area', 'block-end')) return;
    const r = quotaPill.getBoundingClientRect();
    const pw = quotaPopover.offsetWidth || 256;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const left = Math.max(8, Math.min(vw - pw - 8, r.right - pw));
    quotaPopover.style.left = `${Math.round(left)}px`;
    quotaPopover.style.top = `${Math.round(r.bottom + 6)}px`;
  };
  const isQuotaOpen = (): boolean => Boolean(quotaPopover?.matches(':popover-open')) || quotaPill?.getAttribute('aria-expanded') === 'true';
  const openQuotaPopover = (): void => {
    if (!quotaPill || !quotaPopover) return;
    if (quotaCloseTimer) { clearTimeout(quotaCloseTimer); quotaCloseTimer = null; }
    if (!quotaPopover.matches(':popover-open')) {
      try { quotaPopover.showPopover(); } catch { quotaPopover.style.display = 'block'; }
    }
    positionQuotaPopoverFallback();
    setAttr(quotaPill, 'aria-expanded', 'true');
  };
  const closeQuotaPopoverNow = (): void => {
    quotaPinned = false;
    if (quotaCloseTimer) { clearTimeout(quotaCloseTimer); quotaCloseTimer = null; }
    if (quotaPopover && typeof quotaPopover.hidePopover === 'function' && quotaPopover.matches(':popover-open')) {
      try { quotaPopover.hidePopover(); } catch { quotaPopover.style.display = 'none'; }
    } else if (quotaPopover) {
      quotaPopover.style.display = 'none';
    }
    setAttr(quotaPill, 'aria-expanded', 'false');
  };
  const scheduleCloseQuotaPopover = (): void => {
    if (quotaPinned) return;
    if (quotaCloseTimer) clearTimeout(quotaCloseTimer);
    quotaCloseTimer = setTimeout(closeQuotaPopoverNow, 120);
  };
  quotaPill?.addEventListener('pointerenter', openQuotaPopover);
  quotaPill?.addEventListener('pointerleave', scheduleCloseQuotaPopover);
  quotaPill?.addEventListener('focus', openQuotaPopover);
  quotaPill?.addEventListener('blur', scheduleCloseQuotaPopover);
  quotaPill?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (quotaPinned && isQuotaOpen()) {
      closeQuotaPopoverNow();
    } else {
      quotaPinned = true;
      openQuotaPopover();
    }
  });
  quotaPopover?.addEventListener('pointerenter', () => {
    if (quotaCloseTimer) { clearTimeout(quotaCloseTimer); quotaCloseTimer = null; }
  });
  quotaPopover?.addEventListener('pointerleave', scheduleCloseQuotaPopover);
  const onDocQuotaPointerDown = (event: PointerEvent): void => {
    if (!isQuotaOpen() || !quotaPill || !quotaPopover) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    if (path.includes(quotaPopover) || path.includes(quotaPill)) return;
    closeQuotaPopoverNow();
  };
  const onDocQuotaKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && isQuotaOpen()) {
      closeQuotaPopoverNow();
      quotaPill?.focus();
    }
  };
  const onQuotaResize = (): void => {
    if (isQuotaOpen()) positionQuotaPopoverFallback();
  };
  document.addEventListener('pointerdown', onDocQuotaPointerDown, true);
  document.addEventListener('keydown', onDocQuotaKeyDown, true);
  window.addEventListener('resize', onQuotaResize);

  ctx.$('timeline-enable-btn')?.addEventListener('click', () => { void controller.setTimelineEnabled(true); });
  ctx.$('timeline-disable-btn')?.addEventListener('click', () => {
    state.pinnedSwimlaneIdx = -1;
    void controller.setTimelineEnabled(false);
  });
  ctx.$('timeline-clear-btn')?.addEventListener('click', () => {
    state.pinnedSwimlaneIdx = -1;
    void controller.clearTimelineData();
  });

  const swimlanesEl = ctx.$('timeline-swimlanes');
  swimlanesEl?.addEventListener('pointerover', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const seg = target?.closest<HTMLElement>('.timeline-seg[data-seg-idx]');
    if (seg) showSwimlaneTip(ctx, Number(seg.dataset.segIdx));
  });
  swimlanesEl?.addEventListener('pointerleave', () => showSwimlaneTip(ctx, state.pinnedSwimlaneIdx));
  swimlanesEl?.addEventListener('focusin', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const seg = target?.closest<HTMLElement>('.timeline-seg[data-seg-idx]');
    if (seg) showSwimlaneTip(ctx, Number(seg.dataset.segIdx));
  });
  swimlanesEl?.addEventListener('focusout', (event) => {
    if (!swimlanesEl.contains(event.relatedTarget as Node | null)) showSwimlaneTip(ctx, state.pinnedSwimlaneIdx);
  });
  swimlanesEl?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const segEl = target?.closest<HTMLElement>('.timeline-seg[data-seg-idx]');
    if (!segEl) return;
    const idx = Number(segEl.dataset.segIdx);
    state.pinnedSwimlaneIdx = state.pinnedSwimlaneIdx === idx ? -1 : idx;
    showSwimlaneTip(ctx, state.pinnedSwimlaneIdx >= 0 ? state.pinnedSwimlaneIdx : idx);
    const segData = state.lastTimelineRender[idx];
    if (segData?.stepStart != null) focusTimelineNodeByStep(ctx, segData.stepStart);
  });
  ctx.$('timeline-tree')?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLElement>('.timeline-node-row');
    const nodeEl = row?.closest<HTMLElement>('.timeline-node');
    const btn = row?.querySelector<HTMLElement>(':scope > .timeline-toggle-btn');
    const kids = nodeEl?.querySelector<HTMLElement>(':scope > .timeline-children');
    if (!btn || !kids || !nodeEl?.dataset.nodeId) return;
    const expanded = btn.getAttribute('aria-expanded') !== 'true';
    state.timelineToggled.set(nodeEl.dataset.nodeId, !expanded);
    setAttr(btn, 'aria-expanded', String(expanded));
    kids.hidden = !expanded;
  });

  ctx.$('refresh-button')?.addEventListener('click', controller.refreshManually);
  const settingsTrigger = ctx.$<HTMLButtonElement>('settings-button');
  if (settingsTrigger) {
    ctx.settingsPopover = createSettingsPopover({
      trigger: settingsTrigger,
      mountRoot: document.body,
      language,
      initialPreferences: { sidebarFontScale: resolveFontScale(localGet('ag-pulse-sidebar-font-scale')) },
      onFontChange: async (update, next) => {
        applySidebarFontScale(next.sidebarFontScale);
        localSet('ag-pulse-sidebar-font-scale', String(next.sidebarFontScale));
        try {
          const saved = await controller.savePreferences(update);
          if (saved && !('error' in saved)) {
            ctx.settingsPopover?.syncPreferences(saved);
            localUsage?.syncPreferences?.(saved);
            applySidebarFontScale(saved.sidebarFontScale);
            localSet('ag-pulse-sidebar-font-scale', String(resolveFontScale(saved.sidebarFontScale)));
          }
        } catch {
          // Keep optimistic preview if offline/standalone.
        }
      },
      onSelectLanguage: async (lang) => {
        await ctx.preferences.choose(lang);
        ctx.settingsPopover?.syncLanguage(language.language, ctx.preferences.error);
        ctx.settingsPopover?.localize();
      },
      onToggleDebugLaunch: async (nextEnabled) => {
        ctx.settingsPopover?.syncDebugLaunch({ busy: true, error: null });
        try {
          const result = await controller.apiJson<{
            enabled?: boolean;
            configured?: boolean;
            activePortPresent?: boolean;
            platform?: string | null;
            preferences?: PreferencesSnapshot;
          }>('/api/debug-launch', { enabled: nextEnabled });
          if (result.preferences && !('error' in result.preferences)) {
            ctx.preferences.sync(result.preferences);
            ctx.settingsPopover?.syncPreferences(result.preferences);
          }
          ctx.settingsPopover?.syncDebugLaunch({
            enabled: result.enabled ?? nextEnabled,
            configured: Boolean(result.configured),
            activePortPresent: Boolean(result.activePortPresent),
            platform: result.platform ?? null,
            busy: false,
            error: null,
          });
          await controller.refresh(true);
        } catch (err) {
          ctx.settingsPopover?.syncDebugLaunch({
            busy: false,
            error: err instanceof Error ? err.message : t('debugLaunchFailed'),
          });
        }
      },
      onRefreshDebugLaunch: async () => {
        try {
          const status = await controller.apiJson<{
            enabled?: boolean;
            configured?: boolean;
            activePortPresent?: boolean;
            platform?: string | null;
          }>('/api/debug-launch');
          ctx.settingsPopover?.syncDebugLaunch({
            ...(typeof status.enabled === 'boolean' ? { enabled: status.enabled } : {}),
            ...(typeof status.configured === 'boolean' ? { configured: status.configured } : {}),
            ...(typeof status.activePortPresent === 'boolean' ? { activePortPresent: status.activePortPresent } : {}),
            platform: status.platform ?? null,
            error: null,
          });
        } catch {
          // Non-fatal in standalone/offline mode.
        }
      },
    });
  }

  const ensureLocalUsage = (): UsageDashboardHandle => {
    if (localUsage) return localUsage;
    const usageHost = ctx.$('panel-usage-host') || document.body;
    const shadow = usageHost.shadowRoot || usageHost.attachShadow({ mode: 'open' });
    usageThemeController = theme.attach(usageHost);
    usageThemeController.setHostTheme(state.snapshot?.theme ?? null);
    const usageBridge: Partial<RuntimeBridgeApi> = {
      getPreferences: () => controller.apiJson('/api/preferences'),
      setPreferences: (input) => controller.apiJson('/api/preferences', input),
      getAccounts: () => controller.apiJson('/api/usage/accounts', {}),
      switchAccount: (input) => controller.apiJson('/api/usage/switch-account', input),
      addManualUsage: (input) => controller.apiJson('/api/usage/manual/add', input),
      deleteManualUsage: (input) => controller.apiJson('/api/usage/manual/delete', input),
      getProjectUsage: (input) => controller.apiJson('/api/usage/project-overview', input),
      getProjectDetail: (input) => controller.apiJson('/api/usage/project-detail', input),
    };
    const currentPrefs =
      state.snapshot?.preferences && !('error' in state.snapshot.preferences)
        ? state.snapshot.preferences
        : undefined;
    localUsage = createUsageDashboard({
      root: shadow,
      language,
      setMarkup,
      hostLabel: 'Antigravity',
      bridge: usageBridge,
      initialPreferences: currentPrefs,
      guideDismissed: Boolean(currentPrefs?.usageGuideDismissed),
      onDismissGuide: async () => {
        const saved = await controller.savePreferences({ usageGuideDismissed: true });
        if (saved && !('error' in saved)) {
          ctx.preferences.sync(saved);
          localUsage?.syncGuideDismissed();
        }
      },
      onLanguage: async (next) => {
        await ctx.preferences.choose(next);
        if (state.snapshot?.usage) localUsage?.update(state.snapshot.usage);
      },
      onRefresh: async () => {
        await controller.refresh(true);
        if (state.snapshot?.usage) localUsage?.update(state.snapshot.usage);
      },
      onPreferencesSaved: (saved) => {
        ctx.preferences.sync(saved);
        ctx.settingsPopover?.syncPreferences(saved);
        if ('sidebarFontScale' in saved) {
          const scale = resolveFontScale(saved.sidebarFontScale);
          applySidebarFontScale(scale);
          localSet('ag-pulse-sidebar-font-scale', String(scale));
        }
      },
    });
    return localUsage;
  };

  const openUsageBtn = ctx.$<HTMLButtonElement>('open-usage-button');
  openUsageBtn?.addEventListener('click', () => {
    if (openUsageBtn.disabled) return;
    openUsageBtn.disabled = true;
    void (async () => {
      try {
        try {
          const res = await controller.apiJson<{ openedInHost?: boolean }>('/api/usage/open', {});
          if (res?.openedInHost) return;
        } catch {
          // Fall back to embedded local usage modal when host CDP modal is unavailable.
        }
        if (!state.snapshot?.usage) {
          await controller.refresh(true);
        }
        if (!state.snapshot?.usage) return;
        const dashboard = ensureLocalUsage();
        dashboard.open(state.snapshot.usage, openUsageBtn);
      } finally {
        openUsageBtn.disabled = false;
      }
    })();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void controller.refresh();
  });
  window.addEventListener('pagehide', () => {
    closeQuotaPopoverNow();
    document.removeEventListener('pointerdown', onDocQuotaPointerDown, true);
    document.removeEventListener('keydown', onDocQuotaKeyDown, true);
    window.removeEventListener('resize', onQuotaResize);
    ctx.settingsPopover?.dispose();
    localUsage?.dispose();
    localUsage = null;
    usageThemeController?.dispose();
    usageThemeController = null;
    ctx.themeController.dispose();
    ctx.preferences.dispose();
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    ctx.setThemeController(theme.attach(document.documentElement));
    ctx.setPreferences(controller.connectPreferences());
  });

  setInterval(handleUpdateCountdowns, 1000);
  controller.localize();
  showCard('speed');
  syncPinBottom(ctx);
  void controller.refresh();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPanel, { once: true });
else initPanel();
