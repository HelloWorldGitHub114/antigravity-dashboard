import type { UsageDayIndex } from './aggregator.ts';
import { addDays, shiftMonth } from './aggregator.ts';
import { renderOnboardingGuide } from './dom-shell.ts';
import type { HeatmapController } from './heatmap.ts';
import { renderHourlySpline } from './hourly-spline.ts';
import type { UsagePalette } from './palette.ts';
import type { StackedBarController } from './stacked-bar.ts';
import type { TooltipController } from './tooltip.ts';
import type {
  UsageDashboardOptions,
  UsageDomContext,
  UsageHeatMode,
  UsagePeriod,
  UsageTab,
} from './types.ts';

export interface UsageEventsCleanup {
  dismissGuide: () => void;
  dispose: () => void;
}

export function bindUsageModalEvents(
  ctx: UsageDomContext,
  options: UsageDashboardOptions,
  deps: {
    palette: UsagePalette;
    dayIndex: UsageDayIndex;
    tooltip: TooltipController;
    heatmap: HeatmapController;
    chart: StackedBarController;
    render: () => void;
  },
): UsageEventsCleanup {
  const { $, view, dialog, state, text, zh, w } = ctx;
  const { palette, dayIndex, tooltip, heatmap, chart, render } = deps;

  const dismissGuide = (): void => {
    if (state.disposed) return;
    const focused = view.activeElement === $('usage-intro-done');
    state.guideDismissed = true;
    renderOnboardingGuide(ctx, palette);
    if (focused && dialog.open) $('overview-tab')?.focus({ preventScroll: true });
  };

  $('usage-intro-done')?.addEventListener('click', async () => {
    if (state.guideSaving || state.disposed) return;
    state.guideSaving = true;
    state.guideError = false;
    renderOnboardingGuide(ctx, palette);
    try {
      await options.onDismissGuide();
      dismissGuide();
    } catch {
      if (!state.disposed) state.guideError = true;
    } finally {
      state.guideSaving = false;
      if (!state.disposed) renderOnboardingGuide(ctx, palette);
    }
  });

  const changeTab = (next: UsageTab): void => {
    heatmap.closeYear(false);
    state.tab = next;
    state.selectedBar = null;
    tooltip.hide();
    render();
  };
  $('overview-tab')?.addEventListener('click', () => changeTab('overview'));
  $('details-tab')?.addEventListener('click', () => changeTab('details'));

  for (const b of view.querySelectorAll<HTMLElement>('[data-heat]')) {
    b.addEventListener('click', () => {
      state.heatMode = (b.dataset.heat as UsageHeatMode) || 'day';
      heatmap.renderHeat();
    });
  }
  for (const b of view.querySelectorAll<HTMLElement>('[data-period]')) {
    b.addEventListener('click', () => {
      state.period = (b.dataset.period as UsagePeriod) || 'day';
      state.selectedBar = null;
      chart.renderChart();
    });
  }

  const handleCustomChange = (): void => {
    const s = $<HTMLInputElement>('custom-start')?.value || '';
    const e = $<HTMLInputElement>('custom-end')?.value || '';
    if (s && e && s <= e) {
      state.customStart = s;
      state.customEnd = e;
      state.selectedBar = null;
      chart.renderChart();
    }
  };
  $('custom-start')?.addEventListener('change', handleCustomChange);
  $('custom-end')?.addEventListener('change', handleCustomChange);

  $('dim-model')?.addEventListener('click', () => { state.dimension = 'model'; chart.renderChart(); });
  $('dim-user')?.addEventListener('click', () => { state.dimension = 'user'; chart.renderChart(); });
  $('model-view-simple')?.addEventListener('click', () => {
    state.modelViewMode = 'simple';
    state.disabledModels.clear();
    chart.renderChart();
  });
  $('model-view-detailed')?.addEventListener('click', () => {
    state.modelViewMode = 'detailed';
    state.disabledModels.clear();
    chart.renderChart();
  });
  $('hourly-mode-combined')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.hourlyMode = 'combined';
    state.hourlyExpanded = true;
    renderHourlySpline(ctx, dayIndex, tooltip);
  });
  $('hourly-mode-today')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.hourlyMode = 'today';
    state.hourlyExpanded = true;
    renderHourlySpline(ctx, dayIndex, tooltip);
  });
  $('hourly-toggle')?.addEventListener('click', () => {
    state.hourlyExpanded = !state.hourlyExpanded;
    renderHourlySpline(ctx, dayIndex, tooltip);
  });

  $('selection-details')?.addEventListener('click', () => {
    if (!state.value) return;
    state.anchor = state.selected?.from || state.value.today;
    state.period = state.heatMode;
    changeTab('details');
  });
  for (const [id, step] of [['previous', -1], ['next', 1]] as const) {
    $(id)?.addEventListener('click', () => {
      if (!state.anchor) return;
      state.selectedBar = null;
      state.anchor =
        state.period === 'day'
          ? shiftMonth(state.anchor, step)
          : state.period === 'week'
            ? addDays(state.anchor, step * 84)
            : shiftMonth(state.anchor, step * 12);
      chart.renderChart();
    });
  }
  $('locale')?.addEventListener('click', () => void options.onLanguage(zh() ? 'en' : 'zh-CN'));

  let refreshMotion: Animation | null = null;
  let refreshDelay: ReturnType<typeof setTimeout> | null = null;
  let finishRefresh: (() => void) | null = null;
  $('refresh')?.addEventListener('click', async () => {
    if (state.busy || state.disposed) return;
    const button = $<HTMLButtonElement>('refresh');
    if (!button) return;
    state.busy = true;
    const turn = 600;
    const started = performance.now();
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    refreshMotion = button.querySelector('svg')?.animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
      { duration: turn, iterations: Infinity },
    ) ?? null;
    try {
      await options.onRefresh();
    } catch {
      if (!state.disposed) {
        text('alert', w('暂时无法刷新，请稍后重试', 'Refresh unavailable. Try again shortly.'));
        const alertEl = $('alert');
        if (alertEl) alertEl.hidden = false;
      }
    } finally {
      if (!state.disposed) {
        const elapsed = performance.now() - started;
        const remaining = Math.max(turn, Math.ceil(elapsed / turn) * turn) - elapsed;
        await new Promise<void>((resolve) => {
          finishRefresh = resolve;
          refreshDelay = setTimeout(resolve, Math.max(0, remaining));
        });
      }
      if (refreshDelay) clearTimeout(refreshDelay);
      refreshDelay = null;
      finishRefresh = null;
      refreshMotion?.cancel();
      refreshMotion = null;
      state.busy = false;
      if (!state.disposed) {
        button.disabled = false;
        button.setAttribute('aria-busy', 'false');
      }
    }
  });

  return {
    dismissGuide,
    dispose() {
      if (refreshDelay) clearTimeout(refreshDelay);
      finishRefresh?.();
      refreshMotion?.cancel();
    },
  };
}
