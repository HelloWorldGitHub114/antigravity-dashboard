// Shared, serializable translations for the inline widget and native panel.
import type { LanguageCode, PreferencesSnapshot, PreferencesUpdateInput } from '../../contracts/preferences.ts';
import {
  countdown as formatCountdown,
  elapsed as formatElapsed,
  resetDate as formatResetDate,
} from '../../shared/format.ts';
import { EN_DICTIONARY, type I18nDictionary, type I18nKey } from './dictionary-en.ts';
import { ZH_DICTIONARY } from './dictionary-zh.ts';

export interface ConnectPreferencesOptions {
  read: () => Promise<PreferencesSnapshot>;
  write: (input: PreferencesUpdateInput) => Promise<PreferencesSnapshot>;
  cache?: (language: LanguageCode) => void;
  changed?: () => void;
}

export interface PreferencesController {
  ready: Promise<void>;
  sync: (value: PreferencesSnapshot) => void;
  choose: (value: LanguageCode) => Promise<void>;
  toggle: () => Promise<void>;
  readonly error: boolean;
  readonly pending: boolean;
  dispose: () => void;
}

export interface RateNoteSpeedInput {
  latestRateStatus?: string | null;
  rateBasis?: string | null;
  status?: string | null;
}

export interface DashboardI18n {
  t: (key: string, args?: Record<string, string | number | boolean | null | undefined>) => string;
  rateNote: (speed: RateNoteSpeedInput | null | undefined) => string;
  countdown: (at: string | number | Date | null | undefined, now?: number, compact?: boolean) => string;
  elapsed: (value: number | null | undefined) => string;
  resetDate: (value: string | number | Date | null | undefined) => string;
  errorMessage: (value: string | null | undefined) => string;
  connectPreferences: (options: ConnectPreferencesOptions) => PreferencesController;
  readonly language: LanguageCode;
  setLanguage: (value: string) => void;
  toggle: () => LanguageCode;
}

const BACKEND_ERRORS: Record<string, string> = {
  '请先打开 Antigravity': 'Open Antigravity to connect.',
  '当前采集适配器支持 Windows': 'This collector requires Windows.',
  '检测到多个 Antigravity 实例，请保留一个': 'Multiple Antigravity instances detected. Keep one open.',
  '未找到 Antigravity 桌面后台': 'Antigravity desktop backend was not found.',
  '当前版本未提供可用的本地检测凭据': 'Local metrics credentials are unavailable in this version.',
  '当前版本已切换为本地 SQLite 直读模式（云端额度暂不可用）':
    'Local SQLite mode active (cloud quota unavailable in this host version).',
  '等待 Antigravity 本地接口启动': 'Waiting for the local Antigravity API.',
  '未找到 Antigravity 语言服务日志，请检查日志路径':
    'Antigravity language-server log was not found. Check the log path.',
  '会话暂时没有可用统计': 'No statistics are available for this conversation yet.',
  '完整会话统计分页暂不可用': 'Complete conversation statistics are temporarily unavailable.',
  '会话统计数据超过内存预算': 'Conversation statistics exceed the memory budget.',
  '会话统计数据超过采集上限': 'Retained conversation statistics exceed the collection budget.',
  '会话统计字段超过采集上限': 'A statistics field exceeds the collection budget.',
  '会话统计分页读取超时': 'Conversation statistics pagination timed out.',
  '会话统计分页数量无效': 'Invalid conversation statistics page count.',
  '会话统计分页格式无效': 'Invalid conversation statistics page format.',
  '会话仍在更新，请等待下一次刷新': 'The conversation is updating; waiting for the next refresh.',
  '接口响应超过采集上限': 'The API response exceeds the collection budget.',
  'Antigravity 接口返回了无法解析的数据': 'Antigravity returned an invalid response.',
  'Antigravity 本地接口超时': 'The local Antigravity API timed out.',
  '远程环境休眠或同步较慢，请稍候刷新':
    'Remote environment is hibernated or syncing slowly; please refresh shortly.',
  '当前登录账号未开启远程 Agent (Cloud Conversations) 权限':
    'Cloud Conversations (Remote Agent) is not enabled for the signed-in account.',
  '会话标识无效': 'Invalid conversation identifier.',
  '等待 Antigrative Dashboard 后台启动': 'Waiting for the dashboard background process.',
  '等待 Antigrative Dashboard 重新连接': 'Waiting for the dashboard to reconnect.',
  '等待 AG Pulse 后台启动': 'Waiting for the dashboard background process.',
  '等待 AG Pulse 重新连接': 'Waiting for the dashboard to reconnect.',
};

const DICTIONARIES: Record<LanguageCode, I18nDictionary> = {
  en: EN_DICTIONARY,
  'zh-CN': ZH_DICTIONARY,
};

const isLanguageCode = (value: unknown): value is LanguageCode =>
  value === 'en' || value === 'zh-CN';

