import type { SubagentContextSummary, SubagentItem } from '../../contracts/index.ts';
import { count, percent } from '../../shared/format.ts';
import type { PanelDomContext } from './types.ts';

export interface SubagentTreeNode extends SubagentItem {
  children: SubagentTreeNode[];
}

export const SUBAGENT_STATUS_MAP: Record<string, { kind: string; key: string; running?: boolean; error?: boolean }> = {
  IDLE: { kind: 'idle', key: 'subagentStatusIdle' },
  DONE: { kind: 'done', key: 'subagentStatusDone' },
  COMPLETED: { kind: 'done', key: 'subagentStatusDone' },
  COMPLETE: { kind: 'done', key: 'subagentStatusDone' },
  FINISHED: { kind: 'done', key: 'subagentStatusDone' },
  SUCCEEDED: { kind: 'done', key: 'subagentStatusDone' },
  RUNNING: { kind: 'running', key: 'subagentStatusRunning', running: true },
  WORKING: { kind: 'running', key: 'subagentStatusRunning', running: true },
  IN_PROGRESS: { kind: 'running', key: 'subagentStatusRunning', running: true },
  WAITING_FOR_USER: { kind: 'waiting', key: 'subagentStatusWaitingUser' },
  WAITING: { kind: 'waiting', key: 'subagentStatusWaiting' },
  PENDING: { kind: 'waiting', key: 'subagentStatusWaiting' },
  QUEUED: { kind: 'waiting', key: 'subagentStatusWaiting' },
  ERROR: { kind: 'error', key: 'subagentStatusError', error: true },
  FAILED: { kind: 'error', key: 'subagentStatusError', error: true },
  CANCELLED: { kind: 'stopped', key: 'subagentStatusStopped' },
  CANCELED: { kind: 'stopped', key: 'subagentStatusStopped' },
  ABORTED: { kind: 'stopped', key: 'subagentStatusStopped' },
  STOPPED: { kind: 'stopped', key: 'subagentStatusStopped' },
  UNSPECIFIED: { kind: 'unknown', key: 'subagentStatusUnknown' },
};

export function subagentLabels(ctx: PanelDomContext) {
  return ctx.language.language === 'zh-CN'
    ? {
        expand: '展开子代理',
        collapse: '折叠子代理',
        toggleAria: '切换子代理列表',
        detailTitle: '查看指标明细',
        detailAria: '切换详情',
        count: (n: number) => String(n),
        countTitle: (n: number) => `${n} 个子代理`,
      }
    : {
        expand: 'Expand subagents',
        collapse: 'Collapse subagents',
        toggleAria: 'Toggle subagents',
        detailTitle: 'View metric details',
        detailAria: 'Toggle details',
        count: (n: number) => String(n),
        countTitle: (n: number) => `${n} ${n === 1 ? 'subagent' : 'subagents'}`,
      };
}

export function buildSubagentTree(items: ReadonlyArray<SubagentItem>): SubagentTreeNode[] {
  const map = new Map<string, SubagentTreeNode>();
  const roots: SubagentTreeNode[] = [];
  for (const item of items) map.set(item.id, { ...item, children: [] });
  const hasAncestor = (childId: string, ancestorId: string): boolean => {
    let curr = map.get(ancestorId);
    while (curr && curr.parentId) {
      if (curr.parentId === childId) return true;
      curr = map.get(curr.parentId);
    }
    return false;
  };
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId) && node.parentId !== node.id && !hasAncestor(node.id, node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function classifySubagentStatus(ctx: PanelDomContext, raw: string | null | undefined) {
  const t = ctx.language.t;
  const rawText = typeof raw === 'string' && raw.trim() ? raw.trim() : '';
  const norm = rawText.toUpperCase().replace(/^CASCADE_RUN_STATUS_/, '');
  const match = norm ? SUBAGENT_STATUS_MAP[norm] : null;
  const label = match
    ? t(match.key)
    : norm
      ? norm.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (ch) => ch.toUpperCase())
      : t('subagentStatusUnknown');
  return { raw: rawText, label, kind: match ? match.kind : 'unknown', running: Boolean(match?.running), error: Boolean(match?.error) };
}

