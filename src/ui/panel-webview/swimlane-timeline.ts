import type { TimelineNode, TimelineSwimlaneItem } from '../../contracts/index.ts';
import { setAttr, setHidden, setStyle, setText } from '../../shared/dom.ts';
import { compact } from '../../shared/format.ts';
import { assignModelColors, PANEL_MIX_PALETTE } from '../shared/model-donut.ts';
import { panelMotion, setExpandedState, syncPinBottom } from './dom-motion.ts';
import {
  createChevronSvg,
  formatClock,
  formatDurationMs,
  registerSwimlaneSegments,
  renderTimelineStatus,
  resetSwimlaneTipState,
  showSwimlaneTip,
  timelineEventLabel,
  timelineNodeSummary,
  yieldToMain,
} from './timeline-helpers.ts';
import type { PanelDomContext, PanelSpeedMetrics, PanelState } from './types.ts';

export { renderTimelineStatus, showSwimlaneTip };

interface LaneRef {
  lane: HTMLElement;
  label: HTMLElement;
  track: HTMLElement;
  segments: HTMLButtonElement[];
}

interface TimelineNodeRef {
  el: HTMLElement;
  row: HTMLElement;
  toggleBtn: HTMLButtonElement | null;
  bullet: HTMLElement | null;
  eventBadge: HTMLElement;
  summary: HTMLElement;
  badges: HTMLElement;
  mChip: HTMLElement | null;
  tChip: HTMLElement | null;
  dChip: HTMLElement | null;
  cChip: HTMLElement | null;
  childrenEl: HTMLElement | null;
  childMap: Map<string, HTMLElement>;
  lastSig: string;
}

interface TimelineDomCache {
  lanes: Map<string, LaneRef>;
  rootNodes: Map<string, HTMLElement>;
  activeTreeRow: HTMLElement | null;
  renderGen: number;
}

const timelineCaches = new WeakMap<PanelState, TimelineDomCache>();
const timelineNodeRefs = new WeakMap<HTMLElement, TimelineNodeRef>();

function getTimelineCache(state: PanelState): TimelineDomCache {
  let cache = timelineCaches.get(state);
  if (!cache) {
    cache = { lanes: new Map(), rootNodes: new Map(), activeTreeRow: null, renderGen: 0 };
    timelineCaches.set(state, cache);
  }
  return cache;
}

class Hasher {
  h1 = 0x811c9dc5;
  h2 = 0x9e3779b1;
  str(value: string | null | undefined): void {
    const s = value ?? '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.h1 = Math.imul(this.h1 ^ c, 0x01000193);
      this.h2 = Math.imul(this.h2 ^ (c + i), 0x85ebca6b);
    }
    this.h1 = Math.imul(this.h1 ^ 0x1f, 0x01000193);
    this.h2 = Math.imul(this.h2 ^ 0x1f, 0x85ebca6b);
  }
  num(value: number | null | undefined): void {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) : -1;
    this.h1 = Math.imul(this.h1 ^ (n & 0xffff), 0x01000193);
    this.h2 = Math.imul(this.h2 ^ (n >>> 16), 0x85ebca6b);
  }
  digest(): string {
    return `${(this.h1 >>> 0).toString(36)}:${(this.h2 >>> 0).toString(36)}`;
  }
}

function hashTimelineNode(node: TimelineNode, sigMap: WeakMap<TimelineNode, string>, hasher: Hasher): number {
  const local = new Hasher();
  local.str(node.id);
  local.str(node.kind);
  local.str(node.event);
  local.str(node.role);
  local.str(node.model);
  local.str(node.time);
  local.num(node.durationMs);
  local.num(node.tokens?.totalTokens);
  local.num(node.tokens?.outputTokens);
  const meta = (node.meta || null) as Record<string, string | number | null | undefined> | null;
  if (meta) {
    local.num(typeof meta.turnIndex === 'number' ? meta.turnIndex : null);
    local.num(typeof meta.stepStart === 'number' ? meta.stepStart : null);
    local.num(typeof meta.stepEnd === 'number' ? meta.stepEnd : null);
    local.num(typeof meta.stepIndex === 'number' ? meta.stepIndex : null);
    local.num(typeof meta.calls === 'number' ? meta.calls : null);
    local.str(typeof meta.fromModel === 'string' ? meta.fromModel : null);
    local.str(typeof meta.toModel === 'string' ? meta.toModel : null);
    local.str(typeof meta.category === 'string' ? meta.category : null);
    local.str(typeof meta.role === 'string' ? meta.role : null);
    local.str(typeof meta.status === 'string' ? meta.status : null);
  }
  const children = Array.isArray(node.children) ? node.children : [];
  local.num(children.length);
  let count = 1;
  for (const child of children) {
    count += hashTimelineNode(child, sigMap, local);
  }
  const digest = local.digest();
  sigMap.set(node, digest);
  hasher.str(digest);
  return count;
}

