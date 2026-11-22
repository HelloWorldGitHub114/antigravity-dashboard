import type { SpeedMetrics, TokenSummary } from '../../contracts/index.ts';
import { resolveMonitorPrefs } from '../../contracts/preferences.ts';
import { setAttr, setStyle, setText } from '../../shared/dom.ts';
import { compact, count, percent, rate } from '../../shared/format.ts';
import {
  resolveCacheTtl,
  resolveContextLoad,
  summarizeActiveWaitAlert,
} from '../../shared/request-alerts.ts';
import {
  buildContextBreakdownSegments,
  errorKindCopy,
  formatCacheTtlText,
  formatTurnStateLabel,
  resolveAlertBadge,
} from '../shared/monitor-ui.ts';
import { toggleHidden } from './cards.ts';
import type { ComposerMatch, WidgetLanguage, WidgetMetricsSnapshot, WidgetSurface } from './types.ts';

type ExtendedLatestRateStatus = SpeedMetrics['latestRateStatus'] | 'generating';

export function renderSpeedContextCacheCards(params: {
  root: ShadowRoot;
  data: WidgetMetricsSnapshot;
  composer: ComposerMatch | null;
  lastConversation: string | null;
  surface: WidgetSurface | undefined;
  language: WidgetLanguage;
}): void {
  const { root, data, composer, lastConversation, surface, language } = params;
  const $ = (id: string) => root.getElementById(id);
  const t = language.t;
  const speed = data.speed;

  toggleHidden(root.querySelector<HTMLElement>('[data-card="speed"]'), !lastConversation && !surface?.showEmpty);
  toggleHidden(
    root.querySelector<HTMLElement>('[data-card="cache"]'),
    !lastConversation && !surface?.showEmpty && !data.usage,
  );
  toggleHidden(root.querySelector<HTMLElement>('[data-card="context"]'), false);

  const context = speed?.context;
  const hasCapacity = typeof context?.usedFraction === 'number';
  const isCompacted = context?.compacted === true;
  const empty = surface?.conversationState?.(composer).status === 'new' && !lastConversation && data.connection === 'live';

  const usedPct = hasCapacity ? Math.round((context.usedFraction ?? 0) * 100) : null;
  setText($('context-percent'), usedPct !== null ? `${isCompacted ? '~' : ''}${usedPct}%` : '—');
  setStyle(
    $('context-ring') as HTMLElement | null,
    '--used-angle',
    `${hasCapacity ? Math.min(1, context.usedFraction ?? 0) * 360 : 0}deg`,
  );
  setText(
    $('context-summary'),
    hasCapacity && usedPct !== null
      ? isCompacted
        ? t('contextCompactedUsed', { used: usedPct })
        : t('contextUsed', {
            used: usedPct,
            remaining: Math.round((context.remainingFraction ?? 0) * 100),
          })
      : t(empty ? 'waitingRequest' : 'contextUnknown'),
  );
  setText(
    $('context-tokens'),
    context
      ? t('contextTokens', {
          used: `${isCompacted ? '~' : ''}${compact(context.usedTokens)}`,
          max: context.maxTokens === null ? '—' : compact(context.maxTokens),
        })
      : '—',
  );
  const compactions = Math.max(
    context?.compactionCount ?? 0,
    speed?.transcriptStats?.compactionMarkers ?? 0,
  );
  const compactionPill = $('context-compaction-pill') as HTMLElement | null;
  if (compactionPill) {
    toggleHidden(compactionPill, compactions <= 0);
    if (compactions > 0) {
      setText(compactionPill, `🗜 ${t('contextCompactionCount', { n: compactions })}`);
      setAttr(compactionPill, 'title', t('contextCompactionsTitle', { n: compactions }));
    }
  }
  const compactedNote = $('context-compacted-note') as HTMLElement | null;
  if (compactedNote) {
    toggleHidden(compactedNote, !isCompacted);
    if (isCompacted) {
      const prevTokens = context?.preCompactionUsedTokens;
      const prevText =
        typeof prevTokens === 'number' && typeof context?.maxTokens === 'number' && context.maxTokens > 0
          ? `${Math.round((prevTokens / context.maxTokens) * 100)}%`
          : typeof prevTokens === 'number'
            ? `${compact(prevTokens)} tok`
            : '—';
      setText(compactedNote, t('contextCompactedNote', { prev: prevText }));
    }
  }

  const muModels = Array.isArray(speed?.modelUsage?.models) ? speed.modelUsage.models : [];
  const planModel = speed?.planModel || speed?.modelUsage?.planModel || null;
  const activeModel = speed?.activeModel || speed?.modelUsage?.activeModel || context?.model || null;
  setText($('context-model'), activeModel || '—');

  const hasHybridPlan = Boolean(planModel && activeModel && planModel !== activeModel);
  const showOrchestrator = hasHybridPlan || muModels.length >= 2;
  toggleHidden($('context-orchestrator-row') as HTMLElement | null, !showOrchestrator);
  if (showOrchestrator) {
    if (planModel) {
      setText($('context-orchestrator-label'), t('contextPlanner'));
      setText($('context-planner'), planModel);
      setText(
        $('context-orchestrator-note'),
        /orchestrator/i.test(planModel) ? t('contextQuotaSplit') : t('contextMultiModelHint'),
      );
    } else {
      setText($('context-orchestrator-label'), t('modelMixTitle'));
      setText($('context-planner'), t('modelMixModelsCount', { count: muModels.length }));
      setText($('context-orchestrator-note'), t('contextMultiModelHint'));
    }
  }

  const monitorPrefs = resolveMonitorPrefs(data.preferences);
  const contextLoad = hasCapacity && !isCompacted ? resolveContextLoad(context.usedFraction, monitorPrefs) : 'normal';
  const contextChip = root.querySelector<HTMLElement>('[data-card="context"]');
  if (contextChip) contextChip.dataset.load = contextLoad;

  const contextFill = $('context-fill') as HTMLElement | null;
  setStyle(contextFill, 'width', hasCapacity ? `${Math.min(1, context.usedFraction ?? 0) * 100}%` : '0%');
  setStyle(
    contextFill,
    'background',
    contextLoad === 'danger'
      ? 'var(--pulse-danger)'
      : contextLoad === 'warn'
        ? 'var(--pulse-warning)'
        : '',
  );
  const contextTrack = $('context-track');
  setAttr(contextTrack, 'aria-valuenow', hasCapacity ? Math.min(100, (context.usedFraction ?? 0) * 100) : null);
  setAttr(contextTrack, 'aria-valuemin', '0');
  setAttr(contextTrack, 'aria-valuemax', '100');

  const breakdownSegments = buildContextBreakdownSegments(isCompacted ? null : context?.breakdown);
  toggleHidden($('context-breakdown') as HTMLElement | null, breakdownSegments.length === 0);
  for (const seg of breakdownSegments) {
    setStyle($(`ctx-seg-bar-${seg.key}`) as HTMLElement | null, 'width', `${seg.pct.toFixed(2)}%`);
    setText($(`ctx-seg-val-${seg.key}`), `${compact(seg.tokens)} (${Math.round(seg.pct)}%)`);
  }

  setText($('tps'), rate(speed?.tps));
  setText(
    $('rounds'),
    speed ? t('rounds', { rounds: speed.rounds ?? 0, steps: speed.steps ?? 0 }) : '',
  );
  setText(
    $('samples'),
    speed
      ? t('sample', {
          rounds: speed.rounds ?? 0,
          steps: speed.steps ?? 0,
          requests: speed.measuredRequests ?? 0,
        })
      : t('waitingRequest'),
  );
  setText($('model-time'), language.elapsed(speed?.modelSeconds));
  setText($('tool-time'), language.elapsed(speed?.toolSeconds));
  setText($('ttft'), language.elapsed(speed?.ttftSeconds));
  setText($('session-rate'), `${rate(speed?.tps)} tok/s`);

  const status = speed?.latestRateStatus as ExtendedLatestRateStatus | undefined;
  const inlineLatestDisplay =
    status === 'generating'
      ? speed?.latestTps !== null && speed?.latestTps !== undefined
        ? `~${rate(speed.latestTps)} tok/s`
        : t('generating')
      : status === 'unreliable'
        ? t('timingUnreliable')
        : status === 'legacy'
          ? t('ratePending')
          : `${rate(speed?.latestTps)} tok/s`;
  setText($('latest-rate'), inlineLatestDisplay);
  setText(
    $('tokens'),
    speed ? `${count(speed.counts.responseOutput)} / ${count(speed.counts.thinkingOutput)} tok` : '—',
  );
  if (status === 'legacy') setText($('session-rate'), t('ratePending'));

  const savedNote = speed?.restoredFromHistory
    ? ` ${t('savedStats', { time: speed.savedAt ? language.resetDate(speed.savedAt) : '—' })}`
    : '';
  const saveWarning = data.persistenceError ? ` ${t('saveFailed')}` : '';
  setText(
    $('rate-note'),
    [language.errorMessage(data.error || data.sessionError), language.rateNote(speed)].filter(Boolean).join(' ') +
      savedNote +
      saveWarning,
  );
  const rateNoteEl = $('rate-note') as HTMLElement | null;
  if (rateNoteEl && !rateNoteEl.hidden) rateNoteEl.hidden = true;

  const cache = speed?.cache;
  setText($('cache-rate'), percent(cache?.hitRate));
  setText($('cache-detail-rate'), percent(cache?.hitRate));

  const tokens = (speed?.tokens || cache) as Partial<TokenSummary> | undefined;
  // Keep coverage in the data model; the compact card shows readable counters.
  const hasTotal =
    Boolean(tokens?.measuredRequests) &&
    Number.isSafeInteger(tokens?.totalTokens) &&
    (tokens?.totalTokens ?? -1) >= 0;
  setText($('cache-total'), hasTotal ? `${compact(tokens?.totalTokens)} tok` : '— tok');
  setText($('cache-coverage'), hasTotal ? `${count(tokens?.totalTokens)} tok` : '— tok');

  const inputCoverage = {
    uncachedTokens: 'uncachedRequests',
    cachedTokens: 'cachedRequests',
    cacheWriteTokens: 'cacheWriteRequests',
  } as const;
  for (const [field, id] of [
    ['cachedTokens', 'cache-read'],
    ['uncachedTokens', 'cache-miss'],
    ['cacheWriteTokens', 'cache-write'],
    ['outputTokens', 'cache-output'],
  ] as const) {
    const available =
      field === 'outputTokens'
        ? (tokens?.outputAvailable ?? tokens?.outputRequests ?? tokens?.measuredRequests)
        : (tokens?.[inputCoverage[field]] ?? tokens?.inputRequests ?? tokens?.measuredRequests);
    const val = tokens?.[field];
    const known = Number.isSafeInteger(val) && (val ?? -1) >= 0;
    setText($(id), available && known ? `${count(val)} tok` : '—');
  }
  toggleHidden($('cache-write-row') as HTMLElement | null, !((tokens?.cacheWriteTokens ?? 0) > 0));

  const task = speed?.taskUsage;
  if (task && task.subagents > 0) {
    toggleHidden($('task-tokens-row') as HTMLElement | null, false);
    toggleHidden($('subagent-tokens-row') as HTMLElement | null, false);
    setText(
      $('task-total-tokens'),
      `${count(task.tokens?.totalTokens)} tok${task.state === 'loading' ? ` (${t('loading')})` : ''}`,
    );
    setText($('subagent-tokens'), `${count(task.subagentTokens)} tok`);
    setText($('subagent-tokens-label'), t('taskTokensSubagents', { count: task.subagents }));
  } else {
    toggleHidden($('task-tokens-row') as HTMLElement | null, true);
    toggleHidden($('subagent-tokens-row') as HTMLElement | null, true);
  }
  toggleHidden($('cache-note') as HTMLElement | null, true);

  // 本轮汇总（最新一条用户消息维度）
  const turn = speed?.turnMetrics ?? null;
  toggleHidden($('turn-section') as HTMLElement | null, !turn);
  if (turn) {
    setText($('turn-state'), formatTurnStateLabel(turn.state, t));
    setText($('turn-requests'), t('turnRequestsCount', { n: turn.requests }));
    setText($('turn-tokens'), `${compact(turn.thinkingTokens)} / ${compact(turn.outputTokens)} tok`);
  }

  tickInlineMonitorLive(root, data, language);
}

