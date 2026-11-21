import type { ModelUsageBucket, QuotaGroup, QuotaWindow, QuotaWindowUsage } from '../../contracts/index.ts';
import { setAttr, setStyle, setText } from '../../shared/dom.ts';
import { compact, percent } from '../../shared/format.ts';
import { groupQuotaPace, quotaForecast, shortEta } from '../../shared/quota-forecast.ts';
import {
  INLINE_MIX_PALETTE,
  SVG_NS,
  createDonutSegment,
  formatQuotaGroupLabel,
  partitionModelSlices,
  selectPreferredQuotaGroup,
} from '../shared/model-donut.ts';
import { toggleHidden } from './cards.ts';
import type { ComposerMatch, WidgetLanguage, WidgetMetricsSnapshot } from './types.ts';

interface CachedWindowUsageEntry {
  resetMinute: number | null;
  usage: QuotaWindowUsage;
}

const inlineQuotaUsageCaches = new WeakMap<
  ShadowRoot,
  { account: string | null; windows: Map<string, CachedWindowUsageEntry> }
>();

function getInlineQuotaUsageCache(root: ShadowRoot) {
  let entry = inlineQuotaUsageCaches.get(root);
  if (!entry) {
    entry = { account: null, windows: new Map() };
    inlineQuotaUsageCaches.set(root, entry);
  }
  return entry;
}

const DONUT_RADIUS = 13;
const DONUT_CIRC = 2 * Math.PI * DONUT_RADIUS;

export function formatGroupLabel(group: QuotaGroup | null | undefined, language: WidgetLanguage): string {
  return formatQuotaGroupLabel(group, language.t('group'));
}

export function selectQuotaGroup(
  groups: QuotaGroup[],
  chosen: string | null,
  composer: ComposerMatch | null,
  data: WidgetMetricsSnapshot,
): QuotaGroup | undefined {
  const model =
    composer?.model?.getAttribute('aria-label') ||
    composer?.model?.textContent ||
    data.speed?.model ||
    '';
  return selectPreferredQuotaGroup(groups, chosen, model);
}

export function renderModelDonut(
  root: ShadowRoot,
  models: ModelUsageBucket[],
  language: WidgetLanguage,
): void {
  const mixBox = root.getElementById('model-mix-compact') as HTMLElement | null;
  if (!mixBox) return;
  const showMix = models.length >= 2;
  toggleHidden(mixBox, !showMix);

  if (!showMix) {
    if (mixBox.dataset.signature !== 'hidden') {
      mixBox.dataset.signature = 'hidden';
      root.getElementById('model-mix-svg')?.replaceChildren();
      root.getElementById('model-mix-legend')?.replaceChildren();
    }
    return;
  }

  setText(root.getElementById('model-mix-count'), language.t('modelMixModelsCount', { count: models.length }));
  const items = partitionModelSlices(models, {
    metric: 'total',
    maxVisible: 3,
    headCount: 3,
    otherLabel: language.t('modelMixOther'),
    otherColor: 'var(--pulse-muted)',
    palette: INLINE_MIX_PALETTE,
  });

  const mixSig = `${language.language}|${models.length}|${items.map((it) => `${it.id}:${it.name}:${it.value}:${it.color}`).join(';')}`;
  if (mixBox.dataset.signature === mixSig) return;
  mixBox.dataset.signature = mixSig;

  const totalMix = items.reduce((acc, it) => acc + it.value, 0);
  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('class', 'model-mix-track');
  track.setAttribute('cx', '18');
  track.setAttribute('cy', '18');
  track.setAttribute('r', String(DONUT_RADIUS));
  const circles: SVGCircleElement[] = [track];

  if (totalMix > 0) {
    let offset = 0;
    for (const it of items) {
      if (it.value <= 0) continue;
      const len = (it.value / totalMix) * DONUT_CIRC;
      circles.push(
        createDonutSegment({
          cx: 18,
          cy: 18,
          r: DONUT_RADIUS,
          className: 'model-mix-seg',
          color: it.color,
          dasharray: `${len.toFixed(2)} ${DONUT_CIRC.toFixed(2)}`,
          dashoffset: `${(-offset).toFixed(2)}`,
          modelId: it.id,
        }),
      );
      offset += len;
    }
  }

  root.getElementById('model-mix-svg')?.replaceChildren(...circles);
  root.getElementById('model-mix-legend')?.replaceChildren(
    ...items.map((it) => {
      const row = document.createElement('div');
      row.className = 'model-mix-item';
      const left = document.createElement('span');
      left.className = 'model-mix-label';
      const dot = document.createElement('i');
      dot.className = 'model-mix-dot';
      dot.style.setProperty('background', it.color);
      const name = document.createElement('span');
      name.className = 'model-mix-name';
      name.textContent = it.name;
      name.title = it.name;
      left.append(dot, name);
      const val = document.createElement('span');
      val.className = 'model-mix-val';
      const share = totalMix > 0 ? Math.round((it.value / totalMix) * 100) : 0;
      val.textContent = `${share}% (${compact(it.value)})`;
      row.append(left, val);
      return row;
    }),
  );
}