function fingerprintTimeline(
  lang: string,
  cascadeId: string,
  savedAt: string,
  truncated: boolean,
  swimlanes: ReadonlyArray<TimelineSwimlaneItem>,
  nodes: ReadonlyArray<TimelineNode>,
): { sig: string; nodeSigs: WeakMap<TimelineNode, string>; totalNodes: number } {
  const swimHasher = new Hasher();
  for (const seg of swimlanes) {
    swimHasher.str(seg.kind);
    swimHasher.str(seg.model);
    swimHasher.str(seg.label);
    swimHasher.num(seg.startMs);
    swimHasher.num(seg.endMs);
    swimHasher.num(seg.startRatio);
    swimHasher.num(seg.widthRatio);
    swimHasher.num(seg.stepStart);
    swimHasher.num(seg.stepEnd);
    swimHasher.num(seg.calls);
  }
  const nodeHasher = new Hasher();
  const nodeSigs = new WeakMap<TimelineNode, string>();
  let totalNodes = 0;
  for (const node of nodes) {
    totalNodes += hashTimelineNode(node, nodeSigs, nodeHasher);
  }
  return {
    sig: `${lang}|${cascadeId}|${savedAt}|${truncated ? 1 : 0}|${swimlanes.length}:${swimHasher.digest()}|${totalNodes}:${nodeHasher.digest()}`,
    nodeSigs,
    totalNodes,
  };
}

function createTimelineNodeShell(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'timeline-node';
  const row = document.createElement('div');
  row.className = 'timeline-node-row';
  const bullet = document.createElement('span');
  bullet.className = 'timeline-bullet';
  bullet.textContent = '·';
  const main = document.createElement('div');
  main.className = 'timeline-node-main';
  const eventBadge = document.createElement('span');
  eventBadge.className = 'timeline-event-badge';
  const summary = document.createElement('span');
  summary.className = 'timeline-node-summary';
  main.append(eventBadge, summary);
  const badges = document.createElement('div');
  badges.className = 'timeline-node-badges';
  row.append(bullet, main, badges);
  el.appendChild(row);
  timelineNodeRefs.set(el, {
    el,
    row,
    toggleBtn: null,
    bullet,
    eventBadge,
    summary,
    badges,
    mChip: null,
    tChip: null,
    dChip: null,
    cChip: null,
    childrenEl: null,
    childMap: new Map(),
    lastSig: '',
  });
  return el;
}

function syncChip(
  parent: HTMLElement,
  existing: HTMLElement | null,
  text: string,
  className: string,
  title?: string,
): HTMLElement | null {
  if (!text) {
    existing?.remove();
    return null;
  }
  let chip = existing;
  if (!chip) {
    chip = document.createElement('span');
    chip.className = className;
    parent.appendChild(chip);
  } else if (chip.parentNode !== parent) {
    parent.appendChild(chip);
  }
  setText(chip, text);
  if (title !== undefined) setAttr(chip, 'title', title || null);
  return chip;
}

