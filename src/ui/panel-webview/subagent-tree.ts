import { escapeHtml, setAttr, setHidden, setStyle, setText } from '../../shared/dom.ts';
import { compact, count, rate } from '../../shared/format.ts';
import { panelMotion, setExpandedState, syncPinBottom } from './dom-motion.ts';
import {
  buildSubagentTree,
  classifySubagentStatus,
  createSubagentNodeElement,
  formatSubagentContext,
  subagentLabels,
  subagentRefs,
  type SubagentTreeNode,
} from './subagent-helpers.ts';
import type { PanelDomContext, PanelMetricsSnapshot, PanelState } from './types.ts';

const subagentNodeMaps = new WeakMap<PanelState, Map<string, HTMLElement>>();

function getSubagentNodeMap(state: PanelState): Map<string, HTMLElement> {
  let map = subagentNodeMaps.get(state);
  if (!map) {
    map = new Map();
    subagentNodeMaps.set(state, map);
  }
  return map;
}

function syncSubagentNode(
  ctx: PanelDomContext,
  nodeEl: HTMLElement,
  node: SubagentTreeNode,
  depth: number,
  existingNodes: Map<string, HTMLElement>,
  nextNodes: Map<string, HTMLElement>,
): void {
  const { state, language } = ctx;
  const t = language.t;
  const refs = subagentRefs.get(nodeEl)!;
  const id = String(node.id);
  const hasChildren = Boolean(node.children?.length);
  const isTreeExpanded = state.treeState.has(id) ? state.treeState.get(id)! : depth <= 1;
  const isDetailExpanded = state.detailState.has(id);
  const shortId = node.id ? node.id.slice(0, 8) : 'agent';
  const displayName = node.role || shortId;
  const model = node.model || 'Gemini';
  const tpsStr = node.tps !== null && node.tps !== undefined ? `${rate(node.tps)} tok/s` : '—';
  const tokStr = node.totalTokens !== null && node.totalTokens !== undefined ? `${compact(node.totalTokens)} tok` : '—';
  const latestTpsStr = node.latestRateStatus === 'unreliable'
    ? t('timingUnreliable')
    : node.latestRateStatus === 'legacy'
      ? t('ratePending')
      : node.latestTps !== null && node.latestTps !== undefined
        ? `${rate(node.latestTps)} tok/s`
        : '—';
  const ctxInfo = formatSubagentContext(ctx, node.context);
  const statusInfo = classifySubagentStatus(ctx, node.status);
  const labels = subagentLabels(ctx);

  nodeEl.dataset.id = id;
  refs.itemEl.classList.toggle('is-running', statusInfo.running);
  refs.itemEl.classList.toggle('is-error', statusInfo.error);
  refs.statusDotEl.dataset.status = statusInfo.kind;
  const statusTooltip = `${t('subagentStatus')}: ${statusInfo.label}${statusInfo.raw ? ` (${statusInfo.raw})` : ''}`;
  setAttr(refs.statusDotEl, 'title', statusTooltip);
  setAttr(refs.statusDotEl, 'aria-label', statusTooltip);
  refs.summaryEl.dataset.id = id;
  setAttr(refs.summaryEl, 'aria-expanded', String(isDetailExpanded));

  if (hasChildren && !refs.treeBtn && refs.bullet) {
    const btn = document.createElement('button');
    btn.className = 'tree-toggle-btn';
    btn.type = 'button';
    btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#chevron"/></svg>';
    refs.bullet.replaceWith(btn);
    refs.bullet = null;
    refs.treeBtn = btn;
  } else if (!hasChildren && refs.treeBtn) {
    const bullet = document.createElement('span');
    bullet.className = 'tree-bullet';
    bullet.textContent = '•';
    refs.treeBtn.replaceWith(bullet);
    refs.treeBtn = null;
    refs.bullet = bullet;
  }

  if (hasChildren && refs.treeBtn) {
    refs.treeBtn.dataset.id = id;
    setAttr(refs.treeBtn, 'aria-expanded', String(isTreeExpanded));
    setAttr(refs.treeBtn, 'title', isTreeExpanded ? labels.collapse : labels.expand);
    setAttr(refs.treeBtn, 'aria-label', labels.toggleAria);
    if (!refs.childCountEl) {
      const span = document.createElement('span');
      span.className = 'subagent-child-count';
      refs.leftEl.appendChild(span);
      refs.childCountEl = span;
    }
    setText(refs.childCountEl, labels.count(node.children.length));
    setAttr(refs.childCountEl, 'title', labels.countTitle(node.children.length));
  } else if (refs.childCountEl) {
    refs.childCountEl.remove();
    refs.childCountEl = null;
  }

  setText(refs.nameEl, displayName);
  setAttr(refs.nameEl, 'title', node.role ? `${node.role} (${id})` : id);
  setText(refs.badgeEl, model);
  setAttr(refs.badgeEl, 'title', model);
  setText(refs.tpsEl, tpsStr);
  setText(refs.tokensEl, tokStr);
  refs.contextRingEl.classList.toggle('is-unavailable', !ctxInfo.available);
  setAttr(refs.contextRingEl, 'title', ctxInfo.label);
  setAttr(refs.contextRingEl, 'aria-label', ctxInfo.label);
  setStyle(refs.contextRingFillEl, 'strokeDashoffset', ctxInfo.dashoffset);
  setStyle(refs.contextRingFillEl, 'stroke', ctxInfo.color);
  refs.detailBtn.dataset.id = id;
  setAttr(refs.detailBtn, 'title', labels.detailTitle);
  setAttr(refs.detailBtn, 'aria-label', labels.detailAria);
  setAttr(refs.detailBtn, 'aria-pressed', String(isDetailExpanded));

  if (!panelMotion.has(refs.detailEl)) setHidden(refs.detailEl, !isDetailExpanded);
  const dtTexts = [t('subagentModel'), t('subagentTPS'), t('latest'), t('subagentSteps'), t('subagentTokensDetail'), t('subagentContext'), t('subagentStatus')];
  for (let i = 0; i < dtTexts.length; i++) setText(refs.dts[i], dtTexts[i]);
  const ddTexts = [model, tpsStr, latestTpsStr, node.steps || 0, `${node.totalTokens !== null && node.totalTokens !== undefined ? count(node.totalTokens) : '—'} tok`, ctxInfo.detail, statusInfo.label, shortId];
  for (let i = 0; i < ddTexts.length; i++) setText(refs.dds[i], ddTexts[i]);
  setAttr(refs.dds[5], 'title', ctxInfo.label);
  setAttr(refs.dds[6], 'title', statusInfo.raw || null);
  setAttr(refs.dds[7], 'title', id);

  if (hasChildren) {
    if (!refs.childrenEl) {
      const childrenDiv = document.createElement('div');
      childrenDiv.className = 'subagent-children';
      nodeEl.appendChild(childrenDiv);
      refs.childrenEl = childrenDiv;
    }
    refs.childrenEl.dataset.parentId = id;
    if (!panelMotion.has(refs.childrenEl)) setHidden(refs.childrenEl, !isTreeExpanded);
    syncSubagentChildren(ctx, refs.childrenEl, node.children, depth + 1, existingNodes, nextNodes);
  } else if (refs.childrenEl) {
    refs.childrenEl.remove();
    refs.childrenEl = null;
  }
}

