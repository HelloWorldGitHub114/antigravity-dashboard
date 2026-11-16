import type {
  AccountsResponse,
  ElectronIpcChannel,
} from '../../contracts/ipc.ts';
import type {
  PreferencesState,
  PreferencesUpdateInput,
} from '../../contracts/preferences.ts';

export interface ElectronSenderFrame {
  url?: string;
}

export interface ElectronSender {
  getURL(): string;
}

export interface ElectronIpcMainEvent {
  senderFrame?: ElectronSenderFrame | null;
  sender: ElectronSender;
}

export interface ElectronIpcMain {
  handle(
    channel: ElectronIpcChannel,
    listener: (event: ElectronIpcMainEvent, input?: unknown) => Promise<unknown> | unknown,
  ): void;
  on(
    channel: ElectronIpcChannel,
    listener: (event: ElectronIpcMainEvent, input?: unknown) => void,
  ): void;
}

export interface ElectronMainApi {
  ipcMain: ElectronIpcMain;
}

export type AuthoritiesMap = Iterable<[string, string]>;

export interface PreferenceStoreLike {
  get(): Promise<PreferencesState>;
  set(input: PreferencesUpdateInput): Promise<PreferencesState>;
}

export interface UsageLedgerLike {
  addManualUsage(scope: unknown, data: unknown): Promise<unknown>;
  deleteManualUsage(scope: unknown, id: unknown): Promise<unknown>;
  getAccounts(activeScope: string | null): Promise<AccountsResponse | unknown>;
}
