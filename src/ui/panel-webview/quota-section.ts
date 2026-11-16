import type { QuotaGroup, QuotaWindowAvailable, TokenSummary } from '../../contracts/index.ts';
import { setAttr, setHidden, setStyle, setText } from '../../shared/dom.ts';
import { compact, count, percent, rate } from '../../shared/format.ts';
import { formatQuotaGroupLabel, selectPreferredQuotaGroup } from '../shared/model-donut.ts';
import type { PanelDomContext, PanelMetricsSnapshot, PanelSpeedMetrics } from './types.ts';

export function chooseGroup(
  ctx: PanelDomContext,
  groups: ReadonlyArray<QuotaGroup>,
  speed: PanelSpeedMetrics | null | undefined,
): QuotaGroup | null {
  return (
    selectPreferredQuotaGroup(
      groups,
      ctx.state.selectedGroup,
      speed?.activeModel || speed?.model,
    ) ?? null
  );
}

export function groupLabel(value: QuotaGroup): string {
  return formatQuotaGroupLabel(value, value.name);
}

const quotaColor = (remaining: number | null | undefined): string =>
  typeof remaining === 'number' && remaining < 0.05
    ? 'var(--pulse-danger)'
    : typeof remaining === 'number' && remaining < 0.2
      ? 'var(--pulse-warning)'
      : '';

export function applyQuotaFill(fill: HTMLElement | null, remaining: number | null | undefined): void {
  setStyle(
    fill,
    'width',
    typeof remaining === 'number' ? `${Math.min(100, Math.max(0, remaining * 100))}%` : '0%',
  );
  setStyle(fill, 'background', quotaColor(remaining));
}

export function renderQuota(ctx: PanelDomContext, windowName: '5h' | 'weekly', prefix: 'five' | 'week'): void {
  const { $, state, language } = ctx;
  const t = language.t;
  const bucket = state.group?.windows?.[windowName];
  const availableBucket = bucket?.available ? (bucket as QuotaWindowAvailable) : null;
  const remaining = availableBucket?.remaining ?? null;
  setText($(`${prefix}-balance`), percent(remaining));
  const fill = $(`${prefix}-fill`);
  const track = $(`${prefix}-track`);
  applyQuotaFill(fill, remaining);
  if (typeof remaining === 'number') {
    setAttr(track, 'aria-valuenow', String(remaining * 100));
    setAttr(track, 'aria-valuemin', '0');
    setAttr(track, 'aria-valuemax', '100');
  } else {
    setAttr(track, 'aria-valuenow', null);
  }
  setText($(`${prefix}-reset`), language.resetDate(availableBucket?.resetAt));
  setText(
    $(`${prefix}-note`),
    !bucket?.available
      ? t('noQuota')
      : availableBucket?.disabled
        ? t('disabledQuota')
        : remaining === null
          ? t('noFraction')
          : `${t('sharedQuota')} ${t('quotaSource')}`,
  );
}