export function renderQuotaSection(
  root: ShadowRoot,
  group: QuotaGroup | undefined,
  data: WidgetMetricsSnapshot,
  composer: ComposerMatch | null,
  language: WidgetLanguage,
): void {
  const $ = (id: string) => root.getElementById(id);
  const serverMs = typeof data.serverTime === 'string' ? Date.parse(data.serverTime) : NaN;
  const now = Number.isFinite(serverMs) ? serverMs : Date.now();
  const usageCache = getInlineQuotaUsageCache(root);
  const activeAccount = data.usage?.recordingAccount ?? data.usage?.activeAccount ?? null;
  if (data.usage && activeAccount !== usageCache.account) {
    usageCache.account = activeAccount;
    usageCache.windows.clear();
  }
  const quotaWindowsMap = data.quotaWindows ?? data.usage?.quotaWindows ?? null;

  // 渲染当前分组的综合消耗节奏徽标
  const paceBadge = $('quota-pace') as HTMLElement | null;
  if (paceBadge) {
    const pace = groupQuotaPace(group, now);
    toggleHidden(paceBadge, !pace);
    if (pace) {
      const labelText = language.t(pace.labelKey);
      const winLabel = language.t(pace.windowKey);
      setText($('quota-pace-text'), labelText);
      setAttr(paceBadge, 'data-pace', pace.pace);
      setAttr(paceBadge, 'data-critical', pace.critical ? 'true' : null);
      setAttr(paceBadge, 'title', pace.pace === 'idle' ? labelText : `${winLabel} · ${labelText}`);
    }
  }

  for (const [windowKey, name] of [
    ['5h', 'five'],
    ['weekly', 'week'],
  ] as const) {
    const windowData: QuotaWindow | undefined = group?.windows?.[windowKey];
    const available = windowData?.available === true;
    const remaining = available ? windowData.remaining : null;
    const resetAt = available ? windowData.resetAt : null;
    const disabled = available ? windowData.disabled : false;
    const forecast = quotaForecast(windowData, windowKey, now);

    setText($(name), percent(remaining));
    setText($(`${name}-balance`), percent(remaining));
    setText($(`${name}-reset`), language.resetDate(resetAt));

    const fill = $(`${name}-fill`) as HTMLElement | null;
    const projectedFill = $(`${name}-projected-fill`) as HTMLElement | null;
    setStyle(fill, 'width', typeof remaining === 'number' ? `${remaining * 100}%` : '0%');
    setStyle(
      fill,
      'background',
      typeof remaining === 'number' && remaining < 0.05
        ? 'var(--pulse-danger)'
        : (typeof remaining === 'number' && remaining < 0.2) || forecast?.willExhaust
          ? 'var(--pulse-warning)'
          : '',
    );

    // 实心段始终表示真实余额，斜纹尾段表示按当前速率预计重置前会继续消耗的部分
    const projectedRemaining = forecast?.projectedRemaining ?? null;
    const showHatch = Boolean(
      forecast?.forecastReady &&
        typeof remaining === 'number' &&
        projectedRemaining !== null &&
        projectedRemaining < remaining - 0.005,
    );
    if (projectedFill) {
      setStyle(projectedFill, 'left', showHatch && projectedRemaining !== null ? `${projectedRemaining * 100}%` : '0%');
      setStyle(
        projectedFill,
        'width',
        showHatch && typeof remaining === 'number' && projectedRemaining !== null
          ? `${(remaining - projectedRemaining) * 100}%`
          : '0%',
      );
    }

    const forecastRow = $(`${name}-forecast`) as HTMLElement | null;
    const forecastText = $(`${name}-forecast-text`) as HTMLElement | null;
    if (forecastRow && forecastText) {
      const showForecast = Boolean(forecast && typeof forecast.timeRemaining === 'number');
      toggleHidden(forecastRow, !showForecast);
      if (showForecast && forecast) {
        if (forecast.willExhaust) {
          setText(
            forecastText,
            language.t('forecastDepletes', {
              eta: shortEta(forecast.exhaustInMs),
              early: shortEta(forecast.earlyByMs),
            }),
          );
          setAttr(forecastText, 'data-alert', 'true');
        } else {
          setAttr(forecastText, 'data-alert', null);
          setText(
            forecastText,
            forecast.warmingUp
              ? language.t('forecastWarming', { pct: percent(forecast.used) })
              : language.t('forecastLeft', { pct: percent(forecast.projectedRemaining) }),
          );
        }
        setAttr(
          forecastRow,
          'title',
          language.t('forecastBasis', {
            remaining: percent(forecast.remaining),
            time: percent(forecast.timeRemaining),
          }),
        );
      }
    }

    const usageRow = $(`${name}-usage`) as HTMLElement | null;
    if (usageRow) {
      const winKey = group?.id ? `${group.id}:${windowKey}` : null;
      const resetMs = typeof resetAt === 'string' ? Date.parse(resetAt) : NaN;
      const resetMinute = Number.isFinite(resetMs) ? Math.round(resetMs / 60000) : null;
      const rawUsage = winKey && available && !disabled ? quotaWindowsMap?.[winKey] : null;
      let winUsage =
        rawUsage && typeof rawUsage.observedTokens === 'number' && rawUsage.observedTokens > 0
          ? rawUsage
          : null;
      if (winKey && winUsage) {
        usageCache.windows.set(winKey, { resetMinute, usage: winUsage });
      } else if (winKey && available && !disabled && !quotaWindowsMap && resetMinute !== null) {
        const prev = usageCache.windows.get(winKey);
        if (prev && prev.resetMinute !== null && Math.abs(prev.resetMinute - resetMinute) <= 2) {
          const usedFrac = typeof remaining === 'number' ? Math.max(0, Math.min(1, 1 - remaining)) : null;
          const estFull =
            prev.usage.observedTokens > 0 && usedFrac !== null && usedFrac >= 0.05
              ? Math.round(prev.usage.observedTokens / usedFrac)
              : null;
          winUsage = { ...prev.usage, estimatedFullTokens: estFull };
        }
      } else if (winKey && quotaWindowsMap) {
        usageCache.windows.delete(winKey);
      }

      const showUsage = Boolean(winUsage && winUsage.observedTokens > 0);
      toggleHidden(usageRow, !showUsage);
      if (showUsage && winUsage) {
        const refText = winUsage.estimatedFullTokens
          ? ` (${language.t('quotaWindowFullRef', { full: compact(winUsage.estimatedFullTokens) })})`
          : '';
        setText($(`${name}-usage-value`), `${compact(winUsage.observedTokens)} tok${refText}`);
        setAttr(usageRow, 'title', language.t('quotaWindowBasis'));
      } else {
        setAttr(usageRow, 'title', null);
      }
    }

    const track = $(`${name}-track`);
    setAttr(track, 'aria-valuenow', typeof remaining === 'number' ? remaining * 100 : null);
    setAttr(track, 'aria-valuemin', '0');
    setAttr(track, 'aria-valuemax', '100');

    const updatedTime = data.quotaUpdatedAt
      ? new Date(data.quotaUpdatedAt).toLocaleTimeString(language.language, { hour12: false })
      : '—';
    const noteBody =
      language.errorMessage(data.error) ||
      (disabled
        ? language.t('disabledQuota')
        : !available
          ? language.t('noQuota')
          : `${language.t('sharedQuota')} ${language.t('updated', { time: updatedTime })}`);
    setText($(`${name}-note`), `${composer?.kind === 'subagent' ? `${language.t('accountQuota')} ` : ''}${noteBody}`);
  }
}

