import type { QuotaGroup, QuotaWindow, QuotaWindowAvailable, QuotaWindowUsage, TokenSummary } from '../../contracts/index.ts';
import { resolveMonitorPrefs } from '../../contracts/preferences.ts';
import { createEl, setAttr, setHidden, setStyle, setText } from '../../shared/dom.ts';
import { compact, count, percent, rate } from '../../shared/format.ts';
import { groupQuotaPace, quotaForecast, shortEta, type QuotaWindowKey } from '../../shared/quota-forecast.ts';
import {
  resolveCacheTtl,
  resolveContextLoad,
  resolveSpeedPulse,
  summarizeActiveWaitAlert,
} from '../../shared/request-alerts.ts';
import { formatQuotaGroupLabel, selectPreferredQuotaGroup, SVG_NS } from '../shared/model-donut.ts';
import {
  buildContextBreakdownSegments,
  errorKindCopy,
  formatCacheTtlText,
  formatTurnStateLabel,
  resolveAlertBadge,
} from '../shared/monitor-ui.ts';
import type { PanelDomContext, PanelMetricsSnapshot, PanelSpeedMetrics, PanelState } from './types.ts';

interface RingNodeRef {
  wrap: HTMLElement;
  innerBg: SVGCircleElement;
  innerTrack: SVGCircleElement;
  innerHole: SVGCircleElement;
  innerArc: SVGCircleElement;
  outerArc: SVGCircleElement;
  letterEl: HTMLElement;
}

interface PopoverRowRef {
  row: HTMLElement;
  labelEl: HTMLElement;
  numsEl: HTMLElement;
  fillEl: HTMLElement;
  projectedFillEl: HTMLElement;
  forecastEl: HTMLElement;
  forecastTextEl: HTMLElement;
  usageEl: HTMLElement;
  usageLabelEl: HTMLElement;
  usageValEl: HTMLElement;
}

interface PopoverGroupRef {
  block: HTMLElement;
  titleTextEl: HTMLElement;
  paceEl: HTMLElement;
  paceTextEl: HTMLElement;
  badgeEl: HTMLElement;
  weekRow: PopoverRowRef;
  fiveRow: PopoverRowRef;
}

interface CachedPanelWindowUsage {
  resetMinute: number | null;
  usage: QuotaWindowUsage;
}

interface QuotaDomCache {
  rings: Map<string, RingNodeRef>;
  popGroups: Map<string, PopoverGroupRef>;
  windowUsageAccount: string | null;
  windowUsage: Map<string, CachedPanelWindowUsage>;
  emptyPill: HTMLElement | null;
  emptyPop: HTMLElement | null;
  nextResetAtMs: number;
  resetTimesComputed: boolean;
}

const quotaCaches = new WeakMap<PanelState, QuotaDomCache>();

function getQuotaCache(state: PanelState): QuotaDomCache {
  let cache = quotaCaches.get(state);
  if (!cache) {
    cache = {
      rings: new Map(),
      popGroups: new Map(),
      windowUsageAccount: null,
      windowUsage: new Map(),
      emptyPill: null,
      emptyPop: null,
      nextResetAtMs: Infinity,
      resetTimesComputed: false,
    };
    quotaCaches.set(state, cache);
  }
  return cache;
}

function clampRatio(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

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
  setStyle(fill, '--fill-scale', String(clampRatio(remaining)));
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

function createRingNode(groupId: string): RingNodeRef {
  const wrap = createEl('span', { class: 'quota-ring-item', 'data-group-id': groupId });
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'quota-ring-svg');
  svg.setAttribute('viewBox', '0 0 28 28');
  svg.setAttribute('aria-hidden', 'true');

  const innerBg = createSvgCircle({ cx: 14, cy: 14, r: 6.35 });
  const innerTrack = createSvgCircle({ cx: 14, cy: 14, r: 8.3, fill: 'none' });
  const innerHole = createSvgCircle({ cx: 14, cy: 14, r: 8.3, fill: 'none', stroke: 'var(--pill-bg)' });
  const innerArc = createSvgCircle({
    class: 'quota-ring-arc',
    cx: 14,
    cy: 14,
    r: 8.3,
    fill: 'none',
    pathLength: 100,
    transform: 'rotate(-90 14 14)',
  });
  const outerArc = createSvgCircle({
    class: 'quota-ring-arc',
    cx: 14,
    cy: 14,
    r: 12.1,
    fill: 'none',
    'stroke-width': 1.35,
    pathLength: 100,
    transform: 'rotate(-90 14 14)',
  });

  svg.append(innerBg, innerTrack, innerHole, innerArc, outerArc);
  const letterEl = createEl('span', { class: 'quota-ring-letter' });
  wrap.append(svg, letterEl);
  return { wrap, innerBg, innerTrack, innerHole, innerArc, outerArc, letterEl };
}

