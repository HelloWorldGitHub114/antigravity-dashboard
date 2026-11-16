import type {
  LanguageCode,
  RuntimeBridgeApi,
  UsageBucketCounts,
  UsageDayBucket,
  UsageSummarySnapshot,
  UsageUserBucket,
} from '../../contracts/index.ts';

export type UsageTab = 'overview' | 'details';
export type UsageHeatMode = 'day' | 'week';
export type UsagePeriod = 'day' | 'week' | 'month' | 'custom';
export type UsageDimension = 'model' | 'user';
export type ModelViewMode = 'simple' | 'detailed';
export type HourlyMode = 'combined' | 'today';

export interface UsageDashboardLanguage {
  readonly language: LanguageCode;
}

export interface UsageDashboardOptions {
  root: ShadowRoot;
  language: UsageDashboardLanguage;
  setMarkup: (element: Element | ShadowRoot, markup: string) => void;
  hostLabel?: string;
  guideDismissed?: boolean;
  onDismissGuide: () => Promise<void>;
  onLanguage: (next: LanguageCode) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export interface UsageDashboardHandle {
  readonly isOpen: boolean;
  open(data: UsageSummarySnapshot | null | undefined, trigger: Element | null): void;
  update(data: UsageSummarySnapshot | null | undefined): void;
  restoreModal(): void;
  close(): void;
  syncGuideDismissed(): void;
  dispose(): void;
}

export interface UsageTotalsResult {
  from: string;
  to: string;
  models: Record<string, UsageBucketCounts>;
  modelVariants: Record<string, Record<string, UsageBucketCounts>>;
  users: Record<string, UsageUserBucket>;
  legacyTokens: number;
  total: number;
  requests: number;
}

export interface UsageWindow extends Window {
  __agPulseUsageGuidePreview?: boolean;
  agPulseBridge?: RuntimeBridgeApi;
  agPulseHost?: RuntimeBridgeApi;
}

export interface UsageModalState {
  value: UsageSummarySnapshot | null;
  tab: UsageTab;
  heatMode: UsageHeatMode;
  period: UsagePeriod;
  year: string | null;
  anchor: string | null;
  selected: UsageTotalsResult | null;
  disabledModels: Set<string>;
  disabledUsers: Set<string>;
  dimension: UsageDimension;
  modelViewMode: ModelViewMode;
  expandedModelGroups: Set<string>;
  hourlyMode: HourlyMode;
  lastKey: string;
  busy: boolean;
  opener: HTMLElement | null;
  showAllModels: boolean;
  selectedBar: UsageTotalsResult | null;
  hourlyExpanded: boolean;
  customStart: string;
  customEnd: string;
  disposed: boolean;
  accountKey: string | null;
  currentBuckets: UsageTotalsResult[];
  guideDismissed: boolean;
  guideSaving: boolean;
  guideError: boolean;
  guideSignature: string | null;
  lastManualSig: string;
  lastAccQueryKey: string;
}

export interface UsageDomContext {
  root: ShadowRoot;
  dialog: HTMLDialogElement;
  view: ShadowRoot;
  page: HTMLElement;
  intro: HTMLElement;
  options: UsageDashboardOptions;
  state: UsageModalState;
  $: <T extends HTMLElement = HTMLElement>(id: string) => T | null;
  text: (id: string, value: string) => void;
  zh: () => boolean;
  w: (cn: string, en: string) => string;
  full: (n: number | null | undefined) => string;
  compactNum: (n: number | null | undefined) => string;
}
