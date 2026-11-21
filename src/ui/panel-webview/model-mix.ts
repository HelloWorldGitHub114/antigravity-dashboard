import type { ModelUsageBucket } from '../../contracts/index.ts';
import { createEl, setAttr, setHidden, setStyle, setText } from '../../shared/dom.ts';
import { compact, count } from '../../shared/format.ts';
import {
  createDonutSegment,
  partitionModelSlices,
  type MixMetricKind,
  type PartitionedModelSlice,
} from '../shared/model-donut.ts';
import type { MixScopeKind, PanelDomContext, PanelSpeedMetrics, PanelState } from './types.ts';

interface MixRowRef {
  row: HTMLButtonElement;
  dot: HTMLElement;
  name: HTMLElement;
  badge: HTMLElement;
  share: HTMLElement;
  stats: HTMLElement;
}

interface ModelMixDomCache {
  segments: Map<string, SVGCircleElement>;
  rows: Map<string, MixRowRef>;
  scopeBtns: HTMLElement[] | null;
  metricBtns: HTMLElement[] | null;
  activeSeg: SVGCircleElement | null;
  activeRow: HTMLButtonElement | null;
  pressedRow: HTMLButtonElement | null;
  lastCenterSig: string | null;
}

const modelMixCaches = new WeakMap<PanelState, ModelMixDomCache>();

function getModelMixCache(state: PanelState): ModelMixDomCache {
  let cache = modelMixCaches.get(state);
  if (!cache) {
    cache = {
      segments: new Map(),
      rows: new Map(),
      scopeBtns: null,
      metricBtns: null,
      activeSeg: null,
      activeRow: null,
      pressedRow: null,
      lastCenterSig: null,
    };
    modelMixCaches.set(state, cache);
  }
  return cache;
}

function createMixRow(modelId: string): MixRowRef {
  const row = createEl('button', {
    type: 'button',
    class: 'model-mix-row',
    'data-model-id': modelId,
  });
  const top = createEl('div', { class: 'model-mix-row-top' });
  const left = createEl('span', { class: 'model-mix-row-id' });
  const dot = createEl('span', { class: 'model-mix-dot' });
  const name = createEl('span', { class: 'model-mix-name' });
  const badge = createEl('span', { class: 'model-mix-role' });
  left.append(dot, name, badge);
  const share = createEl('span', { class: 'model-mix-share' });
  top.append(left, share);
  const stats = createEl('div', { class: 'model-mix-stats' });
  row.append(top, stats);
  return { row, dot, name, badge, share, stats };
}

export function roleLabel(ctx: PanelDomContext, role: string | null | undefined): string {
  const t = ctx.language.t;
  if (role === 'plan') return t('modelRolePlan');
  if (role === 'worker') return t('modelRoleWorker');
  if (role === 'subagent') return t('modelRoleSubagent');
  return t('modelRoleModel');
}

