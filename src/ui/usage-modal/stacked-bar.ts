import { addDays, startOfWeek, type AggregationQuery, type UsageDayIndex } from './aggregator.ts';
import { renderChartSummaryAndTable } from './breakdown-table.ts';
import { createDomNode } from './dom-shell.ts';
import { renderHourlySpline } from './hourly-spline.ts';
import { effectiveModelKey, modelLabel, type UsagePalette } from './palette.ts';
import type { TooltipController } from './tooltip.ts';
import type { UsageDomContext, UsageTotalsResult } from './types.ts';

export interface StackedBarController {
  renderChart(): void;
  updateDrilldownView(): void;
}

export function createStackedBarController(
  ctx: UsageDomContext,
  dayIndex: UsageDayIndex,
  palette: UsagePalette,
  tooltip: TooltipController,
  getQuery: () => AggregationQuery,
): StackedBarController {
  const { $, view, state, root, text, w, compactNum } = ctx;

  const chartSummary = createDomNode('div', 'chart-summary');
  const resetDrilldown = createDomNode('button', 'reset-drilldown', w('显示全部时段', 'Show all'));
  resetDrilldown.id = 'reset-drilldown';
  resetDrilldown.hidden = true;
  const chartHeading = createDomNode('div');
  const detailTitle = $('detail-title');
  if (detailTitle) {
    detailTitle.after(chartSummary);
    detailTitle.before(chartHeading);
    chartHeading.append(detailTitle, chartSummary, resetDrilldown);
  }

  const updateDrilldownView = (): void => {
    for (const col of $('plot')?.querySelectorAll<HTMLElement>('.bar-column') || []) {
      const active = Boolean(
        state.selectedBar && col.dataset.from === state.selectedBar.from && col.dataset.to === state.selectedBar.to,
      );
      col.classList.toggle('selected', active);
      col.setAttribute('aria-pressed', String(active));
    }
    renderChartSummaryAndTable(ctx, dayIndex, palette, chartSummary, getQuery);
    renderHourlySpline(ctx, dayIndex, tooltip);
  };

  resetDrilldown.addEventListener('click', () => {
    state.selectedBar = null;
    updateDrilldownView();
  });

  const renderChart = (): void => {
    if (!state.value || !state.anchor) return;
    palette.sync(state.value, state.modelViewMode, root.host);
    tooltip.hide();

    if (state.period === 'custom') {
      state.customStart ||= addDays(state.value.today, -14);
      state.customEnd ||= state.value.today;
    }
    const query = getQuery();
    const { buckets, rangeLabel } = dayIndex.buildPeriodBuckets(
      state.period,
      state.anchor,
      state.customStart,
      state.customEnd,
      query,
    );
    text('range-label', rangeLabel);
    state.currentBuckets = buckets;

    const plotEl = $('plot');
    const chartEl = view.querySelector<HTMLElement>('.chart');
    const wrapEl = view.querySelector<HTMLElement>('.chart-wrap');
    if (buckets.length > 31) {
      if (plotEl) plotEl.style.minWidth = `${buckets.length * 24}px`;
      if (chartEl) chartEl.style.minWidth = `${buckets.length * 24 + 60}px`;
      if (wrapEl) wrapEl.style.scrollBehavior = 'smooth';
    } else {
      if (plotEl) plotEl.style.minWidth = '';
      if (chartEl) chartEl.style.minWidth = '';
      if (wrapEl) wrapEl.style.scrollBehavior = '';
    }

    const customControls = $('custom-range-controls');
    if (customControls) customControls.hidden = state.period !== 'custom';
    const rangeEl = view.querySelector<HTMLElement>('.range');
    if (rangeEl) rangeEl.hidden = state.period === 'custom';

    const startInput = $<HTMLInputElement>('custom-start');
    const endInput = $<HTMLInputElement>('custom-end');
    if (startInput) {
      startInput.value = state.customStart;
      startInput.max = state.value.today;
    }
    if (endInput) {
      endInput.value = state.customEnd;
      endInput.max = state.value.today;
    }

    const prevBtn = $<HTMLButtonElement>('previous');
    const nextBtn = $<HTMLButtonElement>('next');
    if (prevBtn) prevBtn.disabled = state.period === 'custom';
    if (nextBtn) {
      nextBtn.disabled =
        state.period === 'custom'
          ? true
          : state.period === 'week'
            ? startOfWeek(state.anchor) >= startOfWeek(state.value.today)
            : state.anchor.slice(0, 7) >= state.value.today.slice(0, 7);
    }

    $('dim-model')?.setAttribute('aria-pressed', String(state.dimension === 'model'));
    $('dim-user')?.setAttribute('aria-pressed', String(state.dimension === 'user'));
    text('dim-model', w('按模型统计', 'By Model'));
    text('dim-user', w('按用户统计', 'By User'));
    const mvCtrl = $('model-view-controls');
    if (mvCtrl) mvCtrl.hidden = state.dimension !== 'model';
    $('model-view-simple')?.setAttribute('aria-pressed', String(state.modelViewMode === 'simple'));
    $('model-view-detailed')?.setAttribute('aria-pressed', String(state.modelViewMode === 'detailed'));
    text('model-view-simple', w('简易', 'Simple'));
    text('model-view-detailed', w('详细', 'Detailed'));
    text('detail-title', state.dimension === 'model' ? w('按模型统计', 'Usage by model') : w('按用户统计', 'Usage by user'));

    const allRangeTotals = dayIndex.totals(buckets[0].from, buckets.at(-1)!.to, query, false);
    const legendFrag = document.createDocumentFragment();
    const modelKeys =
      state.dimension === 'user'
        ? []
        : [...new Set([...(state.value.models || []).map((m) => effectiveModelKey(m, state.modelViewMode)), ...Object.keys(allRangeTotals.models)])];

    if (state.dimension === 'user') {
      const activeUserSet = new Set(Object.keys(allRangeTotals.users).filter((u) => allRangeTotals.users[u].total > 0));
      for (const u of (state.value.users || []).filter((user) => activeUserSet.has(user))) {
        const button = createDomNode('button');
        const dot = createDomNode('i', 'dot');
        dot.style.setProperty('--model-color', palette.userColor(u));
        if (u === 'legacy') dot.classList.add('legacy');
        button.append(dot, document.createTextNode(palette.userDisplayName(u, state.value, w)));
        button.type = 'button';
        button.setAttribute('aria-pressed', String(!state.disabledUsers.has(u)));
        button.addEventListener('click', () => {
          if (state.disabledUsers.has(u)) state.disabledUsers.delete(u);
          else state.disabledUsers.add(u);
          renderChart();
        });
        button.addEventListener('pointerenter', () => tooltip.highlightItem(state.disabledUsers.has(u) ? null : u));
        button.addEventListener('pointerleave', () => tooltip.highlightItem(null));
        legendFrag.append(button);
      }
    } else {
      const activeModelSet = new Set(Object.keys(allRangeTotals.models).filter((m) => allRangeTotals.models[m].total > 0));
      const inRangeModels = modelKeys.filter((m) => activeModelSet.has(m));
      const otherModels = modelKeys.filter((m) => !activeModelSet.has(m));
      const makeModelBtn = (model: string): HTMLButtonElement => {
        const button = createDomNode('button');
        const dot = createDomNode('i', 'dot');
        dot.style.setProperty('--model-color', palette.modelColor(model, state.modelViewMode));
        button.append(dot, document.createTextNode(modelLabel(model, state.modelViewMode)));
        button.type = 'button';
        button.setAttribute('aria-pressed', String(!state.disabledModels.has(model)));
        button.addEventListener('click', () => {
          if (state.disabledModels.has(model)) state.disabledModels.delete(model);
          else state.disabledModels.add(model);
          renderChart();
        });
        button.addEventListener('pointerenter', () => tooltip.highlightItem(state.disabledModels.has(model) ? null : model));
        button.addEventListener('pointerleave', () => tooltip.highlightItem(null));
        return button;
      };
      for (const model of inRangeModels) legendFrag.append(makeModelBtn(model));
      if (otherModels.length > 0) {
        const toggleBtn = createDomNode('button', 'toggle-all-models');
        toggleBtn.id = 'toggle-all-models';
        toggleBtn.type = 'button';
        const updateToggleLabel = (btn: HTMLButtonElement) => {
          btn.textContent = state.showAllModels
            ? w('收起历史模型 ▲', 'Collapse historical models ▲')
            : w(`更多历史模型 (${otherModels.length}) ▼`, `More historical models (${otherModels.length}) ▼`);
          btn.setAttribute('aria-expanded', String(state.showAllModels));
        };
        updateToggleLabel(toggleBtn);
        const otherContainer = createDomNode('div', 'other-models');
        otherContainer.hidden = !state.showAllModels;
        toggleBtn.addEventListener('click', () => {
          state.showAllModels = !state.showAllModels;
          updateToggleLabel(toggleBtn);
          otherContainer.hidden = !state.showAllModels;
        });
        for (const model of otherModels) otherContainer.append(makeModelBtn(model));
        legendFrag.append(toggleBtn, otherContainer);
      }
    }
    $('legend')?.replaceChildren(legendFrag);

    const max = Math.max(1, ...buckets.map((b) => b.total));
    const mag = 10 ** Math.floor(Math.log10(max));
    const ceiling = max > 1 ? Math.ceil(max / mag) * mag : 1;
    const axisFrag = document.createDocumentFragment();
    const plotFrag = document.createDocumentFragment();
    for (let i = 0; i <= 4; i++) {
      const bottom = `${19 + ((246 - 19) * i) / 4}px`;
      const label = createDomNode('span', '', compactNum((ceiling * i) / 4));
      label.style.bottom = bottom;
      axisFrag.append(label);
      const line = createDomNode('i', 'grid-line');
      line.style.bottom = bottom;
      plotFrag.append(line);
    }

    for (const [i, bucket] of buckets.entries()) {
      const button = createDomNode('button', 'bar-column');
      button.type = 'button';
      button.dataset.from = bucket.from;
      button.dataset.to = bucket.to;
      const isDrilled = Boolean(state.selectedBar && state.selectedBar.from === bucket.from && state.selectedBar.to === bucket.to);
      if (isDrilled) button.classList.add('selected');
      button.setAttribute('aria-pressed', String(isDrilled));
      const stack = createDomNode('div', 'stack');

      if (state.dimension === 'user') {
        const segments = (state.value.users || []).filter((u) => bucket.users[u]?.total > 0 && !state.disabledUsers.has(u));
        for (const [j, u] of segments.entries()) {
          const height = (bucket.users[u].total / ceiling) * 227;
          const bar = createDomNode('i', 'bar-segment');
          bar.dataset.user = u;
          bar.setAttribute('aria-hidden', 'true');
          bar.style.setProperty('--model-color', palette.userColor(u));
          if (u === 'legacy') bar.classList.add('legacy');
          bar.style.height = `${height}px`;
          if (j && height >= 3) bar.style.boxShadow = 'inset 0 -1px 0 color-mix(in srgb,var(--pulse-background) 48%,transparent)';
          stack.append(bar);
        }
      } else {
        const segments = modelKeys.filter((model) => bucket.models[model]?.total > 0 && !state.disabledModels.has(model));
        for (const [j, model] of segments.entries()) {
          const height = (bucket.models[model].total / ceiling) * 227;
          const bar = createDomNode('i', 'bar-segment');
          bar.dataset.model = model;
          bar.setAttribute('aria-hidden', 'true');
          bar.style.setProperty('--model-color', palette.modelColor(model, state.modelViewMode));
          bar.style.height = `${height}px`;
          if (j && height >= 3) bar.style.boxShadow = 'inset 0 -1px 0 color-mix(in srgb,var(--pulse-background) 48%,transparent)';
          stack.append(bar);
        }
      }

      if (!bucket.total) stack.append(createDomNode('i', 'empty-bar'));
      button.append(stack);

      const showX =
        state.period === 'day'
          ? i % 3 === 0 || i === buckets.length - 1
          : state.period === 'custom'
            ? buckets.length > 31
              ? i % Math.ceil(buckets.length / 15) === 0 || i === buckets.length - 1
              : true
            : true;
      if (showX) {
        const xTxt =
          state.period === 'day'
            ? String(i + 1)
            : state.period === 'week'
              ? bucket.from.slice(5)
              : state.period === 'month'
                ? bucket.from.slice(0, 7)
                : bucket.from.slice(5);
        button.append(createDomNode('span', 'x-label', xTxt));
      }

      tooltip.bindBucket(button, bucket, (picked: UsageTotalsResult) => {
        state.selected = picked;
        state.anchor = picked.from;
      });
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        state.selectedBar =
          state.selectedBar && state.selectedBar.from === bucket.from && state.selectedBar.to === bucket.to ? null : bucket;
        updateDrilldownView();
      });
      plotFrag.append(button);
    }

    if (!buckets.some((b) => b.total)) {
      plotFrag.append(createDomNode('div', 'chart-empty', w('所选时段暂无用量记录', 'No usage recorded in this period')));
    }
    $('axis')?.replaceChildren(axisFrag);
    plotEl?.replaceChildren(plotFrag);

    renderChartSummaryAndTable(ctx, dayIndex, palette, chartSummary, getQuery);
    for (const b of view.querySelectorAll<HTMLElement>('[data-period]')) {
      b.setAttribute('aria-pressed', String(b.dataset.period === state.period));
    }
    renderHourlySpline(ctx, dayIndex, tooltip);
  };

  return { renderChart, updateDrilldownView };
}
