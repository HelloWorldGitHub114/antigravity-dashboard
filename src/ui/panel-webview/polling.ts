import type { PreferencesSnapshot, PreferencesUpdateInput } from '../../contracts/index.ts';
import { setAttr, setText } from '../../shared/dom.ts';
import { renderTimeline, renderTimelineStatus } from './swimlane-timeline.ts';
import type { PanelDomContext, PanelMetricsSnapshot, PanelWindow } from './types.ts';

export function createPanelController(
  ctx: PanelDomContext,
  handlers: {
    render: () => void;
    updateCountdowns: () => void;
  },
) {
  const { $, state, language, host } = ctx;
  const t = language.t;
  const i18nTextNodes = [...document.querySelectorAll<HTMLElement>('[data-i18n]')];
  const i18nAriaNodes = [...document.querySelectorAll<HTMLElement>('[data-i18n-aria]')];
  const i18nTitleNodes = [...document.querySelectorAll<HTMLElement>('[data-i18n-aria][title]')];

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
      if (e.id === 'language-toggle' || !e.dataset.i18nAria) continue;
      const ariaTitle = t(e.dataset.i18nAria);
      if (e.title !== ariaTitle) e.title = ariaTitle;
    }
    const privacyEl = $('timeline-privacy-text');
    if (privacyEl) setAttr(privacyEl, 'title', t('timelinePrivacySummary'));
    renderTimelineStatus(ctx);
    const toggle = $('language-toggle');
    if (toggle) {
      setText(toggle, language.language === 'en' ? 'EN' : '中');
      const nextTitle = t('switchLanguage') + (ctx.preferences.error ? ` · ${t('languageSaveFailed')}` : '');
      if (toggle.title !== nextTitle) toggle.title = nextTitle;
      setAttr(toggle, 'data-save-failed', String(ctx.preferences.error));
    }
  };

  const connectPreferences = () =>
    language.connectPreferences({
      read: () => preferenceRequest(),
      write: preferenceRequest,
      cache: (value) => ctx.localSet('ag-pulse-language', value),
      changed: () => {
        localize();
        if (!state.syncingFromRefresh) {
          handlers.render();
          handlers.updateCountdowns();
        }
      },
    });

  const refreshBusy = (busy: boolean): void => {
    const button = $('refresh-button');
    if (!button) return;
    setAttr(button, 'aria-busy', String(busy));
    setAttr(button, 'aria-disabled', String(busy));
    button.dataset.i18nAria = busy ? 'refreshing' : 'refreshStats';
    button.title = t(button.dataset.i18nAria);
    setAttr(button, 'aria-label', button.title);
  };

  const refresh = (force = false): Promise<void> => {
    if (state.pending && state.refreshRequest) return state.refreshRequest;
    state.pending = true;
    const reqTimelineEpoch = state.timelineEpoch;
    state.refreshRequest = (async () => {
      try {
        const params = new URLSearchParams();
        if (host?.conversationId) params.set('conversationId', host.conversationId);
        if (force) params.set('force', '1');
        const transport = host?.fetch ? host.fetch.bind(host) : fetch;
        const response = await transport(`/api/metrics?${params}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(t('panelUnavailable'));
        const value = (await response.json()) as PanelMetricsSnapshot;
        if (!['live', 'stale', 'offline'].includes(value.connection)) throw new Error(t('invalidData'));
        state.snapshot = value;
        if (Object.hasOwn(value, 'theme')) {
          const themeKey = JSON.stringify(value.theme ?? null);
          if (themeKey !== state.lastThemeKey) {
            state.lastThemeKey = themeKey;
            ctx.themeController.setHostTheme(value.theme ?? null);
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
          } finally {
            state.syncingFromRefresh = false;
          }
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
      } catch (error) {
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
        state.pending = false;
        state.refreshRequest = null;
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => void refresh(), document.hidden ? 10000 : 2200);
      }
    })();
    return state.refreshRequest;
  };

  const refreshManually = (): void => {
    if (state.manualRequest) return;
    refreshBusy(true);
    const started = performance.now();
    state.manualRequest = (async () => {
      try {
        if (state.pending && state.refreshRequest) await state.refreshRequest;
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
        updated && 'modelTimelineEnabled' in updated ? updated.modelTimelineEnabled : next;
      state.timelineEnabled = Boolean(updatedEnabled);
      if (state.snapshot?.preferences && 'modelTimelineEnabled' in state.snapshot.preferences) {
        state.snapshot.preferences.modelTimelineEnabled = state.timelineEnabled;
      }
      if (!state.timelineEnabled) state.timelineToggled.clear();
      state.lastTimelineSig = null;
      state.timelineBusy = false;
      renderTimeline(ctx, state.snapshot?.speed);
      if (state.pending && state.refreshRequest) await state.refreshRequest;
      await refresh(true);
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
      if (state.pending && state.refreshRequest) await state.refreshRequest;
      await refresh(true);
    } catch {
      state.timelineBusy = false;
      state.timelineNoticeKey = 'timelineClearFailed';
      state.timelineNoticeIsError = true;
      renderTimeline(ctx, state.snapshot?.speed);
    }
  };

  return {
    localize,
    connectPreferences,
    refresh,
    refreshManually,
    setTimelineEnabled,
    clearTimelineData,
  };
}
