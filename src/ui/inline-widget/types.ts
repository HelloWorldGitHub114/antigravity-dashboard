import type {
  HostThemeConfig,
  LanguageCode,
  MetricsSnapshot,
  PreferencesSnapshot,
  PreferencesUpdateInput,
  RuntimeBridgeApi,
  SpeedMetrics,
  UpdatePluginRequest,
  UpdatePluginState,
  UsageSummarySnapshot,
} from '../../contracts/index.ts';

export type ComposerKind = 'main' | 'subagent' | 'ide';

export interface NativeBaselineIcon {
  icon: SVGElement;
  width: number;
}

export interface NativeBaseline {
  height: number;
  icons: NativeBaselineIcon[];
  reserve: number;
}

export interface ComposerMatch {
  editor: HTMLElement;
  model: HTMLElement | null;
  row: HTMLElement;
  branch: HTMLElement;
  anchor?: HTMLElement;
  box: HTMLElement | null;
  distance?: number;
  kind: ComposerKind;
  native?: NativeBaseline;
}

export interface ConversationStateResult {
  id: string | null;
  status: 'active' | 'new' | 'unavailable';
}

export interface WidgetSurface {
  findComposer(previous: ComposerMatch | null): ComposerMatch | null;
  conversationId(composer: ComposerMatch | null): string | null;
  conversationState?(composer: ComposerMatch | null): ConversationStateResult;
  nativeReserve(composer: ComposerMatch): number;
  setMarkup?(element: Element | ShadowRoot, markup: string): void;
  showEmpty?: boolean;
  usageHostLabel?: string;
}

export interface PreferencesBindingOptions {
  read: () => Promise<PreferencesSnapshot>;
  write: (input: PreferencesUpdateInput) => Promise<PreferencesSnapshot>;
  cache?: (value: LanguageCode) => void;
  changed?: () => void;
}

export interface PreferencesConnection {
  readonly ready: Promise<void>;
  readonly error: boolean;
  readonly pending: boolean;
  sync(value: PreferencesSnapshot): void;
  choose(value: LanguageCode): Promise<void>;
  toggle(): Promise<void>;
  dispose(): void;
}

export interface WidgetLanguage {
  readonly language: LanguageCode;
  t(key: string, args?: Record<string, string | number>): string;
  rateNote(speed: SpeedMetrics | null | undefined): string;
  countdown(at: string | number | null | undefined, now?: number, compact?: boolean): string;
  elapsed(value: number | null | undefined): string;
  resetDate(value: string | number | Date | null | undefined): string;
  errorMessage(value: string | null | undefined): string;
  connectPreferences(options: PreferencesBindingOptions): PreferencesConnection;
  setLanguage(value: string): void;
  toggle(): LanguageCode;
}

export interface WidgetThemeController {
  update(): void;
  setHostTheme(value: HostThemeConfig | undefined): void;
  dispose(): void;
}

export interface WidgetThemeFactory {
  shadowCss(): string;
  attach(target: HTMLElement, options?: { embedded?: boolean }): WidgetThemeController;
}

export interface UsageDashboardHandle {
  readonly isOpen: boolean;
  open(data: UsageSummarySnapshot | null | undefined, trigger: Element | null): void;
  update(data: UsageSummarySnapshot | null | undefined): void;
  restoreModal(): void;
  syncGuideDismissed(): void;
  syncPreferences?(prefs: PreferencesSnapshot): void;
  dispose(): void;
}

export interface UsageDashboardOptions {
  root: ShadowRoot;
  language: WidgetLanguage;
  setMarkup: (element: Element | ShadowRoot, markup: string) => void;
  hostLabel: string;
  guideDismissed: boolean;
  initialPreferences?: Partial<PreferencesSnapshot> | null;
  onPreferencesSaved?: (prefs: PreferencesSnapshot) => void;
  onDismissGuide: () => Promise<void>;
  onLanguage: (next: LanguageCode) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export interface UpdateMenuHandle {
  localize(): void;
  dispose(): void;
}

export interface UpdateMenuOptions {
  root: ShadowRoot;
  row: HTMLElement;
  language: WidgetLanguage;
  setMarkup: (element: Element | ShadowRoot, markup: string) => void;
  request: (input: UpdatePluginRequest) => Promise<UpdatePluginState>;
  onOpen?: () => void;
}

export type WidgetMetricsSnapshot = MetricsSnapshot & {
  enabled?: boolean;
};

export interface WidgetWindow extends Window {
  agPulseHost?: RuntimeBridgeApi;
  __agPulseInlineInstalled?: boolean;
  __agPulseOpenUsage?: () => boolean;
  __agPulseDispose?: () => void;
  __agPulseI18nFactory?: (initialLanguage: string | null) => WidgetLanguage;
  __agPulseThemeFactory?: () => WidgetThemeFactory;
  __agPulseSurface?: WidgetSurface;
  __agPulseUpdateFactory?: (options: UpdateMenuOptions) => UpdateMenuHandle;
  __agPulseUsageFactory?: (options: UsageDashboardOptions) => UsageDashboardHandle;
}