function createPopoverRow(): PopoverRowRef {
  const row = createEl('div', { class: 'quota-pop-row' });
  const meta = createEl('div', { class: 'quota-pop-meta' });
  const labelEl = createEl('span');
  const numsEl = createEl('span', { class: 'quota-pop-nums' });
  meta.append(labelEl, numsEl);
  const track = createEl('div', { class: 'quota-pop-track' });
  const fillEl = createEl('i', { class: 'quota-pop-fill' });
  const projectedFillEl = createEl('i', { class: 'quota-pop-forecast-fill', 'aria-hidden': 'true' });
  track.append(fillEl, projectedFillEl);
  const forecastEl = createEl('div', { class: 'quota-pop-forecast', hidden: '' });
  const forecastTextEl = createEl('span', { class: 'quota-pop-forecast-text' });
  forecastEl.appendChild(forecastTextEl);
  const usageEl = createEl('div', { class: 'quota-pop-usage', hidden: '' });
  const usageLabelEl = createEl('span');
  const usageValEl = createEl('span', { class: 'quota-pop-usage-val' });
  usageEl.append(usageLabelEl, usageValEl);
  row.append(meta, track, forecastEl, usageEl);
  return { row, labelEl, numsEl, fillEl, projectedFillEl, forecastEl, forecastTextEl, usageEl, usageLabelEl, usageValEl };
}

function createPopoverGroup(groupId: string): PopoverGroupRef {
  const block = createEl('div', { class: 'quota-pop-group', 'data-group-id': groupId });
  const title = createEl('div', { class: 'quota-pop-title' });
  const titleTextEl = createEl('span', { class: 'quota-pop-title-text' });
  const badges = createEl('span', { class: 'quota-pop-badges' });
  const paceEl = createEl('span', { class: 'quota-pop-pace', hidden: '' });
  const paceDot = createEl('i', { class: 'quota-pop-pace-dot', 'aria-hidden': 'true' });
  const paceTextEl = createEl('span');
  paceEl.append(paceDot, paceTextEl);
  const badgeEl = createEl('span', { class: 'quota-pop-badge' });
  badges.append(paceEl, badgeEl);
  title.append(titleTextEl, badges);
  const weekRow = createPopoverRow();
  const fiveRow = createPopoverRow();
  block.append(title, weekRow.row, fiveRow.row);
  return { block, titleTextEl, paceEl, paceTextEl, badgeEl, weekRow, fiveRow };
}

