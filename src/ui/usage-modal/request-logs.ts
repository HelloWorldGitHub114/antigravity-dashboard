import type {
  UsageRequestCacheFilter,
  UsageRequestLogItem,
  UsageRequestLogSnapshot,
} from '../../contracts/index.ts';
import {
  calculateBucketCost,
  formatRateSummary,
  formatUsd,
  resolveModelPricing,
} from '../../shared/model-pricing.ts';
import { addDays } from './aggregator.ts';
import { createDomNode, resolveUsageBridge } from './dom-shell.ts';
import { baseModelName, formatModelName, type UsagePalette } from './palette.ts';
import { createPopoverListbox, type PickerOption } from './picker.ts';
import {
  classifyCacheHitTone,
  formatHitPct,
  resolveLogsDateRange,
  summarizeRequestLogCost,
} from './request-logs-helpers.ts';
import type { UsageDashboardOptions, UsageDomContext, UsageLogsRange } from './types.ts';

export {
  classifyCacheHitTone,
  formatHitPct,
  resolveLogsDateRange,
  summarizeRequestLogCost,
  type CacheHitTone,
} from './request-logs-helpers.ts';

export interface RequestLogsController {
  render(): void;
  invalidate(): void;
  closeSubPopovers(): boolean;
  dispose(): void;
}