function syncTimelineNode(
  ctx: PanelDomContext,
  el: HTMLElement,
  node: TimelineNode,
  depth: number,
  lang: string,
  nodeSigs: WeakMap<TimelineNode, string>,
): void {
  const ref = timelineNodeRefs.get(el)!;
  const fullSig = `${lang}|${nodeSigs.get(node) ?? ''}`;
  if (ref.lastSig === fullSig) return;
  ref.lastSig = fullSig;

  setAttr(el, 'data-kind', node.kind || 'step');
  setAttr(el, 'data-node-id', node.id || '');
  const meta = (node.meta || {}) as Record<string, string | number | null | undefined>;
  setAttr(el, 'data-step-start', meta.stepStart != null ? String(meta.stepStart) : null);
  setAttr(el, 'data-step-end', meta.stepEnd != null ? String(meta.stepEnd) : null);
  setAttr(el, 'data-step-index', meta.stepIndex != null ? String(meta.stepIndex) : null);

  const children = Array.isArray(node.children) ? node.children : [];
  const hasChildren = children.length > 0;
  const collapsed =
    hasChildren && (ctx.state.timelineToggled.has(node.id) ? Boolean(ctx.state.timelineToggled.get(node.id)) : depth >= 2);
  const eventLabel = timelineEventLabel(ctx, node);

  if (hasChildren) {
    if (!ref.toggleBtn) {
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'timeline-toggle-btn';
      toggleBtn.appendChild(createChevronSvg());
      if (ref.bullet) {
        ref.bullet.replaceWith(toggleBtn);
        ref.bullet = null;
      } else {
        ref.row.prepend(toggleBtn);
      }
      ref.toggleBtn = toggleBtn;
    }
    ref.toggleBtn.dataset.nodeId = node.id;
    setAttr(ref.toggleBtn, 'aria-expanded', String(!collapsed));
    setAttr(ref.toggleBtn, 'aria-label', eventLabel);
  } else if (ref.toggleBtn) {
    const bullet = document.createElement('span');
    bullet.className = 'timeline-bullet';
    bullet.textContent = '·';
    ref.toggleBtn.replaceWith(bullet);
    ref.toggleBtn = null;
    ref.bullet = bullet;
  }

  setText(ref.eventBadge, eventLabel);
  const summaryText = timelineNodeSummary(ctx, node);
  setText(ref.summary, summaryText);
  setAttr(ref.summary, 'title', summaryText || null);

  const modelChipText = node.model && node.kind !== 'handoff' && !summaryText.includes(node.model) ? node.model : '';
  const tokTotal = node.tokens?.totalTokens || node.tokens?.outputTokens || 0;
  const tokChipText = tokTotal > 0 ? `${compact(tokTotal)} tok` : '';
  const durChipText = formatDurationMs(node.durationMs);
  const clkChipText = formatClock(ctx, node.time);

  ref.mChip = syncChip(ref.badges, ref.mChip, modelChipText, 'timeline-chip', modelChipText);
  ref.tChip = syncChip(ref.badges, ref.tChip, tokChipText, 'timeline-chip');
  ref.dChip = syncChip(ref.badges, ref.dChip, durChipText, 'timeline-chip');
  ref.cChip = syncChip(ref.badges, ref.cChip, clkChipText, 'timeline-chip is-time');

  if (hasChildren) {
    if (!ref.childrenEl) {
      const kidsEl = document.createElement('div');
      kidsEl.className = 'timeline-children';
      el.appendChild(kidsEl);
      ref.childrenEl = kidsEl;
    }
    if (!panelMotion.has(ref.childrenEl)) setHidden(ref.childrenEl, collapsed);
    reconcileTimelineList(ctx, ref.childrenEl, ref.childMap, children, depth + 1, lang, nodeSigs);
  } else if (ref.childrenEl) {
    ref.childrenEl.remove();
    ref.childrenEl = null;
    ref.childMap.clear();
  }
}

function nodeKey(node: TimelineNode, depth: number, index: number): string {
  return node.id ? node.id : `__tl_${depth}_${index}`;
}