export function formatSubagentContext(ctx: PanelDomContext, sctx: SubagentContextSummary | null | undefined) {
  const t = ctx.language.t;
  const hasUsed = sctx && typeof sctx.usedTokens === 'number' && Number.isFinite(sctx.usedTokens);
  const hasFraction = Boolean(
    sctx && typeof sctx.usedFraction === 'number' && Number.isFinite(sctx.usedFraction) &&
      typeof sctx.maxTokens === 'number' && Number.isFinite(sctx.maxTokens) && sctx.maxTokens > 0,
  );
  if (hasFraction && sctx && typeof sctx.usedFraction === 'number') {
    const pctText = percent(sctx.usedFraction);
    const usedPct = (sctx.usedFraction * 100).toFixed(1);
    const remainingPct = Math.max(0, 100 - sctx.usedFraction * 100).toFixed(1);
    const tokText = t('contextTokens', { used: count(sctx.usedTokens), max: count(sctx.maxTokens) });
    const clamped = Math.max(0, Math.min(1, sctx.usedFraction));
    const dashoffset = String(Math.round((1 - clamped) * 1000) / 10);
    const color = sctx.usedFraction >= 0.9 ? 'var(--pulse-danger)' : sctx.usedFraction >= 0.8 ? 'var(--pulse-warning)' : '';
    const summary = `${t('contextUsed', { used: usedPct, remaining: remainingPct })} · ${tokText}`;
    return { available: true, dashoffset, color, label: `${t('subagentContext')}: ${summary}`, detail: `${pctText} · ${tokText}` };
  }
  const partialTokens = hasUsed && sctx ? t('contextTokens', { used: count(sctx.usedTokens), max: '—' }) : null;
  return {
    available: false,
    dashoffset: '100',
    color: '',
    label: partialTokens ? `${t('subagentContext')}: ${t('contextUnknown')} · ${partialTokens}` : `${t('subagentContext')}: ${t('contextUnknown')}`,
    detail: partialTokens || '—',
  };
}

export interface SubagentNodeRefs {
  itemEl: HTMLElement;
  summaryEl: HTMLElement;
  leftEl: HTMLElement;
  treeBtn: HTMLButtonElement | null;
  bullet: HTMLElement | null;
  nameEl: HTMLElement;
  statusDotEl: HTMLElement;
  childCountEl: HTMLElement | null;
  badgeEl: HTMLElement;
  tpsEl: HTMLElement;
  tokensEl: HTMLElement;
  contextRingEl: HTMLElement;
  contextRingFillEl: SVGElement;
  detailBtn: HTMLButtonElement;
  detailEl: HTMLElement;
  childrenEl: HTMLElement | null;
  dts: HTMLElement[];
  dds: HTMLElement[];
}

export const subagentRefs = new WeakMap<HTMLElement, SubagentNodeRefs>();

export function createSubagentNodeElement(): HTMLElement {
  const nodeEl = document.createElement('div');
  nodeEl.className = 'subagent-tree-node';
  nodeEl.innerHTML = `<div class="subagent-item"><div class="subagent-summary" tabindex="0" role="button"><div class="subagent-left"><span class="tree-bullet">•</span><span class="subagent-name"></span><span class="subagent-status-dot" role="img"></span></div><div class="subagent-right"><span class="subagent-badge"></span><span class="subagent-tps"></span><span class="subagent-tokens"></span><span class="subagent-context-ring" role="img"><svg viewBox="0 0 16 16" aria-hidden="true"><circle class="subagent-context-track" cx="8" cy="8" r="5.3"></circle><circle class="subagent-context-fill" cx="8" cy="8" r="5.3" pathLength="100"></circle></svg></span><button class="detail-toggle-btn" type="button">ℹ</button></div></div><div class="subagent-detail" hidden><dl><div><dt></dt><dd></dd></div><div><dt></dt><dd></dd></div><div><dt></dt><dd></dd></div><div><dt></dt><dd></dd></div><div><dt></dt><dd></dd></div><div><dt></dt><dd></dd></div><div><dt></dt><dd></dd></div><div><dt>ID</dt><dd></dd></div></dl></div></div>`;
  const itemEl = nodeEl.firstElementChild as HTMLElement;
  const summaryEl = itemEl.firstElementChild as HTMLElement;
  const leftEl = summaryEl.firstElementChild as HTMLElement;
  const rightEl = summaryEl.lastElementChild as HTMLElement;
  const detailEl = itemEl.lastElementChild as HTMLElement;
  const rows = [...detailEl.firstElementChild!.children];
  const contextRingEl = rightEl.children[3] as HTMLElement;
  subagentRefs.set(nodeEl, {
    itemEl,
    summaryEl,
    leftEl,
    treeBtn: null,
    bullet: leftEl.children[0] as HTMLElement,
    nameEl: leftEl.children[1] as HTMLElement,
    statusDotEl: leftEl.children[2] as HTMLElement,
    childCountEl: null,
    badgeEl: rightEl.children[0] as HTMLElement,
    tpsEl: rightEl.children[1] as HTMLElement,
    tokensEl: rightEl.children[2] as HTMLElement,
    contextRingEl,
    contextRingFillEl: contextRingEl.firstElementChild!.lastElementChild as SVGElement,
    detailBtn: rightEl.children[4] as HTMLButtonElement,
    detailEl,
    childrenEl: null,
    dts: rows.map((r) => r.firstElementChild as HTMLElement),
    dds: rows.map((r) => r.lastElementChild as HTMLElement),
  });
  return nodeEl;
}
