import type { TimelineNode } from '../../contracts/index.ts';
import { setAttr, setHidden, setText } from '../../shared/dom.ts';
import { compact } from '../../shared/format.ts';
import { assignModelColors, PANEL_MIX_PALETTE } from '../shared/model-donut.ts';
import { syncPinBottom } from './dom-motion.ts';
import {
  createChevronSvg,
  formatClock,
  formatDurationMs,
  renderTimelineStatus,
  showSwimlaneTip,
  timelineEventLabel,
  timelineNodeSummary,
} from './timeline-helpers.ts';
import type { PanelDomContext, PanelSpeedMetrics } from './types.ts';

export { renderTimelineStatus, showSwimlaneTip };

function buildTimelineTreeNode(ctx: PanelDomContext, node: TimelineNode, depth: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'timeline-node';
  el.dataset.kind = node.kind || 'step';
  el.dataset.nodeId = node.id || '';
  const meta = (node.meta || {}) as Record<string, string | number | null | undefined>;
  if (meta.stepStart != null) el.dataset.stepStart = String(meta.stepStart);
  if (meta.stepEnd != null) el.dataset.stepEnd = String(meta.stepEnd);
  if (meta.stepIndex != null) el.dataset.stepIndex = String(meta.stepIndex);
  const children = Array.isArray(node.children) ? node.children : [];
  const hasChildren = children.length > 0;
  const collapsed = hasChildren && (ctx.state.timelineToggled.has(node.id) ? Boolean(ctx.state.timelineToggled.get(node.id)) : depth >= 2);
  const row = document.createElement('div');
  row.className = 'timeline-node-row';
  if (hasChildren) {
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'timeline-toggle-btn';
    toggleBtn.dataset.nodeId = node.id;
    setAttr(toggleBtn, 'aria-expanded', String(!collapsed));
    setAttr(toggleBtn, 'aria-label', timelineEventLabel(ctx, node));
    toggleBtn.appendChild(createChevronSvg());
    row.appendChild(toggleBtn);
  } else {
    const bullet = document.createElement('span');
    bullet.className = 'timeline-bullet';
    bullet.textContent = '·';
    row.appendChild(bullet);
  }
  const eventBadge = document.createElement('span');
  eventBadge.className = 'timeline-event-badge';
  eventBadge.textContent = timelineEventLabel(ctx, node);
  const main = document.createElement('div');
  main.className = 'timeline-node-main';
  const summary = document.createElement('span');
  summary.className = 'timeline-node-summary';
  const summaryText = timelineNodeSummary(ctx, node);
  summary.textContent = summaryText;
  if (summaryText) setAttr(summary, 'title', summaryText);
  main.append(eventBadge, summary);
  const badges = document.createElement('div');
  badges.className = 'timeline-node-badges';
  if (node.model && node.kind !== 'handoff' && !summaryText.includes(node.model)) {
    const mChip = document.createElement('span');
    mChip.className = 'timeline-chip';
    mChip.textContent = node.model;
    setAttr(mChip, 'title', node.model);
    badges.appendChild(mChip);
  }
  const tokTotal = node.tokens?.totalTokens || node.tokens?.outputTokens || 0;
  if (tokTotal > 0) {
    const tChip = document.createElement('span');
    tChip.className = 'timeline-chip';
    tChip.textContent = `${compact(tokTotal)} tok`;
    badges.appendChild(tChip);
  }
  const dur = formatDurationMs(node.durationMs);
  if (dur) {
    const dChip = document.createElement('span');
    dChip.className = 'timeline-chip';
    dChip.textContent = dur;
    badges.appendChild(dChip);
  }
  const clk = formatClock(ctx, node.time);
  if (clk) {
    const cChip = document.createElement('span');
    cChip.className = 'timeline-chip is-time';
    cChip.textContent = clk;
    badges.appendChild(cChip);
  }
  row.append(main, badges);
  el.appendChild(row);
  if (hasChildren) {
    const kidsEl = document.createElement('div');
    kidsEl.className = 'timeline-children';
    kidsEl.hidden = collapsed;
    for (const child of children) kidsEl.appendChild(buildTimelineTreeNode(ctx, child, depth + 1));
    el.appendChild(kidsEl);
  }
  return el;
}