function reconcileTimelineList(
  ctx: PanelDomContext,
  container: HTMLElement,
  existingMap: Map<string, HTMLElement>,
  nodes: ReadonlyArray<TimelineNode>,
  depth: number,
  lang: string,
  nodeSigs: WeakMap<TimelineNode, string>,
): void {
  const desiredKeys = new Set<string>();
  for (let i = 0; i < nodes.length; i++) desiredKeys.add(nodeKey(nodes[i], depth, i));

  for (const [key, nodeEl] of existingMap) {
    if (!desiredKeys.has(key)) {
      nodeEl.remove();
      existingMap.delete(key);
    }
  }

  if (container.children.length === 0 && nodes.length > 0) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < nodes.length; i++) {
      const key = nodeKey(nodes[i], depth, i);
      let nodeEl = existingMap.get(key);
      if (!nodeEl) {
        nodeEl = createTimelineNodeShell();
        existingMap.set(key, nodeEl);
      }
      syncTimelineNode(ctx, nodeEl, nodes[i], depth, lang, nodeSigs);
      frag.appendChild(nodeEl);
    }
    container.appendChild(frag);
    return;
  }

  let cursor: Element | null = container.firstElementChild;
  for (let i = 0; i < nodes.length; i++) {
    const key = nodeKey(nodes[i], depth, i);
    let nodeEl = existingMap.get(key);
    if (!nodeEl) {
      nodeEl = createTimelineNodeShell();
      existingMap.set(key, nodeEl);
    }
    syncTimelineNode(ctx, nodeEl, nodes[i], depth, lang, nodeSigs);
    if (nodeEl !== cursor) {
      container.insertBefore(nodeEl, cursor);
    } else {
      cursor = cursor.nextElementSibling;
    }
  }
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

  const cache = getTimelineCache(state);

  for (const btnId of ['timeline-enable-btn', 'timeline-disable-btn', 'timeline-clear-btn']) {
    const btn = $<HTMLButtonElement>(btnId);
    if (btn) {
      btn.disabled = state.timelineBusy;
      setAttr(btn, 'aria-busy', state.timelineBusy ? 'true' : null);
    }
  }
  renderTimelineStatus(ctx);
  if (!state.timelineEnabled) {
    cache.renderGen++;
    setHidden(offBar, false);
    setHidden(panel, true);
    if (swimEl.children.length) swimEl.textContent = '';
    if (treeEl.children.length) treeEl.textContent = '';
    cache.lanes.clear();
    cache.rootNodes.clear();
    cache.activeTreeRow = null;
    resetSwimlaneTipState(state);
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

  const lang = language.language;
  const { sig, nodeSigs, totalNodes } = fingerprintTimeline(
    lang,
    tl?.cascadeId || '',
    tl?.savedAt || '',
    Boolean(tl?.truncated),
    swimlanes,
    nodes,
  );
  if (sig === state.lastTimelineSig) return;
  state.lastTimelineSig = sig;
  const myGen = ++cache.renderGen;

  const colorModels = [
    ...(speed?.modelUsage?.models || []),
    ...swimlanes.map((s) => ({
      name: s.model || s.label,
      role: s.kind === 'plan' || s.kind === 'worker' || s.kind === 'subagent' ? s.kind : 'model',
    })),
  ];
  const colorMap = assignModelColors(colorModels);
  state.lastTimelineRender = [];

  if (swimlanes.length > 0) {
    const tracks = [
      { key: 'plan', label: t('timelineLanePlan'), match: (s: TimelineSwimlaneItem) => s.kind === 'plan' },
      { key: 'worker', label: t('timelineLaneWorker'), match: (s: TimelineSwimlaneItem) => s.kind === 'worker' },
      { key: 'tools', label: t('timelineLaneToolsAgents'), match: (s: TimelineSwimlaneItem) => s.kind === 'tool' || s.kind === 'subagent' || s.kind === 'handoff' },
    ];
    const orderedSegs: HTMLElement[] = [];
    const newLanesFrag = cache.lanes.size === 0 ? document.createDocumentFragment() : null;

    for (const trackDef of tracks) {
      let laneRef = cache.lanes.get(trackDef.key);
      if (!laneRef || !laneRef.lane.isConnected) {
        const lane = document.createElement('div');
        lane.className = 'timeline-lane';
        lane.dataset.lane = trackDef.key;
        const lbl = document.createElement('span');
        lbl.className = 'timeline-lane-label';
        const track = document.createElement('div');
        track.className = 'timeline-track';
        lane.append(lbl, track);
        laneRef = { lane, label: lbl, track, segments: [] };
        cache.lanes.set(trackDef.key, laneRef);
        (newLanesFrag ?? swimEl).appendChild(lane);
      }
      setText(laneRef.label, trackDef.label);
      setAttr(laneRef.label, 'title', trackDef.label);

      const matched = swimlanes.filter(trackDef.match);
      const newSegFrag = matched.length > laneRef.segments.length ? document.createDocumentFragment() : null;
      for (let i = 0; i < matched.length; i++) {
        const seg = matched[i];
        const idx = state.lastTimelineRender.length;
        state.lastTimelineRender.push(seg);
        const leftPct = Math.min(98.5, Math.max(0, (Number(seg.startRatio) || 0) * 100));
        const widthPct = Math.min(100 - leftPct, Math.max(1.5, (Number(seg.widthRatio) || 0.02) * 100));
        const bg = seg.kind === 'handoff'
          ? 'var(--pulse-warning)'
          : colorMap.get(seg.model || seg.label) || PANEL_MIX_PALETTE[idx % PANEL_MIX_PALETTE.length];
        const tipLabel = [
          seg.model || seg.label,
          seg.stepStart != null ? `#${seg.stepStart}${seg.stepEnd != null && seg.stepEnd !== seg.stepStart ? `–${seg.stepEnd}` : ''}` : '',
          formatDurationMs((seg.endMs ?? 0) - (seg.startMs ?? 0)),
        ].filter(Boolean).join(' · ');

        let btn = laneRef.segments[i];
        if (!btn) {
          btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'timeline-seg';
          laneRef.segments.push(btn);
          (newSegFrag ?? laneRef.track).appendChild(btn);
        }
        setAttr(btn, 'data-seg-idx', String(idx));
        setAttr(btn, 'data-kind', seg.kind || 'step');
        setStyle(btn, 'left', `${leftPct.toFixed(2)}%`);
        setStyle(btn, 'width', `${widthPct.toFixed(2)}%`);
        setStyle(btn, 'background', bg);
        setAttr(btn, 'title', tipLabel);
        setAttr(btn, 'aria-label', tipLabel);
        orderedSegs.push(btn);
      }
      if (newSegFrag && newSegFrag.childNodes.length > 0) {
        laneRef.track.appendChild(newSegFrag);
      }
      while (laneRef.segments.length > matched.length) {
        laneRef.segments.pop()?.remove();
      }
    }
    if (newLanesFrag && newLanesFrag.childNodes.length > 0) {
      swimEl.appendChild(newLanesFrag);
    }
    registerSwimlaneSegments(state, orderedSegs);
    if (state.pinnedSwimlaneIdx >= orderedSegs.length) state.pinnedSwimlaneIdx = -1;
    showSwimlaneTip(ctx, state.pinnedSwimlaneIdx);
  } else {
    if (swimEl.children.length) swimEl.textContent = '';
    cache.lanes.clear();
    resetSwimlaneTipState(state);
    state.pinnedSwimlaneIdx = -1;
    showSwimlaneTip(ctx, -1);
  }

  if (nodes.length === 0) {
    if (treeEl.children.length) treeEl.textContent = '';
    cache.rootNodes.clear();
    cache.activeTreeRow = null;
    return;
  }

  // Time-slice very large initial/burst trees (>80 total nodes when mounting fresh roots)
  // so main-thread input handling stays under the 50ms INP budget.
  const newRootCount = nodes.reduce((acc, n, i) => acc + (cache.rootNodes.has(nodeKey(n, 0, i)) ? 0 : 1), 0);
  if (totalNodes > 80 && newRootCount > 24 && treeEl.children.length === 0) {
    void renderLargeRootBurst(ctx, treeEl, cache, nodes, lang, nodeSigs, myGen);
    return;
  }
  reconcileTimelineList(ctx, treeEl, cache.rootNodes, nodes, 0, lang, nodeSigs);
}