export function updateModelMixFocus(ctx: PanelDomContext): void {
  const { $, state, language } = ctx;
  const t = language.t;
  const svg = $('model-mix-svg');
  const list = $('model-mix-list');
  const wrap = $('model-mix-ring-wrap');
  if (!svg || !list) return;

  const cache = getModelMixCache(state);
  const focusId = state.mixHoverId || state.mixActiveId;
  const focused = focusId ? state.mixDisplayModels.find((m) => m.id === focusId) : null;
  svg.classList.toggle('has-focus', Boolean(focused));

  const nextSeg = focused ? cache.segments.get(focused.id) ?? null : null;
  if (cache.activeSeg !== nextSeg) {
    cache.activeSeg?.classList.remove('is-active');
    nextSeg?.classList.add('is-active');
    cache.activeSeg = nextSeg;
  }

  const nextRow = focused ? cache.rows.get(focused.id)?.row ?? null : null;
  if (cache.activeRow !== nextRow) {
    cache.activeRow?.classList.remove('is-active');
    nextRow?.classList.add('is-active');
    cache.activeRow = nextRow;
  }

  const nextPressedRow = state.mixActiveId ? cache.rows.get(state.mixActiveId)?.row ?? null : null;
  if (cache.pressedRow !== nextPressedRow) {
    if (cache.pressedRow) setAttr(cache.pressedRow, 'aria-pressed', 'false');
    if (nextPressedRow) setAttr(nextPressedRow, 'aria-pressed', 'true');
    cache.pressedRow = nextPressedRow;
  }

  if (focused) {
    const pctText = `${Math.round(focused.share * 100)}%`;
    const labelText =
      state.mixMetric === 'calls'
        ? t('modelCallsCount', { count: focused.value })
        : `${compact(focused.value)} · ${focused.name}`;
    const titleText = `${focused.name} (${pctText})`;
    const centerSig = `F|${pctText}|${labelText}|${titleText}`;
    if (centerSig !== cache.lastCenterSig) {
      cache.lastCenterSig = centerSig;
      setText($('model-mix-center-value'), pctText);
      setText($('model-mix-center-label'), labelText);
      setAttr(wrap, 'title', titleText);
    }
  } else {
    let total = 0;
    for (const item of state.mixDisplayModels) total += item.value;
    const valText = state.mixMetric === 'calls' ? count(total) : compact(total);
    const labelText =
      state.mixMetric === 'calls'
        ? t('modelCallsUnit')
        : t('modelMixModelsCount', { count: state.mixDisplayModels.length });
    const centerSig = `T|${valText}|${labelText}`;
    if (centerSig !== cache.lastCenterSig) {
      cache.lastCenterSig = centerSig;
      setText($('model-mix-center-value'), valText);
      setText($('model-mix-center-label'), labelText);
      setAttr(wrap, 'title', '');
    }
  }
}