function syncPopoverRow(
  rowRef: PopoverRowRef,
  label: string,
  windowKey: QuotaWindowKey,
  groupId: string,
  bucket: QuotaWindowAvailable | null,
  quotaWindows: Record<string, QuotaWindowUsage> | null | undefined,
  usageCache: Map<string, CachedPanelWindowUsage>,
  language: PanelDomContext['language'],
  now: number,
): void {
  if (!bucket) {
    setHidden(rowRef.row, true);
    delete rowRef.numsEl.dataset.resetAt;
    return;
  }
  setHidden(rowRef.row, false);
  setText(rowRef.labelEl, label);
  const pctText = percent(bucket.remaining);
  const resetText = bucket.resetAt ? language.countdown(bucket.resetAt, now, true) : '';
  setText(rowRef.numsEl, resetText ? `${pctText} · ${resetText}` : pctText);
  if (rowRef.numsEl.dataset.pct !== pctText) rowRef.numsEl.dataset.pct = pctText;
  if (bucket.resetAt) {
    if (rowRef.numsEl.dataset.resetAt !== bucket.resetAt) rowRef.numsEl.dataset.resetAt = bucket.resetAt;
  } else {
    delete rowRef.numsEl.dataset.resetAt;
  }

  const forecast = quotaForecast(bucket, windowKey, now);
  setStyle(rowRef.fillEl, '--fill-scale', String(clampRatio(bucket.remaining)));
  setStyle(
    rowRef.fillEl,
    'background',
    typeof bucket.remaining === 'number' && bucket.remaining < 0.05
      ? 'var(--pulse-quota-red)'
      : (typeof bucket.remaining === 'number' && bucket.remaining < 0.2) || forecast?.willExhaust
        ? 'var(--pulse-quota-yellow)'
        : quotaToneColor(bucket.remaining),
  );

  // 斜纹预测尾段：标记当前节奏下在重置前预计会消耗的区间
  const remaining = typeof bucket.remaining === 'number' ? bucket.remaining : null;
  const projectedRemaining = forecast?.projectedRemaining ?? null;
  const showHatch = Boolean(
    forecast?.forecastReady &&
      remaining !== null &&
      projectedRemaining !== null &&
      projectedRemaining < remaining - 0.005,
  );
  setStyle(
    rowRef.projectedFillEl,
    'left',
    showHatch && projectedRemaining !== null ? `${projectedRemaining * 100}%` : '0%',
  );
  setStyle(
    rowRef.projectedFillEl,
    'width',
    showHatch && remaining !== null && projectedRemaining !== null
      ? `${(remaining - projectedRemaining) * 100}%`
      : '0%',
  );

  const showForecast = Boolean(forecast && typeof forecast.timeRemaining === 'number');
  setHidden(rowRef.forecastEl, !showForecast);
  if (showForecast && forecast) {
    if (forecast.willExhaust) {
      setText(
        rowRef.forecastTextEl,
        language.t('forecastDepletes', {
          eta: shortEta(forecast.exhaustInMs),
          early: shortEta(forecast.earlyByMs),
        }),
      );
      setAttr(rowRef.forecastTextEl, 'data-alert', 'true');
    } else {
      setAttr(rowRef.forecastTextEl, 'data-alert', null);
      setText(
        rowRef.forecastTextEl,
        forecast.warmingUp
          ? language.t('forecastWarming', { pct: percent(forecast.used) })
          : language.t('forecastLeft', { pct: percent(forecast.projectedRemaining) }),
      );
    }
    setAttr(
      rowRef.forecastEl,
      'title',
      language.t(windowKey === 'weekly' ? 'forecastBasisWeekly' : 'forecastBasis', {
        remaining: percent(forecast.remaining),
        time: percent(forecast.timeRemaining),
      }),
    );
  }

  const winKey = `${groupId}:${windowKey}`;
  const resetMs = typeof bucket.resetAt === 'string' ? Date.parse(bucket.resetAt) : NaN;
  const resetMinute = Number.isFinite(resetMs) ? Math.round(resetMs / 60000) : null;
  const rawUsage = quotaWindows?.[winKey] ?? null;
  let winUsage =
    rawUsage && typeof rawUsage.observedTokens === 'number' && rawUsage.observedTokens > 0
      ? rawUsage
      : null;
  if (winUsage) {
    usageCache.set(winKey, { resetMinute, usage: winUsage });
  } else if (!quotaWindows && resetMinute !== null) {
    const prev = usageCache.get(winKey);
    if (prev && prev.resetMinute !== null && Math.abs(prev.resetMinute - resetMinute) <= 2) {
      const usedFrac = remaining !== null ? Math.max(0, Math.min(1, 1 - remaining)) : null;
      const estFull =
        prev.usage.observedTokens > 0 && usedFrac !== null && usedFrac >= 0.05
          ? Math.round(prev.usage.observedTokens / usedFrac)
          : null;
      winUsage = { ...prev.usage, estimatedFullTokens: estFull };
    }
  } else if (quotaWindows) {
    usageCache.delete(winKey);
  }

  const showUsage = Boolean(winUsage && winUsage.observedTokens > 0);
  setHidden(rowRef.usageEl, !showUsage);
  if (showUsage && winUsage) {
    setText(rowRef.usageLabelEl, language.t('quotaWindowUsage'));
    const refText = winUsage.estimatedFullTokens
      ? ` (${language.t('quotaWindowFullRef', { full: compact(winUsage.estimatedFullTokens) })})`
      : '';
    setText(rowRef.usageValEl, `${compact(winUsage.observedTokens)} tok${refText}`);
    setAttr(rowRef.usageEl, 'title', language.t('quotaWindowBasis'));
  } else {
    setAttr(rowRef.usageEl, 'title', null);
  }
}

