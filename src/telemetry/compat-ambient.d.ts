declare module '*compat/runtime-ui.mjs' {
  import type {
    AccountsResponse,
    ClearTimelineRequest,
    ClearTimelineResult,
    DeleteManualUsageRequest,
    IntegrationHealth,
    ManualUsageInput,
    ManualUsageRecord,
    MetricsRequestInput,
    MetricsSnapshot,
    PreferencesSnapshot,
    PreferencesState,
    PreferencesUpdateInput,
    SwitchAccountRequest,
    SwitchAccountResponse,
    UpdatePluginRequest,
    UpdatePluginState,
    UsageAccountInfo,
    AddManualUsageRequest,
  } from '../contracts/index.ts';

  export interface RuntimePreferencesBridge {
    get(): Promise<PreferencesState>;
    snapshot(): Promise<PreferencesSnapshot>;
    set(input: PreferencesUpdateInput): Promise<PreferencesState>;
  }

  export interface RuntimeUpdaterBridge {
    request(input: UpdatePluginRequest): Promise<UpdatePluginState>;
  }

  export interface RuntimeUiOptions {
    snapshot?: (input?: MetricsRequestInput) => Promise<MetricsSnapshot>;
    source?: string;
    profile?: string;
    dataDir?: string;
    preferences?: RuntimePreferencesBridge;
    updater?: RuntimeUpdaterBridge | null;
    owner?: string | null;
    owns?: () => boolean | Promise<boolean>;
    enabled?: () => boolean | Promise<boolean>;
    interval?: number;
    addManualUsage?: ((input?: AddManualUsageRequest & { data?: ManualUsageInput }) => Promise<ManualUsageRecord | { error: string }>) | null;
    deleteManualUsage?: ((input?: DeleteManualUsageRequest) => Promise<boolean | { error: string }>) | null;
    getAccounts?: ((input?: unknown) => Promise<UsageAccountInfo[] | AccountsResponse>) | null;
    switchAccount?: ((input?: SwitchAccountRequest) => Promise<SwitchAccountResponse>) | null;
    clearTimeline?: ((input?: ClearTimelineRequest) => Promise<ClearTimelineResult>) | null;
  }

  export class RuntimeUi {
    health: IntegrationHealth;
    constructor(options?: RuntimeUiOptions);
    start(): void;
    stop(): Promise<void>;
  }

  export function makeRendererSource(
    i18n: string,
    widget: string,
    theme?: string,
    owner?: string | null,
    generation?: number,
    extraSource?: string,
  ): string;
}

declare module '*compat/host-theme.mjs' {
  import type { HostThemeConfig } from '../contracts/ipc.ts';

  export function readHostTheme(options?: {
    file?: string;
    read?: (path: string, encoding: BufferEncoding) => Promise<string>;
  }): Promise<HostThemeConfig>;
}
