import type { PreferencesSnapshot, QuotaCycleWindow } from '../../contracts/index.ts';
import { resolveFontScale, sanitizePricingOverrides } from '../../contracts/preferences.ts';
import { createFontPopover } from '../shared/font-popover.ts';
import type { UsageDayIndex } from './aggregator.ts';
import { addDays, shiftMonth } from './aggregator.ts';
import { renderOnboardingGuide, resolveUsageBridge } from './dom-shell.ts';
import type { HeatmapController } from './heatmap.ts';
import { renderHourlySpline } from './hourly-spline.ts';
import type { UsagePalette } from './palette.ts';
import { createPopoverListbox } from './picker.ts';
import type { StackedBarController } from './stacked-bar.ts';
import type { TooltipController } from './tooltip.ts';
import type {
  ModelViewMode,
  UsageDashboardOptions,
  UsageDimension,
  UsageDomContext,
  UsageHeatMode,
  UsagePeriod,
  UsageTab,
  UsageWindow,
} from './types.ts';

export interface UsageEventsCleanup {
  dismissGuide: () => void;
  syncPickers: () => void;
  syncPreferences: (prefs?: Partial<PreferencesSnapshot> | null) => void;
  closeSubPopovers: () => boolean;
  loadPreferencesIfNeeded: () => void;
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
  const { $, view, page, dialog, state, text, zh, w } = ctx;
  const { palette, dayIndex, tooltip, heatmap, chart, render } = deps;

  const applyUsageFontScale = (scale: unknown): void => {
    const resolved = String(resolveFontScale(scale));
    dialog.style.setProperty('--pulse-usage-font-scale', resolved);
    page.style.setProperty('--pulse-usage-font-scale', resolved);
  };
  const initScale =
    options.initialPreferences &&
    !('error' in options.initialPreferences) &&
    'usageFontScale' in options.initialPreferences
      ? options.initialPreferences.usageFontScale
      : undefined;
  applyUsageFontScale(initScale);

  const fontTrigger = $<HTMLButtonElement>('font-settings');
  const fontPopover = fontTrigger
    ? createFontPopover({
        trigger: fontTrigger,
        mountRoot: view,
        getLanguage: () => options.language.language,
        initial: options.initialPreferences ?? null,
        onChange: async (update, next) => {
          applyUsageFontScale(next.usageFontScale);
          const bridge = resolveUsageBridge(options);
          try {
            if (typeof bridge?.setPreferences === 'function') {
              const saved = await bridge.setPreferences(update);
              if (saved && typeof saved === 'object' && !('error' in saved)) {
                fontPopover?.sync(saved);
                applyUsageFontScale(saved.usageFontScale);
                options.onPreferencesSaved?.(saved);
              }
            }
          } catch {
            // Keep optimistic preview if persistence fails.
          }
        },
      })
    : null;

  const applyPricingOverrides = (raw: unknown): boolean => {
    const next = sanitizePricingOverrides(raw);
    const prevJson = JSON.stringify(state.pricingOverrides);
    const nextJson = JSON.stringify(next);
    if (prevJson === nextJson) return false;
    state.pricingOverrides = next;
    return true;
  };
  const initPricing =
    options.initialPreferences &&
    !('error' in options.initialPreferences) &&
    'modelPricingOverrides' in options.initialPreferences
      ? options.initialPreferences.modelPricingOverrides
      : undefined;
  if (initPricing !== undefined) {
    state.pricingOverrides = sanitizePricingOverrides(initPricing);
  }

  let prefsLoaded = Boolean(options.initialPreferences && !('error' in options.initialPreferences));
  const loadPreferencesIfNeeded = (): void => {
    fontPopover?.localize();
    if (prefsLoaded) return;
    prefsLoaded = true;
    const bridge = resolveUsageBridge(options);
    if (typeof bridge?.getPreferences !== 'function') return;
    void bridge
      .getPreferences()
      .then((prefs) => {
        if (state.disposed || !prefs || typeof prefs !== 'object' || 'error' in prefs) return;
        fontPopover?.sync(prefs);
        applyUsageFontScale(prefs.usageFontScale);
        const pricingChanged = applyPricingOverrides(prefs.modelPricingOverrides);
        options.onPreferencesSaved?.(prefs);
        if (pricingChanged && state.value && dialog.open) render();
      })
      .catch(() => {
        prefsLoaded = false;
      });
  };

  const dimTrigger = $<HTMLButtonElement>('dim-trigger');
  const dimMenu = $('dim-menu');
  const dimLabel = $('dim-label');
  const dimPicker =
    dimTrigger && dimMenu && dimLabel
      ? createPopoverListbox({
          trigger: dimTrigger,
          menu: dimMenu,
          labelEl: dimLabel,
          dialog,
          view,
          setMarkup: options.setMarkup,
          getSelected: () => state.dimension,
          onSelect: (val) => {
            state.dimension = (val as UsageDimension) || 'model';
            state.selectedBar = null;
            chart.renderChart();
          },
        })
      : null;