export function renderQuotaAndSpeedSections(ctx: PanelDomContext, value: PanelMetricsSnapshot): void {
  const { $, state, language } = ctx;
  const t = language.t;
  const groups = value.groups || [];
  const speed = value.speed;
  state.group = chooseGroup(ctx, groups, speed);
  const optionsKey = `${language.language}:${groups.map((g) => g.id).join('|')}`;
  const select = $<HTMLSelectElement>('quota-group');
  if (select && select.dataset.options !== optionsKey) {
    select.replaceChildren(
      ...(groups.length
        ? groups.map((g) => new Option(groupLabel(g), g.id))
        : [new Option(t('unavailableQuota'), '')]),
    );
    select.dataset.options = optionsKey;
  }
  if (select && state.group && select.value !== state.group.id) {
    select.value = state.group.id;
  }
  const groupText = state.group ? groupLabel(state.group) : '—';
  for (const element of ctx.groupNameNodes) setText(element, groupText);
  renderQuota(ctx, '5h', 'five');
  renderQuota(ctx, 'weekly', 'week');

  setText($('strip-tps'), rate(speed?.tps));
  setAttr($('speed-tab'), 'title', `${rate(speed?.tps)} tok/s`);
  setText($('session-tps'), speed?.latestRateStatus === 'legacy' ? t('ratePending') : `${rate(speed?.tps)} tok/s`);
  const latestDisplay =
    speed?.latestRateStatus === 'unreliable'
      ? t('timingUnreliable')
      : speed?.latestRateStatus === 'legacy'
        ? t('ratePending')
        : speed?.latestTps !== null && speed?.latestTps !== undefined
          ? `${rate(speed.latestTps)} tok/s`
          : '—';
  setText($('latest-tps'), latestDisplay);
  setText($('request-count'), t('sampleCount', { n: speed?.measuredRequests ?? 0 }));
  setText(
    $('session-steps'),
    speed ? t('rounds', { rounds: speed.rounds, steps: speed.steps }).replace(/\s*·\s*$/, '') : '',
  );
  const planModel = speed?.planModel || null;
  const activeModel = speed?.activeModel || null;
  const isHybrid = Boolean(planModel && activeModel && planModel !== activeModel);
  const modelText = isHybrid ? `${planModel} \u2192 ${activeModel}` : speed?.model || t('waitingRequest');
  setText($('strip-model'), modelText);
  setAttr($('strip-model'), 'title', modelText);
  setText($('model-time'), language.elapsed(speed?.modelSeconds));
  setText($('tool-time'), language.elapsed(speed?.toolSeconds));
  setText($('ttft'), language.elapsed(speed?.ttftSeconds));
  setText(
    $('token-detail'),
    speed ? `${count(speed.counts.responseOutput)} / ${count(speed.counts.thinkingOutput)} tok` : '—',
  );
  const savedNote = speed?.restoredFromHistory
    ? ` ${t('savedStats', { time: speed.savedAt ? language.resetDate(speed.savedAt) : '—' })}`
    : '';
  const saveWarning = value.persistenceError ? ` ${t('saveFailed')}` : '';
  setText($('speed-basis'), language.rateNote(speed) + savedNote + saveWarning);
  setHidden($('speed-basis'), true);

  renderContextAndCacheCards(ctx, speed, value);
}

