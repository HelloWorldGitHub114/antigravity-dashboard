/**
 * Supported UI and sidecar language codes.
 */
export type LanguageCode = 'en' | 'zh-CN';

/**
 * Whitelisted preference keys accepted by the preferences store and IPC bridges.
 */
export const FONT_SCALE_KEYS = [
  'usageFontScale',
  'sidebarFontScale',
  'inlineFontScale',
] as const;

export type FontScaleKey = (typeof FONT_SCALE_KEYS)[number];

export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 1.5;

/**
 * Clamp and round a font-scale multiplier to 1% precision (`0.80`..`1.50`).
 */
export function resolveFontScale(value: unknown, fallback = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value));
  return Math.round(clamped * 100) / 100;
}

/**
 * Validate any font-scale keys present on a partial preference payload.
 */
export function validateFontScaleInput(input: Record<string, unknown>): void {
  for (const key of FONT_SCALE_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    const raw = input[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < FONT_SCALE_MIN || raw > FONT_SCALE_MAX) {
      throw new Error('Invalid font scale preference');
    }
  }
}

/**
 * Per-million-token API pricing rates (USD / 1M tokens) for a model family.
 */
export interface ModelPriceRates {
  input: number;
  cacheRead: number;
  cacheWrite?: number;
  output: number;
}

/**
 * User-defined model pricing overrides keyed by canonical pricing key.
 */
export type ModelPricingOverrides = Record<string, ModelPriceRates>;

const MAX_PRICING_OVERRIDE_ENTRIES = 64;
const MAX_PRICING_KEY_LENGTH = 80;
const MAX_USD_PER_MTOK = 10000;

function isValidRateNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_USD_PER_MTOK;
}

function roundRate(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Sanitize persisted or partial model pricing overrides, dropping malformed entries.
 */
export function sanitizePricingOverrides(raw: unknown): ModelPricingOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ModelPricingOverrides = {};
  let count = 0;
  for (const [rawKey, rawRates] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_PRICING_OVERRIDE_ENTRIES) break;
    const key = rawKey.trim().toLowerCase();
    if (!key || key.length > MAX_PRICING_KEY_LENGTH) continue;
    if (!rawRates || typeof rawRates !== 'object' || Array.isArray(rawRates)) continue;
    const r = rawRates as Record<string, unknown>;
    if (!isValidRateNumber(r.input) || !isValidRateNumber(r.cacheRead) || !isValidRateNumber(r.output)) {
      continue;
    }
    const entry: ModelPriceRates = {
      input: roundRate(r.input),
      cacheRead: roundRate(r.cacheRead),
      output: roundRate(r.output),
    };
    if (r.cacheWrite !== undefined) {
      if (!isValidRateNumber(r.cacheWrite)) continue;
      entry.cacheWrite = roundRate(r.cacheWrite);
    }
    out[key] = entry;
    count++;
  }
  return out;
}

/**
 * Validate `modelPricingOverrides` on an incoming preference update payload.
 */
export function validatePricingOverridesInput(input: Record<string, unknown>): void {
  if (!Object.hasOwn(input, 'modelPricingOverrides')) return;
  const raw = input.modelPricingOverrides;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid model pricing preference');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_PRICING_OVERRIDE_ENTRIES) {
    throw new Error('Invalid model pricing preference');
  }
  for (const [rawKey, rawRates] of entries) {
    const key = rawKey.trim().toLowerCase();
    if (!key || key.length > MAX_PRICING_KEY_LENGTH) {
      throw new Error('Invalid model pricing preference');
    }
    if (!rawRates || typeof rawRates !== 'object' || Array.isArray(rawRates)) {
      throw new Error('Invalid model pricing preference');
    }
    const r = rawRates as Record<string, unknown>;
    if (
      !isValidRateNumber(r.input) ||
      !isValidRateNumber(r.cacheRead) ||
      !isValidRateNumber(r.output) ||
      (r.cacheWrite !== undefined && !isValidRateNumber(r.cacheWrite))
    ) {
      throw new Error('Invalid model pricing preference');
    }
  }
}

export const MONITOR_PREFERENCE_KEYS = [
  'cacheWarnMinutes',
  'cacheColdMinutes',
  'firstTokenWaitSeconds',
  'contextWarnPct',
  'contextDangerPct',
] as const;

export type MonitorPreferenceKey = (typeof MONITOR_PREFERENCE_KEYS)[number];

/**
 * Resolved monitoring and alert threshold preferences with safe defaults.
 */
export interface ResolvedMonitorPrefs {
  cacheWarnMinutes: number;
  cacheColdMinutes: number;
  firstTokenWaitSeconds: number;
  contextWarnPct: number;
  contextDangerPct: number;
}

export const DEFAULT_MONITOR_PREFS: Readonly<ResolvedMonitorPrefs> = Object.freeze({
  cacheWarnMinutes: 3,
  cacheColdMinutes: 4,
  firstTokenWaitSeconds: 30,
  contextWarnPct: 75,
  contextDangerPct: 90,
});

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Resolve monitor and alert thresholds from partial or persisted preferences.
 */