export function renderModelMix(ctx: PanelDomContext, speed: PanelSpeedMetrics | null | undefined): void {
  const { $, state, language } = ctx;
  const t = language.t;
  const mixSection = $('panel-model-mix');
  if (!mixSection) return;

  const sessionModels: ReadonlyArray<ModelUsageBucket> = Array.isArray(speed?.modelUsage?.models)
    ? speed.modelUsage.models
    : [];
  const taskModels: ReadonlyArray<ModelUsageBucket> = Array.isArray(speed?.taskUsage?.modelUsage?.models)
    ? speed.taskUsage.modelUsage.models
    : [];

  if (sessionModels.length < 2 && taskModels.length < 2) {
    setHidden(mixSection, true);
    state.lastMixSig = null;
    state.mixDisplayModels = [];
    return;
  }

  const cache = getModelMixCache(state);
  setHidden(mixSection, false);
  const hasSubagents = Boolean((speed?.taskUsage?.subagents ?? 0) > 0 && taskModels.length > 0);
  const scopeGroup = $('model-mix-scope');
  setHidden(scopeGroup, !hasSubagents);
  const effectiveScope: MixScopeKind = !hasSubagents
    ? 'session'
    : state.mixScopeManual
      ? state.mixScope
      : sessionModels.length < 2 && taskModels.length >= 2
        ? 'task'
        : state.mixScope;
  state.mixScope = effectiveScope;

  if (!cache.scopeBtns || cache.scopeBtns.some((b) => !b.isConnected)) {
    cache.scopeBtns = [...mixSection.querySelectorAll<HTMLElement>('[data-mix-scope]')];
  }
  if (!cache.metricBtns || cache.metricBtns.some((b) => !b.isConnected)) {
    cache.metricBtns = [...mixSection.querySelectorAll<HTMLElement>('[data-mix-metric]')];
  }
  for (const btn of cache.scopeBtns) {
    setAttr(btn, 'aria-pressed', String(btn.dataset.mixScope === effectiveScope));
  }
  for (const btn of cache.metricBtns) {
    setAttr(btn, 'aria-pressed', String(btn.dataset.mixMetric === state.mixMetric));
  }

  const rawModels = effectiveScope === 'task' && taskModels.length ? taskModels : sessionModels;
  const display: PartitionedModelSlice[] = partitionModelSlices(rawModels, {
    metric: state.mixMetric,
    maxVisible: 6,
    headCount: 5,
    otherLabel: t('modelMixOther'),
  });

  const sig = `${language.language}|${state.mixMetric}|${effectiveScope}|${hasSubagents}|${display
    .map((m) => `${m.id}:${m.name}:${m.role}:${m.requests}:${m.outputTokens}:${m.totalTokens}`)
    .join('|')}`;
  if (sig === state.lastMixSig) {
    updateModelMixFocus(ctx);
    return;
  }
  state.lastMixSig = sig;
  state.mixDisplayModels = display;
  cache.lastCenterSig = null;

  if (state.mixActiveId && !display.some((m) => m.id === state.mixActiveId)) state.mixActiveId = null;
  if (state.mixHoverId && !display.some((m) => m.id === state.mixHoverId)) state.mixHoverId = null;

  const segHost = $('model-mix-segments');
  const listHost = $('model-mix-list');
  if (segHost) {
    const desiredSegIds = new Set<string>();
    for (const item of display) {
      if (item.share > 0) desiredSegIds.add(item.id);
    }
    for (const [id, circle] of cache.segments) {
      if (!desiredSegIds.has(id)) {
        if (cache.activeSeg === circle) cache.activeSeg = null;
        circle.remove();
        cache.segments.delete(id);
      }
    }
    for (const child of [...segHost.children]) {
      const mid = (child as SVGElement).dataset?.modelId;
      if (!mid || !cache.segments.has(mid)) child.remove();
    }

    let offset = 0;
    let cursor: Element | null = segHost.firstElementChild;
    for (const item of display) {
      if (item.share <= 0) continue;
      const pct = item.share * 100;
      const dasharray = `${pct.toFixed(3)} ${Math.max(0, 100 - pct).toFixed(3)}`;
      const dashoffset = String(100 - offset);
      const ariaLabel = `${item.name} (${Math.round(pct)}%)`;

      let circle = cache.segments.get(item.id);
      if (!circle) {
        circle = createDonutSegment({
          cx: 19,
          cy: 19,
          r: 15.9154943,
          pathLength: 100,
          className: 'model-mix-segment',
          color: item.color,
          dasharray,
          dashoffset,
          modelId: item.id,
          tabIndex: 0,
          role: 'button',
          ariaLabel,
        });
        cache.segments.set(item.id, circle);
      } else {
        setAttr(circle, 'stroke-dasharray', dasharray);
        setAttr(circle, 'stroke-dashoffset', dashoffset);
        setAttr(circle, 'aria-label', ariaLabel);
        setStyle(circle, 'stroke', item.color);
      }
      if (circle !== cursor) {
        segHost.insertBefore(circle, cursor);
      } else {
        cursor = cursor.nextElementSibling;
      }
      offset += pct;
    }
  }

  if (listHost) {
    const desiredRowIds = new Set(display.map((m) => m.id));
    for (const [id, ref] of cache.rows) {
      if (!desiredRowIds.has(id)) {
        if (cache.activeRow === ref.row) cache.activeRow = null;
        if (cache.pressedRow === ref.row) cache.pressedRow = null;
        ref.row.remove();
        cache.rows.delete(id);
      }
    }
    for (const child of [...listHost.children]) {
      const mid = (child as HTMLElement).dataset?.modelId;
      if (!mid || !cache.rows.has(mid)) child.remove();
    }

    let cursor: Element | null = listHost.firstElementChild;
    for (const item of display) {
      const pctText = `${Math.round(item.share * 100)}%`;
      const statTok = state.mixMetric === 'output' ? item.outputTokens : item.totalTokens;
      const roleText = roleLabel(ctx, item.role);
      const roleAttr = item.role || 'model';

      let ref = cache.rows.get(item.id);
      if (!ref) {
        ref = createMixRow(item.id);
        setAttr(ref.row, 'aria-pressed', String(state.mixActiveId === item.id));
        cache.rows.set(item.id, ref);
      }
      setAttr(
        ref.row,
        'title',
        `${item.name} · ${roleText} · ${count(item.totalTokens)} tok / ${count(item.outputTokens)} out / ${t('modelCallsCount', { count: item.requests || 0 })}`,
      );
      setStyle(ref.dot, 'background', item.color);
      setText(ref.name, item.name);
      setAttr(ref.badge, 'data-role', roleAttr);
      setText(ref.badge, roleText);
      setText(ref.share, pctText);
      setText(ref.stats, `${compact(statTok)} tok · ${t('modelCallsCount', { count: item.requests || 0 })}`);

      if (ref.row !== cursor) {
        listHost.insertBefore(ref.row, cursor);
      } else {
        cursor = cursor.nextElementSibling;
      }
    }
  }

  updateModelMixFocus(ctx);
}