function syncRingNode(
  ref: RingNodeRef,
  family: { letter: string; color: string },
  weekAvail: QuotaWindowAvailable | null,
  fiveAvail: QuotaWindowAvailable | null,
): void {
  const has5h = Boolean(fiveAvail);
  const innerR = has5h ? 8.3 : 10.0;
  const innerOuterW = has5h ? 2.5 : 2.6;
  const innerHoleW = has5h ? 1.2 : 1.25;
  const wPct = weekAvail ? Math.max(0, Math.min(100, (weekAvail.remaining ?? 0) * 100)) : 0;
  const weeklyColor = weekAvail ? quotaToneColor(weekAvail.remaining) : 'var(--pulse-ring-track)';

  setAttr(ref.innerBg, 'r', (innerR - innerOuterW / 2 - 0.7).toFixed(2));
  setAttr(ref.innerBg, 'fill', `color-mix(in srgb, ${family.color} 10%, transparent)`);

  setAttr(ref.innerTrack, 'r', innerR);
  setAttr(ref.innerTrack, 'stroke', weeklyColor);
  setAttr(ref.innerTrack, 'stroke-opacity', weekAvail ? '0.75' : '0.45');
  setAttr(ref.innerTrack, 'stroke-width', innerOuterW);

  setAttr(ref.innerHole, 'r', innerR);
  setAttr(ref.innerHole, 'stroke-width', innerHoleW);

  if (wPct > 0) {
    setAttr(ref.innerArc, 'display', null);
    setAttr(ref.innerArc, 'r', innerR);
    setAttr(ref.innerArc, 'stroke', weeklyColor);
    setAttr(ref.innerArc, 'stroke-width', innerOuterW);
    setAttr(ref.innerArc, 'stroke-linecap', wPct < 99 ? 'round' : null);
    setAttr(ref.innerArc, 'stroke-dasharray', wPct < 99 ? `${wPct} ${100 - wPct}` : '100 0');
  } else {
    setAttr(ref.innerArc, 'display', 'none');
    setAttr(ref.innerArc, 'stroke-dasharray', '0 100');
  }

  if (fiveAvail) {
    const remaining5h = fiveAvail.remaining ?? 0;
    if (remaining5h > 0) {
      const fPct = Math.max(0, Math.min(100, remaining5h * 100));
      setAttr(ref.outerArc, 'display', null);
      setAttr(ref.outerArc, 'data-depleted', null);
      setAttr(ref.outerArc, 'stroke-opacity', null);
      setAttr(ref.outerArc, 'stroke', quotaToneColor(remaining5h));
      setAttr(ref.outerArc, 'stroke-linecap', fPct < 99 ? 'round' : null);
      setAttr(ref.outerArc, 'stroke-dasharray', fPct < 99 ? `${fPct} ${100 - fPct}` : '100 0');
    } else {
      setAttr(ref.outerArc, 'display', null);
      setAttr(ref.outerArc, 'data-depleted', 'true');
      setAttr(ref.outerArc, 'stroke', 'var(--pulse-quota-red)');
      setAttr(ref.outerArc, 'stroke-linecap', null);
      setAttr(ref.outerArc, 'stroke-dasharray', '4.5 3.83');
      setAttr(ref.outerArc, 'stroke-opacity', '0.92');
    }
  } else {
    setAttr(ref.outerArc, 'display', 'none');
    setAttr(ref.outerArc, 'data-depleted', null);
    setAttr(ref.outerArc, 'stroke-opacity', null);
    setAttr(ref.outerArc, 'stroke-dasharray', '0 100');
  }

  setText(ref.letterEl, family.letter);
  setStyle(ref.letterEl, 'color', family.color);
}

