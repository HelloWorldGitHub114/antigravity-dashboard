import type { ProjectConversationItem } from '../../contracts/usage.ts';
import {
  SVG_NS,
  createDonutSegment,
  partitionModelSlices,
  type PartitionedModelSlice,
} from '../shared/model-donut.ts';
import { createDomNode } from './dom-shell.ts';
import type { UsagePalette } from './palette.ts';
import { createPopoverListbox, type PopoverListboxHandle } from './picker.ts';
import type { TooltipController } from './tooltip.ts';
import type { UsageDomContext } from './types.ts';

export interface ProjectDetailController {
  render(): void;
  syncPicker(): void;
  closePicker(restore?: boolean): void;
  isPickerOpen(): boolean;
  positionPicker(): void;
  dispose(): void;
}

interface MergedSessionGroup {
  id: string;
  title: string;
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
  requests: number;
  share: number;
  isRemote: boolean;
  selfTotal: number;
  selfRequests: number;
  selfUncached: number;
  selfCacheRead: number;
  selfOutput: number;
  subagents: ProjectConversationItem[];
}

const INITIAL_VISIBLE_MAIN = 10;

const DONUT_PALETTE = [
  '#5b8ff9',
  '#5ad8a6',
  '#5d7092',
  '#f6bd16',
  '#e86452',
  '#6dc8ec',
  '#945fb9',
  '#ff9845',
  '#1e9493',
  '#ff99c3',
  '#269a99',
  '#9270ca',
  '#52c41a',
  '#fa8c16',
  '#2f54eb',
] as const;

function buildMergedGroups(
  items: ProjectConversationItem[],
  totalTokens: number,
): MergedSessionGroup[] {
  const mainByTitle = new Map<string, ProjectConversationItem>();
  for (const item of items) {
    if (!item.isSubagent) mainByTitle.set(item.title.toLowerCase(), item);
  }

  const groups = new Map<string, MergedSessionGroup>();
  for (const item of items) {
    const inferredRoot =
      item.isSubagent && !item.rootId && item.title.includes(' · ')
        ? mainByTitle.get(item.title.slice(0, item.title.lastIndexOf(' · ')).toLowerCase())
        : undefined;
    const rawRootId = item.isSubagent ? item.rootId || inferredRoot?.id || item.id : item.id;
    const key = rawRootId.toLowerCase();

    let group = groups.get(key);
    if (!group) {
      const rootTitle = item.isSubagent
        ? item.rootTitle || inferredRoot?.title || item.title.split(' · ')[0] || item.title
        : item.title;
      group = {
        id: rawRootId,
        title: rootTitle,
        uncached: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        total: 0,
        requests: 0,
        share: 0,
        isRemote: item.isRemote,
        selfTotal: 0,
        selfRequests: 0,
        selfUncached: 0,
        selfCacheRead: 0,
        selfOutput: 0,
        subagents: [],
      };
      groups.set(key, group);
    }

    group.uncached += item.uncached;
    group.cacheRead += item.cacheRead;
    group.cacheWrite += item.cacheWrite;
    group.output += item.output;
    group.total += item.total;
    group.requests += item.requests;
    if (item.isSubagent) {
      group.subagents.push(item);
    } else {
      group.title = item.title;
      group.isRemote = item.isRemote;
      group.selfTotal += item.total;
      group.selfRequests += item.requests;
      group.selfUncached += item.uncached;
      group.selfCacheRead += item.cacheRead;
      group.selfOutput += item.output;
    }
  }

  const result = Array.from(groups.values());
  for (const g of result) {
    g.share = totalTokens > 0 ? g.total / totalTokens : 0;
    g.subagents.sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
  }
  result.sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
  return result;
}

function subagentDisplayLabel(sub: ProjectConversationItem, parentTitle: string): string {
  if (sub.agentName) return sub.agentName;
  const prefix = `${parentTitle} · `;
  if (sub.title.startsWith(prefix)) return sub.title.slice(prefix.length) || sub.title;
  const idx = sub.title.lastIndexOf(' · ');
  return idx >= 0 ? sub.title.slice(idx + 3) || sub.title : sub.title;
}

