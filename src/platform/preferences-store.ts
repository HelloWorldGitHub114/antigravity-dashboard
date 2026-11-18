// App-independent preferences: no renderer origin, account, or conversation data.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  LanguageCode,
  PreferencesDiskRecord,
  PreferencesSnapshot,
  PreferencesState,
  PreferencesUpdateInput,
} from '../contracts/preferences.ts';
import {
  FONT_SCALE_KEYS,
  PREFERENCE_KEYS,
  resolveFontScale,
  validateFontScaleInput,
} from '../contracts/preferences.ts';
import { atomicWriteJson, readJsonSafe } from '../shared/atomic-fs.ts';
import { platformPaths } from './paths.ts';

export interface PreferencesStoreOptions {
  file?: string;
}

const PREFERENCE_KEY_SET = new Set<string>(PREFERENCE_KEYS);

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null | undefined)?.code === code;
}

/**
 * Validate a UI language code against the supported locale set (`en` | `zh-CN`).
 */
export function validateLanguage(value: unknown): LanguageCode {
  if (value !== 'en' && value !== 'zh-CN') {
    throw new Error('Invalid language preference');
  }
  return value;
}

/**
 * Serialized, atomic, schema-versioned store for user UI preferences.
 */
export class PreferencesStore {
  file: string;
  private queue: Promise<void>;

  constructor({
    file = join(dirname(platformPaths().settings), 'preferences.json'),
  }: PreferencesStoreOptions = {}) {
    this.file = file;
    this.queue = Promise.resolve();
  }

  /**
   * Read the current persisted preferences state, or defaults when missing.
   */
  async get(): Promise<PreferencesState> {
    await this.queue;
    try {
      const raw = (await readFile(this.file, 'utf8')).replace(/^\uFEFF/, '');
      const value = JSON.parse(raw) as Record<string, unknown> | null;
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1) {
        throw new Error('Invalid preferences schema');
      }
      return {
        language: value.language === null ? null : validateLanguage(value.language),
        languageGuideDismissed: value.languageGuideDismissed === true,
        usageGuideDismissed: value.usageGuideDismissed === true,
        modelTimelineEnabled: value.modelTimelineEnabled === true,
        debugLaunchEnabled: value.debugLaunchEnabled === true,
        usageFontScale: resolveFontScale(value.usageFontScale),
        sidebarFontScale: resolveFontScale(value.sidebarFontScale),
        inlineFontScale: resolveFontScale(value.inlineFontScale),
        revision:
          typeof value.revision === 'number' &&
          Number.isSafeInteger(value.revision) &&
          value.revision >= 0
            ? value.revision
            : 0,
      };
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        return {
          language: null,
          languageGuideDismissed: false,
          usageGuideDismissed: false,
          modelTimelineEnabled: false,
          debugLaunchEnabled: false,
          usageFontScale: 1,
          sidebarFontScale: 1,
          inlineFontScale: 1,
          revision: 0,
        };
      }
      throw new Error('Language preference could not be read');
    }
  }

  /**
   * Validate and atomically merge a partial preference update in FIFO queue order.
   */
  async set(input: PreferencesUpdateInput): Promise<PreferencesState> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Invalid preferences request');
    }
    const keys = Object.keys(input);
    if (keys.length === 0 || keys.some((key) => !PREFERENCE_KEY_SET.has(key))) {
      throw new Error('Invalid preferences request');
    }
    const hasLanguage = Object.hasOwn(input, 'language');
    if (hasLanguage) {
      validateLanguage(input.language);
    }
    if (Object.hasOwn(input, 'languageGuideDismissed') && input.languageGuideDismissed !== true) {
      throw new Error('Invalid guide preference');
    }
    if (Object.hasOwn(input, 'usageGuideDismissed') && input.usageGuideDismissed !== true) {
      throw new Error('Invalid usage guide preference');
    }
    if (
      Object.hasOwn(input, 'modelTimelineEnabled') &&
      typeof input.modelTimelineEnabled !== 'boolean'
    ) {
      throw new Error('Invalid timeline preference');
    }
    if (
      Object.hasOwn(input, 'debugLaunchEnabled') &&
      typeof input.debugLaunchEnabled !== 'boolean'
    ) {
      throw new Error('Invalid debug launch preference');
    }
    validateFontScaleInput(input as Record<string, unknown>);

    const operation = this.queue.then(async (): Promise<PreferencesState> => {
      const existing = await readJsonSafe<Record<string, unknown>>(this.file);
      const validRecord =
        existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : null;
      const prior =
        validRecord &&
        typeof validRecord.revision === 'number' &&
        Number.isSafeInteger(validRecord.revision)
          ? validRecord.revision
          : 0;
      const previousLanguage: LanguageCode | null =
        validRecord && (validRecord.language === 'en' || validRecord.language === 'zh-CN')
          ? validRecord.language
          : null;
      const previous = {
        language: previousLanguage,
        languageGuideDismissed: validRecord?.languageGuideDismissed === true,
        usageGuideDismissed: validRecord?.usageGuideDismissed === true,
        modelTimelineEnabled: validRecord?.modelTimelineEnabled === true,
        debugLaunchEnabled: validRecord?.debugLaunchEnabled === true,
        usageFontScale: resolveFontScale(validRecord?.usageFontScale),
        sidebarFontScale: resolveFontScale(validRecord?.sidebarFontScale),
        inlineFontScale: resolveFontScale(validRecord?.inlineFontScale),
      };

      const language: LanguageCode | null = hasLanguage
        ? (input.language as LanguageCode)
        : previous.language;
      const languageGuideDismissed =
        previous.languageGuideDismissed || hasLanguage || input.languageGuideDismissed === true;
      const usageGuideDismissed =
        previous.usageGuideDismissed || input.usageGuideDismissed === true;
      const modelTimelineEnabled = Object.hasOwn(input, 'modelTimelineEnabled')
        ? (input.modelTimelineEnabled as boolean)
        : previous.modelTimelineEnabled;
      const debugLaunchEnabled = Object.hasOwn(input, 'debugLaunchEnabled')
        ? (input.debugLaunchEnabled as boolean)
        : previous.debugLaunchEnabled;
      const scales = Object.fromEntries(
        FONT_SCALE_KEYS.map((key) => [
          key,
          Object.hasOwn(input, key) ? resolveFontScale(input[key]) : previous[key],
        ]),
      ) as Record<(typeof FONT_SCALE_KEYS)[number], number>;
      const revision = Math.max(Date.now(), prior + 1);

      const diskRecord: PreferencesDiskRecord = {
        schema: 1,
        language,
        languageGuideDismissed,
        usageGuideDismissed,
        modelTimelineEnabled,
        debugLaunchEnabled,
        ...scales,
        revision,
      };
      await atomicWriteJson(this.file, diskRecord, { fsync: true, trailingNewline: true });

      return {
        language,
        languageGuideDismissed,
        usageGuideDismissed,
        modelTimelineEnabled,
        debugLaunchEnabled,
        ...scales,
        revision,
      };
    });

    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /**
   * Read current preferences without throwing, returning an error payload on failure.
   */
  async snapshot(): Promise<PreferencesSnapshot> {
    try {
      return await this.get();
    } catch {
      return { error: 'Language preference could not be read' };
    }
  }
}