export function bindModelMixEvents(ctx: PanelDomContext, _rerender?: () => void): void {
  const { $, state } = ctx;
  const mixCard = $('panel-model-mix');
  mixCard?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const scopeBtn = target.closest<HTMLElement>('[data-mix-scope]');
    if (scopeBtn) {
      const nextScope = (scopeBtn.dataset.mixScope as MixScopeKind) || 'session';
      if (state.mixScope === nextScope && state.mixScopeManual) return;
      state.mixScope = nextScope;
      state.mixScopeManual = true;
      state.lastMixSig = null;
      renderModelMix(ctx, state.snapshot?.speed);
      return;
    }
    const metricBtn = target.closest<HTMLElement>('[data-mix-metric]');
    if (metricBtn) {
      const nextMetric = (metricBtn.dataset.mixMetric as MixMetricKind) || 'total';
      if (state.mixMetric === nextMetric) return;
      state.mixMetric = nextMetric;
      state.lastMixSig = null;
      renderModelMix(ctx, state.snapshot?.speed);
      return;
    }
    const modelTarget = target.closest<HTMLElement>('[data-model-id]');
    if (modelTarget?.dataset.modelId) {
      const id = modelTarget.dataset.modelId;
      state.mixActiveId = state.mixActiveId === id ? null : id;
      updateModelMixFocus(ctx);
    }
  });
  mixCard?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target instanceof Element ? event.target : null;
    const seg = target?.closest<SVGElement>('.model-mix-segment[data-model-id]');
    if (!seg?.dataset.modelId) return;
    event.preventDefault();
    const id = seg.dataset.modelId;
    state.mixActiveId = state.mixActiveId === id ? null : id;
    updateModelMixFocus(ctx);
  });
  for (const focusHost of [$('model-mix-segments'), $('model-mix-list')]) {
    focusHost?.addEventListener('pointerover', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const item = target?.closest<HTMLElement | SVGElement>('[data-model-id]');
      if (!item?.dataset.modelId || state.mixHoverId === item.dataset.modelId) return;
      state.mixHoverId = item.dataset.modelId;
      updateModelMixFocus(ctx);
    });
    focusHost?.addEventListener('pointerleave', () => {
      if (!state.mixHoverId) return;
      state.mixHoverId = null;
      updateModelMixFocus(ctx);
    });
    focusHost?.addEventListener('focusin', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const item = target?.closest<HTMLElement | SVGElement>('[data-model-id]');
      if (!item?.dataset.modelId) return;
      state.mixHoverId = item.dataset.modelId;
      updateModelMixFocus(ctx);
    });
    focusHost?.addEventListener('focusout', (event) => {
      if (focusHost.contains(event.relatedTarget as Node | null)) return;
      if (state.mixHoverId) {
        state.mixHoverId = null;
        updateModelMixFocus(ctx);
      }
    });
  }
}