export function createRequestLogsController(
  ctx: UsageDomContext,
  palette: UsagePalette,
  options: UsageDashboardOptions,
): RequestLogsController {
  const { $, view, dialog, state, zh, w, full, compactNum } = ctx;
  let reqEpoch = 0;

  const modelTrigger = $<HTMLButtonElement>('logs-model-trigger');
  const modelMenu = $('logs-model-menu');
  const modelLabel = $('logs-model-label');
  const modelPicker =
    modelTrigger && modelMenu && modelLabel
      ? createPopoverListbox({
          trigger: modelTrigger,
          menu: modelMenu,
          labelEl: modelLabel,
          dialog,
          view,
          setMarkup: options.setMarkup,
          getSelected: () => state.logsModel,
          placeholder: () => w('全部模型', 'All models'),
          onSelect: (val) => {
            if (state.logsModel === val) return;
            state.logsModel = val;
            state.logsPage = 1;
            render();
          },
        })
      : null;

  const cacheTrigger = $<HTMLButtonElement>('logs-cache-trigger');
  const cacheMenu = $('logs-cache-menu');
  const cacheLabel = $('logs-cache-label');
  const cachePicker =
    cacheTrigger && cacheMenu && cacheLabel
      ? createPopoverListbox({
          trigger: cacheTrigger,
          menu: cacheMenu,
          labelEl: cacheLabel,
          dialog,
          view,
          setMarkup: options.setMarkup,
          getSelected: () => state.logsCacheFilter,
          placeholder: () => w('全部缓存', 'All cache'),
          onSelect: (val) => {
            const next: UsageRequestCacheFilter =
              val === 'hot' || val === 'warm' || val === 'miss' ? val : 'all';
            if (state.logsCacheFilter === next) return;
            state.logsCacheFilter = next;
            state.logsPage = 1;
            render();
          },
        })
      : null;

  const currentBounds = (): { from: string | null; to: string | null } => {
    const today = state.value?.today || '';
    return resolveLogsDateRange(state.logsRange, today, state.logsFrom, state.logsTo);
  };

  const buildReqKey = (scope: string | null, from: string | null, to: string | null): string =>
    [
      scope || '',
      from || '',
      to || '',
      state.logsModel,
      state.logsCacheFilter,
      state.logsPage,
      state.logsPageSize,
      state.value?.requests ?? 0,
      state.value?.totalTokens ?? 0,
    ].join('|');

  const ensureLogsData = async (): Promise<void> => {
    if (!state.value) return;
    const scope = state.value.viewScope || state.value.accountKey || state.value.activeAccount || null;
    const { from, to } = currentBounds();
    const reqKey = buildReqKey(scope, from, to);
    if (state.logsDataKey === reqKey) return;

    const bridge = resolveUsageBridge(options);
    if (typeof bridge?.getUsageRequestLogs !== 'function') {
      state.logsError = w('当前环境暂不支持请求日志查询', 'Request logs are unavailable here');
      renderBodyOnly();
      return;
    }

    const myEpoch = ++reqEpoch;
    state.logsDataKey = reqKey;
    state.logsLoading = true;
    state.logsError = null;
    renderBodyOnly();

    try {
      const res = await bridge.getUsageRequestLogs({
        scope,
        from,
        to,
        model: state.logsModel || null,
        cacheFilter: state.logsCacheFilter,
        page: state.logsPage,
        pageSize: state.logsPageSize,
      });
      if (state.disposed || myEpoch !== reqEpoch) return;
      if (res && typeof res === 'object' && 'error' in res) {
        state.logsData = null;
        state.logsDataKey = '';
        state.logsError = res.error;
      } else {
        state.logsData = res;
        if (res.page !== state.logsPage) {
          state.logsPage = res.page;
          state.logsDataKey = buildReqKey(scope, from, to);
        }
      }
    } catch (err) {
      if (state.disposed || myEpoch !== reqEpoch) return;
      state.logsData = null;
      state.logsDataKey = '';
      state.logsError = err instanceof Error ? err.message : w('加载失败', 'Load failed');
    } finally {
      if (!state.disposed && myEpoch === reqEpoch) {
        state.logsLoading = false;
        if (state.tab === 'logs') renderBodyOnly();
      }
    }
  };

  const resetFilters = (): void => {
    state.logsRange = 'today';
    state.logsModel = '';
    state.logsCacheFilter = 'all';
    state.logsPage = 1;
    render();
  };

  const switchRange = (next: UsageLogsRange): void => {
    if (state.logsRange === next) return;
    if (next === 'custom' && state.value?.today) {
      if (!state.logsFrom || !state.logsTo) {
        const prev = currentBounds();
        state.logsFrom = prev.from || addDays(state.value.today, -6);
        state.logsTo = prev.to || state.value.today;
      }
    }
    state.logsRange = next;
    state.logsPage = 1;
    render();
  };

  for (const btn of view.querySelectorAll<HTMLElement>('[data-logs-range]')) {
    btn.addEventListener('click', () => {
      const next = (btn.dataset.logsRange as UsageLogsRange) || 'today';
      switchRange(next);
    });
  }

  const handleDateInputChange = (): void => {
    const fromVal = $<HTMLInputElement>('logs-from')?.value || '';
    const toVal = $<HTMLInputElement>('logs-to')?.value || '';
    if (fromVal && toVal && fromVal <= toVal) {
      state.logsFrom = fromVal;
      state.logsTo = toVal;
      state.logsPage = 1;
      render();
    }
  };
  $('logs-from')?.addEventListener('change', handleDateInputChange);
  $('logs-to')?.addEventListener('change', handleDateInputChange);
  $('logs-reset')?.addEventListener('click', resetFilters);

  const goToPage = (targetPage: number): void => {
    const totalPages = state.logsData?.totalPages ?? 1;
    const clamped = Math.max(1, Math.min(totalPages, targetPage));
    if (clamped === state.logsPage) return;
    state.logsPage = clamped;
    render();
  };
  $('logs-first')?.addEventListener('click', () => goToPage(1));
  $('logs-prev')?.addEventListener('click', () => goToPage(state.logsPage - 1));
  $('logs-next')?.addEventListener('click', () => goToPage(state.logsPage + 1));
  $('logs-last')?.addEventListener('click', () => goToPage(state.logsData?.totalPages ?? 1));

  const syncControls = (): void => {
    const rangeLabels: Record<UsageLogsRange, string> = {
      today: w('今日', 'Today'),
      '7d': w('近 7 天', '7d'),
      '30d': w('近 30 天', '30d'),
      all: w('全部', 'All'),
      custom: w('自定义', 'Custom'),
    };
    for (const btn of view.querySelectorAll<HTMLElement>('[data-logs-range]')) {
      const r = (btn.dataset.logsRange as UsageLogsRange) || 'today';
      btn.textContent = rangeLabels[r] || '';
      btn.setAttribute('aria-pressed', String(state.logsRange === r));
    }

    const dateControls = $('logs-date-controls');
    if (dateControls) dateControls.hidden = state.logsRange !== 'custom';
    if (state.logsRange === 'custom') {
      const today = state.value?.today || '';
      if (!state.logsFrom && today) state.logsFrom = addDays(today, -6);
      if (!state.logsTo && today) state.logsTo = today;
      const fromEl = $<HTMLInputElement>('logs-from');
      const toEl = $<HTMLInputElement>('logs-to');
      if (fromEl && fromEl.value !== state.logsFrom) fromEl.value = state.logsFrom;
      if (toEl && toEl.value !== state.logsTo) toEl.value = state.logsTo;
    }

    const modelOpts: PickerOption[] = [{ value: '', label: w('全部模型', 'All models') }];
    const availableModels = state.logsData?.models || [];
    for (const item of availableModels) {
      modelOpts.push({
        value: item.model,
        label: formatModelName(item.model),
        hint: String(item.requests),
      });
    }
    if (state.logsModel && !availableModels.some((m) => m.model === state.logsModel)) {
      modelOpts.push({
        value: state.logsModel,
        label: formatModelName(state.logsModel),
        hint: '0',
      });
    }
    modelPicker?.setOptions(modelOpts, w('按模型筛选', 'Filter by model'));

    cachePicker?.setOptions(
      [
        { value: 'all', label: w('全部缓存', 'All cache') },
        { value: 'hot', label: w('热命中 ≥70%', 'Hot ≥70%') },
        { value: 'warm', label: w('部分命中 20–70%', 'Partial 20–70%') },
        { value: 'miss', label: w('低/未命中 <20%', 'Miss <20%') },
      ],
      w('按缓存命中筛选', 'Filter by cache hit'),
    );

    const resetBtn = $<HTMLButtonElement>('logs-reset');
    if (resetBtn) {
      const hasCustomFilter =
        state.logsRange !== 'today' || state.logsModel !== '' || state.logsCacheFilter !== 'all';
      resetBtn.hidden = !hasCustomFilter;
      resetBtn.textContent = w('重置', 'Reset');
    }
  };

  const renderSummaryStrip = (data: UsageRequestLogSnapshot | null): void => {
    const strip = $('logs-summary');
    if (!strip) return;
    if (!data) {
      strip.replaceChildren();
      return;
    }

    const { summary } = data;
    const cost = summarizeRequestLogCost(summary.costBuckets, state.pricingOverrides);
    const hitTone = classifyCacheHitTone(summary.cacheHitRate);

    const makeChip = (
      label: string,
      valueText: string,
      valueClass = '',
      extraText?: string,
      title?: string,
    ): HTMLElement => {
      const chip = createDomNode('div', 'logs-summary-chip');
      if (title) chip.title = title;
      chip.append(createDomNode('span', 'logs-chip-label', label));
      chip.append(createDomNode('strong', `logs-chip-val${valueClass ? ` ${valueClass}` : ''}`, valueText));
      if (extraText) chip.append(createDomNode('span', 'logs-chip-extra', extraText));
      return chip;
    };

    const costText =
      summary.totalTokens <= 0
        ? '$0.00'
        : cost.pricedTokens <= 0
          ? '—'
          : `${formatUsd(cost.costUsd, { approx: true })}${cost.hasUnpriced ? '+' : ''}`;
    const costTitle =
      cost.pricedTokens > 0
        ? `${w('筛选范围内等效 API 花费', 'Estimated API cost for matched requests')}: ${formatUsd(cost.costUsd, { precise: true })}${
            cost.hasUnpriced
              ? ` (${w(`另含 ${compactNum(cost.unpricedTokens)} 未定价 Token`, `excludes ${compactNum(cost.unpricedTokens)} unpriced tokens`)})`
              : ''
          }`
        : w('暂无公开单价（点击右上角 $ 可自定义）', 'Unpriced (click $ in header to configure)');

    const reqTitle = w(
      `热命中 ${full(summary.hotCount)} · 部分命中 ${full(summary.warmCount)} · 低/未命中 ${full(summary.missCount)}`,
      `Hot ${full(summary.hotCount)} · Partial ${full(summary.warmCount)} · Miss ${full(summary.missCount)}`,
    );

    const tokTitle = w(
      `输入 ${full(summary.inputTokens)}（缓存读 ${full(summary.cachedTokens)} · 缓存写 ${full(summary.cacheWriteTokens)} · 未缓存 ${full(summary.uncachedTokens)}）· 输出 ${full(summary.outputTokens)}`,
      `Input ${full(summary.inputTokens)} (read ${full(summary.cachedTokens)} · write ${full(summary.cacheWriteTokens)} · uncached ${full(summary.uncachedTokens)}) · Output ${full(summary.outputTokens)}`,
    );

    // 多页时额外在提示里补充本页命中率，兼顾全局与当前页观察
    let pageHitSuffix = '';
    if (data.totalPages > 1 && data.items.length > 0) {
      let pageIn = 0;
      let pageRead = 0;
      for (const item of data.items) {
        pageIn += item.inputTokens;
        pageRead += item.cacheRead;
      }
      if (pageIn > 0) {
        pageHitSuffix = w(
          ` · 本页 ${formatHitPct(pageRead / pageIn)}`,
          ` · Page ${formatHitPct(pageRead / pageIn)}`,
        );
      }
    }
    const cacheExtra =
      summary.totalRequests > 0
        ? w(
            `热 ${full(summary.hotCount)} / 未中 ${full(summary.missCount)}`,
            `${full(summary.hotCount)} hot / ${full(summary.missCount)} miss`,
          )
        : undefined;
    const cacheTitle = `${w('范围加权缓存命中率', 'Weighted cache hit rate')} = ${full(summary.cachedTokens)} / ${full(summary.inputTokens)}${pageHitSuffix}`;

    strip.replaceChildren(
      makeChip(w('等效花费', 'Est. cost'), costText, 'is-cost', undefined, costTitle),
      makeChip(
        w('请求数', 'Requests'),
        w(`${full(summary.totalRequests)} 次`, full(summary.totalRequests)),
        '',
        undefined,
        reqTitle,
      ),
      makeChip(w('总 Token', 'Tokens'), compactNum(summary.totalTokens), '', undefined, tokTitle),
      makeChip(
        w('缓存命中率', 'Cache hit'),
        formatHitPct(summary.cacheHitRate),
        `is-${hitTone}`,
        cacheExtra,
        cacheTitle,
      ),
    );
  };

  const renderRow = (item: UsageRequestLogItem): HTMLTableRowElement => {
    const tr = createDomNode('tr', 'log-row');

    // 1. 时间 + 来源/会话上下文
    const tdTime = createDomNode('td', 'log-col-time');
    const timeMain = createDomNode('div', 'log-time-main');
    timeMain.append(createDomNode('span', 'log-time-text', item.timeText));
    if (item.source === 'remote') {
      timeMain.append(createDomNode('span', 'log-badge is-remote', w('远程', 'Remote')));
    }
    if (item.partial) {
      timeMain.append(createDomNode('span', 'log-badge is-partial', w('部分', 'Partial')));
    }
    tdTime.append(timeMain);

    const subParts: HTMLElement[] = [];
    const titleBits: string[] = [item.timeText];
    if (item.projectName) {
      subParts.push(createDomNode('span', 'log-project-tag', item.projectName));
      titleBits.push(item.projectName);
    }
    const labelText = item.conversationTitle || item.note || '';
    if (labelText) {
      subParts.push(createDomNode('span', 'log-conv-title', labelText));
      titleBits.push(labelText);
    }
    if (item.accountName) {
      subParts.push(createDomNode('span', 'log-account-tag', item.accountName));
      titleBits.push(item.accountName);
    }
    if (subParts.length > 0) {
      const subRow = createDomNode('div', 'log-time-sub');
      subRow.append(...subParts);
      tdTime.append(subRow);
    }
    tdTime.title = titleBits.join(' · ');

    // 2. 模型
    const tdModel = createDomNode('td', 'log-col-model');
    const modelWrap = createDomNode('div', 'log-model-cell');
    const dot = createDomNode('span', 'dot');
    const color =
      palette.modelColor(item.model, 'detailed') ||
      palette.modelColor(baseModelName(item.model), 'simple');
    dot.style.setProperty('--model-color', color);
    modelWrap.append(dot, createDomNode('span', 'log-model-name', formatModelName(item.model)));
    tdModel.title = item.model;
    tdModel.append(modelWrap);

    // 3. 缓存命中率徽章
    const tdCache = createDomNode('td', 'log-col-cache');
    const tone = classifyCacheHitTone(item.cacheHitRate);
    const pill = createDomNode('span', `log-cache-pill is-${tone}`, formatHitPct(item.cacheHitRate));
    if (item.cacheHitRate !== null) {
      tdCache.title = w(
        `缓存读 ${full(item.cacheRead)} / 总输入 ${full(item.inputTokens)} = ${formatHitPct(item.cacheHitRate)}`,
        `Cache read ${full(item.cacheRead)} / Input ${full(item.inputTokens)} = ${formatHitPct(item.cacheHitRate)}`,
      );
    } else {
      tdCache.title = w('无输入 Token，无法计算缓存命中率', 'No input tokens');
    }
    tdCache.append(pill);

    // 4. Token 明细（主行：输入 / 输出；副行：缓存读 ↓ · 缓存写 ↑ · 未缓存）
    const tdTokens = createDomNode('td', 'log-col-tokens');
    const tokMain = createDomNode('div', 'log-tok-main');
    tokMain.append(
      createDomNode('strong', '', full(item.inputTokens)),
      createDomNode('span', 'log-tok-sep', ' / '),
      createDomNode('span', 'log-tok-out', full(item.output)),
    );
    tdTokens.append(tokMain);

    const breakdownNodes: HTMLElement[] = [];
    if (item.cacheRead > 0) {
      breakdownNodes.push(
        createDomNode('span', 'log-tok-hit', w(`缓存读 ↓ ${full(item.cacheRead)}`, `Read ↓ ${full(item.cacheRead)}`)),
      );
    }
    if (item.cacheWrite > 0) {
      breakdownNodes.push(
        createDomNode('span', 'log-tok-write', w(`缓存写 ↑ ${full(item.cacheWrite)}`, `Write ↑ ${full(item.cacheWrite)}`)),
      );
    }
    if (item.uncached > 0 || breakdownNodes.length === 0) {
      breakdownNodes.push(
        createDomNode('span', 'log-tok-uncached', w(`未缓存 ${full(item.uncached)}`, `Uncached ${full(item.uncached)}`)),
      );
    }
    const tokSub = createDomNode('div', 'log-tok-sub');
    breakdownNodes.forEach((node, idx) => {
      if (idx > 0) tokSub.append(createDomNode('span', 'log-tok-dot', ' · '));
      tokSub.append(node);
    });
    tdTokens.append(tokSub);
    tdTokens.title = w(
      `总计 ${full(item.total)} Token（未缓存 ${full(item.uncached)} · 缓存读 ${full(item.cacheRead)} · 缓存写 ${full(item.cacheWrite)} · 输出 ${full(item.output)}）`,
      `Total ${full(item.total)} tokens (Uncached ${full(item.uncached)} · Read ${full(item.cacheRead)} · Write ${full(item.cacheWrite)} · Output ${full(item.output)})`,
    );

    // 5. 单次请求等效 API 花费
    const tdCost = createDomNode('td', 'log-col-cost');
    const usd = calculateBucketCost(item.model, item, item.date, state.pricingOverrides);
    const resolvedPrice = resolveModelPricing(item.model, item.date, state.pricingOverrides);
    const costText = usd === null ? '—' : formatUsd(usd, { precise: true });
    const costBadge = createDomNode('span', `log-cost-pill${usd === null ? ' is-muted' : ''}`, costText);
    tdCost.title = resolvedPrice
      ? `${resolvedPrice.label} · ${formatRateSummary(resolvedPrice.rates, zh())}`
      : w('暂无公开单价（点击右上角 $ 可自定义）', 'Unpriced (click $ in header to configure)');
    tdCost.append(costBadge);

    tr.append(tdTime, tdModel, tdCache, tdTokens, tdCost);
    return tr;
  };

  const renderPagination = (data: UsageRequestLogSnapshot | null): void => {
    const pager = $('logs-pagination');
    if (!pager) return;
    if (!data || data.totalCount === 0) {
      pager.hidden = true;
      return;
    }
    pager.hidden = false;
    const startIdx = (data.page - 1) * data.pageSize + 1;
    const endIdx = Math.min(data.totalCount, data.page * data.pageSize);
    const info = $('logs-page-info');
    if (info) {
      info.textContent = w(
        `显示第 ${full(startIdx)}–${full(endIdx)} 条，共 ${full(data.totalCount)} 条`,
        `Showing ${full(startIdx)}–${full(endIdx)} of ${full(data.totalCount)}`,
      );
    }
    const label = $('logs-page-label');
    if (label) label.textContent = `${data.page} / ${data.totalPages}`;

    const firstBtn = $<HTMLButtonElement>('logs-first');
    const prevBtn = $<HTMLButtonElement>('logs-prev');
    const nextBtn = $<HTMLButtonElement>('logs-next');
    const lastBtn = $<HTMLButtonElement>('logs-last');
    if (prevBtn) prevBtn.textContent = w('上一页', 'Prev');
    if (nextBtn) nextBtn.textContent = w('下一页', 'Next');
    if (firstBtn) {
      firstBtn.disabled = data.page <= 1 || state.logsLoading;
      firstBtn.title = w('首页', 'First page');
    }
    if (prevBtn) prevBtn.disabled = data.page <= 1 || state.logsLoading;
    if (nextBtn) nextBtn.disabled = data.page >= data.totalPages || state.logsLoading;
    if (lastBtn) {
      lastBtn.disabled = data.page >= data.totalPages || state.logsLoading;
      lastBtn.title = w('末页', 'Last page');
    }
  };

  const renderBodyOnly = (): void => {
    syncControls();
    const head = $('logs-table-head');
    const body = $('logs-table-body');
    if (!head || !body) return;

    head.replaceChildren(
      ...[
        [w('时间', 'Time'), 'log-col-time'],
        [w('模型', 'Model'), 'log-col-model'],
        [w('缓存命中', 'Cache'), 'log-col-cache'],
        [w('Tokens（输入 / 输出）', 'Tokens (In / Out)'), 'log-col-tokens'],
        [w('等效花费', 'Est. cost'), 'log-col-cost'],
      ].map(([label, cls]) => createDomNode('th', cls, label)),
    );

    const data = state.logsData;
    renderSummaryStrip(data);
    renderPagination(data);
    body.classList.toggle('is-loading', state.logsLoading && Boolean(data));

    if (state.logsLoading && !data) {
      const tr = createDomNode('tr');
      const td = createDomNode('td', 'logs-empty-cell', w('正在加载请求日志…', 'Loading request logs…'));
      td.colSpan = 5;
      tr.append(td);
      body.replaceChildren(tr);
      return;
    }

    if (state.logsError) {
      const tr = createDomNode('tr');
      const td = createDomNode('td', 'logs-empty-cell');
      td.colSpan = 5;
      td.append(createDomNode('span', '', state.logsError));
      const retryBtn = createDomNode('button', 'logs-inline-action', w('重试', 'Retry'));
      retryBtn.type = 'button';
      retryBtn.addEventListener('click', () => {
        state.logsDataKey = '';
        void ensureLogsData();
      });
      td.append(retryBtn);
      tr.append(td);
      body.replaceChildren(tr);
      return;
    }

    if (!data || data.items.length === 0) {
      const tr = createDomNode('tr');
      const td = createDomNode('td', 'logs-empty-cell');
      td.colSpan = 5;
      const hasNarrowFilter = state.logsModel !== '' || state.logsCacheFilter !== 'all';
      td.append(
        createDomNode(
          'span',
          '',
          hasNarrowFilter
            ? w('当前筛选条件下暂无匹配请求', 'No requests match the current filters')
            : state.logsRange === 'today'
              ? w('今日暂无请求记录', 'No requests recorded today')
              : w('该时间范围内暂无请求记录', 'No requests in this range'),
        ),
      );
      if (hasNarrowFilter) {
        const clearBtn = createDomNode('button', 'logs-inline-action', w('清除筛选', 'Clear filters'));
        clearBtn.type = 'button';
        clearBtn.addEventListener('click', () => {
          state.logsModel = '';
          state.logsCacheFilter = 'all';
          state.logsPage = 1;
          render();
        });
        td.append(clearBtn);
      } else if (state.logsRange === 'today') {
        const weekBtn = createDomNode('button', 'logs-inline-action', w('查看近 7 天', 'View last 7d'));
        weekBtn.type = 'button';
        weekBtn.addEventListener('click', () => switchRange('7d'));
        td.append(weekBtn);
      }
      tr.append(td);
      body.replaceChildren(tr);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of data.items) {
      frag.append(renderRow(item));
    }
    body.replaceChildren(frag);
  };

  const render = (): void => {
    renderBodyOnly();
    void ensureLogsData();
  };

  const invalidate = (): void => {
    state.logsDataKey = '';
  };

  const closeSubPopovers = (): boolean => {
    let closed = false;
    if (modelPicker?.isOpen()) {
      modelPicker.close();
      closed = true;
    }
    if (cachePicker?.isOpen()) {
      cachePicker.close();
      closed = true;
    }
    return closed;
  };

  const dispose = (): void => {
    reqEpoch++;
    modelPicker?.dispose();
    cachePicker?.dispose();
  };

  return { render, invalidate, closeSubPopovers, dispose };
}
