import type { ModelPriceRates, ModelPricingOverrides } from '../../contracts/index.ts';
import { sanitizePricingOverrides } from '../../contracts/preferences.ts';
import {
  listConfigurablePricingRows,
  type ConfigurablePricingRow,
} from '../../shared/model-pricing.ts';
import { createDomNode, resolveUsageBridge } from './dom-shell.ts';
import type { UsageDomContext } from './types.ts';

export interface PricingModalHandle {
  open(): void;
  close(restore?: boolean): void;
  isOpen(): boolean;
}

const RATE_EPSILON = 1e-6;

function ratesMatch(a: ModelPriceRates, b: ModelPriceRates): boolean {
  return (
    Math.abs(a.input - b.input) < RATE_EPSILON &&
    Math.abs(a.cacheRead - b.cacheRead) < RATE_EPSILON &&
    Math.abs((a.cacheWrite ?? a.input) - (b.cacheWrite ?? b.input)) < RATE_EPSILON &&
    Math.abs(a.output - b.output) < RATE_EPSILON
  );
}

function formatRateInput(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
  return String(Number(value.toFixed(4)));
}

function parseRateInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0 || num > 10000) return null;
  return Math.round(num * 10000) / 10000;
}

/**
 * 绑定 API 参考单价配置弹窗，支持查看官方单价、按模型自定义覆写及一键恢复默认。
 */