export function renderTimeline(ctx: PanelDomContext, speed: PanelSpeedMetrics | null | undefined): void {
  const { $, state, language } = ctx;
  const t = language.t;
  const offBar = $('timeline-off-bar');
  const panel = $('timeline-panel');
  const swimWrap = $('timeline-swimlanes-wrap');
  const swimEl = $('timeline-swimlanes');
  const treeEl = $('timeline-tree');
  if (!offBar || !panel || !swimEl || !treeEl) return;

  for (const btnId of ['timeline-enable-btn', 'timeline-disable-btn', 'timeline-clear-btn']) {
    const btn = $<HTMLButtonElement>(btnId);
    if (btn) btn.disabled = state.timelineBusy;
  }
  renderTimelineStatus(ctx);
  if (!state.timelineEnabled) {
    setHidden(offBar, false);
    setHidden(panel, true);
    if (swimEl.children.length) swimEl.textContent = '';
    if (treeEl.children.length) treeEl.textContent = '';
    state.lastTimelineRender = [];
    state.lastTimelineSig = null;
    syncPinBottom(ctx);
    return;
  }
  setHidden(offBar, true);
  setHidden(panel, false);
  syncPinBottom(ctx);
  const tl = speed?.modelTimeline || null;
  const nodes = Array.isArray(tl?.nodes) ? tl.nodes : [];
  const swimlanes = Array.isArray(tl?.swimlanes) ? tl.swimlanes : [];
  const countEl = $('timeline-count');
  setText(countEl, String(nodes.length));
  setHidden(countEl, nodes.length === 0);
  setHidden($('timeline-truncated'), !tl?.truncated);
  setHidden($('timeline-empty'), nodes.length > 0 || swimlanes.length > 0);
  setHidden(swimWrap, swimlanes.length === 0);

  const sig = `${language.language}|${tl?.cascadeId || ''}|${tl?.savedAt || ''}|${Boolean(tl?.truncated)}|${JSON.stringify(swimlanes)}|${JSON.stringify(nodes)}`;
  if (sig === state.lastTimelineSig) return;
  state.lastTimelineSig = sig;
  const colorModels = [
    ...(speed?.modelUsage?.models || []),
    ...swimlanes.map((s) => ({
      name: s.model || s.label,
      role: s.kind === 'plan' || s.kind === 'worker' || s.kind === 'subagent' ? s.kind : 'model',
    })),
  ];
  const colorMap = assignModelColors(colorModels);
  swimEl.textContent = '';
  state.lastTimelineRender = [];
  showSwimlaneTip(ctx, -1);

  if (swimlanes.length > 0) {
    const tracks = [
      { key: 'plan', label: t('timelineLanePlan'), match: (s: (typeof swimlanes)[number]) => s.kind === 'plan' },
      { key: 'worker', label: t('timelineLaneWorker'), match: (s: (typeof swimlanes)[number]) => s.kind === 'worker' },
      { key: 'tools', label: t('timelineLaneToolsAgents'), match: (s: (typeof swimlanes)[number]) => s.kind === 'tool' || s.kind === 'subagent' || s.kind === 'handoff' },
    ];
    for (const trackDef of tracks) {
      const lane = document.createElement('div');
      lane.className = 'timeline-lane';
      lane.dataset.lane = trackDef.key;
      const lbl = document.createElement('span');
      lbl.className = 'timeline-lane-label';
      lbl.textContent = trackDef.label;
      setAttr(lbl, 'title', trackDef.label);
      const track = document.createElement('div');
      track.className = 'timeline-track';
      for (const seg of swimlanes.filter(trackDef.match)) {
        const idx = state.lastTimelineRender.length;
        state.lastTimelineRender.push(seg);
        const leftPct = Math.min(98.5, Math.max(0, (Number(seg.startRatio) || 0) * 100));
        const widthPct = Math.min(100 - leftPct, Math.max(1.5, (Number(seg.widthRatio) || 0.02) * 100));
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'timeline-seg';
        btn.dataset.segIdx = String(idx);
        btn.dataset.kind = seg.kind || 'step';
        btn.style.left = `${leftPct.toFixed(2)}%`;
        btn.style.width = `${widthPct.toFixed(2)}%`;
        btn.style.background = seg.kind === 'handoff'
          ? 'var(--pulse-warning)'
          : colorMap.get(seg.model || seg.label) || PANEL_MIX_PALETTE[idx % PANEL_MIX_PALETTE.length];
        const tipLabel = [
          seg.model || seg.label,
          seg.stepStart != null ? `#${seg.stepStart}${seg.stepEnd != null && seg.stepEnd !== seg.stepStart ? `–${seg.stepEnd}` : ''}` : '',
          formatDurationMs((seg.endMs ?? 0) - (seg.startMs ?? 0)),
        ].filter(Boolean).join(' · ');
        setAttr(btn, 'title', tipLabel);
        setAttr(btn, 'aria-label', tipLabel);
        track.appendChild(btn);
      }
      lane.append(lbl, track);
      swimEl.appendChild(lane);
    }
  }
  treeEl.textContent = '';
  for (const node of nodes) treeEl.appendChild(buildTimelineTreeNode(ctx, node, 0));
}

export function focusTimelineNodeByStep(ctx: PanelDomContext, stepStart: number | null | undefined): void {
  const treeEl = ctx.$('timeline-tree');
  if (!treeEl || stepStart == null) return;
  let targetNode: HTMLElement | null = null;
  for (const el of treeEl.querySelectorAll<HTMLElement>('.timeline-node')) {
    const row = el.querySelector<HTMLElement>(':scope > .timeline-node-row');
    if (row) row.classList.remove('is-active');
    const idx = el.dataset.stepIndex != null ? Number(el.dataset.stepIndex) : null;
    const s = el.dataset.stepStart != null ? Number(el.dataset.stepStart) : null;
    const e = el.dataset.stepEnd != null ? Number(el.dataset.stepEnd) : null;
    if (idx === stepStart || (s != null && s === stepStart) || (s != null && e != null && stepStart >= s && stepStart <= e)) {
      if (!targetNode || idx === stepStart || s === stepStart) targetNode = el;
    }
  }
  if (!targetNode) return;
  let cur = targetNode.parentElement;
  while (cur && cur !== treeEl) {
    if (cur.classList.contains('timeline-children')) {
      cur.hidden = false;
      const parentNode = cur.closest<HTMLElement>('.timeline-node');
      if (parentNode?.dataset.nodeId) {
        ctx.state.timelineToggled.set(parentNode.dataset.nodeId, false);
        const btn = parentNode.querySelector<HTMLElement>(':scope > .timeline-node-row > .timeline-toggle-btn');
        setAttr(btn ?? null, 'aria-expanded', 'true');
      }
    }
    cur = cur.parentElement;
  }
  const activeRow = targetNode.querySelector<HTMLElement>(':scope > .timeline-node-row');
  if (activeRow) {
    activeRow.classList.add('is-active');
    activeRow.scrollIntoView({ block: 'nearest' });
  }
}