export function resolveMonitorPrefs(
  raw?: Partial<PreferencesState> | PreferencesSnapshot | Record<string, unknown> | null,
): ResolvedMonitorPrefs {
  const src =
    raw && typeof raw === 'object' && !('error' in raw) ? (raw as Record<string, unknown>) : {};
  const cacheWarnMinutes = clampInt(src.cacheWarnMinutes, 0, 998, DEFAULT_MONITOR_PREFS.cacheWarnMinutes);
  let cacheColdMinutes = clampInt(src.cacheColdMinutes, 0, 999, DEFAULT_MONITOR_PREFS.cacheColdMinutes);
  if (cacheWarnMinutes > 0 && cacheColdMinutes <= cacheWarnMinutes) {
    cacheColdMinutes = Math.min(999, cacheWarnMinutes + 1);
  }
  const firstTokenWaitSeconds = clampInt(
    src.firstTokenWaitSeconds,
    0,
    999,
    DEFAULT_MONITOR_PREFS.firstTokenWaitSeconds,
  );
  const contextWarnPct = clampInt(src.contextWarnPct, 50, 95, DEFAULT_MONITOR_PREFS.contextWarnPct);
  let contextDangerPct = clampInt(src.contextDangerPct, 60, 99, DEFAULT_MONITOR_PREFS.contextDangerPct);
  if (contextDangerPct <= contextWarnPct) {
    contextDangerPct = Math.min(99, contextWarnPct + 5);
  }
  return {
    cacheWarnMinutes,
    cacheColdMinutes,
    firstTokenWaitSeconds,
    contextWarnPct,
    contextDangerPct,
  };
}

/**
 * Extract only explicitly persisted non-default monitor preferences so default state stays minimal.
 */
export function extractMonitorPrefOverrides(
  raw: Record<string, unknown> | null | undefined,
): Partial<ResolvedMonitorPrefs> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<ResolvedMonitorPrefs> = {};
  const resolved = resolveMonitorPrefs(raw);
  if (Object.hasOwn(raw, 'cacheWarnMinutes') && resolved.cacheWarnMinutes !== DEFAULT_MONITOR_PREFS.cacheWarnMinutes) {
    out.cacheWarnMinutes = resolved.cacheWarnMinutes;
  }
  if (Object.hasOwn(raw, 'cacheColdMinutes') && resolved.cacheColdMinutes !== DEFAULT_MONITOR_PREFS.cacheColdMinutes) {
    out.cacheColdMinutes = resolved.cacheColdMinutes;
  }
  if (
    Object.hasOwn(raw, 'firstTokenWaitSeconds') &&
    resolved.firstTokenWaitSeconds !== DEFAULT_MONITOR_PREFS.firstTokenWaitSeconds
  ) {
    out.firstTokenWaitSeconds = resolved.firstTokenWaitSeconds;
  }
  if (Object.hasOwn(raw, 'contextWarnPct') && resolved.contextWarnPct !== DEFAULT_MONITOR_PREFS.contextWarnPct) {
    out.contextWarnPct = resolved.contextWarnPct;
  }
  if (Object.hasOwn(raw, 'contextDangerPct') && resolved.contextDangerPct !== DEFAULT_MONITOR_PREFS.contextDangerPct) {
    out.contextDangerPct = resolved.contextDangerPct;
  }
  return out;
}

/**
 * Validate monitor threshold keys on an incoming preference update payload.
 */
export function validateMonitorPrefsInput(input: Record<string, unknown>): void {
  const checkIntRange = (key: string, min: number, max: number): void => {
    if (!Object.hasOwn(input, key)) return;
    const raw = input[key];
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
      throw new Error('Invalid monitor threshold preference');
    }
  };
  checkIntRange('cacheWarnMinutes', 0, 998);
  checkIntRange('cacheColdMinutes', 0, 999);
  checkIntRange('firstTokenWaitSeconds', 0, 999);
  checkIntRange('contextWarnPct', 50, 95);
  checkIntRange('contextDangerPct', 60, 99);
}

export const PREFERENCE_KEYS = [
  'language',
  'languageGuideDismissed',
  'usageGuideDismissed',
  'modelTimelineEnabled',
  'debugLaunchEnabled',
  ...FONT_SCALE_KEYS,
  'modelPricingOverrides',
  ...MONITOR_PREFERENCE_KEYS,
] as const;

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

/**
 * Persisted and runtime preferences state.
 */
export interface PreferencesState {
  language: LanguageCode | null;
  languageGuideDismissed: boolean;
  usageGuideDismissed: boolean;
  modelTimelineEnabled: boolean;
  debugLaunchEnabled: boolean;
  usageFontScale?: number;
  sidebarFontScale?: number;
  inlineFontScale?: number;
  modelPricingOverrides?: ModelPricingOverrides;
  cacheWarnMinutes?: number;
  cacheColdMinutes?: number;
  firstTokenWaitSeconds?: number;
  contextWarnPct?: number;
  contextDangerPct?: number;
  revision: number;
}

/**
 * Validated partial update payload accepted by `PreferencesStore.set`.
 */
export interface PreferencesUpdateInput {
  language?: LanguageCode;
  languageGuideDismissed?: true;
  usageGuideDismissed?: true;
  modelTimelineEnabled?: boolean;
  debugLaunchEnabled?: boolean;
  usageFontScale?: number;
  sidebarFontScale?: number;
  inlineFontScale?: number;
  modelPricingOverrides?: ModelPricingOverrides;
  cacheWarnMinutes?: number;
  cacheColdMinutes?: number;
  firstTokenWaitSeconds?: number;
  contextWarnPct?: number;
  contextDangerPct?: number;
}

/**
 * Error payload returned when preferences cannot be read or saved.
 */
export interface PreferencesErrorResult {
  error: string;
}

/**
 * Result returned by `PreferencesStore.snapshot()` and IPC preference handlers.
 */
export type PreferencesSnapshot = PreferencesState | PreferencesErrorResult;

/**
 * Schema-1 on-disk representation stored in `preferences.json`.
 */
export interface PreferencesDiskRecord extends PreferencesState {
  schema: 1;
}