  const mvTrigger = $<HTMLButtonElement>('model-view-trigger');
  const mvMenu = $('model-view-menu');
  const mvLabel = $('model-view-label');
  const modelViewPicker =
    mvTrigger && mvMenu && mvLabel
      ? createPopoverListbox({
          trigger: mvTrigger,
          menu: mvMenu,
          labelEl: mvLabel,
          dialog,
          view,
          setMarkup: options.setMarkup,
          getSelected: () => state.modelViewMode,
          onSelect: (val) => {
            state.modelViewMode = (val as ModelViewMode) || 'simple';
            state.disabledModels.clear();
            chart.renderChart();
          },
        })
      : null;

  const cgTrigger = $<HTMLButtonElement>('cycle-group-trigger');
  const cgMenu = $('cycle-group-menu');
  const cgLabel = $('cycle-group-label');
  const cycleGroupPicker =
    cgTrigger && cgMenu && cgLabel
      ? createPopoverListbox({
          trigger: cgTrigger,
          menu: cgMenu,
          labelEl: cgLabel,
          dialog,
          view,
          setMarkup: options.setMarkup,
          getSelected: () => state.cycleGroupId || state.cycleData?.selectedGroupId || '',
          placeholder: () => w('选择额度池', 'Quota pool'),
          onSelect: (val) => {
            state.cycleGroupId = val || null;
            state.cycleOffset = 0;
            state.selectedBar = null;
            state.disabledModels.clear();
            chart.renderChart();
          },
        })
      : null;

  const syncPickers = (): void => {
    dimPicker?.setOptions(
      [
        { value: 'model', label: w('按模型统计', 'By Model') },
        { value: 'user', label: w('按用户统计', 'By User') },
        { value: 'project', label: w('项目统计', 'Project Stats') },
      ],
      w('统计维度', 'Dimension'),
    );
    modelViewPicker?.setOptions(
      [
        { value: 'simple', label: w('简易', 'Simple') },
        { value: 'detailed', label: w('详细', 'Detailed') },
      ],
      w('视图模式', 'View mode'),
    );
    const cycleGroups = state.cycleData?.groups || [];
    cycleGroupPicker?.setOptions(
      cycleGroups.map((g) => {
        const rem = state.cycleWindow === '5h' ? g.fiveHourRemaining : g.weeklyRemaining;
        const resetAt = state.cycleWindow === '5h' ? g.fiveHourResetAt : g.weeklyResetAt;
        const hint =
          typeof rem === 'number' && Number.isFinite(rem)
            ? rem >= 0.9995 && !resetAt
              ? w('满额空闲', 'Idle 100%')
              : w(`剩 ${Math.round(rem * 100)}%`, `${Math.round(rem * 100)}% left`)
            : undefined;
        return { value: g.id, label: g.name || g.id, hint };
      }),
      w('额度池', 'Quota pool'),
    );
    if (cgTrigger) cgTrigger.disabled = cycleGroups.length <= 1;
    fontPopover?.localize();
  };

  const closeSubPopovers = (): boolean => {
    let closed = false;
    if (dimPicker?.isOpen()) {
      dimPicker.close();
      closed = true;
    }
    if (modelViewPicker?.isOpen()) {
      modelViewPicker.close();
      closed = true;
    }
    if (cycleGroupPicker?.isOpen()) {
      cycleGroupPicker.close();
      closed = true;
    }
    if (fontPopover?.element.matches(':popover-open')) {
      fontPopover.close();
      closed = true;
    }
    return closed;
  };

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
  for (const b of view.querySelectorAll<HTMLElement>('[data-cycle-window]')) {
    b.addEventListener('click', () => {
      const next: QuotaCycleWindow = b.dataset.cycleWindow === '5h' ? '5h' : 'weekly';
      if (state.cycleWindow === next) return;
      state.cycleWindow = next;
      state.cycleOffset = 0;
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
      if (state.period === 'cycle') {
        const nextOffset = Math.min(0, state.cycleOffset + step);
        if (nextOffset === state.cycleOffset) return;
        state.cycleOffset = nextOffset;
        state.selectedBar = null;
        chart.renderChart();
        return;
      }
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
      state.projectOverviewKey = '';
      state.projectDetailKey = '';
      state.cycleDataKey = '';
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
    syncPickers,
    syncPreferences: (prefs) => {
      if (!prefs || 'error' in prefs) return;
      prefsLoaded = true;
      fontPopover?.sync(prefs);
      if ('usageFontScale' in prefs) applyUsageFontScale(prefs.usageFontScale);
      if (
        ('modelPricingOverrides' in prefs || 'revision' in prefs) &&
        applyPricingOverrides(prefs.modelPricingOverrides)
      ) {
        if (state.value && dialog.open) render();
      }
    },
    closeSubPopovers,
    loadPreferencesIfNeeded,
    dispose() {
      if (refreshDelay) clearTimeout(refreshDelay);
      finishRefresh?.();
      refreshMotion?.cancel();
      dimPicker?.dispose();
      modelViewPicker?.dispose();
      cycleGroupPicker?.dispose();
      fontPopover?.dispose();
    },
  };
}