function syncSubagentChildren(
  ctx: PanelDomContext,
  containerEl: HTMLElement,
  nodes: ReadonlyArray<SubagentTreeNode>,
  depth: number,
  existingNodes: Map<string, HTMLElement>,
  nextNodes: Map<string, HTMLElement>,
): void {
  const desiredIds = new Set(nodes.map((n) => String(n.id)));
  for (const child of [...containerEl.children]) {
    if (!child.classList?.contains('subagent-tree-node') || !desiredIds.has((child as HTMLElement).dataset?.id || '')) {
      child.remove();
    }
  }
  let cursor: Element | null = containerEl.firstElementChild;
  for (const node of nodes) {
    const id = String(node.id);
    let nodeEl = existingNodes.get(id);
    if (nodeEl) existingNodes.delete(id);
    else nodeEl = createSubagentNodeElement();
    nextNodes.set(id, nodeEl);
    syncSubagentNode(ctx, nodeEl, node, depth, existingNodes, nextNodes);
    if (nodeEl !== cursor) containerEl.insertBefore(nodeEl, cursor);
    else cursor = cursor.nextElementSibling;
  }
}

export function renderSubagentsSection(ctx: PanelDomContext, snapshot: PanelMetricsSnapshot): void {
  const { $, state, language } = ctx;
  const subSection = $('subagents-section');
  if (!subSection) return;
  const speed = snapshot.speed;
  const task = speed?.taskUsage;
  if (task && task.subagents > 0) {
    setHidden(subSection, false);
    setText($('subagents-count'), String(task.subagents));
    const list = $('subagents-list');
    if (!list) return;
    const items = Array.isArray(task.items) ? task.items : [];
    const currentConvId = speed?.conversationId || snapshot.conversationId;
    const nextSig = items.length
      ? `${currentConvId || ''}|${language.language}|${items
          .map((i) => `${i.id}\u0001${i.parentId ?? ''}\u0001${i.role ?? ''}\u0001${i.model ?? ''}\u0001${i.tps ?? ''}\u0001${i.latestTps ?? ''}\u0001${i.latestRateStatus ?? ''}\u0001${i.steps ?? 0}\u0001${i.totalTokens ?? ''}\u0001${i.context?.usedTokens ?? ''}\u0001${i.context?.maxTokens ?? ''}\u0001${i.context?.usedFraction ?? ''}\u0001${i.status ?? ''}`)
          .join('\u0002')}`
      : `EMPTY|${language.language}`;
    if (nextSig !== state.lastSubagentsSig || list.children.length === 0) {
      state.lastSubagentsSig = nextSig;
      const nodeMap = getSubagentNodeMap(state);
      if (items.length) {
        const container = $('subagents-container');
        const preserveScroll = Boolean(container && !container.hidden);
        const savedScroll = preserveScroll && container ? container.scrollTop : 0;
        const existingNodes = new Map<string, HTMLElement>();
        for (const [id, el] of nodeMap) {
          if (el.isConnected && list.contains(el)) existingNodes.set(id, el);
        }
        if (existingNodes.size === 0 && list.children.length > 0) {
          for (const el of list.querySelectorAll<HTMLElement>('.subagent-tree-node[data-id]')) {
            if (el.dataset.id) existingNodes.set(el.dataset.id, el);
          }
        }
        const nextNodes = new Map<string, HTMLElement>();
        syncSubagentChildren(ctx, list, buildSubagentTree(items), 1, existingNodes, nextNodes);
        nodeMap.clear();
        for (const [id, el] of nextNodes) nodeMap.set(id, el);
        if (preserveScroll && container) container.scrollTop = savedScroll;
      } else {
        nodeMap.clear();
        list.innerHTML = `<div class="subagent-empty">${escapeHtml(language.t('transcriptLoading'))}</div>`;
      }
    }
  } else {
    setHidden(subSection, true);
    state.lastSubagentsSig = null;
  }
  syncPinBottom(ctx);
}