export function createProjectDetailController(
  ctx: UsageDomContext,
  palette: UsagePalette,
  tooltip: TooltipController,
  onSelectProject: (projectKey: string) => void,
): ProjectDetailController {
  const { $, w, full, compactNum, state, dialog, view, options } = ctx;
  const host = $('project-detail-section');
  let picker: PopoverListboxHandle | null = null;
  let lastRenderSig = '';
  let lastDetailIdentity = '';
  let expandAllSubagents = false;
  let showAllMain = false;
  const expandedMainIds = new Set<string>();
  let renderedGroups: MergedSessionGroup[] = [];
  let renderedSlices: PartitionedModelSlice[] = [];

  if (host) {
    options.setMarkup(
      host,
      '<div class="project-detail-head"><div class="project-detail-title-group"><h2 id="project-detail-title"></h2><div class="picker" id="project-detail-picker"><button id="project-detail-trigger" type="button" class="picker-trigger" aria-haspopup="listbox" aria-controls="project-detail-menu" aria-expanded="false"><span id="project-detail-label"></span><svg class="picker-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button><div id="project-detail-menu" class="picker-menu" role="listbox" popover="manual"></div></div></div><div id="project-detail-summary" class="muted"></div></div><div id="project-detail-body" class="project-detail-body"></div>',
    );
    const trigger = $<HTMLButtonElement>('project-detail-trigger');
    const menu = $('project-detail-menu');
    const labelEl = $('project-detail-label');
    if (trigger && menu && labelEl) {
      picker = createPopoverListbox({
        trigger,
        menu,
        labelEl,
        dialog,
        view,
        setMarkup: options.setMarkup,
        getSelected: () => state.selectedProjectKey || '',
        placeholder: () => w('选择项目…', 'Select project…'),
        onSelect: (projectKey) => onSelectProject(projectKey),
      });
    }
  }

  const syncPicker = (): void => {
    if (!picker) return;
    const projects = state.projectOverview?.projects || [];
    picker.setOptions(
      projects.map((p) => ({ value: p.projectKey, label: p.name, hint: compactNum(p.total) })),
      w('选择项目', 'Select project'),
    );
  };

  const applyHighlight = (convId: string | null): void => {
    state.activeConvId = convId;
    if (!host) return;
    for (const seg of host.querySelectorAll<SVGElement>('.proj-donut-seg[data-model-id]')) {
      const id = seg.dataset.modelId || '';
      seg.classList.toggle('is-active', Boolean(convId && id === convId));
      seg.classList.toggle('is-dimmed', Boolean(convId && id !== convId));
    }
    for (const row of host.querySelectorAll<HTMLElement>('[data-conv-id]')) {
      const id = row.dataset.convId || '';
      row.classList.toggle('is-active', Boolean(convId && id === convId));
    }
    const centerVal = $('proj-donut-center-val');
    const centerSub = $('proj-donut-center-sub');
    if (centerVal && centerSub) {
      if (convId) {
        const sl = renderedSlices.find((s) => s.id === convId);
        if (sl) {
          centerVal.textContent = `${(sl.share * 100).toFixed(1)}%`;
          centerSub.textContent = sl.name;
          return;
        }
      }
      centerVal.textContent = compactNum(state.projectDetail?.totalTokens ?? 0);
      centerSub.textContent = w('项目总用量', 'Project total');
    }
  };

  const showTip = (
    target: Element | null,
    title: string,
    stats: { total: number; share: number; requests: number; uncached: number; cacheRead: number; output: number },
  ): void => {
    if (!target) return;
    tooltip.showNodes(target, [
      createDomNode('div', 'tip-title', title),
      createDomNode('strong', '', `${full(stats.total)} Token`),
      createDomNode('div', 'muted', `${(stats.share * 100).toFixed(1)}% · ${stats.requests} ${w('次请求', 'requests')}`),
      createDomNode(
        'div',
        'tip-sub',
        `${w('输入', 'Uncached')}: ${compactNum(stats.uncached)} · ${w('缓存读', 'Cache read')}: ${compactNum(stats.cacheRead)} · ${w('输出', 'Output')}: ${compactNum(stats.output)}`,
      ),
    ]);
  };

  const renderLoaded = (body: HTMLElement): void => {
    const detail = state.projectDetail;
    if (!detail) return;
    const prevScroll = body.querySelector<HTMLElement>('.proj-bars')?.scrollTop ?? 0;
    const prevDonutScroll = body.querySelector<HTMLElement>('.proj-donut-list')?.scrollTop ?? 0;

    if (!renderedGroups.length) {
      body.replaceChildren(
        createDomNode(
          'div',
          'project-detail-empty',
          w('该项目在此时间范围内暂无会话用量记录。', 'No conversation token usage recorded for this project in range.'),
        ),
      );
      return;
    }

    const totalSubagents = renderedGroups.reduce((s, g) => s + g.subagents.length, 0);
    const donutHeadCount = showAllMain ? renderedGroups.length : 6;
    const slices = partitionModelSlices(
      renderedGroups.map((g) => ({
        id: g.id,
        name: g.title,
        role: 'model',
        requests: g.requests,
        inputTokens: g.uncached + g.cacheRead + g.cacheWrite,
        uncachedTokens: g.uncached,
        cachedTokens: g.cacheRead,
        cacheWriteTokens: g.cacheWrite,
        outputTokens: g.output,
        thinkingTokens: 0,
        totalTokens: g.total,
      })),
      {
        metric: 'total',
        maxVisible: showAllMain ? renderedGroups.length : 7,
        headCount: donutHeadCount,
        otherLabel: w('其他会话', 'Other sessions'),
        otherColor: '#8c95a6',
        palette: [...DONUT_PALETTE],
      },
    );
    renderedSlices = slices;
    const colorById = new Map(slices.map((s) => [s.id, s.color]));
    const maxTotal = renderedGroups[0]?.total || 1;
    const grid = createDomNode('div', 'proj-detail-grid');

    // Left: Merged Main-Session Bar Chart with Expandable Subagents & View All
    const barPanel = createDomNode('div', 'proj-bar-panel');
    const barHead = createDomNode('div', 'proj-panel-head');
    barHead.append(createDomNode('div', 'proj-panel-label', w('主会话用量分布', 'Main Session Distribution')));

    const actions = createDomNode('div', 'proj-panel-actions');
    if (totalSubagents > 0) {
      const subBtn = createDomNode(
        'button',
        'proj-action-btn',
        expandAllSubagents ? w('收起子代理', 'Collapse subagents') : w(`展开子代理 (${totalSubagents})`, `Expand subagents (${totalSubagents})`),
      );
      subBtn.id = 'proj-toggle-subagents';
      subBtn.type = 'button';
      subBtn.setAttribute('aria-pressed', String(expandAllSubagents));
      subBtn.addEventListener('click', () => {
        expandAllSubagents = !expandAllSubagents;
        expandedMainIds.clear();
        renderLoaded(body);
      });
      actions.append(subBtn);
    }
    if (renderedGroups.length > INITIAL_VISIBLE_MAIN) {
      const allBtn = createDomNode(
        'button',
        'proj-action-btn',
        showAllMain ? w(`收起 (前${INITIAL_VISIBLE_MAIN})`, `Top ${INITIAL_VISIBLE_MAIN}`) : w(`查看全部会话 (${renderedGroups.length})`, `View all (${renderedGroups.length})`),
      );
      allBtn.id = 'proj-toggle-all';
      allBtn.type = 'button';
      allBtn.setAttribute('aria-pressed', String(showAllMain));
      allBtn.addEventListener('click', () => {
        showAllMain = !showAllMain;
        renderLoaded(body);
      });
      actions.append(allBtn);
    }
    if (actions.childElementCount > 0) barHead.append(actions);
    barPanel.append(barHead);

    const barsWrap = createDomNode('div', `proj-bars${showAllMain ? ' is-all' : ''}`);
    const shown = showAllMain ? renderedGroups : renderedGroups.slice(0, INITIAL_VISIBLE_MAIN);

    const toggleMainRow = (groupId: string): void => {
      if (expandAllSubagents) {
        expandAllSubagents = false;
        for (const g of renderedGroups) {
          if (g.subagents.length > 0 && g.id !== groupId) expandedMainIds.add(g.id);
        }
      } else if (expandedMainIds.has(groupId)) {
        expandedMainIds.delete(groupId);
      } else {
        expandedMainIds.add(groupId);
      }
      renderLoaded(body);
    };

    for (const group of shown) {
      const wrap = createDomNode('div', 'proj-bar-group');
      const hasSub = group.subagents.length > 0;
      const isExpanded = hasSub && (expandAllSubagents || expandedMainIds.has(group.id));
      const color = colorById.get(group.id) || '#8c95a6';

      const row = createDomNode('div', 'proj-bar-row');
      row.dataset.convId = group.id;
      row.tabIndex = 0;
      if (hasSub) {
        row.setAttribute('role', 'button');
        row.setAttribute('aria-expanded', String(isExpanded));
      }

      const metaRow = createDomNode('div', 'proj-bar-meta');
      const titleWrap = createDomNode('span', 'proj-bar-title');
      titleWrap.title = group.title;
      if (hasSub) titleWrap.append(createDomNode('span', 'proj-bar-caret', isExpanded ? '▾' : '▸'));
      titleWrap.append(createDomNode('span', 'proj-bar-name', group.title));
      if (hasSub) {
        titleWrap.append(createDomNode('span', 'proj-badge', w(`含 ${group.subagents.length} 子代理`, `${group.subagents.length} sub`)));
      }
      if (group.isRemote) titleWrap.append(createDomNode('span', 'proj-badge', w('远程', 'Remote')));

      metaRow.append(titleWrap, createDomNode('span', 'proj-bar-val', `${compactNum(group.total)} (${(group.share * 100).toFixed(1)}%)`));
      const track = createDomNode('div', 'proj-bar-track');
      const fill = createDomNode('div', 'proj-bar-fill');
      fill.style.width = `${Math.max(2, Math.round((group.total / maxTotal) * 1000) / 10)}%`;
      fill.style.background = color;
      track.append(fill);

      row.append(metaRow, track);
      row.addEventListener('pointerenter', (e) => {
        applyHighlight(group.id);
        showTip(e.currentTarget as Element, group.title, group);
      });
      row.addEventListener('pointerleave', () => {
        applyHighlight(null);
        tooltip.hide();
      });
      row.addEventListener('focus', (e) => {
        applyHighlight(group.id);
        showTip(e.currentTarget as Element, group.title, group);
      });
      row.addEventListener('blur', () => {
        applyHighlight(null);
        tooltip.hide();
      });
      if (hasSub) {
        row.addEventListener('click', () => toggleMainRow(group.id));
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleMainRow(group.id);
          }
        });
      }
      wrap.append(row);

      if (isExpanded) {
        const subList = createDomNode('div', 'proj-subagent-list');
        const subBase = group.total || 1;
        if (group.selfTotal > 0) {
          const selfRow = createDomNode('div', 'proj-subagent-row');
          const sMeta = createDomNode('div', 'proj-bar-meta');
          const sTitle = createDomNode('span', 'proj-bar-title');
          sTitle.append(createDomNode('span', 'proj-bar-name', w('主会话自身', 'Main session direct')));
          const selfShare = detail.totalTokens > 0 ? group.selfTotal / detail.totalTokens : 0;
          sMeta.append(sTitle, createDomNode('span', 'proj-bar-val', `${compactNum(group.selfTotal)} (${(selfShare * 100).toFixed(1)}%)`));
          const sTrack = createDomNode('div', 'proj-bar-track');
          const sFill = createDomNode('div', 'proj-bar-fill');
          sFill.style.width = `${Math.max(2, Math.round((group.selfTotal / subBase) * 1000) / 10)}%`;
          sFill.style.background = color;
          sTrack.append(sFill);
          selfRow.append(sMeta, sTrack);
          selfRow.addEventListener('pointerenter', (e) =>
            showTip(e.currentTarget as Element, `${group.title} (${w('主会话自身', 'Main direct')})`, {
              total: group.selfTotal,
              share: selfShare,
              requests: group.selfRequests,
              uncached: group.selfUncached,
              cacheRead: group.selfCacheRead,
              output: group.selfOutput,
            }),
          );
          selfRow.addEventListener('pointerleave', () => tooltip.hide());
          subList.append(selfRow);
        }
        for (const sub of group.subagents) {
          const sRow = createDomNode('div', 'proj-subagent-row');
          const label = subagentDisplayLabel(sub, group.title);
          const sMeta = createDomNode('div', 'proj-bar-meta');
          const sTitle = createDomNode('span', 'proj-bar-title');
          sTitle.title = sub.title;
          sTitle.append(
            createDomNode('span', 'proj-bar-name', label),
            createDomNode('span', 'proj-badge', w('子代理', 'Subagent')),
          );
          sMeta.append(sTitle, createDomNode('span', 'proj-bar-val', `${compactNum(sub.total)} (${(sub.share * 100).toFixed(1)}%)`));
          const sTrack = createDomNode('div', 'proj-bar-track');
          const sFill = createDomNode('div', 'proj-bar-fill');
          sFill.style.width = `${Math.max(2, Math.round((sub.total / subBase) * 1000) / 10)}%`;
          sFill.style.background = color;
          sTrack.append(sFill);
          sRow.append(sMeta, sTrack);
          sRow.addEventListener('pointerenter', (e) => showTip(e.currentTarget as Element, sub.title, sub));
          sRow.addEventListener('pointerleave', () => tooltip.hide());
          subList.append(sRow);
        }
        wrap.append(subList);
      }

      barsWrap.append(wrap);
    }

    if (renderedGroups.length > INITIAL_VISIBLE_MAIN) {
      const foot = createDomNode('div', 'proj-bars-more muted');
      foot.append(
        createDomNode(
          'span',
          '',
          showAllMain
            ? w(`已展开全部 ${renderedGroups.length} 个主会话`, `Showing all ${renderedGroups.length} main sessions`)
            : w(`仅展示前 ${shown.length} 个主会话（共 ${renderedGroups.length} 个）`, `Showing top ${shown.length} of ${renderedGroups.length} main sessions`),
        ),
      );
      barsWrap.append(foot);
    }
    barPanel.append(barsWrap);

    // Right: Donut Chart + Bounded Share List
    const donutPanel = createDomNode('div', 'proj-donut-panel');
    donutPanel.append(createDomNode('div', 'proj-panel-label', w('主会话占比环形图', 'Main Session Share')));
    const donutWrap = createDomNode('div', 'proj-donut-layout');
    const chartBox = createDomNode('div', 'proj-donut-box');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 120 120');
    svg.setAttribute('class', 'proj-donut-svg');
    svg.setAttribute('aria-label', w('主会话用量环形图', 'Main session share donut chart'));

    const trackCircle = document.createElementNS(SVG_NS, 'circle');
    trackCircle.setAttribute('class', 'proj-donut-track');
    trackCircle.setAttribute('cx', '60');
    trackCircle.setAttribute('cy', '60');
    trackCircle.setAttribute('r', '44');
    svg.append(trackCircle);

    let offset = 0;
    for (const slice of slices) {
      const len = Math.max(0.25, slice.share * 100);
      const seg = createDonutSegment({
        className: 'proj-donut-seg',
        cx: 60,
        cy: 60,
        r: 44,
        pathLength: 100,
        dasharray: `${len} ${Math.max(0, 100 - len)}`,
        dashoffset: String(-offset),
        modelId: slice.id,
        color: slice.color,
        tabIndex: 0,
        role: 'img',
        ariaLabel: `${slice.name}: ${(slice.share * 100).toFixed(1)}%`,
      });
      offset += slice.share * 100;
      seg.addEventListener('pointerenter', () => applyHighlight(slice.id));
      seg.addEventListener('pointerleave', () => applyHighlight(null));
      seg.addEventListener('focus', () => applyHighlight(slice.id));
      seg.addEventListener('blur', () => applyHighlight(null));
      svg.append(seg);
    }

    const center = createDomNode('div', 'proj-donut-center');
    const cVal = createDomNode('strong', '', compactNum(detail.totalTokens));
    cVal.id = 'proj-donut-center-val';
    const cSub = createDomNode('span', '', w('项目总用量', 'Project total'));
    cSub.id = 'proj-donut-center-sub';
    center.append(cVal, cSub);
    chartBox.append(svg, center);

    const shareList = createDomNode('div', `proj-donut-list${showAllMain ? ' is-all' : ''}`);
    for (const slice of slices) {
      const item = createDomNode('div', 'proj-donut-item');
      item.dataset.convId = slice.id;
      const dot = createDomNode('i', 'proj-donut-dot');
      dot.style.background = slice.color;
      const nameEl = createDomNode('span', 'proj-donut-item-name', slice.name);
      nameEl.title = slice.name;
      item.append(dot, nameEl, createDomNode('span', 'proj-donut-item-pct', `${(slice.share * 100).toFixed(1)}%`));
      item.addEventListener('pointerenter', () => applyHighlight(slice.id));
      item.addEventListener('pointerleave', () => applyHighlight(null));
      item.addEventListener('click', () => {
        applyHighlight(slice.id);
        const targetBar = body.querySelector<HTMLElement>(`.proj-bar-row[data-conv-id="${CSS.escape(slice.id)}"]`);
        targetBar?.scrollIntoView({ block: 'nearest' });
      });
      shareList.append(item);
    }

    donutWrap.append(chartBox, shareList);
    donutPanel.append(donutWrap);
    grid.append(barPanel, donutPanel);
    body.replaceChildren(grid);
    if (prevScroll > 0) {
      const newBars = body.querySelector<HTMLElement>('.proj-bars');
      if (newBars) newBars.scrollTop = prevScroll;
    }
    if (prevDonutScroll > 0) {
      const newList = body.querySelector<HTMLElement>('.proj-donut-list');
      if (newList) newList.scrollTop = prevDonutScroll;
    }
    applyHighlight(null);
  };

  const render = (): void => {
    if (!host) return;
    const isProjectDim = state.dimension === 'project';
    host.hidden = !isProjectDim;
    if (!isProjectDim) return;

    const titleEl = $('project-detail-title');
    if (titleEl) titleEl.textContent = w('项目内会话分布', 'Project Conversations');
    syncPicker();

    const summaryEl = $('project-detail-summary');
    const bodyEl = $('project-detail-body');
    if (!summaryEl || !bodyEl) return;

    const sig = JSON.stringify([
      options.language.language,
      state.selectedProjectKey,
      state.projectDetailLoading,
      state.projectDetailError,
      state.projectDetail?.updatedAt || null,
      state.projectDetail?.projectKey || null,
      state.projectDetail?.from || null,
      state.projectDetail?.to || null,
      state.projectDetail?.totalTokens ?? 0,
      state.projectDetail?.conversations.length ?? 0,
    ]);
    if (sig === lastRenderSig) return;
    lastRenderSig = sig;

    if (!state.selectedProjectKey) {
      summaryEl.textContent = w('按需加载 · 默认不计算', 'On demand · Not loaded');
      bodyEl.replaceChildren(
        createDomNode(
          'div',
          'project-detail-empty',
          w(
            '点击上方表格中的任意项目或通过下拉框选择特定项目后，再计算项目内各个会话的使用量柱形图与环形图占比。',
            'Select a project from the table or dropdown above to compute per-conversation bar and donut share charts on demand.',
          ),
        ),
      );
      return;
    }

    if (state.projectDetailLoading) {
      summaryEl.textContent = w('正在加载会话明细…', 'Loading sessions…');
      bodyEl.replaceChildren(
        createDomNode(
          'div',
          'project-detail-empty',
          w('正在按需读取该项目的会话用量…', 'Calculating conversation usage for selected project…'),
        ),
      );
      return;
    }

    if (state.projectDetailError) {
      summaryEl.textContent = w('加载失败', 'Load failed');
      bodyEl.replaceChildren(createDomNode('div', 'project-detail-empty', state.projectDetailError));
      return;
    }

    const detail = state.projectDetail;
    if (detail) {
      const identity = `${detail.projectKey}|${detail.from}|${detail.to}|${detail.updatedAt}`;
      if (identity !== lastDetailIdentity) {
        lastDetailIdentity = identity;
        expandAllSubagents = false;
        showAllMain = false;
        expandedMainIds.clear();
        renderedGroups = buildMergedGroups(detail.conversations, detail.totalTokens);
      }
      const totalAll = detail.conversations.length;
      const totalMain = renderedGroups.length;
      const rangeLabel = detail.from === detail.to ? detail.from : `${detail.from}..${detail.to}`;
      summaryEl.textContent = totalAll > totalMain
        ? w(
            `${detail.projectName} · ${rangeLabel} · ${totalMain} 个主会话（共 ${totalAll} 含子代理） · ${compactNum(detail.totalTokens)} Token`,
            `${detail.projectName} · ${rangeLabel} · ${totalMain} main (${totalAll} total) · ${compactNum(detail.totalTokens)} Token`,
          )
        : w(
            `${detail.projectName} · ${rangeLabel} · ${totalMain} 个会话 · ${compactNum(detail.totalTokens)} Token`,
            `${detail.projectName} · ${rangeLabel} · ${totalMain} sessions · ${compactNum(detail.totalTokens)} Token`,
          );
      renderLoaded(bodyEl);
    }
  };

  return {
    render,
    syncPicker,
    closePicker: (restore) => picker?.close(restore),
    isPickerOpen: () => Boolean(picker?.isOpen()),
    positionPicker: () => picker?.position(),
    dispose: () => picker?.dispose(),
  };
}
