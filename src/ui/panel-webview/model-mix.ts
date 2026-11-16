import type { ModelUsageBucket } from '../../contracts/index.ts';
import { createEl, setAttr, setHidden, setText } from '../../shared/dom.ts';
import { compact, count } from '../../shared/format.ts';
import {
  createDonutSegment,
  partitionModelSlices,
  type MixMetricKind,
  type PartitionedModelSlice,
} from '../shared/model-donut.ts';
import type { MixScopeKind, PanelDomContext, PanelSpeedMetrics } from './types.ts';

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

  const focusId = state.mixHoverId || state.mixActiveId;
  const focused = focusId ? state.mixDisplayModels.find((m) => m.id === focusId) : null;
  svg.classList.toggle('has-focus', Boolean(focused));
  for (const seg of svg.querySelectorAll<SVGElement>('.model-mix-segment')) {
    seg.classList.toggle('is-active', Boolean(focused && seg.dataset.modelId === focused.id));
  }
  for (const row of list.querySelectorAll<HTMLElement>('.model-mix-row')) {
    const active = Boolean(focused && row.dataset.modelId === focused.id);
    row.classList.toggle('is-active', active);
    setAttr(row, 'aria-pressed', String(state.mixActiveId === row.dataset.modelId));
  }
  if (focused) {
    const pctText = `${Math.round(focused.share * 100)}%`;
    setText($('model-mix-center-value'), pctText);
    setText(
      $('model-mix-center-label'),
      state.mixMetric === 'calls'
        ? t('modelCallsCount', { count: focused.value })
        : `${compact(focused.value)} · ${focused.name}`,
    );
    setAttr(wrap, 'title', `${focused.name} (${pctText})`);
  } else {
    const total = state.mixDisplayModels.reduce((sum, item) => sum + item.value, 0);
    setText($('model-mix-center-value'), state.mixMetric === 'calls' ? count(total) : compact(total));
    setText(
      $('model-mix-center-label'),
      state.mixMetric === 'calls'
        ? t('modelCallsUnit')
        : t('modelMixModelsCount', { count: state.mixDisplayModels.length }),
    );
    setAttr(wrap, 'title', '');
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
  for (const btn of mixSection.querySelectorAll<HTMLElement>('[data-mix-scope]')) {
    setAttr(btn, 'aria-pressed', String(btn.dataset.mixScope === effectiveScope));
  }
  for (const btn of mixSection.querySelectorAll<HTMLElement>('[data-mix-metric]')) {
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

  if (state.mixActiveId && !display.some((m) => m.id === state.mixActiveId)) state.mixActiveId = null;
  if (state.mixHoverId && !display.some((m) => m.id === state.mixHoverId)) state.mixHoverId = null;

  const segHost = $('model-mix-segments');
  const listHost = $('model-mix-list');
  if (segHost) {
    segHost.textContent = '';
    let offset = 0;
    for (const item of display) {
      if (item.share <= 0) continue;
      const pct = item.share * 100;
      segHost.appendChild(
        createDonutSegment({
          cx: 19,
          cy: 19,
          r: 15.9154943,
          pathLength: 100,
          className: 'model-mix-segment',
          color: item.color,
          dasharray: `${pct.toFixed(3)} ${Math.max(0, 100 - pct).toFixed(3)}`,
          dashoffset: String(100 - offset),
          modelId: item.id,
          tabIndex: 0,
          role: 'button',
          ariaLabel: `${item.name} (${Math.round(pct)}%)`,
        }),
      );
      offset += pct;
    }
  }

  if (listHost) {
    listHost.textContent = '';
    for (const item of display) {
      const pctText = `${Math.round(item.share * 100)}%`;
      const row = createEl('button', {
        type: 'button',
        class: 'model-mix-row',
        'data-model-id': item.id,
      });
      const statTok = state.mixMetric === 'output' ? item.outputTokens : item.totalTokens;
      setAttr(
        row,
        'title',
        `${item.name} · ${roleLabel(ctx, item.role)} · ${count(item.totalTokens)} tok / ${count(item.outputTokens)} out / ${t('modelCallsCount', { count: item.requests || 0 })}`,
      );
      const top = createEl('div', { class: 'model-mix-row-top' });
      const left = createEl('span', { class: 'model-mix-row-id' });
      const dot = createEl('span', { class: 'model-mix-dot' });
      dot.style.background = item.color;
      const name = createEl('span', { class: 'model-mix-name', text: item.name });
      const badge = createEl('span', {
        class: 'model-mix-role',
        'data-role': item.role || 'model',
        text: roleLabel(ctx, item.role),
      });
      left.append(dot, name, badge);
      const share = createEl('span', { class: 'model-mix-share', text: pctText });
      top.append(left, share);
      const stats = createEl('div', {
        class: 'model-mix-stats',
        text: `${compact(statTok)} tok · ${t('modelCallsCount', { count: item.requests || 0 })}`,
      });
      row.append(top, stats);
      listHost.appendChild(row);
    }
  }

  updateModelMixFocus(ctx);
}

export function bindModelMixEvents(ctx: PanelDomContext, rerender: () => void): void {
  const { $, state } = ctx;
  const mixCard = $('panel-model-mix');
  mixCard?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const scopeBtn = target.closest<HTMLElement>('[data-mix-scope]');
    if (scopeBtn) {
      state.mixScope = (scopeBtn.dataset.mixScope as MixScopeKind) || 'session';
      state.mixScopeManual = true;
      state.lastMixSig = null;
      rerender();
      return;
    }
    const metricBtn = target.closest<HTMLElement>('[data-mix-metric]');
    if (metricBtn) {
      state.mixMetric = (metricBtn.dataset.mixMetric as MixMetricKind) || 'total';
      state.lastMixSig = null;
      rerender();
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
