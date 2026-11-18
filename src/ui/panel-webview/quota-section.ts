import type { QuotaGroup, QuotaWindow, QuotaWindowAvailable, TokenSummary } from '../../contracts/index.ts';
import { createEl, setAttr, setHidden, setStyle, setText } from '../../shared/dom.ts';
import { compact, count, percent, rate } from '../../shared/format.ts';
import { formatQuotaGroupLabel, selectPreferredQuotaGroup, SVG_NS } from '../shared/model-donut.ts';
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

const quotaToneColor = (remaining: number | null | undefined): string =>
  typeof remaining === 'number' && remaining < 0.05
    ? 'var(--pulse-quota-red)'
    : typeof remaining === 'number' && remaining < 0.2
      ? 'var(--pulse-quota-yellow)'
      : typeof remaining === 'number'
        ? 'var(--pulse-quota-green)'
        : 'var(--pulse-muted)';

export function applyQuotaFill(fill: HTMLElement | null, remaining: number | null | undefined): void {
  setStyle(
    fill,
    'width',
    typeof remaining === 'number' ? `${Math.min(100, Math.max(0, remaining * 100))}%` : '0%',
  );
  setStyle(fill, 'background', quotaToneColor(remaining));
}

function readAvailableWindow(bucket: QuotaWindow | undefined): QuotaWindowAvailable | null {
  if (!bucket?.available) return null;
  const avail = bucket as QuotaWindowAvailable;
  if (avail.disabled || typeof avail.remaining !== 'number' || !Number.isFinite(avail.remaining)) {
    return null;
  }
  return avail;
}

function resolveQuotaFamily(group: QuotaGroup): { letter: string; color: string } {
  const hint = `${group.name || ''} ${group.id || ''}`;
  if (/claude|gpt|3p/i.test(hint)) {
    return { letter: 'C', color: 'var(--pulse-claude)' };
  }
  if (/gemini/i.test(hint)) {
    return { letter: 'G', color: 'var(--pulse-gemini)' };
  }
  const ch = (group.name || group.id || '?').trim().charAt(0).toUpperCase();
  return { letter: ch || '?', color: 'var(--pulse-accent)' };
}

function createSvgCircle(attrs: Record<string, string | number>): SVGCircleElement {
  const circle = document.createElementNS(SVG_NS, 'circle');
  for (const [k, v] of Object.entries(attrs)) {
    circle.setAttribute(k, String(v));
  }
  return circle;
}