/**
 * 每秒实时刷新依赖本地时钟的底栏监控项：
 * Prompt Cache 保鲜进度条、本轮实时耗时与异常/首字等待告警胶囊。
 */
export function tickInlineMonitorLive(
  root: ShadowRoot,
  data: WidgetMetricsSnapshot | null | undefined,
  language: WidgetLanguage,
  nowMs = Date.now(),
): void {
  if (!data) return;
  const $ = (id: string) => root.getElementById(id);
  const t = language.t;
  const speed = data.speed;
  const prefs = resolveMonitorPrefs(data.preferences);

  // 1. 本轮实时耗时（运行中跳秒，结束后固定）
  const turn = speed?.turnMetrics ?? null;
  if (turn) {
    const liveSec =
      turn.durationSeconds !== null
        ? turn.durationSeconds
        : (turn.state === 'running' || turn.state === 'queued') && turn.startedAtMs
          ? Math.max(0, (nowMs - turn.startedAtMs) / 1000)
          : null;
    setText($('turn-duration'), language.elapsed(liveSec));
  }

  // 3. Prompt Cache 过期倒计时提醒
  const ttl = resolveCacheTtl(
    speed?.lastResponseAtMs,
    nowMs,
    speed?.isGenerating === true,
    prefs,
  );
  const cacheChip = root.querySelector<HTMLElement>('[data-card="cache"]');
  if (cacheChip) {
    cacheChip.dataset.ttl = ttl.state;
  }
  const ttlSection = $('cache-ttl-section') as HTMLElement | null;
  if (ttlSection) {
    toggleHidden(ttlSection, !speed || ttl.state === 'idle');
    ttlSection.dataset.ttl = ttl.state;
    setText($('cache-ttl-text'), formatCacheTtlText(ttl, t));
    setStyle(
      $('cache-ttl-fill') as HTMLElement | null,
      'width',
      ttl.state === 'active' ? '100%' : `${Math.round(ttl.progress * 100)}%`,
    );
  }

  // 4. 请求失败 + 首字等待告警胶囊（平时隐藏，仅异常或卡首字时弹出）
  const err = speed?.requestError ?? null;
  const waitAlert = summarizeActiveWaitAlert(speed?.turnQueue, nowMs, prefs.firstTokenWaitSeconds);
  const badge = resolveAlertBadge(err, waitAlert, t);
  const alertChip = root.querySelector<HTMLElement>('[data-card="alert"]');
  if (alertChip) {
    toggleHidden(alertChip, !badge.visible);
    alertChip.dataset.severity = badge.severity;
    if (badge.visible) setText($('alert-chip-text'), badge.label);
  }
  if (!badge.visible) {
    const alertCard = $('alert-card') as HTMLElement | null;
    if (alertCard && !alertCard.hidden) {
      if (alertCard.hasAttribute('popover') && alertCard.matches(':popover-open')) {
        try { alertCard.hidePopover(); } catch {}
      }
      toggleHidden(alertCard, true);
    }
  }
  const hasVisibleErr = Boolean(err && err.kind !== 'none' && err.kind !== 'canceled');
  const errBlock = $('alert-error-block') as HTMLElement | null;
  if (errBlock) {
    toggleHidden(errBlock, !hasVisibleErr);
    if (hasVisibleErr && err) {
      const copy = errorKindCopy(err.kind, t);
      setText($('alert-error-badge'), copy.label);
      setText($('alert-error-desc'), copy.desc);
      const retryEl = $('alert-error-retry') as HTMLElement | null;
      toggleHidden(retryEl, err.retryAfterSec === null);
      if (err.retryAfterSec !== null) {
        setText(retryEl, t('alertRetryAfter', { sec: Math.round(err.retryAfterSec) }));
      }
      const diagEl = $('alert-error-diag') as HTMLElement | null;
      toggleHidden(diagEl, !err.diagnostic);
      if (err.diagnostic) setText(diagEl, err.diagnostic);
    }
  }
  const waitBlock = $('alert-wait-block') as HTMLElement | null;
  if (waitBlock) {
    toggleHidden(waitBlock, !waitAlert.active);
    if (waitAlert.active) {
      setText(
        $('alert-wait-summary'),
        waitAlert.isWaitingNow && waitAlert.currentWaitSec !== null
          ? t('alertWaitActive', {
              sec: Math.round(waitAlert.currentWaitSec),
              n: waitAlert.count,
            })
          : t('alertWaitCompleted', {
              n: waitAlert.count,
              threshold: prefs.firstTokenWaitSeconds,
              sec: Math.round(waitAlert.maxWaitSec),
            }),
      );
    }
  }
}