async function renderLargeRootBurst(
  ctx: PanelDomContext,
  treeEl: HTMLElement,
  cache: TimelineDomCache,
  nodes: ReadonlyArray<TimelineNode>,
  lang: string,
  nodeSigs: WeakMap<TimelineNode, string>,
  gen: number,
): Promise<void> {
  const BATCH_BUDGET_MS = 28;
  let i = 0;
  while (i < nodes.length) {
    if (cache.renderGen !== gen || !ctx.state.timelineEnabled) return;
    const deadline = performance.now() + BATCH_BUDGET_MS;
    const frag = document.createDocumentFragment();
    let count = 0;
    while (i < nodes.length) {
      const node = nodes[i];
      const key = nodeKey(node, 0, i);
      let nodeEl = cache.rootNodes.get(key);
      if (!nodeEl) {
        nodeEl = createTimelineNodeShell();
        cache.rootNodes.set(key, nodeEl);
      }
      syncTimelineNode(ctx, nodeEl, node, 0, lang, nodeSigs);
      frag.appendChild(nodeEl);
      i++;
      count++;
      if (count >= 16 && performance.now() >= deadline) break;
    }
    treeEl.appendChild(frag);
    if (i < nodes.length) {
      await yieldToMain();
    }
  }
}

export function focusTimelineNodeByStep(ctx: PanelDomContext, stepStart: number | null | undefined): void {
  const treeEl = ctx.$('timeline-tree');
  if (!treeEl || stepStart == null) return;
  const cache = getTimelineCache(ctx.state);
  cache.activeTreeRow?.classList.remove('is-active');
  cache.activeTreeRow = null;

  let targetNode: HTMLElement | null = null;
  for (const el of treeEl.querySelectorAll<HTMLElement>('.timeline-node')) {
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
      setExpandedState(cur, true, false);
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
    cache.activeTreeRow = activeRow;
    activeRow.scrollIntoView({ block: 'nearest' });
  }
}
