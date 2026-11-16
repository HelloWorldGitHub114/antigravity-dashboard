import type {
  MetricsSnapshot,
  QuotaGroup,
  RuntimeBridgeApi,
  SpeedMetrics,
  TimelineSwimlaneItem,
} from '../../contracts/index.ts';
import type { DashboardI18n, PreferencesController } from '../i18n/index.ts';
import type { MixMetricKind, PartitionedModelSlice } from '../shared/model-donut.ts';
import type { AgPulseThemeAttachment } from '../theme/index.ts';

export type PanelCardName = 'speed' | 'cache' | 'context';
export type MixScopeKind = 'session' | 'task';

export interface SidecarHostBridge {
  conversationId?: string | null;
  fetch?: typeof fetch;
}

export interface PanelWindow extends Window {
  __agPulsePanelInstalled?: boolean;
  sidecar?: SidecarHostBridge;
  agPulseHost?: RuntimeBridgeApi;
}

export type PanelSpeedMetrics = SpeedMetrics & {
  rateBasis?: 'response' | 'all-output' | null;
  note?: string | null;
  updatedAt?: number | null;
};

export type PanelMetricsSnapshot = MetricsSnapshot & {
  conversationId?: string | null;
  speed: PanelSpeedMetrics | null;
};

export interface PanelState {
  snapshot: PanelMetricsSnapshot | null;
  selectedGroup: string | null;
  group: QuotaGroup | null;
  pending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  serverOffset: number;
  lastExpiredRefresh: number;
  selectedCard: PanelCardName;
  refreshRequest: Promise<void> | null;
  manualRequest: Promise<void> | null;
  syncingFromRefresh: boolean;
  lastThemeKey: string | null;
  lastLocalizedKey: string | null;
  mixMetric: MixMetricKind;
  mixScope: MixScopeKind;
  mixScopeManual: boolean;
  mixActiveId: string | null;
  mixHoverId: string | null;
  lastMixSig: string | null;
  mixDisplayModels: PartitionedModelSlice[];
  timelineEnabled: boolean;
  timelineEpoch: number;
  timelineBusy: boolean;
  timelineNoticeKey: string | null;
  timelineNoticeIsError: boolean;
  lastTimelineSig: string | null;
  lastTimelineRender: TimelineSwimlaneItem[];
  lastTimelineClearAt: number;
  pinnedSwimlaneIdx: number;
  lastTaskId: string | null;
  lastSubagentsSig: string | null;
  readonly treeState: Map<string, boolean>;
  readonly detailState: Set<string>;
  readonly timelineToggled: Map<string, boolean>;
}

export interface PanelDomContext {
  state: PanelState;
  language: DashboardI18n;
  preferences: PreferencesController;
  themeController: AgPulseThemeAttachment;
  setThemeController: (next: AgPulseThemeAttachment) => void;
  setPreferences: (next: PreferencesController) => void;
  host: SidecarHostBridge | undefined;
  $: <T extends HTMLElement = HTMLElement>(id: string) => T | null;
  localGet: (key: string) => string | null;
  localSet: (key: string, value: string) => void;
  groupNameNodes: HTMLElement[];
}
