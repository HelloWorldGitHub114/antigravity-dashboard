/**
 * Supported UI and sidecar language codes.
 */
export type LanguageCode = 'en' | 'zh-CN';

/**
 * Whitelisted preference keys accepted by the preferences store and IPC bridges.
 */
export const PREFERENCE_KEYS = [
  'language',
  'languageGuideDismissed',
  'usageGuideDismissed',
  'modelTimelineEnabled',
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
