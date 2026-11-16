// Shared local usage views. Values and model labels are inserted as text.
import type { UsageSummarySnapshot } from '../../contracts/index.ts';
import { bindAccountSwitcher, syncAccountSwitcher } from './account-switcher.ts';
import { UsageDayIndex, type AggregationQuery } from './aggregator.ts';
import { mountUsageDomShell, renderKpiCards, renderOnboardingGuide } from './dom-shell.ts';
import { bindUsageModalEvents } from './events.ts';
import { createFocusTrap } from './focus-trap.ts';
import { createHeatmapController } from './heatmap.ts';
import { renderHeaderAndLabels, renderWaitingState } from './localize-modal.ts';
import { bindManualModal, renderManualEntries } from './manual-modal.ts';
import { UsagePalette } from './palette.ts';
import { createStackedBarController } from './stacked-bar.ts';
import { createTooltipController } from './tooltip.ts';
import type {
  UsageDashboardHandle,
  UsageDashboardOptions,
  UsageModalState,
  UsageWindow,
} from './types.ts';

export type { UsageDashboardHandle, UsageDashboardOptions } from './types.ts';

export default function createUsageDashboard(options: UsageDashboardOptions): UsageDashboardHandle {
  const hostLabel = options.hostLabel ?? 'Antigravity';
  const state: UsageModalState = {
    value: null,
    tab: 'overview',
    heatMode: 'day',
    period: 'day',
    year: null,
    anchor: null,
    selected: null,
    disabledModels: new Set(),
    disabledUsers: new Set(),
    dimension: 'model',
    modelViewMode: 'simple',
    expandedModelGroups: new Set(),
    hourlyMode: 'combined',
    lastKey: '',
    busy: false,
    opener: null,
    showAllModels: false,
    selectedBar: null,
    hourlyExpanded: false,
    customStart: '',
    customEnd: '',
    disposed: false,
    accountKey: null,
    currentBuckets: [],
    guideDismissed: Boolean(options.guideDismissed),
    guideSaving: false,
    guideError: false,
    guideSignature: null,
    lastManualSig: '',
    lastAccQueryKey: '',
  };

  const { dialog, backdrop, context: ctx } = mountUsageDomShell(options, state);
  const { $ } = ctx;
  const palette = new UsagePalette(() => dialog);
  const dayIndex = new UsageDayIndex();
  const getQuery = (): AggregationQuery => ({
    dimension: state.dimension,
    modelViewMode: state.modelViewMode,
    disabledModels: state.disabledModels,
    disabledUsers: state.disabledUsers,
  });

  const tooltip = createTooltipController(ctx, palette);
  const heatmap = createHeatmapController(ctx, dayIndex, tooltip, getQuery);
  const chart = createStackedBarController(ctx, dayIndex, palette, tooltip, getQuery);
  const manual = bindManualModal(ctx);
  bindAccountSwitcher(ctx);
  const focusTrap = createFocusTrap(ctx, {
    onCloseYear: (restore) => heatmap.closeYear(restore),
    onIsYearOpen: () => heatmap.isYearOpen(),
    onCloseManualModal: (restore) => manual.closeManualModal(restore),
  });

  const render = (): void => {
    renderOnboardingGuide(ctx, palette);
    const value = state.value;
    if (!value) {
      heatmap.closeYear(false);
      tooltip.hide();
      renderWaitingState(ctx);
      return;
    }

    const waitEl = $('usage-waiting');
    if (waitEl) waitEl.hidden = true;
    palette.sync(value, state.modelViewMode, options.root.host);

    renderHeaderAndLabels(ctx, hostLabel);
    renderKpiCards(ctx, value);
    void syncAccountSwitcher(ctx);
    renderManualEntries(ctx);

    if (state.tab === 'overview') heatmap.renderHeat();
    else chart.renderChart();
  };

  const events = bindUsageModalEvents(ctx, options, {
    palette,
    dayIndex,
    tooltip,
    heatmap,
    chart,
    render,
  });

  const contentKey = (data: UsageSummarySnapshot): string =>
    JSON.stringify([{ ...data, updatedAt: undefined }, options.language.language, palette.themeSignature(options.root.host)]);

  const themeObserver = new MutationObserver(() => {
    if (!state.disposed && state.value && dialog.open) {
      const key = contentKey(state.value);
      if (key !== state.lastKey) {
        state.lastKey = key;
        render();
      }
    }
  });
  if (options.root.host) {
    themeObserver.observe(options.root.host, { attributes: true, attributeFilter: ['data-pulse-theme', 'style'] });
  }

  return {
    open(data, trigger) {
      if (!data || state.disposed) return;
      state.accountKey = data.accountKey;
      state.value = data;
      state.opener = (trigger as HTMLElement | null) ?? null;
      state.year ||= data.today.slice(0, 4);
      state.anchor ||= data.today;
      state.lastKey = contentKey(data);
      dayIndex.rebuild(data);
      render();
      focusTrap.present();
    },
    update(data) {
      if (state.disposed) return;
      if (!data) {
        if (!state.value) return;
        state.value = null;
        state.lastKey = '';
        dayIndex.rebuild(null);
        if (dialog.open) render();
        return;
      }
      if (state.accountKey && state.accountKey !== data.accountKey) {
        state.selected = null;
        state.selectedBar = null;
        state.disabledModels.clear();
        state.disabledUsers.clear();
        state.expandedModelGroups.clear();
        state.lastAccQueryKey = '';
        state.year = data.today.slice(0, 4);
        state.anchor = data.today;
      }
      state.accountKey = data.accountKey;
      state.value = data;
      if (!dialog.open) return;
      const key = contentKey(data);
      if (key === state.lastKey) return;
      state.lastKey = key;
      dayIndex.rebuild(data);
      render();
    },
    restoreModal() {
      if (!state.disposed && dialog.open && dialog.isConnected && !dialog.matches(':popover-open')) {
        heatmap.closeYear(false);
        focusTrap.present();
      }
    },
    close: focusTrap.close,
    syncGuideDismissed() {
      if ((window as UsageWindow).__agPulseUsageGuidePreview !== true) events.dismissGuide();
    },
    dispose() {
      state.disposed = true;
      themeObserver.disconnect();
      events.dispose();
      heatmap.dispose();
      focusTrap.dispose();
      dialog.remove();
      backdrop.remove();
    },
    get isOpen() {
      return dialog.open;
    },
  };
}