export function bindSubagentEvents(ctx: PanelDomContext): void {
  const { $, state } = ctx;
  const toggleSubagentTree = (id: string, animate = true): void => {
    const list = $('subagents-list');
    const escaped = CSS.escape(id);
    const childDiv = list?.querySelector<HTMLElement>(`.subagent-children[data-parent-id="${escaped}"]`);
    const btn = list?.querySelector<HTMLElement>(`.tree-toggle-btn[data-id="${escaped}"]`);
    if (!childDiv || !btn) return;
    const nextOpen = btn.getAttribute('aria-expanded') !== 'true';
    state.treeState.set(id, nextOpen);
    setExpandedState(childDiv, nextOpen, animate);
    const labels = subagentLabels(ctx);
    setAttr(btn, 'aria-expanded', String(nextOpen));
    setAttr(btn, 'title', nextOpen ? labels.collapse : labels.expand);
  };
  const toggleSubagentDetail = (id: string, animate = true): void => {
    const list = $('subagents-list');
    const detailBtn = list?.querySelector<HTMLElement>(`.detail-toggle-btn[data-id="${CSS.escape(id)}"]`);
    const node = detailBtn?.closest('.subagent-tree-node');
    const detail = node?.querySelector<HTMLElement>(':scope > .subagent-item > .subagent-detail');
    const summary = node?.querySelector<HTMLElement>(':scope > .subagent-item > .subagent-summary');
    if (!detail) return;
    const nextOpen = !state.detailState.has(id);
    if (nextOpen) state.detailState.add(id);
    else state.detailState.delete(id);
    setExpandedState(detail, nextOpen, animate);
    setAttr(summary ?? null, 'aria-expanded', String(nextOpen));
    setAttr(detailBtn ?? null, 'aria-pressed', String(nextOpen));
  };

  $('subagents-toggle')?.addEventListener('click', () => {
    const toggle = $('subagents-toggle');
    const container = $('subagents-container');
    if (!toggle || !container) return;
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    setAttr(toggle, 'aria-expanded', String(expanded));
    setExpandedState(container, expanded, true, () => syncPinBottom(ctx));
    syncPinBottom(ctx);
  });
  const subList = $('subagents-list');
  subList?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const treeBtn = target.closest<HTMLElement>('.tree-toggle-btn');
    if (treeBtn?.dataset.id) { event.stopPropagation(); toggleSubagentTree(treeBtn.dataset.id, true); return; }
    const detailBtn = target.closest<HTMLElement>('.detail-toggle-btn');
    if (detailBtn?.dataset.id) { event.stopPropagation(); toggleSubagentDetail(detailBtn.dataset.id, true); return; }
    const summary = target.closest<HTMLElement>('.subagent-summary');
    if (!summary?.dataset.id) return;
    if (summary.querySelector('.tree-toggle-btn')) toggleSubagentTree(summary.dataset.id, true);
    else toggleSubagentDetail(summary.dataset.id, true);
  });
  subList?.addEventListener('dblclick', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('button')) return;
    const summary = target.closest<HTMLElement>('.subagent-summary');
    if (!summary?.dataset.id) return;
    event.stopPropagation();
    toggleSubagentDetail(summary.dataset.id, true);
  });
  subList?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target instanceof Element ? event.target : null;
    const summary = target?.closest<HTMLElement>('.subagent-summary');
    if (!summary?.dataset.id || target !== summary) return;
    event.preventDefault();
    if (summary.querySelector('.tree-toggle-btn')) toggleSubagentTree(summary.dataset.id, true);
    else toggleSubagentDetail(summary.dataset.id, true);
  });
}