export function renderQuotaRings(
  ctx: PanelDomContext,
  groups: ReadonlyArray<QuotaGroup>,
  quotaWindows?: Record<string, QuotaWindowUsage> | null,
  activeAccount?: string | null,
): void {
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

  const now = Date.now() + state.serverOffset;
  const minuteBucket = Math.floor(now / 60000);
  const winUsageSig = quotaWindows
    ? Object.entries(quotaWindows)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v.observedTokens}/${v.estimatedFullTokens ?? ''}`)
        .join(',')
    : '';
  const sig = `${language.language}|${minuteBucket}|${winUsageSig}|${usable
    .map((g) => {
      const w = readAvailableWindow(g.windows?.weekly);
      const f = readAvailableWindow(g.windows?.['5h']);
      const fTag = f ? ((f.remaining ?? 0) <= 0 ? '0:depleted' : String(f.remaining)) : '';
      return `${g.id}:${g.name}:${w?.remaining ?? ''}:${w?.resetAt ?? ''}:${fTag}:${f?.resetAt ?? ''}`;
    })
    .join('|')}`;
  if (sig === state.lastQuotaSig) return;
  state.lastQuotaSig = sig;

  const cache = getQuotaCache(state);
  if (activeAccount !== undefined && activeAccount !== cache.windowUsageAccount) {
    cache.windowUsageAccount = activeAccount;
    cache.windowUsage.clear();
  }
  let nextResetAtMs = Infinity;
  for (const g of groups) {
    for (const windowName of ['5h', 'weekly'] as const) {
      const avail = readAvailableWindow(g.windows?.[windowName]);
      if (avail?.resetAt) {
        const parsed = Date.parse(avail.resetAt);
        if (Number.isFinite(parsed) && parsed < nextResetAtMs) nextResetAtMs = parsed;
      }
    }
  }
  cache.nextResetAtMs = nextResetAtMs;
  cache.resetTimesComputed = true;

  if (usable.length === 0) {
    for (const ref of cache.rings.values()) ref.wrap.remove();
    cache.rings.clear();
    for (const ref of cache.popGroups.values()) ref.block.remove();
    cache.popGroups.clear();

    if (!cache.emptyPill) {
      cache.emptyPill = createEl('span', { class: 'quota-unavailable-text' });
    }
    setText(cache.emptyPill, t('unavailableQuota'));
    for (const child of [...pill.children]) {
      if (child !== cache.emptyPill) child.remove();
    }
    if (cache.emptyPill.parentNode !== pill) pill.appendChild(cache.emptyPill);

    if (!cache.emptyPop) {
      cache.emptyPop = createEl('div', { class: 'quota-pop-empty' });
    }
    setText(cache.emptyPop, t('unavailableQuota'));
    for (const child of [...popover.children]) {
      if (child !== cache.emptyPop) child.remove();
    }
    if (cache.emptyPop.parentNode !== popover) popover.appendChild(cache.emptyPop);
    return;
  }

  cache.emptyPill?.remove();
  cache.emptyPop?.remove();

  const desiredIds = new Set(usable.map((g) => g.id));
  for (const [id, ref] of cache.rings) {
    if (!desiredIds.has(id)) {
      ref.wrap.remove();
      cache.rings.delete(id);
    }
  }
  for (const [id, ref] of cache.popGroups) {
    if (!desiredIds.has(id)) {
      ref.block.remove();
      cache.popGroups.delete(id);
    }
  }
  // Remove any unmanaged initial placeholder children (e.g. "Loading quota…").
  for (const child of [...pill.children]) {
    const gid = (child as HTMLElement).dataset?.groupId;
    if (!gid || !cache.rings.has(gid)) child.remove();
  }
  for (const child of [...popover.children]) {
    const gid = (child as HTMLElement).dataset?.groupId;
    if (!gid || !cache.popGroups.has(gid)) child.remove();
  }

  let pillCursor: Element | null = pill.firstElementChild;
  let popCursor: Element | null = popover.firstElementChild;

  for (const g of usable) {
    const weekAvail = readAvailableWindow(g.windows?.weekly);
    const fiveAvail = readAvailableWindow(g.windows?.['5h']);
    const has5h = Boolean(fiveAvail);
    const family = resolveQuotaFamily(g);

    let ringRef = cache.rings.get(g.id);
    if (!ringRef) {
      ringRef = createRingNode(g.id);
      cache.rings.set(g.id, ringRef);
    }
    syncRingNode(ringRef, family, weekAvail, fiveAvail);
    if (ringRef.wrap !== pillCursor) {
      pill.insertBefore(ringRef.wrap, pillCursor);
    } else {
      pillCursor = pillCursor.nextElementSibling;
    }

    let popRef = cache.popGroups.get(g.id);
    if (!popRef) {
      popRef = createPopoverGroup(g.id);
      cache.popGroups.set(g.id, popRef);
    }
    setText(popRef.titleTextEl, g.name || groupLabel(g));
    const pace = groupQuotaPace(g, now);
    setHidden(popRef.paceEl, !pace);
    if (pace) {
      const paceLabel = t(pace.labelKey);
      const winLabel = t(pace.windowKey);
      setText(popRef.paceTextEl, paceLabel);
      setAttr(popRef.paceEl, 'data-pace', pace.pace);
      setAttr(popRef.paceEl, 'data-critical', pace.critical ? 'true' : null);
      setAttr(popRef.paceEl, 'title', pace.pace === 'idle' ? paceLabel : `${winLabel} · ${paceLabel}`);
    }
    setHidden(popRef.badgeEl, has5h);
    if (!has5h) setText(popRef.badgeEl, t('quotaNo5hTag'));
    syncPopoverRow(popRef.weekRow, t('week'), 'weekly', g.id, weekAvail, quotaWindows, cache.windowUsage, language, now);
    syncPopoverRow(popRef.fiveRow, t('five'), '5h', g.id, fiveAvail, quotaWindows, cache.windowUsage, language, now);
    if (popRef.block !== popCursor) {
      popover.insertBefore(popRef.block, popCursor);
    } else {
      popCursor = popCursor.nextElementSibling;
    }
  }
}

export function renderQuotaAndSpeedSections(ctx: PanelDomContext, value: PanelMetricsSnapshot): void {
  const { $, state, language } = ctx;
  const t = language.t;
  const groups = value.groups || [];
  const speed = value.speed;
  state.group = chooseGroup(ctx, groups, speed);
  const quotaWindows = value.quotaWindows ?? value.usage?.quotaWindows ?? null;
  const activeAccount = value.usage?.recordingAccount ?? value.usage?.activeAccount;
  renderQuotaRings(ctx, groups, quotaWindows, activeAccount);

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
  const isCompacted = context?.compacted === true;
  const planModel = speed?.planModel || null;
  const activeModel = speed?.activeModel || null;
  const isHybrid = Boolean(planModel && activeModel && planModel !== activeModel);

  const usedPrefix = isCompacted ? '~' : '';
  setText(
    $('strip-context-size'),
    context
      ? `${usedPrefix}${compact(context.usedTokens)} / ${context.maxTokens === null ? '—' : compact(context.maxTokens)}`
      : '—',
  );
  setAttr(
    $('context-tab'),
    'title',
    context
      ? t('contextTokens', {
          used: `${usedPrefix}${count(context.usedTokens)}`,
          max: context.maxTokens === null ? '—' : count(context.maxTokens),
        })
      : t('contextUnknown'),
  );
  const usedPct = hasCapacity && context.usedFraction != null ? Math.round(context.usedFraction * 100) : null;
  setText(
    $('context-summary'),
    usedPct !== null
      ? isCompacted
        ? t('contextCompactedUsed', { used: usedPct })
        : t('contextUsed', {
            used: usedPct,
            remaining: Math.round((context?.remainingFraction ?? 0) * 100),
          })
      : t('contextUnknown'),
  );
  setText(
    $('context-tokens'),
    context
      ? t('contextTokens', {
          used: `${usedPrefix}${compact(context.usedTokens)}`,
          max: context.maxTokens === null ? '—' : compact(context.maxTokens),
        })
      : '—',
  );
  const compactions = Math.max(
    context?.compactionCount ?? 0,
    speed?.transcriptStats?.compactionMarkers ?? 0,
  );
  const compactionPill = $('context-compaction-pill');
  setHidden(compactionPill, compactions <= 0);
  if (compactions > 0) {
    setText(compactionPill, `🗜 ${t('contextCompactionCount', { n: compactions })}`);
    setAttr(compactionPill, 'title', t('contextCompactionsTitle', { n: compactions }));
  }
  const compactedNote = $('context-compacted-note');
  setHidden(compactedNote, !isCompacted);
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
  setText($('context-model'), context?.model || activeModel || '—');
  const sessionModelCount = speed?.modelUsage?.models?.length || 0;
  const showOrchContext = isHybrid || sessionModelCount >= 2;
  setHidden($('context-orchestrator-row'), !showOrchContext);
  setHidden($('context-orchestrator-note'), !showOrchContext);
  if (showOrchContext) {
    setText($('context-orchestrator'), planModel || t('modelMixModelsCount', { count: sessionModelCount }));
    setText($('context-orchestrator-note'), t(isHybrid ? 'contextQuotaSplit' : 'contextMultiModelHint'));
  }

  const monitorPrefs = resolveMonitorPrefs(value.preferences);
  const contextLoad = hasCapacity && !isCompacted ? resolveContextLoad(context.usedFraction, monitorPrefs) : 'normal';
  const contextTab = $('context-tab');
  if (contextTab) contextTab.dataset.load = contextLoad;

  const fillScale = hasCapacity && context.usedFraction != null ? String(clampRatio(context.usedFraction)) : '0';
  const ctxColor =
    contextLoad === 'danger'
      ? 'var(--pulse-danger)'
      : contextLoad === 'warn'
        ? 'var(--pulse-warning)'
        : '';

  const breakdownSegments = buildContextBreakdownSegments(isCompacted ? null : context?.breakdown);
  setHidden($('panel-context-breakdown'), breakdownSegments.length === 0);
  for (const seg of breakdownSegments) {
    setStyle($(`panel-ctx-seg-bar-${seg.key}`), 'width', `${seg.pct.toFixed(2)}%`);
    setText($(`panel-ctx-seg-val-${seg.key}`), `${compact(seg.tokens)} (${Math.round(seg.pct)}%)`);
  }

  const stripFill = $('strip-context-fill');
  const stripTrack = $('strip-context-track');
  setStyle(stripFill, '--fill-scale', fillScale);
  setStyle(stripFill, 'background', ctxColor);
  if (hasCapacity && context.usedFraction != null) {
    setAttr(stripTrack, 'aria-valuenow', String(Math.min(100, context.usedFraction * 100)));
  } else {
    setAttr(stripTrack, 'aria-valuenow', null);
  }

  const ctxFill = $('context-fill');
  const ctxTrack = $('context-track');
  setStyle(ctxFill, '--fill-scale', fillScale);
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

  // 本轮统计（最新一条用户消息维度）
  const turn = speed?.turnMetrics ?? null;
  setHidden($('panel-turn-section'), !turn);
  if (turn) {
    setText($('panel-turn-state'), formatTurnStateLabel(turn.state, t));
    setText($('panel-turn-requests'), t('turnRequestsCount', { n: turn.requests }));
    setText($('panel-turn-tokens'), `${compact(turn.thinkingTokens)} / ${compact(turn.outputTokens)} tok`);
  }

  updatePanelMonitorLive(ctx, Date.now());
}

/**
 * 每秒刷新侧栏中的实时时钟指标：速度呼吸灯、本轮耗时、缓存保鲜进度与异常/等待横幅。
 */
export function updatePanelMonitorLive(ctx: PanelDomContext, nowMs = Date.now()): void {
  const { $, state, language } = ctx;
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const speed = snapshot.speed;
  const t = language.t;
  const prefs = resolveMonitorPrefs(snapshot.preferences);

  const pulse = resolveSpeedPulse(
    speed?.latestTps ?? speed?.tps,
    speed?.isGenerating === true,
    speed?.lastResponseAtMs,
    nowMs,
    prefs.speedPulseEnabled,
  );
  const pulseEl = $('panel-speed-pulse');
  if (pulseEl) {
    setHidden(pulseEl, !pulse.visible || !speed);
    pulseEl.dataset.level = pulse.level;
    pulseEl.classList.toggle('is-blinking', pulse.blinking);
  }

  const turn = speed?.turnMetrics ?? null;
  if (turn) {
    const liveSec =
      turn.durationSeconds !== null
        ? turn.durationSeconds
        : (turn.state === 'running' || turn.state === 'queued') && turn.startedAtMs
          ? Math.max(0, (nowMs - turn.startedAtMs) / 1000)
          : null;
    setText($('panel-turn-duration'), language.elapsed(liveSec));
  }

  const ttl = resolveCacheTtl(
    speed?.lastResponseAtMs,
    nowMs,
    speed?.isGenerating === true,
    prefs,
  );
  const cacheTab = $('cache-tab');
  if (cacheTab) cacheTab.dataset.ttl = ttl.state;
  const ttlBox = $('panel-cache-ttl');
  if (ttlBox) {
    setHidden(ttlBox, !speed || ttl.state === 'idle');
    ttlBox.dataset.ttl = ttl.state;
    setText($('panel-cache-ttl-text'), formatCacheTtlText(ttl, t));
    setStyle(
      $('panel-cache-ttl-fill'),
      'width',
      ttl.state === 'active' ? '100%' : `${Math.round(ttl.progress * 100)}%`,
    );
  }

  const err = speed?.requestError ?? null;
  const waitAlert = summarizeActiveWaitAlert(speed?.turnQueue, nowMs, prefs.firstTokenWaitSeconds);
  const badge = resolveAlertBadge(err, waitAlert, t);
  const banner = $('panel-alert-banner');
  if (banner) {
    setHidden(banner, !badge.visible);
    banner.dataset.severity = badge.severity;
    if (badge.visible) {
      setText($('panel-alert-title'), badge.label);
      const hasVisibleErr = Boolean(err && err.kind !== 'none' && err.kind !== 'canceled');
      if (hasVisibleErr && err) {
        const copy = errorKindCopy(err.kind, t);
        setText($('panel-alert-desc'), copy.desc);
        setHidden($('panel-alert-retry'), err.retryAfterSec === null);
        if (err.retryAfterSec !== null) {
          setText($('panel-alert-retry'), t('alertRetryAfter', { sec: Math.round(err.retryAfterSec) }));
        }
        setHidden($('panel-alert-diag'), !err.diagnostic);
        if (err.diagnostic) setText($('panel-alert-diag'), err.diagnostic);
      } else {
        setHidden($('panel-alert-retry'), true);
        setHidden($('panel-alert-diag'), true);
        setText(
          $('panel-alert-desc'),
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
}

export function updateCountdowns(
  ctx: PanelDomContext,
  onExpiredRefresh: () => void,
  options: { forceDom?: boolean } = {},
): void {
  const { $, state, language } = ctx;
  const now = Date.now() + state.serverOffset;
  if (!document.hidden || options.forceDom) {
    updatePanelMonitorLive(ctx, Date.now());
  }
  const popover = $('quota-popover');
  const pill = $('quota-rings-pill');
  const popoverOpen = Boolean(
    popover && (popover.matches?.(':popover-open') || pill?.getAttribute('aria-expanded') === 'true'),
  );
  const cache = quotaCaches.get(state);

  if (popover && (options.forceDom || (!document.hidden && popoverOpen))) {
    if (cache && cache.popGroups.size > 0) {
      for (const groupRef of cache.popGroups.values()) {
        for (const rowRef of [groupRef.weekRow, groupRef.fiveRow]) {
          if (rowRef.row.hidden) continue;
          const resetAt = rowRef.numsEl.dataset.resetAt;
          const pctText = rowRef.numsEl.dataset.pct || '—';
          if (resetAt) {
            setText(rowRef.numsEl, `${pctText} · ${language.countdown(resetAt, now, true)}`);
          }
        }
      }
    } else {
      for (const el of popover.querySelectorAll<HTMLElement>('.quota-pop-nums[data-reset-at]')) {
        const resetAt = el.dataset.resetAt;
        const pctText = el.dataset.pct || '—';
        if (resetAt) {
          setText(el, `${pctText} · ${language.countdown(resetAt, now, true)}`);
        }
      }
    }
  }

  if (state.snapshot?.connection !== 'live' || now - state.lastExpiredRefresh <= 30000) return;

  if (cache?.resetTimesComputed) {
    if (cache.nextResetAtMs <= now) {
      state.lastExpiredRefresh = now;
      onExpiredRefresh();
    }
    return;
  }

  for (const group of state.snapshot?.groups || []) {
    for (const windowName of ['5h', 'weekly'] as const) {
      const avail = readAvailableWindow(group.windows?.[windowName]);
      if (avail?.resetAt && Date.parse(avail.resetAt) <= now) {
        state.lastExpiredRefresh = now;
        onExpiredRefresh();
        return;
      }
    }
  }
}