export function bindPricingModal(
  ctx: UsageDomContext,
  onChanged: () => void,
): PricingModalHandle {
  const { $, state, options, w, zh } = ctx;
  const modal = $('pricing-modal');
  let saving = false;

  const isOpen = (): boolean => Boolean(modal && !modal.hidden);

  const close = (restore = true): void => {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    if (restore) $('pricing-settings')?.focus({ preventScroll: true });
  };

  interface RowControls {
    row: ConfigurablePricingRow;
    inputEl: HTMLInputElement;
    cacheReadEl: HTMLInputElement;
    cacheWriteEl: HTMLInputElement;
    outputEl: HTMLInputElement;
    badgeEl: HTMLSpanElement;
    resetBtn: HTMLButtonElement;
  }

  let rowControls: RowControls[] = [];

  const renderModalContent = (): void => {
    if (!modal) return;
    const knownModels = new Set<string>(state.value?.models || []);
    for (const day of state.value?.days || []) {
      for (const m of Object.keys(day.models || {})) knownModels.add(m);
    }
    const rows = listConfigurablePricingRows(
      [...knownModels],
      state.pricingOverrides,
      state.value?.today || new Date().toISOString().slice(0, 10),
    );
    rowControls = [];

    const card = createDomNode('div', 'modal-card pricing-modal-card');
    const title = createDomNode('h3', 'modal-title', w('API 参考单价设置', 'API Reference Pricing'));
    const desc = createDomNode(
      'p',
      'pricing-desc',
      w(
        '单位：美元 / 100 万 Token（Global 口径，思考 Token 按输出计）。内置优惠期模型按请求日期自动切价；手动改价后即时生效并本地保存。',
        'USD per 1M tokens (Global standard; thinking tokens billed as output). Built-in promo models switch rates automatically by date; custom overrides apply immediately.',
      ),
    );

    const form = createDomNode('form', 'pricing-form');
    const tableWrap = createDomNode('div', 'pricing-table-wrap');
    const table = createDomNode('table', 'pricing-table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const colLabel of [
      w('模型', 'Model'),
      w('输入', 'Input'),
      w('缓存读', 'Cache read'),
      w('缓存写', 'Cache write'),
      w('输出', 'Output'),
      '',
    ]) {
      headRow.append(createDomNode('th', '', colLabel));
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement('tbody');
    const makeNumInput = (val: number | undefined, ariaLabel: string): HTMLInputElement => {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '10000';
      input.step = 'any';
      input.className = 'pricing-num-input';
      input.value = formatRateInput(val);
      input.setAttribute('aria-label', ariaLabel);
      return input;
    };

    for (const row of rows) {
      const tr = document.createElement('tr');
      const nameTd = createDomNode('td', 'pricing-model-cell');
      const nameRow = createDomNode('div', 'pricing-model-name-row');
      nameRow.append(createDomNode('span', 'pricing-model-name', row.label));
      const badgeEl = createDomNode(
        'span',
        'pricing-badge',
        row.isOverridden ? w('自定义', 'Custom') : row.builtin ? '' : w('未定价', 'Unpriced'),
      );
      badgeEl.hidden = !badgeEl.textContent;
      nameRow.append(badgeEl);
      nameTd.append(nameRow);
      const noteText = zh() ? row.noteZh : row.noteEn;
      if (noteText) {
        nameTd.append(createDomNode('div', 'pricing-model-note', noteText));
      }

      const inputEl = makeNumInput(row.effectiveRates.input, `${row.label} ${w('输入单价', 'input rate')}`);
      const cacheReadEl = makeNumInput(row.effectiveRates.cacheRead, `${row.label} ${w('缓存读单价', 'cache read rate')}`);
      const cacheWriteEl = makeNumInput(
        row.effectiveRates.cacheWrite ?? row.effectiveRates.input,
        `${row.label} ${w('缓存写单价', 'cache write rate')}`,
      );
      const outputEl = makeNumInput(row.effectiveRates.output, `${row.label} ${w('输出单价', 'output rate')}`);

      const actionTd = createDomNode('td', 'pricing-row-action');
      const resetBtn = createDomNode(
        'button',
        'pricing-row-reset',
        row.builtin ? w('恢复', 'Reset') : w('清除', 'Clear'),
      );
      resetBtn.type = 'button';
      resetBtn.disabled = !row.isOverridden;

      const syncRowBadge = (): void => {
        const curIn = parseRateInput(inputEl.value);
        const curRd = parseRateInput(cacheReadEl.value);
        const curWr = parseRateInput(cacheWriteEl.value);
        const curOut = parseRateInput(outputEl.value);
        if (curIn === null || curRd === null || curWr === null || curOut === null) return;
        const cur: ModelPriceRates = { input: curIn, cacheRead: curRd, cacheWrite: curWr, output: curOut };
        if (row.defaultRates) {
          const modified = !ratesMatch(cur, row.defaultRates);
          badgeEl.textContent = modified ? w('自定义', 'Custom') : '';
          badgeEl.hidden = !modified;
          resetBtn.disabled = !modified;
        } else {
          const hasAny = curIn > 0 || curRd > 0 || curWr > 0 || curOut > 0;
          badgeEl.textContent = hasAny ? w('自定义', 'Custom') : w('未定价', 'Unpriced');
          badgeEl.hidden = false;
          resetBtn.disabled = !hasAny;
        }
      };

      for (const el of [inputEl, cacheReadEl, cacheWriteEl, outputEl]) {
        el.addEventListener('input', syncRowBadge);
      }

      resetBtn.addEventListener('click', () => {
        const target = row.defaultRates ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
        inputEl.value = formatRateInput(target.input);
        cacheReadEl.value = formatRateInput(target.cacheRead);
        cacheWriteEl.value = formatRateInput(target.cacheWrite ?? target.input);
        outputEl.value = formatRateInput(target.output);
        syncRowBadge();
      });

      const wrapTd = (input: HTMLInputElement): HTMLTableCellElement => {
        const td = document.createElement('td');
        td.append(input);
        return td;
      };
      actionTd.append(resetBtn);
      tr.append(
        nameTd,
        wrapTd(inputEl),
        wrapTd(cacheReadEl),
        wrapTd(cacheWriteEl),
        wrapTd(outputEl),
        actionTd,
      );
      tbody.append(tr);
      rowControls.push({ row, inputEl, cacheReadEl, cacheWriteEl, outputEl, badgeEl, resetBtn });
    }

    table.append(tbody);
    tableWrap.append(table);

    const statusEl = createDomNode('span', 'pricing-status');
    statusEl.setAttribute('role', 'status');

    const footer = createDomNode('div', 'pricing-modal-footer');
    const resetAllBtn = createDomNode('button', 'pricing-reset-all', w('全部恢复官方默认', 'Reset all defaults'));
    resetAllBtn.type = 'button';
    resetAllBtn.disabled = Object.keys(state.pricingOverrides || {}).length === 0;

    const actions = createDomNode('div', 'modal-actions');
    const cancelBtn = createDomNode('button', '', w('取消', 'Cancel'));
    cancelBtn.type = 'button';
    const saveBtn = createDomNode('button', 'btn-primary', w('保存单价', 'Save rates'));
    saveBtn.type = 'submit';
    actions.append(cancelBtn, saveBtn);
    footer.append(resetAllBtn, statusEl, actions);

    const persistOverrides = async (nextOverrides: ModelPricingOverrides, closeAfter: boolean): Promise<void> => {
      if (saving) return;
      saving = true;
      saveBtn.disabled = true;
      resetAllBtn.disabled = true;
      statusEl.textContent = w('保存中…', 'Saving…');
      statusEl.classList.remove('is-error');
      const cleaned = sanitizePricingOverrides(nextOverrides);
      const bridge = resolveUsageBridge(options);
      try {
        if (typeof bridge?.setPreferences === 'function') {
          const saved = await bridge.setPreferences({ modelPricingOverrides: cleaned });
          if (saved && typeof saved === 'object' && 'error' in saved) {
            throw new Error(saved.error);
          }
          if (saved && typeof saved === 'object') {
            state.pricingOverrides = sanitizePricingOverrides(saved.modelPricingOverrides);
            options.onPreferencesSaved?.(saved);
          } else {
            state.pricingOverrides = cleaned;
          }
        } else {
          state.pricingOverrides = cleaned;
        }
        onChanged();
        if (closeAfter) {
          close();
        } else {
          renderModalContent();
        }
      } catch {
        statusEl.textContent = w('单价保存失败，请重试。', 'Could not save pricing rates.');
        statusEl.classList.add('is-error');
      } finally {
        saving = false;
        saveBtn.disabled = false;
        resetAllBtn.disabled = Object.keys(state.pricingOverrides || {}).length === 0;
      }
    };

    cancelBtn.addEventListener('click', () => close());
    resetAllBtn.addEventListener('click', () => {
      void persistOverrides({}, false);
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const nextOverrides: ModelPricingOverrides = {};
      for (const ctrl of rowControls) {
        const input = parseRateInput(ctrl.inputEl.value);
        const cacheRead = parseRateInput(ctrl.cacheReadEl.value);
        const cacheWrite = parseRateInput(ctrl.cacheWriteEl.value);
        const output = parseRateInput(ctrl.outputEl.value);
        if (input === null || cacheRead === null || cacheWrite === null || output === null) {
          statusEl.textContent = w('单价需为 0～10000 之间的有效数字。', 'Rates must be valid numbers between 0 and 10000.');
          statusEl.classList.add('is-error');
          return;
        }
        const rates: ModelPriceRates = { input, cacheRead, cacheWrite, output };
        if (ctrl.row.defaultRates) {
          // 仅写入偏离官方默认价的条目，保留未修改模型的自动日期切价能力
          if (!ratesMatch(rates, ctrl.row.defaultRates)) {
            nextOverrides[ctrl.row.key] = rates;
          }
        } else if (input > 0 || cacheRead > 0 || cacheWrite > 0 || output > 0) {
          nextOverrides[ctrl.row.key] = rates;
        }
      }
      void persistOverrides(nextOverrides, true);
    });

    form.append(tableWrap, footer);
    card.append(title, desc, form);
    modal.replaceChildren(card);
  };

  const open = (): void => {
    if (!modal) return;
    renderModalContent();
    modal.hidden = false;
    rowControls[0]?.inputEl.focus({ preventScroll: true });
  };

  $('pricing-settings')?.addEventListener('click', open);
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });

  return { open, close, isOpen };
}