export function renderGroupSelector(
  root: ShadowRoot,
  groups: QuotaGroup[],
  activeGroup: QuotaGroup | undefined,
  language: WidgetLanguage,
  onSelect: (groupId: string, trigger: HTMLElement | null) => void,
): void {
  const signature = groups.map((g) => g.id).join('|');
  for (const button of root.querySelectorAll<HTMLButtonElement>('.group-trigger')) {
    const nextLabel = `${formatGroupLabel(activeGroup, language)} ▾`;
    if (button.textContent !== nextLabel) button.textContent = nextLabel;
    const menu = button.parentElement?.querySelector<HTMLElement>('.group-menu');
    if (!menu) continue;
    if (menu.dataset.signature !== signature) {
      menu.replaceChildren(
        ...groups.map((g) => {
          const option = document.createElement('button');
          option.type = 'button';
          option.setAttribute('role', 'option');
          option.textContent = formatGroupLabel(g, language);
          option.dataset.group = g.id;
          option.addEventListener('click', () => {
            onSelect(g.id, menu.parentElement?.querySelector<HTMLElement>('.group-trigger') ?? null);
          });
          return option;
        }),
      );
      menu.dataset.signature = signature;
    }
    for (const option of menu.children) {
      setAttr(option, 'aria-selected', (option as HTMLElement).dataset.group === activeGroup?.id);
    }
  }
}