function renderContextAndCacheCards(
  ctx: PanelDomContext,
  speed: PanelSpeedMetrics | null,
  value: PanelMetricsSnapshot,
): void {
  const { $, language } = ctx;
  const t = language.t;
  const cache = speed?.cache;
  const context = speed?.context;
  const hasCapacity = typeof context?.usedFraction === 'number';
  const planModel = speed?.planModel || null;
  const activeModel = speed?.activeModel || null;
  const isHybrid = Boolean(planModel && activeModel && planModel !== activeModel);

  setText($('strip-context'), hasCapacity && context.usedFraction != null ? `${Math.round(context.usedFraction * 100)}%` : '—');
  setText(
    $('strip-context-size'),
    context ? `${compact(context.usedTokens)} / ${context.maxTokens === null ? '—' : compact(context.maxTokens)}` : '—',
  );
  setAttr(
    $('context-tab'),
    'title',
    context
      ? t('contextTokens', {
          used: count(context.usedTokens),
          max: context.maxTokens === null ? '—' : count(context.maxTokens),
        })
      : t('contextUnknown'),
  );
  setText(
    $('context-summary'),
    hasCapacity && context.usedFraction != null
      ? t('contextUsed', {
          used: Math.round(context.usedFraction * 100),
          remaining: Math.round((context.remainingFraction ?? 0) * 100),
        })
      : t('contextUnknown'),
  );
  setText(
    $('context-tokens'),
    context
      ? t('contextTokens', {
          used: compact(context.usedTokens),
          max: context.maxTokens === null ? '—' : compact(context.maxTokens),
        })
      : '—',
  );
  setText($('context-model'), context?.model || activeModel || '—');
  const sessionModelCount = speed?.modelUsage?.models?.length || 0;
  const showOrchContext = isHybrid || sessionModelCount >= 2;
  setHidden($('context-orchestrator-row'), !showOrchContext);
  setHidden($('context-orchestrator-note'), !showOrchContext);
  if (showOrchContext) {
    setText($('context-orchestrator'), planModel || t('modelMixModelsCount', { count: sessionModelCount }));
    setText($('context-orchestrator-note'), t(isHybrid ? 'contextQuotaSplit' : 'contextMultiModelHint'));
  }
  const ctxFill = $('context-fill');
  const ctxTrack = $('context-track');
  setStyle(
    ctxFill,
    'width',
    hasCapacity && context.usedFraction != null ? `${Math.min(1, Math.max(0, context.usedFraction)) * 100}%` : '0%',
  );
  setStyle(
    ctxFill,
    'background',
    hasCapacity && (context.usedFraction ?? 0) >= 0.9 ? 'var(--pulse-danger)' : '',
  );
  if (hasCapacity && context.usedFraction != null) {
    setAttr(ctxTrack, 'aria-valuenow', String(Math.min(100, context.usedFraction * 100)));
    setAttr(ctxTrack, 'aria-valuemin', '0');
    setAttr(ctxTrack, 'aria-valuemax', '100');
  } else {
    setAttr(ctxTrack, 'aria-valuenow', null);
  }

  setText($('strip-cache'), percent(cache?.hitRate));
  setText($('cache-rate'), percent(cache?.hitRate));
  const tokens: Partial<TokenSummary> | undefined = speed?.tokens || (cache as unknown as Partial<TokenSummary>);
  const hasTotal = Boolean(
    tokens?.measuredRequests && typeof tokens.totalTokens === 'number' && Number.isSafeInteger(tokens.totalTokens) && tokens.totalTokens >= 0,
  );
  setText($('strip-cache-total'), hasTotal ? `${compact(tokens?.totalTokens)} tok` : '— tok');
  const tokenRows: ReadonlyArray<readonly [keyof TokenSummary, string, keyof TokenSummary | null]> = [
    ['cachedTokens', 'cache-read', 'cachedRequests'],
    ['uncachedTokens', 'cache-miss', 'uncachedRequests'],
    ['cacheWriteTokens', 'cache-write', 'cacheWriteRequests'],
    ['outputTokens', 'cache-output', null],
  ];
  for (const [field, id, reqField] of tokenRows) {
    const available =
      field === 'outputTokens'
        ? (tokens?.outputAvailable ?? tokens?.outputRequests ?? tokens?.measuredRequests)
        : ((reqField ? tokens?.[reqField] : null) ?? tokens?.inputRequests ?? tokens?.measuredRequests);
    const numVal = tokens?.[field];
    const known = typeof numVal === 'number' && Number.isSafeInteger(numVal) && numVal >= 0;
    setText($(id), available && known ? `${count(numVal)} tok` : '—');
  }
  setText($('cache-coverage'), hasTotal ? `${count(tokens?.totalTokens)} tok` : '— tok');
  setHidden($('cache-write-row'), !((tokens?.cacheWriteTokens ?? 0) > 0));

  const task = speed?.taskUsage;
  if (task && task.subagents > 0) {
    setHidden($('panel-task-tokens-row'), false);
    setHidden($('panel-subagent-tokens-row'), false);
    setText(
      $('panel-task-total-tokens'),
      `${count(task.tokens?.totalTokens)} tok${task.state === 'loading' ? ` (${t('loading')})` : ''}`,
    );
    setText($('panel-subagent-tokens'), `${count(task.subagentTokens)} tok`);
    setText($('panel-subagent-tokens-label'), t('taskTokensSubagents', { count: task.subagents }));
  } else {
    setHidden($('panel-task-tokens-row'), true);
    setHidden($('panel-subagent-tokens-row'), true);
  }
  void value;
}

export function updateCountdowns(ctx: PanelDomContext, onExpiredRefresh: () => void): void {
  const { $, state, language } = ctx;
  const now = Date.now() + state.serverOffset;
  for (const [windowName, prefix] of [['5h', 'five'], ['weekly', 'week']] as const) {
    const bucket = state.group?.windows?.[windowName];
    const avail = bucket?.available ? (bucket as QuotaWindowAvailable) : null;
    setText($(`${prefix}-countdown`), language.countdown(avail?.resetAt, now));
    setText($(`${prefix}-summary-countdown`), language.countdown(avail?.resetAt, now, true));
    setText($(`${prefix}-summary-balance`), percent(avail?.remaining));
    applyQuotaFill($(`${prefix}-summary-fill`), avail?.remaining);
    if (
      avail?.resetAt &&
      Date.parse(avail.resetAt) <= now &&
      state.snapshot?.connection === 'live' &&
      now - state.lastExpiredRefresh > 30000
    ) {
      state.lastExpiredRefresh = now;
      onExpiredRefresh();
    }
  }
}
