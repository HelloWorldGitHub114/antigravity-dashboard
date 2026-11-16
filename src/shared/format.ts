export type FormatLanguage = 'en' | 'zh-CN';

export interface CompactOptions {
  fallback?: string;
  localeFallback?: string;
  maxUnit?: 'B' | 'M';
}

/**
 * Formats a `0..1` fraction as a percentage string with 1 decimal place (or `'—'`).
 */
export function percent(fraction: number | null | undefined): string {
  return typeof fraction === 'number' && Number.isFinite(fraction)
    ? `${(fraction * 100).toFixed(1)}%`
    : '—';
}

/**
 * Alias for {@link percent}.
 */
export function pct(fraction: number | null | undefined): string {
  return percent(fraction);
}

/**
 * Formats a throughput/rate value with fixed 1-decimal `en-US` grouping (or `'—'`).
 */
export function rate(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })
    : '—';
}

/**
 * Formats an integer/count value using locale grouping (default `'en-US'`, or `'—'`).
 */
export function count(value: number | null | undefined, locale = 'en-US'): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(locale)
    : '—';
}

/**
 * Formats an elapsed duration in seconds in Chinese (`zh-CN`, default) or English (`en`).
 */
export function elapsed(
  seconds: number | null | undefined,
  language: FormatLanguage = 'zh-CN',
): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) {
    return `${seconds.toFixed(2)}${language === 'en' ? 's' : ' 秒'}`;
  }
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return language === 'en'
    ? `${h ? `${h}h ` : ''}${m}m ${s}s`
    : `${h ? `${h}小时` : ''}${m}分${s}秒`;
}

/**
 * Formats a countdown timer until `resetAt`, matching panel and i18n formatting rules.
 */
export function countdown(
  resetAt: string | number | Date | null | undefined,
  now = Date.now(),
  compactMode = false,
  language: FormatLanguage = 'zh-CN',
): string {
  const end =
    typeof resetAt === 'number'
      ? resetAt
      : resetAt instanceof Date
        ? resetAt.getTime()
        : typeof resetAt === 'string'
          ? Date.parse(resetAt)
          : NaN;
  if (!Number.isFinite(end)) return '—';
  if (end <= now) return language === 'en' ? 'Waiting for refresh' : '等待刷新';
  const left = Math.ceil((end - now) / 1000);
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const dayUnit = language === 'en' ? 'd' : '天';
  return `${d ? `${d}${dayUnit} ` : ''}${pad(h)}:${pad(m)}${compactMode && d ? '' : `:${pad(s)}`}`;
}

/**
 * Formats a reset timestamp in `Asia/Shanghai` (`MM/DD HH:MM`, 24-hour).
 */
export function resetDate(
  value: string | number | Date | null | undefined,
  language: FormatLanguage = 'zh-CN',
): string {
  if (value === null || value === undefined) return '—';
  const date = value instanceof Date ? value : new Date(value);
  const locale = language === 'en' ? 'en-GB' : 'zh-CN';
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(locale, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Asia/Shanghai',
      }).format(date)
    : '—';
}

/**
 * Formats a large numeric token/count value into compact `B`/`M`/`K` units.
 */
export function compact(
  value: number | null | undefined,
  options: CompactOptions = {},
): string {
  const fallback = options.fallback ?? '—';
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (options.maxUnit !== 'M' && value >= 1e9) {
    return `${(value / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  }
  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1e3) {
    return `${(value / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return options.localeFallback
    ? value.toLocaleString(options.localeFallback)
    : String(value);
}

/**
 * Formats a `0..100` percentage value for CLI statusline output (or `fallback`).
 */
export function percentage(
  value: number | null | undefined,
  fallback = '--',
): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return `${Number(value.toFixed(1))}%`;
}

/**
 * Formats a compact CLI quota reset countdown from an absolute timestamp or relative seconds.
 */
export function cliCountdown(
  resetTimeMs: number | null | undefined,
  resetInSeconds: number | null | undefined,
  now = Date.now(),
): string | null {
  const seconds =
    typeof resetTimeMs === 'number' && Number.isFinite(resetTimeMs)
      ? Math.max(0, (resetTimeMs - now) / 1000)
      : typeof resetInSeconds === 'number' && Number.isFinite(resetInSeconds)
        ? resetInSeconds
        : null;
  if (seconds === null) return null;
  if (seconds < 60) return '<1m';
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
  }
  return `${Math.floor(seconds / 86400)}d${Math.floor((seconds % 86400) / 3600)}h`;
}
