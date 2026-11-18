import type { UsageAccountInfo } from '../../contracts/index.ts';
import { renderSubtitle } from './localize-modal.ts';
import type { UsageDomContext, UsageWindow } from './types.ts';

type AccountEntry = UsageAccountInfo | { id?: string; account?: string; accountKey?: string; name?: string; email?: string | null } | string;

export async function syncAccountSwitcher(ctx: UsageDomContext): Promise<void> {
  const select = ctx.$<HTMLSelectElement>('account-switcher');
  if (!select) return;
  const { state, options, w } = ctx;
  const bridge = (window as UsageWindow).agPulseBridge || (window as UsageWindow).agPulseHost;
  let list: AccountEntry[] | null = null;

  if (state.value?.accounts && Array.isArray(state.value.accounts)) {
    list = state.value.accounts;
  } else if (bridge?.getAccounts && state.lastAccQueryKey !== state.value?.accountKey) {
    state.lastAccQueryKey = state.value?.accountKey || '';
    try {
      const res = await bridge.getAccounts();
      list = Array.isArray(res) ? res : res?.accounts || [];
    } catch {}
  } else if (!bridge?.getAccounts) {
    list = [];
  } else {
    return;
  }

  if (!list || !list.length) list = [state.value?.viewScope || state.value?.accountKey || 'default'];
  const currentKey = state.value?.viewScope || 'all';
  select.hidden = list.length <= 1;
  renderSubtitle(ctx);

  const items: Array<[string, string]> = list.map((acc) => {
    const id =
      typeof acc === 'string'
        ? acc
        : acc.id || ('account' in acc ? acc.account : undefined) || ('accountKey' in acc ? acc.accountKey : undefined) || 'default';
    const isAll = id === 'all';
    const name =
      typeof acc === 'string'
        ? acc.length > 12
          ? `${acc.slice(0, 10)}…`
          : acc
        : isAll
          ? w('全部账号 (汇总)', 'All Accounts (Aggregated)')
          : acc.email || acc.name || id;
    return [id, name];
  });

  const optSig = `${options.language.language}|${currentKey}|${items.map(([id, name]) => `${id}:${name}`).join(',')}`;
  if (select.dataset.sig === optSig) return;
  select.dataset.sig = optSig;
  select.replaceChildren(
    ...items.map(([id, name]) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      opt.selected = id === currentKey;
      return opt;
    }),
  );
}

export function bindAccountSwitcher(ctx: UsageDomContext): void {
  const select = ctx.$<HTMLSelectElement>('account-switcher');
  select?.addEventListener('change', async (event) => {
    const newAccount = (event.target as HTMLSelectElement).value;
    if (!newAccount || newAccount === (ctx.state.value?.viewScope || ctx.state.value?.accountKey)) return;
    const bridge = (window as UsageWindow).agPulseBridge || (window as UsageWindow).agPulseHost;
    try {
      await bridge?.switchAccount?.({ account: newAccount });
    } catch {}
    await ctx.options.onRefresh();
  });
}
