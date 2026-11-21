import type { PreferencesSnapshot, PreferencesUpdateInput } from '../../contracts/index.ts';
import { resolveFontScale } from '../../contracts/preferences.ts';
import { setAttr, setText } from '../../shared/dom.ts';
import { renderTimeline, renderTimelineStatus } from './swimlane-timeline.ts';
import type { PanelDomContext, PanelMetricsSnapshot, PanelWindow } from './types.ts';

export function createPanelController(
  ctx: PanelDomContext,
  handlers: {
    render: () => void;
    updateCountdowns: () => void;
    isUsageOpen?: () => boolean;
    onTheme?: (theme: PanelMetricsSnapshot['theme']) => void;
    onUsage?: (usage: PanelMetricsSnapshot['usage']) => void;
  },
) {
  const { $, state, language, host } = ctx;
  const t = language.t;
  const i18nTextNodes = [...document.querySelectorAll<HTMLElement>('[data-i18n]')];
  const i18nAriaNodes = [...document.querySelectorAll<HTMLElement>('[data-i18n-aria]')];
  const i18nTitleNodes = [...document.querySelectorAll<HTMLElement>('[data-i18n-aria][title]')];

  let disposed = false;
  let pendingIncludesUsage = false;
  let pendingForce = false;
  let queuedForceRequest: Promise<void> | null = null;
  let queuedForceIncludesUsage = false;
  let refreshSeq = 0;
  let lastAppliedFontScale: number | null = resolveFontScale(ctx.localGet('ag-pulse-sidebar-font-scale'));
  let hasConnectedPrefsOnce = false;
  let resolveInitialPrefs: ((prefs: PreferencesSnapshot) => void) | null = null;
  let fallbackInitialPrefsTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleNextPoll = (): void => {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (disposed) return;
    state.timer = setTimeout(() => void refresh(), document.hidden ? 30000 : 2200);
  };

  const stopTimers = (): void => {
    disposed = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (fallbackInitialPrefsTimer) {
      clearTimeout(fallbackInitialPrefsTimer);
      fallbackInitialPrefsTimer = null;
    }
  };

  const resumeTimers = (): void => {
    disposed = false;
    scheduleNextPoll();
  };

  const settleInitialPrefsFromMetrics = (prefs: PreferencesSnapshot | undefined): void => {
    if (!resolveInitialPrefs) return;
    const resolve = resolveInitialPrefs;
    resolveInitialPrefs = null;
    if (fallbackInitialPrefsTimer) {
      clearTimeout(fallbackInitialPrefsTimer);
      fallbackInitialPrefsTimer = null;
    }
    if (prefs) {
      resolve(prefs);
    } else {
      void preferenceRequest().then(resolve, () => resolve({ error: 'Preferences unavailable' }));
    }
  };

  const applySidebarFontScaleIfChanged = (rawScale: unknown): void => {
    const scale = resolveFontScale(rawScale);
    if (scale === lastAppliedFontScale) return;
    lastAppliedFontScale = scale;
    const scaleStr = String(scale);
    if (document.documentElement.style.getPropertyValue('--pulse-sidebar-font-scale') !== scaleStr) {
      document.documentElement.style.setProperty('--pulse-sidebar-font-scale', scaleStr);
    }
    if (ctx.localGet('ag-pulse-sidebar-font-scale') !== scaleStr) {
      ctx.localSet('ag-pulse-sidebar-font-scale', scaleStr);
    }
  };

  const apiJson = async <T>(path: string, body?: unknown): Promise<T> => {
    const transport = host?.fetch ? host.fetch.bind(host) : fetch;
    const response = await transport(
      path,
      body !== undefined
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : { cache: 'no-store' },
    );
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const errText =
        payload && typeof payload === 'object' && 'error' in payload && typeof (payload as { error?: unknown }).error === 'string'
          ? (payload as { error: string }).error
          : `Request failed (${response.status})`;
      throw new Error(errText);
    }
    return payload as T;
  };

  const preferenceRequest = async (input?: PreferencesUpdateInput): Promise<PreferencesSnapshot> => {
    const transport = host?.fetch ? host.fetch.bind(host) : fetch;
    const response = await transport(
      '/api/preferences',
      input
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
        : { cache: 'no-store' },
    );
    if (!response.ok) throw new Error('Preferences unavailable');
    return response.json() as Promise<PreferencesSnapshot>;
  };

  const localize = (): void => {
    const locKey = `${language.language}|${Boolean(ctx.preferences.error)}`;
    if (locKey === state.lastLocalizedKey) return;
    state.lastLocalizedKey = locKey;
    state.lastMixSig = null;
    state.lastTimelineSig = null;
    setAttr(document.documentElement, 'lang', language.language);
    for (const e of i18nTextNodes) {
      if (!e.isConnected) continue;
      if (e.dataset.i18n === 'taskTokensSubagents' && (state.snapshot?.speed?.taskUsage?.subagents ?? 0) > 0) continue;
      setText(e, e.dataset.i18n ? t(e.dataset.i18n) : '');
    }
    for (const e of i18nAriaNodes) {
      if (e.dataset.i18nAria) setAttr(e, 'aria-label', t(e.dataset.i18nAria));
    }
    for (const e of i18nTitleNodes) {
      if (!e.dataset.i18nAria) continue;
      const ariaTitle = t(e.dataset.i18nAria);
      if (e.title !== ariaTitle) e.title = ariaTitle;
    }
    const privacyEl = $('timeline-privacy-text');
    if (privacyEl) setAttr(privacyEl, 'title', t('timelinePrivacySummary'));
    renderTimelineStatus(ctx);
    ctx.settingsPopover?.localize();
    ctx.settingsPopover?.syncLanguage(language.language, ctx.preferences.error);
  };

  const connectPreferences = () => {
    const useCoalescedStartup = !hasConnectedPrefsOnce && !state.snapshot;
    hasConnectedPrefsOnce = true;
    return language.connectPreferences({
      read: () => {
        if (!useCoalescedStartup) return preferenceRequest();
        return new Promise<PreferencesSnapshot>((resolve) => {
          resolveInitialPrefs = resolve;
          fallbackInitialPrefsTimer = setTimeout(() => {
            if (!resolveInitialPrefs) return;
            const fn = resolveInitialPrefs;
            resolveInitialPrefs = null;
            fallbackInitialPrefsTimer = null;
            void preferenceRequest().then(fn, () => fn({ error: 'Preferences unavailable' }));
          }, 1200);
        });
      },
      write: preferenceRequest,
      cache: (value) => ctx.localSet('ag-pulse-language', value),
      changed: () => {
        const prevLoc = state.lastLocalizedKey;
        localize();
        if (!state.syncingFromRefresh && state.lastLocalizedKey !== prevLoc) {
          handlers.render();
          handlers.updateCountdowns();
        }
      },
    });
  };

  const refreshBusy = (busy: boolean): void => {
    const button = $('refresh-button');
    if (!button) return;
    setAttr(button, 'aria-busy', String(busy));
    setAttr(button, 'aria-disabled', String(busy));
    button.dataset.i18nAria = busy ? 'refreshing' : 'refreshStats';
    button.title = t(button.dataset.i18nAria);
    setAttr(button, 'aria-label', button.title);
  };

  const refresh = (force = false, options: { includeUsage?: boolean } = {}): Promise<void> => {
    const wantUsage = options.includeUsage ?? Boolean(handlers.isUsageOpen?.());
    if (state.pending && state.refreshRequest) {
      if (!force) {
        if (!wantUsage || pendingIncludesUsage) return state.refreshRequest;
        return state.refreshRequest
          .catch(() => {})
          .then(() => refresh(false, { includeUsage: true }));
      }
      // Coalesce only if an equivalent forced refresh is already running; otherwise
      // queue one forced refresh behind the ongoing poll so it is never dropped.
      if (pendingForce && (!wantUsage || pendingIncludesUsage)) return state.refreshRequest;
      if (queuedForceRequest && (!wantUsage || queuedForceIncludesUsage)) return queuedForceRequest;
      queuedForceIncludesUsage = queuedForceIncludesUsage || wantUsage;
      const nextForced = state.refreshRequest
        .catch(() => {})
        .then(() => {
          const includeUsage = queuedForceIncludesUsage;
          queuedForceRequest = null;
          queuedForceIncludesUsage = false;
          return refresh(true, { includeUsage });
        });
      queuedForceRequest = nextForced;
      return nextForced;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const reqSeq = ++refreshSeq;
    state.pending = true;
    pendingForce = force;
    pendingIncludesUsage = wantUsage;
    const reqTimelineEpoch = state.timelineEpoch;
    const reqPromise = (async () => {
      try {
        const params = new URLSearchParams();
        if (host?.conversationId) params.set('conversationId', host.conversationId);
        if (force) {
          params.set('force', '1');
          params.set('_ts', String(Date.now()));
        }
        if (!wantUsage) params.set('includeUsage', '0');
        const transport = host?.fetch ? host.fetch.bind(host) : fetch;
        const response = await transport(`/api/metrics?${params}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(t('panelUnavailable'));
        const value = (await response.json()) as PanelMetricsSnapshot;
        if (!['live', 'stale', 'offline'].includes(value.connection)) throw new Error(t('invalidData'));
        // Discard response if superseded by a newer forced refresh.
        if (reqSeq !== refreshSeq) return;

        const prevSnapshot = state.snapshot;
        if (value.usage === undefined && prevSnapshot?.usage !== undefined) {
          value.usage = prevSnapshot.usage;
        }
        if (reqTimelineEpoch !== state.timelineEpoch && value.speed && prevSnapshot?.speed) {
          value.speed.modelTimeline = prevSnapshot.speed.modelTimeline;
        }

        state.snapshot = value;
        if (Object.hasOwn(value, 'theme')) {
          const themeKey = JSON.stringify(value.theme ?? null);
          if (themeKey !== state.lastThemeKey) {
            state.lastThemeKey = themeKey;
            ctx.themeController.setHostTheme(value.theme ?? undefined);
            handlers.onTheme?.(value.theme ?? undefined);
          }
        }
        if (value.preferences) {
          if (reqTimelineEpoch === state.timelineEpoch && 'modelTimelineEnabled' in value.preferences) {
            const nextTl = value.preferences.modelTimelineEnabled === true;
            if (nextTl !== state.timelineEnabled) {
              state.timelineEnabled = nextTl;
              state.lastTimelineSig = null;
            }
          }
          state.syncingFromRefresh = true;
          try {
            ctx.preferences.sync(value.preferences);
            if ('sidebarFontScale' in value.preferences) {
              applySidebarFontScaleIfChanged(value.preferences.sidebarFontScale);
            }
            ctx.settingsPopover?.syncPreferences(value.preferences);
          } finally {
            state.syncingFromRefresh = false;
          }
          settleInitialPrefsFromMetrics(value.preferences);
        } else {
          settleInitialPrefsFromMetrics(undefined);
        }
        if (value.integration) {
          ctx.settingsPopover?.syncDebugLaunch({
            ...(typeof value.integration.debugLaunchEnabled === 'boolean'
              ? { enabled: value.integration.debugLaunchEnabled }
              : {}),
            ...(typeof value.integration.debugLaunchConfigured === 'boolean'
              ? { configured: value.integration.debugLaunchConfigured }
              : {}),
            activePortPresent: Boolean(value.integration.activePortPresent),
            integrationState: value.integration.state ?? null,
          });
        }
        if (
          state.timelineNoticeKey === 'timelineCleared' &&
          (value.speed?.modelTimeline?.nodes?.length ?? 0) > 0 &&
          Date.now() - state.lastTimelineClearAt > 1200
        ) {
          state.timelineNoticeKey = null;
          state.timelineNoticeIsError = false;
        }
        state.serverOffset = Date.parse(value.serverTime) - Date.now();
        if (!Number.isFinite(state.serverOffset)) state.serverOffset = 0;
        handlers.render();
        if (value.usage !== undefined && handlers.isUsageOpen?.()) {
          handlers.onUsage?.(value.usage);
        }
      } catch (error) {
        if (reqSeq !== refreshSeq) return;
        settleInitialPrefsFromMetrics(undefined);
        const msg = error instanceof Error ? error.message : String(error);
        if (state.snapshot) {
          state.snapshot.connection = 'stale';
          state.snapshot.error = msg;
          handlers.render();
        } else {
          const note = $('health-note');
          setText(note, language.errorMessage(msg));
          note?.classList.add('warning');
        }
      } finally {
        if (reqSeq === refreshSeq) {
          state.pending = false;
          pendingForce = false;
          pendingIncludesUsage = false;
          state.refreshRequest = null;
          scheduleNextPoll();
        }
      }
    })();
    state.refreshRequest = reqPromise;
    return reqPromise;
  };

  const refreshManually = (): void => {
    if (state.manualRequest) return;
    refreshBusy(true);
    const started = performance.now();
    state.manualRequest = (async () => {
      try {
        await refresh(true);
      } finally {
        const remaining = 250 - (performance.now() - started);
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        refreshBusy(false);
        state.manualRequest = null;
      }
    })();
  };

  const setTimelineEnabled = async (next: boolean): Promise<void> => {
    if (state.timelineBusy) return;
    state.timelineBusy = true;
    state.timelineNoticeKey = null;
    state.timelineNoticeIsError = false;
    const myEpoch = ++state.timelineEpoch;
    renderTimeline(ctx, state.snapshot?.speed);
    try {
      const updated = await preferenceRequest({ modelTimelineEnabled: Boolean(next) });
      if (myEpoch !== state.timelineEpoch) return;
      const updatedEnabled =
        updated && 'modelTimelineEnabled' in updated ? Boolean(updated.modelTimelineEnabled) : Boolean(next);
      if (state.snapshot?.preferences && 'modelTimelineEnabled' in state.snapshot.preferences) {
        state.snapshot.preferences.modelTimelineEnabled = updatedEnabled;
      }
      if (!updatedEnabled) {
        state.timelineEnabled = false;
        state.timelineToggled.clear();
        state.lastTimelineSig = null;
        state.timelineBusy = false;
        renderTimeline(ctx, state.snapshot?.speed);
        return;
      }
      // Enabling: fetch timeline payload before revealing panel so lanes/tree populate on frame 0 without empty flash.
      if (state.pending && state.refreshRequest) await state.refreshRequest.catch(() => {});
      if (myEpoch !== state.timelineEpoch) return;
      state.timelineEnabled = true;
      state.lastTimelineSig = null;
      await refresh(true);
      if (myEpoch === state.timelineEpoch) {
        state.timelineBusy = false;
        renderTimeline(ctx, state.snapshot?.speed);
      }
    } catch {
      state.timelineBusy = false;
      state.timelineNoticeKey = 'timelineSaveFailed';
      state.timelineNoticeIsError = true;
      renderTimeline(ctx, state.snapshot?.speed);
    }
  };

  const clearTimelineData = async (): Promise<void> => {
    if (state.timelineBusy) return;
    state.timelineBusy = true;
    state.timelineNoticeKey = null;
    state.timelineNoticeIsError = false;
    ++state.timelineEpoch;
    renderTimeline(ctx, state.snapshot?.speed);
    const rawConvId =
      host?.conversationId ||
      state.snapshot?.speed?.modelTimeline?.cascadeId ||
      state.snapshot?.speed?.conversationId ||
      null;
    const guidConvId =
      typeof rawConvId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawConvId)
        ? rawConvId
        : null;
    const payload = guidConvId ? { conversationId: guidConvId } : {};
    try {
      const panelWin = window as PanelWindow;
      if (typeof panelWin.agPulseHost?.clearTimeline === 'function') {
        const clearRes = (await panelWin.agPulseHost.clearTimeline(payload)) as { error?: string } | null | undefined;
        if (clearRes && typeof clearRes === 'object' && clearRes.error) throw new Error(clearRes.error);
      } else {
        const transport = host?.fetch ? host.fetch.bind(host) : fetch;
        const res = await transport('/api/timeline/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('Clear failed');
      }
      state.lastTimelineClearAt = Date.now();
      state.timelineToggled.clear();
      if (state.snapshot?.speed) {
        const prevTl = state.snapshot.speed.modelTimeline;
        state.snapshot.speed.modelTimeline = {
          enabled: prevTl?.enabled ?? true,
          cascadeId: prevTl?.cascadeId ?? '',
          planModel: prevTl?.planModel ?? null,
          activeModel: prevTl?.activeModel ?? null,
          startedAt: prevTl?.startedAt ?? null,
          endedAt: prevTl?.endedAt ?? null,
          durationMs: prevTl?.durationMs ?? 0,
          savedAt: prevTl?.savedAt ?? null,
          swimlanes: [],
          nodes: [],
          truncated: false,
        };
      }
      state.lastTimelineSig = null;
      state.timelineNoticeKey = 'timelineCleared';
      state.timelineNoticeIsError = false;
      state.timelineBusy = false;
      renderTimeline(ctx, state.snapshot?.speed);
      setTimeout(() => {
        if (state.timelineNoticeKey === 'timelineCleared') {
          state.timelineNoticeKey = null;
          renderTimelineStatus(ctx);
        }
      }, 2800);
      scheduleNextPoll();
    } catch {
      state.timelineBusy = false;
      state.timelineNoticeKey = 'timelineClearFailed';
      state.timelineNoticeIsError = true;
      renderTimeline(ctx, state.snapshot?.speed);
    }
  };

  return {
    localize,
    apiJson,
    connectPreferences,
    savePreferences: preferenceRequest,
    refresh,
    refreshManually,
    setTimelineEnabled,
    clearTimelineData,
    stopTimers,
    resumeTimers,
    syncFontScaleCache: (scale: number) => {
      lastAppliedFontScale = resolveFontScale(scale);
    },
  };
}