export default function createDashboardI18n(initialLanguage?: unknown): DashboardI18n {
  let language: LanguageCode = initialLanguage === 'zh-CN' ? 'zh-CN' : 'en';

  const t = (
    key: string,
    args: Record<string, string | number | boolean | null | undefined> = {},
  ): string => {
    const dict = DICTIONARIES[language];
    const template =
      (Object.hasOwn(dict, key) ? dict[key as I18nKey] : undefined) ||
      (Object.hasOwn(EN_DICTIONARY, key) ? EN_DICTIONARY[key as I18nKey] : undefined) ||
      key;
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(args[name] ?? ''));
  };

  function countdown(
    at: string | number | Date | null | undefined,
    now = Date.now(),
    compact = false,
  ): string {
    return formatCountdown(at, now, compact, language);
  }

  function elapsed(value: number | null | undefined): string {
    return formatElapsed(value, language);
  }

  function resetDate(value: string | number | Date | null | undefined): string {
    return formatResetDate(value, language);
  }

  function errorMessage(value: string | null | undefined): string {
    if (!value) return '';
    const key = (Object.keys(EN_DICTIONARY) as I18nKey[]).find(
      (entry) => EN_DICTIONARY[entry] === value,
    );
    if (key) return t(key);
    if (language === 'zh-CN') return value;
    if (BACKEND_ERRORS[value]) return BACKEND_ERRORS[value];
    const match = String(value).match(/^Antigravity 接口 (\w+) 返回 (\d+)$/);
    return match
      ? `Antigravity ${match[1]} returned HTTP ${match[2]}.`
      : 'Statistics are temporarily unavailable.';
  }

  function connectPreferences({
    read,
    write,
    cache = () => {},
    changed = () => {},
  }: ConnectPreferencesOptions): PreferencesController {
    let epoch = 0;
    let writes = 0;
    let revision = -1;
    let disposed = false;
    let error = false;
    let queue: Promise<void> = Promise.resolve();

    const notify = (): void => {
      if (!disposed) changed();
    };
    const remember = (): void => {
      try {
        cache(language);
      } catch {
        // Ignore storage write errors in restricted renderer contexts.
      }
    };
    const check = (value: PreferencesSnapshot) => {
      if (
        !value ||
        'error' in value ||
        !Object.hasOwn(value, 'language') ||
        (value.language !== null && !isLanguageCode(value.language))
      ) {
        throw new Error('Invalid preference response');
      }
      return value;
    };

    function sync(value: PreferencesSnapshot): void {
      if (disposed || writes) return;
      try {
        const checked = check(value);
        const next = Number.isSafeInteger(checked.revision) ? checked.revision : 0;
        if (next < revision) return;
        if (error && epoch > 0 && checked.language !== language) return; // retain an unsaved choice and its warning
        if (checked.language === null && epoch === 0 && isLanguageCode(initialLanguage)) {
          void choose(initialLanguage);
          return;
        }
        revision = next;
        error = false;
        if (isLanguageCode(checked.language) && language !== checked.language) {
          language = checked.language;
          remember();
        }
        notify();
      } catch {
        error = true;
        notify();
      }
    }

    function choose(value: LanguageCode): Promise<void> {
      if (disposed || !isLanguageCode(value)) return Promise.resolve();
      const choice = ++epoch;
      language = value;
      writes++;
      error = false;
      remember();
      notify();
      const pending = queue.then(async () => {
        try {
          const saved = check(await write({ language: value }));
          if (saved.language !== value) throw new Error('Preference acknowledgement differs');
          revision = Math.max(revision, Number.isSafeInteger(saved.revision) ? saved.revision : 0);
          if (choice === epoch) error = false;
        } catch {
          if (choice === epoch) error = true;
        } finally {
          writes--;
          notify();
        }
      });
      queue = pending;
      return pending;
    }

    const ready = (async () => {
      const started = epoch;
      try {
        const saved = check(await read());
        if (disposed || epoch !== started) return;
        if (saved.language === null && isLanguageCode(initialLanguage)) {
          await choose(initialLanguage); // migrate an existing browser choice once
        } else {
          sync(saved);
        }
      } catch {
        if (!disposed && epoch === started) {
          error = true;
          notify();
        }
      }
    })();

    return {
      ready,
      sync,
      choose,
      toggle: () => choose(language === 'en' ? 'zh-CN' : 'en'),
      get error() {
        return error;
      },
      get pending() {
        return writes > 0;
      },
      dispose() {
        disposed = true;
      },
    };
  }

  function rateNote(speed: RateNoteSpeedInput | null | undefined): string {
    if (!speed) return t('waitingRequest');
    if (speed.latestRateStatus === 'legacy') return t('ratePending');
    const basis = t(speed.rateBasis === 'all-output' ? 'allBasis' : 'responseBasis');
    if (speed.latestRateStatus === 'generating' || /RUNNING/i.test(speed.status || '')) {
      return `${t('running')} ${basis}`;
    }
    return basis;
  }

  return {
    t,
    rateNote,
    countdown,
    elapsed,
    resetDate,
    errorMessage,
    connectPreferences,
    get language() {
      return language;
    },
    setLanguage(value: string) {
      language = value === 'zh-CN' ? 'zh-CN' : 'en';
    },
    toggle() {
      language = language === 'en' ? 'zh-CN' : 'en';
      return language;
    },
  };
}
