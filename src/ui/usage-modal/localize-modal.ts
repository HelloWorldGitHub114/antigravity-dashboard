import { createDomNode } from './dom-shell.ts';
import type { UsageDomContext } from './types.ts';

export function renderWaitingState(ctx: UsageDomContext): void {
  const { $, text, w } = ctx;
  const ov = $('overview');
  const det = $('details');
  const wait = $('usage-waiting');
  if (ov) ov.hidden = true;
  if (det) det.hidden = true;
  if (wait) wait.hidden = false;
  text('usage-waiting', w('正在重新连接统计…', 'Reconnecting usage…'));
  text('subtitle', w('正在重新连接本机统计', 'Reconnecting local usage'));
  text('coverage', '');
  text('timezone', '');
  const alertEl = $('alert');
  if (alertEl) alertEl.hidden = true;
  for (const metric of $('totals')?.children || []) {
    (metric as HTMLElement).title = '';
    metric.querySelector('.value')?.replaceChildren(createDomNode('span', '', '—'));
    const costNode = metric.querySelector<HTMLElement>('.metric-cost');
    if (costNode) costNode.textContent = '—';
  }
}

export function renderSubtitle(ctx: UsageDomContext, hostLabel = ctx.options.hostLabel ?? 'Antigravity'): void {
  const { $, state, text, w } = ctx;
  const value = state.value;
  if (!value) return;
  const hasMultipleAccounts = Array.isArray(value.accounts)
    ? value.accounts.length > 1
    : !($('account-switcher')?.hidden ?? true);
  text(
    'subtitle',
    hasMultipleAccounts
      ? w(`本机 ${hostLabel}`, `Local ${hostLabel}`)
      : w(`本机 ${hostLabel} · 当前账号`, `Local ${hostLabel} · current account`),
  );
}

export function renderHeaderAndLabels(ctx: UsageDomContext, hostLabel: string): void {
  const { $, view, dialog, state, text, zh, w, full, compactNum } = ctx;
  const value = state.value;
  if (!value) return;

  text('title', w('用量统计', 'Token usage'));
  dialog.setAttribute('aria-label', w('用量统计', 'Token usage'));
  renderSubtitle(ctx, hostLabel);
  text('overview-tab', w('活动概览', 'Activity'));
  text('details-tab', w('用量详情', 'Usage details'));
  text('activity-title', w('Token 活动', 'Token activity'));
  text('dim-model', w('按模型统计', 'By Model'));
  text('dim-user', w('按用户统计', 'By User'));
  const mvControls = $('model-view-controls');
  if (mvControls) mvControls.hidden = state.dimension !== 'model';
  $('model-view-simple')?.setAttribute('aria-pressed', String(state.modelViewMode === 'simple'));
  $('model-view-detailed')?.setAttribute('aria-pressed', String(state.modelViewMode === 'detailed'));
  text('model-view-simple', w('简易', 'Simple'));
  text('model-view-detailed', w('详细', 'Detailed'));
  text('locale-label', zh() ? 'EN' : '中');

  for (const [id, label] of [
    ['locale', w('切换到英文', 'Switch to Chinese')],
    ['refresh', w('刷新用量', 'Refresh usage')],
    ['pricing-settings', w('API 单价设置', 'API pricing settings')],
    ['font-settings', w('字体大小设置', 'Font size settings')],
    ['close', w('关闭', 'Close')],
  ] as const) {
    const btn = $(id);
    if (btn) {
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
  }

  text('less', w('少', 'Less'));
  text('more', w('多', 'More'));
  text('selection-details', w('查看这段用量 →', 'View usage →'));
  text('add-manual-label', w('录入远程用量', 'Remote Usage'));
  text('manual-modal-title', w('录入远程项目用量', 'Record Remote Usage'));
  text('lbl-account', w('归属账号', 'Account'));
  text('lbl-project', w('项目名称', 'Project Name'));
  text('lbl-datetime', w('时间', 'Datetime'));
  text('lbl-model', w('模型', 'Model'));
  text('lbl-prompt', w('Prompt Tokens (输入)', 'Prompt Tokens'));
  text('lbl-completion', w('Completion Tokens (补全)', 'Completion Tokens'));
  text('lbl-cache', w('Cache Tokens (缓存, 可选)', 'Cache Tokens (Optional)'));
  text('lbl-note', w('备注', 'Note'));
  text('manual-cancel', w('取消', 'Cancel'));
  text('manual-submit', w('确认录入', 'Submit'));

  for (const b of view.querySelectorAll<HTMLElement>('[data-heat]')) {
    b.textContent = b.dataset.heat === 'day' ? w('每天', 'Daily') : w('每周', 'Weekly');
  }
  const periodLabels: Record<string, string> = {
    day: w('天', 'Day'),
    week: w('周', 'Week'),
    month: w('月', 'Month'),
    custom: w('自定义', 'Custom'),
  };
  for (const b of view.querySelectorAll<HTMLElement>('[data-period]')) {
    b.textContent = periodLabels[b.dataset.period || ''] || '';
  }

  $('overview-tab')?.setAttribute('aria-selected', String(state.tab === 'overview'));
  $('details-tab')?.setAttribute('aria-selected', String(state.tab === 'details'));
  const ovSec = $('overview');
  const detSec = $('details');
  if (ovSec) ovSec.hidden = state.tab !== 'overview';
  if (detSec) detSec.hidden = state.tab !== 'details';

  text(
    'coverage',
    w(
      `已记录 ${full(value.requests)} 次请求${value.firstDate ? ` · 始于 ${value.firstDate}` : ''}`,
      `${full(value.requests)} requests recorded${value.firstDate ? ` · since ${value.firstDate}` : ''}`,
    ),
  );
  text(
    'timezone',
    `${value.timeZone} · ${value.syncing || (value.retryingConversations ?? 0) > 0 ? w('正在同步历史…', 'Syncing history…') : w('本地统计', 'Local usage')}`,
  );
  const alerts: string[] = [];
  if (value.unknownRequests) {
    alerts.push(
      w(
        `${value.unknownRequests} 次请求日期未知，共 ${compactNum(value.unknownTokens)} Token`,
        `${value.unknownRequests} undated requests · ${compactNum(value.unknownTokens)} tokens`,
      ),
    );
  }
  const confirmedMissing = value.confirmedMissingConversations ?? (value.syncing ? 0 : value.missingConversations ?? 0);
  if (value.partialRequests || value.unreadableFiles || (confirmedMissing > 0 && !value.syncing) || value.persistenceError) {
    alerts.push(w('部分记录暂不可读取，用量可能不完整', 'Some records are unavailable; usage may be incomplete'));
  }
  const alertBox = $('alert');
  if (alertBox) alertBox.hidden = !alerts.length;
  text('alert', alerts.join(' · '));
}
