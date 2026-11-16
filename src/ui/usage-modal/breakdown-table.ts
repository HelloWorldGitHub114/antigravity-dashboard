import type { AggregationQuery, UsageDayIndex } from './aggregator.ts';
import { createDomNode } from './dom-shell.ts';
import { formatModelName, variantLabel, type UsagePalette } from './palette.ts';
import type { UsageDomContext } from './types.ts';

export function renderChartSummaryAndTable(
  ctx: UsageDomContext,
  dayIndex: UsageDayIndex,
  palette: UsagePalette,
  chartSummary: HTMLElement,
  getQuery: () => AggregationQuery,
): void {
  const { $, view, state, w, full, compactNum } = ctx;
  if (!state.value || !state.currentBuckets.length) return;

  const resetBtn = $('reset-drilldown');
  if (resetBtn) {
    resetBtn.hidden = !state.selectedBar;
    resetBtn.textContent = w('显示全部时段', 'Show all');
  }

  const query = getQuery();
  const activeTotals = state.selectedBar
    ? dayIndex.totals(state.selectedBar.from, state.selectedBar.to, query, true)
    : dayIndex.totals(state.currentBuckets[0].from, state.currentBuckets.at(-1)!.to, query, true);
  const rangeLabelStr = state.selectedBar
    ? state.selectedBar.from === state.selectedBar.to
      ? state.selectedBar.from
      : `${state.selectedBar.from} – ${state.selectedBar.to}`
    : '';

  chartSummary.replaceChildren(
    createDomNode('strong', '', `${compactNum(activeTotals.total)} Token`),
    document.createTextNode(
      ` · ${w(`${full(activeTotals.requests)} 次请求`, `${full(activeTotals.requests)} requests`)}${rangeLabelStr ? ` · ${rangeLabelStr}` : ''}`,
    ),
  );

  const focusedGroup =
    (view.activeElement as Element | null)?.closest?.<HTMLElement>('tr.model-group-row')?.dataset.modelGroup || null;
  const bodyFrag = document.createDocumentFragment();
  const tableHead = $('table-head');
  const tableBody = $('table-body');
  if (!tableHead || !tableBody) return;

  if (state.dimension === 'user') {
    tableHead.replaceChildren(
      ...[
        w('用户 / 账号', 'User / Account'),
        w('总 Token', 'Total tokens'),
        w('占比', 'Share'),
        w('未缓存输入', 'Uncached input'),
        w('缓存读取', 'Cache read'),
        w('输出', 'Output'),
        w('请求次数', 'Requests'),
      ].map((label) => createDomNode('th', '', label)),
    );
    for (const [u, r] of Object.entries(activeTotals.users).sort((a, b) => b[1].total - a[1].total)) {
      const row = createDomNode('tr');
      const label = createDomNode('td');
      const dot = createDomNode('span', 'dot');
      dot.style.setProperty('--model-color', palette.userColor(u));
      if (u === 'legacy') dot.classList.add('legacy');
      label.append(dot, document.createTextNode(palette.userDisplayName(u, state.value, w)));
      const share = activeTotals.total ? `${((r.total / activeTotals.total) * 100).toFixed(1)}%` : '0%';
      row.append(
        label,
        createDomNode('td', '', full(r.total)),
        createDomNode('td', '', share),
        createDomNode('td', '', full(r.uncached)),
        createDomNode('td', '', full(r.cacheRead)),
        createDomNode('td', '', full(r.output)),
        createDomNode('td', '', full(r.requests)),
      );
      bodyFrag.append(row);
    }
  } else if (state.modelViewMode === 'detailed') {
    tableHead.replaceChildren(
      ...[
        w('模型', 'Model'),
        w('总 Token', 'Total tokens'),
        w('未缓存输入', 'Uncached input'),
        w('缓存读取', 'Cache read'),
        w('缓存写入', 'Cache write'),
        w('输出', 'Output'),
      ].map((label) => createDomNode('th', '', label)),
    );
    for (const [model, r] of Object.entries(activeTotals.models).sort((a, b) => b[1].total - a[1].total)) {
      const row = createDomNode('tr');
      const label = createDomNode('td');
      const dot = createDomNode('span', 'dot');
      dot.style.setProperty('--model-color', palette.modelColor(model, state.modelViewMode));
      label.append(dot, document.createTextNode(formatModelName(model)));
      row.append(
        label,
        ...[r.total, r.uncached, r.cacheRead, r.cacheWrite, r.output].map((n) => createDomNode('td', '', full(n))),
      );
      bodyFrag.append(row);
    }
  } else {
    tableHead.replaceChildren(
      ...[
        w('模型', 'Model'),
        w('总 Token', 'Total tokens'),
        w('未缓存输入', 'Uncached input'),
        w('缓存读取', 'Cache read'),
        w('缓存写入', 'Cache write'),
        w('输出', 'Output'),
      ].map((label) => createDomNode('th', '', label)),
    );
    for (const [groupKey, r] of Object.entries(activeTotals.models).sort((a, b) => b[1].total - a[1].total)) {
      const variants = Object.entries(activeTotals.modelVariants?.[groupKey] || {}).sort(
        (a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]),
      );
      const isExpanded = state.expandedModelGroups.has(groupKey);
      const row = createDomNode('tr', 'model-group-row');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-expanded', String(isExpanded));
      row.dataset.modelGroup = groupKey;
      const toggle = () => {
        if (state.expandedModelGroups.has(groupKey)) state.expandedModelGroups.delete(groupKey);
        else state.expandedModelGroups.add(groupKey);
        renderChartSummaryAndTable(ctx, dayIndex, palette, chartSummary, getQuery);
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle();
        }
      });
      const label = createDomNode('td');
      const dot = createDomNode('span', 'dot');
      dot.style.setProperty('--model-color', palette.modelColor(groupKey, state.modelViewMode));
      const countText = w(
        `${variants.length} 个后缀`,
        `${variants.length} ${variants.length === 1 ? 'variant' : 'variants'}`,
      );
      const chevron = createDomNode('span', 'model-group-chevron', isExpanded ? '▾' : '▸');
      chevron.setAttribute('aria-hidden', 'true');
      label.append(
        dot,
        createDomNode('span', 'model-group-name', groupKey),
        createDomNode('span', 'model-variant-count', countText),
        chevron,
      );
      row.append(
        label,
        ...[r.total, r.uncached, r.cacheRead, r.cacheWrite, r.output].map((n) => createDomNode('td', '', full(n))),
      );
      bodyFrag.append(row);

      if (isExpanded) {
        for (const [rawModel, vr] of variants) {
          const vRow = createDomNode('tr', 'model-variant-row');
          const vLabel = createDomNode('td');
          const branch = createDomNode('span', 'variant-branch', '└');
          branch.setAttribute('aria-hidden', 'true');
          const share = r.total ? `${((vr.total / r.total) * 100).toFixed(1)}%` : '0%';
          vLabel.append(
            branch,
            createDomNode('span', 'variant-name', variantLabel(rawModel, groupKey)),
            createDomNode('span', 'variant-share', share),
          );
          vRow.append(
            vLabel,
            ...[vr.total, vr.uncached, vr.cacheRead, vr.cacheWrite, vr.output].map((n) => createDomNode('td', '', full(n))),
          );
          bodyFrag.append(vRow);
        }
      }
    }
  }

  tableBody.replaceChildren(bodyFrag);
  if (focusedGroup) {
    for (const tr of tableBody.querySelectorAll<HTMLElement>('tr.model-group-row')) {
      if (tr.dataset.modelGroup === focusedGroup) {
        tr.focus({ preventScroll: true });
        break;
      }
    }
  }
}
