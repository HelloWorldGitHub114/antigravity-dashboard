import type {
  AccountsResponse,
  AddManualUsageRequest,
  ClearTimelineRequest,
  ClearTimelineResult,
  DeleteManualUsageRequest,
  ManualUsageInput,
  ManualUsageRecord,
  MetricsRequestInput,
  MetricsSnapshot,
  PreferencesSnapshot,
  PreferencesState,
  PreferencesUpdateInput,
  ProjectConversationDetail,
  ProjectDetailRequest,
  ProjectUsageOverview,
  ProjectUsageRequest,
  SwitchAccountRequest,
  SwitchAccountResponse,
  UpdatePluginRequest,
  UpdatePluginState,
  UsageAccountInfo,
} from '../../contracts/index.ts';
import type { DevToolsTarget } from '../../platform/devtools.ts';

export type { DevToolsTarget };

export interface CdpEventMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

export interface WebSocketMessageEvent {
  data: unknown;
}

export interface WebSocketLike {
  readyState: number;
  addEventListener(
    type: string,
    listener: (event: WebSocketMessageEvent) => void,
    options?: { once?: boolean },
  ): void;
  send(data: string): void;
  close(): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface CdpConnectionOptions {
  WebSocketImpl?: WebSocketConstructor;
  timeout?: number;
  onEvent?: (message: CdpEventMessage) => void;
  onClose?: () => void;
}

export interface CdpContextCandidate {
  frameId: string;
  origin: string;
}

export interface RuntimeSessionConnection {
  closed: boolean;
  origin?: string;
  frameId?: string;
  contexts?: Set<number>;
  contextCandidates?: Map<number, CdpContextCandidate>;
  inflight?: number;
  mounted?: boolean;
  guardedSource?: string;
  script?: string;
  open(): Promise<this>;
  command(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

export interface RuntimePreferencesBridge {
  get(): Promise<PreferencesState>;
  snapshot?(): Promise<PreferencesSnapshot>;
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
  discover?: (profile: string) => Promise<DevToolsTarget[]>;
  targetOrigin?: (target: DevToolsTarget) => string;
  connect?: (url: string, options: CdpConnectionOptions) => RuntimeSessionConnection;
  interval?: number;
  addManualUsage?:
    | ((
        input?: AddManualUsageRequest & { data?: ManualUsageInput },
      ) => Promise<ManualUsageRecord | { error: string }>)
    | null;
  deleteManualUsage?:
    | ((input?: DeleteManualUsageRequest) => Promise<boolean | { error: string }>)
    | null;
  getAccounts?:
    | ((input?: unknown) => Promise<UsageAccountInfo[] | AccountsResponse>)
    | null;
  switchAccount?: ((input?: SwitchAccountRequest) => Promise<SwitchAccountResponse>) | null;
  getProjectUsage?:
    | ((input?: ProjectUsageRequest) => Promise<ProjectUsageOverview | { error: string }>)
    | null;
  getProjectDetail?:
    | ((input: ProjectDetailRequest) => Promise<ProjectConversationDetail | { error: string }>)
    | null;
  clearTimeline?: ((input?: ClearTimelineRequest) => Promise<ClearTimelineResult>) | null;
}