export function renderQuotaRings(ctx: PanelDomContext, groups: ReadonlyArray<QuotaGroup>): void {
  const { $, state, language } = ctx;
  const t = language.t;
  const pill = $('quota-rings-pill');
  const popover = $('quota-popover');
  if (!pill || !popover) return;

  const label = t('quotaRingsLabel');
  setAttr(pill, 'aria-label', label);
  setAttr(pill, 'title', label);
  setAttr(popover, 'aria-label', label);

  const usable = groups.filter(
    (g) => readAvailableWindow(g.windows?.weekly) || readAvailableWindow(g.windows?.['5h']),
  );

  const sig = `${language.language}|${usable
    .map((g) => {
      const w = readAvailableWindow(g.windows?.weekly);
      const f = readAvailableWindow(g.windows?.['5h']);
      return `${g.id}:${g.name}:${w?.remaining ?? ''}:${w?.resetAt ?? ''}:${f?.remaining ?? ''}:${f?.resetAt ?? ''}`;
    })
    .join('|')}`;
  if (sig === state.lastQuotaSig) return;
  state.lastQuotaSig = sig;

  pill.replaceChildren();
  popover.replaceChildren();

  if (usable.length === 0) {
    pill.appendChild(createEl('span', { class: 'quota-unavailable-text', text: t('unavailableQuota') }));
    popover.appendChild(createEl('div', { class: 'quota-pop-empty', text: t('unavailableQuota') }));
    return;
  }

  const now = Date.now() + state.serverOffset;

  for (const g of usable) {
    const weekAvail = readAvailableWindow(g.windows?.weekly);
    const fiveAvail = readAvailableWindow(g.windows?.['5h']);
    const has5h = Boolean(fiveAvail);
    const family = resolveQuotaFamily(g);

    const innerR = has5h ? 8.3 : 10.0;
    const innerOuterW = has5h ? 2.5 : 2.6;
    const innerHoleW = has5h ? 1.2 : 1.25;
    const wPct = weekAvail ? Math.max(0, Math.min(100, (weekAvail.remaining ?? 0) * 100)) : 0;
    const weeklyColor = weekAvail ? quotaToneColor(weekAvail.remaining) : 'var(--pulse-ring-track)';

    const wrap = createEl('span', { class: 'quota-ring-item' });
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'quota-ring-svg');
    svg.setAttribute('viewBox', '0 0 28 28');
    svg.setAttribute('aria-hidden', 'true');

    svg.appendChild(
      createSvgCircle({
        cx: 14,
        cy: 14,
        r: (innerR - innerOuterW / 2 - 0.7).toFixed(2),
        fill: `color-mix(in srgb, ${family.color} 10%, transparent)`,
      }),
    );

    svg.appendChild(
      createSvgCircle({
        cx: 14,
        cy: 14,
        r: innerR,
        fill: 'none',
        stroke: weeklyColor,
        'stroke-opacity': weekAvail ? '0.75' : '0.45',
        'stroke-width': innerOuterW,
      }),
    );

    svg.appendChild(
      createSvgCircle({
        cx: 14,
        cy: 14,
        r: innerR,
        fill: 'none',
        stroke: 'var(--pill-bg)',
        'stroke-width': innerHoleW,
      }),
    );

    if (wPct > 0) {
      const innerArcAttrs: Record<string, string | number> = {
        class: 'quota-ring-arc',
        cx: 14,
        cy: 14,
        r: innerR,
        fill: 'none',
        stroke: weeklyColor,
        'stroke-width': innerOuterW,
      };
      if (wPct < 99) {
        innerArcAttrs.pathLength = 100;
        innerArcAttrs['stroke-linecap'] = 'round';
        innerArcAttrs['stroke-dasharray'] = `${wPct} ${100 - wPct}`;
        innerArcAttrs.transform = 'rotate(-90 14 14)';
      }
      svg.appendChild(createSvgCircle(innerArcAttrs));
    }

    if (fiveAvail && (fiveAvail.remaining ?? 0) > 0) {
      const fPct = Math.max(0, Math.min(100, (fiveAvail.remaining ?? 0) * 100));
      const outerArcAttrs: Record<string, string | number> = {
        class: 'quota-ring-arc',
        cx: 14,
        cy: 14,
        r: 12.1,
        fill: 'none',
        stroke: quotaToneColor(fiveAvail.remaining),
        'stroke-width': 1.35,
      };
      if (fPct < 99) {
        outerArcAttrs.pathLength = 100;
        outerArcAttrs['stroke-linecap'] = 'round';
        outerArcAttrs['stroke-dasharray'] = `${fPct} ${100 - fPct}`;
        outerArcAttrs.transform = 'rotate(-90 14 14)';
      }
      svg.appendChild(createSvgCircle(outerArcAttrs));
    }

    const letterEl = createEl('span', { class: 'quota-ring-letter', text: family.letter });
    letterEl.style.color = family.color;
    wrap.append(svg, letterEl);
    pill.appendChild(wrap);

    // 悬停完整列表项
    const block = createEl('div', { class: 'quota-pop-group' });
    const title = createEl('div', { class: 'quota-pop-title' });
    title.appendChild(createEl('span', { text: g.name || groupLabel(g) }));
    if (!has5h) {
      title.appendChild(createEl('span', { class: 'quota-pop-badge', text: t('quotaNo5hTag') }));
    }
    block.appendChild(title);

    const rows: Array<{ label: string; bucket: QuotaWindowAvailable }> = [];
    if (weekAvail) rows.push({ label: t('week'), bucket: weekAvail });
    if (fiveAvail) rows.push({ label: t('five'), bucket: fiveAvail });

    for (const r of rows) {
      const row = createEl('div', { class: 'quota-pop-row' });
      const meta = createEl('div', { class: 'quota-pop-meta' });
      meta.appendChild(createEl('span', { text: r.label }));
      const pctText = percent(r.bucket.remaining);
      const resetText = r.bucket.resetAt ? language.countdown(r.bucket.resetAt, now, true) : '';
      const nums = createEl('span', {
        class: 'quota-pop-nums',
        text: resetText ? `${pctText} · ${resetText}` : pctText,
      });
      nums.dataset.pct = pctText;
      if (r.bucket.resetAt) nums.dataset.resetAt = r.bucket.resetAt;
      meta.appendChild(nums);

      const track = createEl('div', { class: 'quota-pop-track' });
      const fill = createEl('i', { class: 'quota-pop-fill' });
      applyQuotaFill(fill, r.bucket.remaining);
      track.appendChild(fill);
      row.append(meta, track);
      block.appendChild(row);
    }

    popover.appendChild(block);
  }
}

export function renderQuotaAndSpeedSections(ctx: PanelDomContext, value: PanelMetricsSnapshot): void {
  const { $, state, language } = ctx;
  const t = language.t;
  const groups = value.groups || [];
  const speed = value.speed;
  state.group = chooseGroup(ctx, groups, speed);
  renderQuotaRings(ctx, groups);

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

  const pctStr =
    hasCapacity && context.usedFraction != null ? `${Math.min(1, Math.max(0, context.usedFraction)) * 100}%` : '0%';
  const ctxColor =
    hasCapacity && (context.usedFraction ?? 0) >= 0.9
      ? 'var(--pulse-danger)'
      : hasCapacity && (context.usedFraction ?? 0) >= 0.8
        ? 'var(--pulse-warning)'
        : '';

  const stripFill = $('strip-context-fill');
  const stripTrack = $('strip-context-track');
  setStyle(stripFill, 'width', pctStr);
  setStyle(stripFill, 'background', ctxColor);
  if (hasCapacity && context.usedFraction != null) {
    setAttr(stripTrack, 'aria-valuenow', String(Math.min(100, context.usedFraction * 100)));
  } else {
    setAttr(stripTrack, 'aria-valuenow', null);
  }

  const ctxFill = $('context-fill');
  const ctxTrack = $('context-track');
  setStyle(ctxFill, 'width', pctStr);
  setStyle(ctxFill, 'background', ctxColor);
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
  const popover = $('quota-popover');
  if (popover) {
    for (const el of popover.querySelectorAll<HTMLElement>('.quota-pop-nums[data-reset-at]')) {
      const resetAt = el.dataset.resetAt;
      const pctText = el.dataset.pct || '—';
      if (resetAt) {
        setText(el, `${pctText} · ${language.countdown(resetAt, now, true)}`);
      }
    }
  }

  for (const group of state.snapshot?.groups || []) {
    for (const windowName of ['5h', 'weekly'] as const) {
      const avail = readAvailableWindow(group.windows?.[windowName]);
      if (
        avail?.resetAt &&
        Date.parse(avail.resetAt) <= now &&
        state.snapshot?.connection === 'live' &&
        now - state.lastExpiredRefresh > 30000
      ) {
        state.lastExpiredRefresh = now;
        onExpiredRefresh();
        return;
      }
    }
  }
}
