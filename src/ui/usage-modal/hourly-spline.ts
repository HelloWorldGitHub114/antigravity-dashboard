import type { UsageDayIndex } from './aggregator.ts';
import type { TooltipController } from './tooltip.ts';
import type { UsageDomContext, UsageTotalsResult } from './types.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  txt?: string,
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (txt !== undefined) n.textContent = txt;
  return n;
}

export function renderHourlySpline(
  ctx: UsageDomContext,
  dayIndex: UsageDayIndex,
  tooltip: TooltipController,
): void {
  const { $, text, state, w, compactNum } = ctx;
  const section = $('hourly-section');
  if (!section || !state.value) return;

  text('hourly-toggle-title', w('小时用量趋势', 'Hourly trend'));
  text('hourly-mode-combined', w('时段合集', 'Period total'));
  text('hourly-mode-today', w('今日', 'Today'));
  $('hourly-mode-combined')?.setAttribute('aria-pressed', String(state.hourlyMode === 'combined'));
  $('hourly-mode-today')?.setAttribute('aria-pressed', String(state.hourlyMode === 'today'));
  $('hourly-toggle')?.setAttribute('aria-expanded', String(state.hourlyExpanded));
  const content = $('hourly-content');
  if (content) content.hidden = !state.hourlyExpanded;

  let hours: number[] | null | undefined = null;
  if (state.hourlyMode === 'today') {
    hours = state.value.todayHours || dayIndex.dayMap.get(state.value.today)?.hours;
    text('hourly-title', w('今日 24 小时用量趋势', "Today's 24-Hour Trend"));
  } else {
    const isSingleDay = state.selectedBar && state.selectedBar.from === state.selectedBar.to;
    if (isSingleDay && state.selectedBar) {
      const targetDate = state.selectedBar.from;
      const day = dayIndex.dayMap.get(targetDate);
      hours = day?.hours || (targetDate === state.value.today ? state.value.todayHours : null);
      text(
        'hourly-title',
        targetDate === state.value.today
          ? w('今日 24 小时用量趋势', "Today's 24-Hour Trend")
          : w(`${targetDate} 24 小时用量趋势`, `${targetDate} 24-Hour Trend`),
      );
    } else {
      const start = state.selectedBar ? state.selectedBar.from : state.currentBuckets[0]?.from || state.value.today;
      const end = state.selectedBar ? state.selectedBar.to : state.currentBuckets.at(-1)?.to || state.value.today;
      hours = dayIndex.aggregateHourlyRange(start, end);
      text(
        'hourly-title',
        w('所选时段 24 小时聚合分布', 'Period 24-Hour Distribution') +
          (state.currentBuckets.length ? ` (${start} – ${end})` : ''),
      );
    }
  }

  if (!hours || !Array.isArray(hours) || hours.length < 24) hours = Array<number>(24).fill(0);
  const totalHourly = hours.reduce((n, c) => n + c, 0);
  const isSingleDay = state.hourlyMode === 'today' || Boolean(state.selectedBar && state.selectedBar.from === state.selectedBar.to);
  text(
    'hourly-subtitle',
    !isSingleDay
      ? w(`${compactNum(totalHourly)} Token · 24小时合集用量`, `${compactNum(totalHourly)} tokens · 24-hour aggregate`)
      : w(`${compactNum(totalHourly)} Token · 每小时用量`, `${compactNum(totalHourly)} tokens · hourly distribution`),
  );
  if (!state.hourlyExpanded) return;

  const maxVal = Math.max(1, ...hours);
  const padL = 40;
  const padR = 15;
  const padT = 15;
  const padB = 25;
  const wPlot = 560;
  const hPlot = 90;
  const width = padL + wPlot + padR;
  const height = padT + hPlot + padB;
  const baseY = padT + hPlot;

  const pts = hours.map((v, i) => ({
    x: padL + (i / 23) * wPlot,
    y: baseY - (v / maxVal) * hPlot,
    val: v,
    hour: i,
  }));

  let pathD = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    let cp1y = p1.y + (p2.y - p0.y) / 6;
    let cp2y = p2.y - (p3.y - p1.y) / 6;
    if (p1.val === 0 && p2.val === 0) {
      cp1y = baseY;
      cp2y = baseY;
    } else {
      if (p1.val === 0) cp1y = baseY;
      if (p2.val === 0) cp2y = baseY;
      cp1y = Math.min(baseY, Math.max(padT, cp1y));
      cp2y = Math.min(baseY, Math.max(padT, cp2y));
    }
    pathD += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  const areaD = `${pathD} L ${pts.at(-1)!.x.toFixed(1)},${baseY.toFixed(1)} L ${pts[0].x.toFixed(1)},${baseY.toFixed(1)} Z`;

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, preserveAspectRatio: 'none' });
  svg.style.overflow = 'visible';
  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: 'hourly-area-grad', x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(
    svgEl('stop', { offset: '0%', 'stop-color': 'var(--pulse-accent)', 'stop-opacity': '0.35' }),
    svgEl('stop', { offset: '100%', 'stop-color': 'var(--pulse-accent)', 'stop-opacity': '0.01' }),
  );
  defs.append(grad);
  svg.append(defs);

  for (const r of [0, 0.5, 1]) {
    const gy = padT + hPlot * (1 - r);
    svg.append(
      svgEl('line', { x1: padL, y1: gy.toFixed(1), x2: padL + wPlot, y2: gy.toFixed(1), stroke: 'var(--pulse-separator)', 'stroke-width': '1' }),
      svgEl('text', { x: padL - 6, y: (gy + 3).toFixed(1), 'text-anchor': 'end', fill: 'var(--pulse-muted)', 'font-size': '9' }, compactNum(maxVal * r)),
    );
  }
  svg.append(
    svgEl('path', { d: areaD, fill: 'url(#hourly-area-grad)', class: 'hourly-area' }),
    svgEl('path', { d: pathD, fill: 'none', stroke: 'var(--pulse-accent)', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'hourly-line' }),
  );

  const crosshair = svgEl('line', { class: 'hourly-crosshair', x1: '0', y1: padT, x2: '0', y2: baseY, stroke: 'var(--pulse-accent)', 'stroke-opacity': '0.5', 'stroke-width': '1', 'stroke-dasharray': '2 2' });
  crosshair.style.opacity = '0';
  const focusRing = svgEl('circle', { class: 'hourly-focus-ring', cx: '0', cy: '0', r: '5.5', fill: 'none', stroke: 'var(--pulse-accent)', 'stroke-opacity': '0.65', 'stroke-width': '1.5' });
  focusRing.style.opacity = '0';
  svg.append(crosshair);

  const circles = pts.map((p) => {
    const c = svgEl('circle', { class: 'hourly-pt', cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: p.val > 0 ? '2.5' : '1.5', fill: 'var(--pulse-accent)', 'fill-opacity': p.val > 0 ? '1' : '0.4' });
    svg.append(c);
    return c;
  });
  svg.append(focusRing);

  for (const h of [0, 4, 8, 12, 16, 20, 23]) {
    svg.append(svgEl('text', { x: pts[h].x.toFixed(1), y: height - 6, 'text-anchor': 'middle', fill: 'var(--pulse-muted)', 'font-size': '9' }, `${String(h).padStart(2, '0')}:00`));
  }

  for (const p of pts) {
    const bucket: UsageTotalsResult = {
      from: `${String(p.hour).padStart(2, '0')}:00`,
      to: `${String(p.hour).padStart(2, '0')}:59`,
      total: p.val,
      requests: 0,
      models: {},
      modelVariants: {},
      users: {},
      legacyTokens: 0,
    };
    const bar = svgEl('rect', { x: (p.x - wPlot / 46).toFixed(1), y: padT, width: (wPlot / 23).toFixed(1), height: hPlot, fill: 'transparent', class: 'hourly-hover', 'data-h': p.hour, 'data-v': p.val });
    bar.style.cursor = 'pointer';
    const circle = circles[p.hour];
    bar.addEventListener('pointerenter', () => {
      crosshair.setAttribute('x1', p.x.toFixed(1));
      crosshair.setAttribute('x2', p.x.toFixed(1));
      crosshair.style.opacity = '1';
      focusRing.setAttribute('cx', p.x.toFixed(1));
      focusRing.setAttribute('cy', p.y.toFixed(1));
      focusRing.style.opacity = '1';
      circle.setAttribute('r', '4');
      circle.setAttribute('fill-opacity', '1');
      tooltip.show(bucket, bar);
    });
    bar.addEventListener('pointerleave', () => {
      crosshair.style.opacity = '0';
      focusRing.style.opacity = '0';
      circle.setAttribute('r', p.val > 0 ? '2.5' : '1.5');
      circle.setAttribute('fill-opacity', p.val > 0 ? '1' : '0.4');
      tooltip.hide();
    });
    svg.append(bar);
  }
  $('hourly-chart')?.replaceChildren(svg);
}
