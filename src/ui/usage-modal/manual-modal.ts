import { createDomNode } from './dom-shell.ts';
import { formatModelName } from './palette.ts';
import type { UsageDomContext, UsageWindow } from './types.ts';

export function renderManualEntries(ctx: UsageDomContext): void {
  const { state, options, $, text, w, zh, compactNum } = ctx;
  const entries = state.value?.manualEntries || [];
  const sig = `${options.language.language}|${state.value?.accountKey}|${JSON.stringify(entries)}`;
  if (sig === state.lastManualSig) return;
  state.lastManualSig = sig;

  text('manual-title', w('远程项目手动录入用量', 'Remote Project Manual Usage'));
  $('manual-table-head')?.replaceChildren(
    ...[
      w('项目名称', 'Project'),
      w('时间', 'Datetime'),
      w('模型', 'Model'),
      w('输入 / 补全', 'Prompt / Output'),
      w('总用量', 'Total'),
      w('备注', 'Note'),
      w('操作', 'Action'),
    ].map((label) => createDomNode('th', '', label)),
  );

  const bodyFrag = document.createDocumentFragment();
  if (!entries.length) {
    const row = createDomNode('tr');
    const cell = createDomNode('td', 'muted', w('暂无手动录入记录', 'No manual entries recorded'));
    cell.colSpan = 7;
    cell.style.textAlign = 'center';
    cell.style.padding = '20px';
    row.append(cell);
    bodyFrag.append(row);
    $('manual-table-body')?.replaceChildren(bodyFrag);
    return;
  }

  for (const entry of entries) {
    const row = createDomNode('tr');
    const prompt = entry.tokens?.prompt ?? 0;
    const candidates = entry.tokens?.candidates ?? 0;
    const total = entry.tokens?.total ?? Number(prompt) + Number(candidates);
    const dt =
      typeof entry.timestamp === 'number'
        ? new Date(entry.timestamp).toLocaleString(zh() ? 'zh-CN' : 'en-US')
        : entry.timestamp
          ? String(entry.timestamp).replace('T', ' ').slice(0, 19)
          : '—';
    const tdProj = createDomNode('td', '', entry.projectName || '—');
    const tdTime = createDomNode('td', '', dt);
    const tdModel = createDomNode('td', '', formatModelName(entry.model || ''));
    const tdTokens = createDomNode('td', '', `${compactNum(prompt)} / ${compactNum(candidates)}`);
    const tdTotal = createDomNode('td', '', compactNum(total));
    const tdNote = createDomNode('td', '', entry.note || '—');
    const tdAction = createDomNode('td');
    const delBtn = createDomNode('button', 'btn-delete', w('删除', 'Delete'));
    delBtn.type = 'button';
    delBtn.addEventListener('click', async () => {
      delBtn.disabled = true;
      const bridge = (window as UsageWindow).agPulseBridge || (window as UsageWindow).agPulseHost;
      try {
        if (bridge?.deleteManualUsage) {
          await bridge.deleteManualUsage({ scope: state.value?.accountKey, id: entry.id });
        }
        await options.onRefresh();
      } catch {
        delBtn.disabled = false;
      }
    });
    tdAction.append(delBtn);
    row.append(tdProj, tdTime, tdModel, tdTokens, tdTotal, tdNote, tdAction);
    bodyFrag.append(row);
  }
  $('manual-table-body')?.replaceChildren(bodyFrag);
}

export function bindManualModal(ctx: UsageDomContext): { closeManualModal: (restore?: boolean) => void } {
  const { $, state, options } = ctx;

  const closeManualModal = (restore = true): void => {
    const modal = $('manual-modal');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    if (restore) $('add-manual')?.focus({ preventScroll: true });
  };

  $('add-manual')?.addEventListener('click', () => {
    const modal = $('manual-modal');
    const form = $<HTMLFormElement>('manual-form');
    if (modal) modal.hidden = false;
    form?.reset();
    const accList = (state.value?.accounts || []).filter((a) => a.id !== 'all');
    if (!accList.length && (state.value?.activeAccount || state.value?.accountKey)) {
      const id = state.value.activeAccount || state.value.accountKey;
      accList.push({ id, name: id, active: true });
    }
    const accountSel = $<HTMLSelectElement>('manual-account');
    accountSel?.replaceChildren(
      ...accList.map((a) => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.name || a.email || a.id;
        opt.selected = a.id === (state.value?.activeAccount || state.value?.accountKey);
        return opt;
      }),
    );
    const accRow = $('manual-account-row');
    if (accRow) accRow.hidden = accList.length <= 1;

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const dtInput = $<HTMLInputElement>('manual-datetime');
    if (dtInput) {
      dtInput.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }
    $('manual-model-list')?.replaceChildren(
      ...(state.value?.models || []).map((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        return opt;
      }),
    );
    $('manual-project')?.focus();
  });

  $('manual-cancel')?.addEventListener('click', () => closeManualModal());
  $('manual-modal')?.addEventListener('click', (e) => {
    if (e.target === $('manual-modal')) closeManualModal();
  });

  $('manual-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitBtn = $<HTMLButtonElement>('manual-submit');
    if (submitBtn) submitBtn.disabled = true;
    const chosenScope =
      $<HTMLSelectElement>('manual-account')?.value ||
      (state.value?.accountKey !== 'all' ? state.value?.accountKey : state.value?.activeAccount) ||
      state.value?.accounts?.find((a) => a.id !== 'all')?.id;
    const project = $<HTMLInputElement>('manual-project')?.value.trim() || '';
    const dt = $<HTMLInputElement>('manual-datetime')?.value || '';
    const model = $<HTMLInputElement>('manual-model')?.value.trim() || '';
    const promptTokens = Number($<HTMLInputElement>('manual-prompt')?.value || 0);
    const completionTokens = Number($<HTMLInputElement>('manual-completion')?.value || 0);
    const cacheTokens = Number($<HTMLInputElement>('manual-cache')?.value || 0);
    const note = $<HTMLInputElement>('manual-note')?.value.trim() || '';

    const payload = {
      scope: chosenScope,
      source: 'remote-manual',
      projectName: project,
      timestamp: new Date(dt).toISOString(),
      at: Date.parse(dt),
      model,
      tokens: {
        prompt: promptTokens,
        candidates: completionTokens,
        cacheRead: cacheTokens,
        cache: cacheTokens,
        total: promptTokens + completionTokens,
      },
      promptTokens,
      completionTokens,
      cacheTokens,
      note,
    };
    const bridge = (window as UsageWindow).agPulseBridge || (window as UsageWindow).agPulseHost;
    try {
      if (bridge?.addManualUsage) await bridge.addManualUsage(payload);
      closeManualModal();
      await options.onRefresh();
    } catch {
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  return { closeManualModal };
}
