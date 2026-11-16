import type * as fsModule from 'node:fs';
import type * as osModule from 'node:os';
import type * as pathModule from 'node:path';
import type * as urlModule from 'node:url';
import type {
  AddManualUsageRequest,
  DeleteManualUsageRequest,
  SwitchAccountRequest,
  SwitchAccountResponse,
} from '../../contracts/ipc.ts';
import type {
  ElectronIpcMainEvent,
  ElectronMainApi,
  UsageLedgerLike,
} from './types.ts';

export interface UsageHandlerDeps {
  electron: ElectronMainApi;
  fs: typeof fsModule;
  os: typeof osModule;
  path: typeof pathModule;
  pathToFileURL: typeof urlModule.pathToFileURL;
  baseDir: string;
  validateOrigin: (event: ElectronIpcMainEvent) => URL;
}

export function registerUsageIpcHandlers({
  electron,
  fs,
  os,
  path,
  pathToFileURL,
  baseDir,
  validateOrigin,
}: UsageHandlerDeps): void {
  let usageLedgerPromise: Promise<UsageLedgerLike> | null = null;
  const getLedger = (): Promise<UsageLedgerLike> => {
    if (!usageLedgerPromise) {
      const candidates = [
        ...(baseDir ? [path.join(baseDir, '..', 'sidecars', 'panel', 'usage.mjs')] : []),
        path.join(
          os.homedir(),
          '.gemini',
          'config',
          'plugins',
          'antigravity-pulse',
          'sidecars',
          'panel',
          'usage.mjs',
        ),
      ];
      const target = candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
      usageLedgerPromise = import(pathToFileURL(target).href)
        .then((mod: unknown) => {
          const { UsageLedger } = mod as { UsageLedger: new () => UsageLedgerLike };
          return new UsageLedger();
        })
        .catch((err: unknown) => {
          usageLedgerPromise = null;
          throw err;
        });
    }
    return usageLedgerPromise;
  };

  const handleAddManualUsage = async (
    event: ElectronIpcMainEvent,
    rawInput: unknown = {},
  ): Promise<unknown> => {
    try {
      validateOrigin(event);
      const ledger = await getLedger();
      const input = (rawInput ?? {}) as AddManualUsageRequest;
      const scope = input.scope || input.account || input.accountKey;
      const data = input.data || input;
      return await ledger.addManualUsage(scope, data);
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : 'Failed to add manual usage' };
    }
  };

  const handleDeleteManualUsage = async (
    event: ElectronIpcMainEvent,
    rawInput: unknown = {},
  ): Promise<unknown> => {
    try {
      validateOrigin(event);
      const ledger = await getLedger();
      const input = rawInput as DeleteManualUsageRequest;
      const scope =
        typeof input === 'object' && input !== null
          ? input.scope || input.account || input.accountKey
          : undefined;
      const id =
        typeof input === 'string'
          ? input
          : typeof input === 'object' && input !== null
            ? input.id || null
            : null;
      return await ledger.deleteManualUsage(scope, id);
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : 'Failed to delete manual usage' };
    }
  };

  const handleGetAccounts = async (
    event: ElectronIpcMainEvent,
    rawInput: unknown = {},
  ): Promise<unknown> => {
    try {
      validateOrigin(event);
      const ledger = await getLedger();
      const input = (rawInput ?? {}) as { active?: string | null; scope?: string | null };
      return await ledger.getAccounts(input.active || input.scope || null);
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : 'Failed to get accounts', accounts: [] };
    }
  };

  const handleSwitchAccount = async (
    event: ElectronIpcMainEvent,
    rawInput: unknown = {},
  ): Promise<SwitchAccountResponse> => {
    try {
      validateOrigin(event);
      const input = rawInput as SwitchAccountRequest;
      const account =
        typeof input === 'string' ? input : input?.account || input?.id || undefined;
      return { success: true, active: account, activeAccount: account };
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : 'Failed to switch account' };
    }
  };

  electron.ipcMain.handle('ag-pulse:add-manual-usage', handleAddManualUsage);
  electron.ipcMain.handle('ag-pulse:addManualUsage', handleAddManualUsage);
  electron.ipcMain.handle('ag-pulse:delete-manual-usage', handleDeleteManualUsage);
  electron.ipcMain.handle('ag-pulse:deleteManualUsage', handleDeleteManualUsage);
  electron.ipcMain.handle('ag-pulse:get-accounts', handleGetAccounts);
  electron.ipcMain.handle('ag-pulse:getAccounts', handleGetAccounts);
  electron.ipcMain.handle('ag-pulse:switch-account', handleSwitchAccount);
  electron.ipcMain.handle('ag-pulse:switchAccount', handleSwitchAccount);
}
