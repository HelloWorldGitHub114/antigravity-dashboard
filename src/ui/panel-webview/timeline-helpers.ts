import type { TimelineNode } from '../../contracts/index.ts';
import { setHidden, setText } from '../../shared/dom.ts';
import { roleLabel } from './model-mix.ts';
import type { PanelDomContext } from './types.ts';

export function renderTimelineStatus(ctx: PanelDomContext): void {
  const { $, state, language } = ctx;
  const el = $('timeline-status');
  if (!el) return;
  if (!state.timelineNoticeKey) {
    setHidden(el, true);
    setText(el, '');
    el.classList.remove('is-error');
    return;
  }
  setHidden(el, false);
  el.classList.toggle('is-error', state.timelineNoticeIsError);
  setText(el, language.t(state.timelineNoticeKey));
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
}

export function formatClock(ctx: PanelDomContext, iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString(ctx.language.language, { hour12: false }) : '';
}

export function timelineEventLabel(ctx: PanelDomContext, node: TimelineNode): string {
  const t = ctx.language.t;
  if (node.event === 'model_switch') return t('timelineEventModelSwitch');
  switch (node.kind) {
    case 'turn': return t('timelineEventTurn');
    case 'handoff': return t('timelineEventHandoff');
    case 'tool_group': return t('timelineEventToolGroup');
    case 'subagent': return t('timelineEventSubagent');
    case 'error': return t('timelineEventError');
    case 'phase':
    case 'model_call':
      return node.role === 'plan'
        ? t('timelineEventPlan')
        : node.role === 'worker'
          ? t('timelineEventWorker')
          : roleLabel(ctx, node.role);
    default: return node.event || node.kind || 'step';
  }
}

export function timelineNodeSummary(ctx: PanelDomContext, node: TimelineNode): string {
  const t = ctx.language.t;
  const meta = (node.meta || {}) as Record<string, string | number | null | undefined>;
  if (node.kind === 'turn') {
    const turnPart = meta.turnIndex ? `#${meta.turnIndex}` : '';
    const spanPart = meta.stepStart != null
      ? `#${meta.stepStart}${meta.stepEnd != null && meta.stepEnd !== meta.stepStart ? `–${meta.stepEnd}` : ''}`
      : '';
    return [turnPart, spanPart].filter(Boolean).join(' · ') || node.event || '';
  }
  if (node.kind === 'handoff' || node.event === 'model_switch') {
    return `${meta.fromModel || '?'} \u2192 ${meta.toModel || node.model || '?'}`;
  }
  if (node.kind === 'tool_group') {
    const callsText = t('modelCallsCount', { count: meta.calls || 1 });
    return meta.category ? `${meta.category} · ${callsText}` : callsText;
  }
  if (node.kind === 'subagent') {
    const title = String(meta.role || node.model || '');
    return meta.status ? `${title} · ${meta.status}` : title;
  }
  const stepPrefix = meta.stepIndex != null ? `#${meta.stepIndex} ` : '';
  return `${stepPrefix}${node.model || node.event || ''}`.trim();
}

export function showSwimlaneTip(ctx: PanelDomContext, idx: number): void {
  const { $, state, language } = ctx;
  const tip = $('timeline-lane-tip');
  const swimHost = $('timeline-swimlanes');
  if (swimHost) {
    for (const segEl of swimHost.querySelectorAll<HTMLElement>('.timeline-seg')) {
      segEl.classList.toggle('is-active', Number(segEl.dataset.segIdx) === idx);
    }
  }
  if (!tip) return;
  if (idx < 0 || idx >= state.lastTimelineRender.length) {
    setHidden(tip, true);
    setText(tip, '');
    return;
  }
  const seg = state.lastTimelineRender[idx];
  const stepLabel = seg.stepStart != null
    ? `#${seg.stepStart}${seg.stepEnd != null && seg.stepEnd !== seg.stepStart ? `–${seg.stepEnd}` : ''}`
    : '';
  const durLabel = formatDurationMs((seg.endMs ?? 0) - (seg.startMs ?? 0));
  const callsLabel = (seg.calls ?? 0) > 0 ? language.t('modelCallsCount', { count: seg.calls ?? 0 }) : '';
  setText(tip, [seg.model || seg.label, stepLabel, durLabel, callsLabel].filter(Boolean).join(' · '));
  setHidden(tip, false);
}

export function createChevronSvg(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#chevron');
  svg.appendChild(use);
  return svg;
}
