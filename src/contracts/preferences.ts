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

export const PREFERENCE_KEYS = [
  'language',
  'languageGuideDismissed',
  'usageGuideDismissed',
  'modelTimelineEnabled',
  ...FONT_SCALE_KEYS,
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
  usageFontScale?: number;
  sidebarFontScale?: number;
  inlineFontScale?: number;
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
  usageFontScale?: number;
  sidebarFontScale?: number;
  inlineFontScale?: number;
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
