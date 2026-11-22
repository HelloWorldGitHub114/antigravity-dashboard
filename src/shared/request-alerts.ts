import type { FirstTokenWaitMetrics, RequestErrorInfo, RequestErrorKind } from '../contracts/metrics.ts';
import { DEFAULT_MONITOR_PREFS, type ResolvedMonitorPrefs } from '../contracts/preferences.ts';

/**
 * Prompt Cache TTL freshness stage computed from idle time since the last completed model response.
 */
export type CacheTtlState = 'idle' | 'active' | 'fresh' | 'warn' | 'cold';

export interface CacheTtlSummary {
  state: CacheTtlState;
  elapsedMs: number;
  progress: number;
  warnMs: number;
  coldMs: number;
}

export type ContextLoadLevel = 'normal' | 'warn' | 'danger';

export interface ActiveWaitAlertSummary {
  active: boolean;
  count: number;
  currentWaitSec: number | null;
  maxWaitSec: number;
  isWaitingNow: boolean;
}

/**
 * 对最近一次模型请求报错进行分类并做基础脱敏（移除 URL、裁剪长度）。
 * 不根据配额百分比反推错误，仅解析宿主或本地轨迹中真实记录的错误文本。
 */
export function classifyRequestError(value: unknown = ''): RequestErrorInfo {
  const text = typeof value === 'string' ? value.trim() : '';
  const diagnostic = text
    .replace(/https?:\/\/[^\s"'<>]+/g, '<API>')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 400);
  const make = (kind: RequestErrorKind, retryAfterSec: number | null = null): RequestErrorInfo => ({
    kind,
    diagnostic,
    retryAfterSec,
  });
  if (!text) return make('none');
  if (
    /\bcontext cancel(?:ed|led)\b|user cancel(?:led|ed)|cancel(?:led|ed) by user|request was aborted|AbortError/i.test(
      text,
    )
  ) {
    return make('canceled');
  }
  if (
    /\b(?:deadline[ _]exceeded|(?:idle|request|connect(?:ion)?|i\/o) timeout|timed out|ETIMEDOUT|TimeoutError)\b/i.test(
      text,
    )
  ) {
    return make('request_timeout');
  }
  if (
    /input token count(?:\s*\([^)]*\)|\s+[\d,]+)?\s+exceeds|context\s*(?:window|length|tokens?|limit|size|capacity)?.{0,35}(?:exceed|too long)|maximum context length|prompt exceeds maximum context length|prompt (?:is )?too long|max_tokens exceeded/i.test(
      text,
    )
  ) {
    return make('context_overflow');
  }
  if (
    /UNAUTHENTICATED|PERMISSION_DENIED|\b401\b|\b403\b|invalid api key|credentials expired|permission denied/i.test(
      text,
    )
  ) {
    return make('auth_error');
  }
  if (
    /UNAVAILABLE|\b50[234]\b|server overloaded|high demand|Bad Gateway|Service Unavailable/i.test(text)
  ) {
    return make('service_unavailable');
  }
  if (
    /\bEOF\b|ECONNRESET|ECONNREFUSED|ENOTFOUND|connection reset|connection refused|socket hang up|fetch failed|NetworkError/i.test(
      text,
    )
  ) {
    return make('network_error');
  }
  if (
    /quota\s*(?:exceeded|reached|limit|exhausted)|out\s+of\s+quota|exhausted.*(?:capacity|quota)|resource_exhausted.*(?:quota|capacity|billing)|free\s+tier\s+quota|daily\s+quota|weekly\s+quota/i.test(
      text,
    )
  ) {
    return make('quota_exhausted');
  }
  if (/rate\s*limit|too\s+many\s+requests|\b429\b|RateLimitError|RESOURCE_EXHAUSTED.*rate/i.test(text)) {
    const wait = text.match(/(?:retry\s+in|retry-after|wait)\s*[:=]?\s*([\d.]+)\s*(?:s|sec|seconds)?/i);
    const seconds = wait ? Number(wait[1]) : null;
    return make('rate_limited', seconds !== null && Number.isFinite(seconds) && seconds >= 0 ? seconds : null);
  }
  return make('unknown');
}

/**
 * 计算服务端 Prompt Cache 距上次响应结束后的本地保鲜估算状态。
 */
export function resolveCacheTtl(
  lastResponseAtMs: number | null | undefined,
  nowMs: number,
  isGenerating: boolean,
  prefs: Pick<ResolvedMonitorPrefs, 'cacheWarnMinutes' | 'cacheColdMinutes'> = DEFAULT_MONITOR_PREFS,
): CacheTtlSummary {
  const warnMs = prefs.cacheWarnMinutes > 0 ? prefs.cacheWarnMinutes * 60_000 : 0;
  const coldMs = prefs.cacheColdMinutes > 0 ? prefs.cacheColdMinutes * 60_000 : 0;
  if (warnMs <= 0 || coldMs <= 0) {
    return { state: 'idle', elapsedMs: 0, progress: 0, warnMs, coldMs };
  }
  if (isGenerating) {
    return { state: 'active', elapsedMs: 0, progress: 0, warnMs, coldMs };
  }
  if (typeof lastResponseAtMs !== 'number' || !Number.isFinite(lastResponseAtMs) || lastResponseAtMs <= 0) {
    return { state: 'idle', elapsedMs: 0, progress: 0, warnMs, coldMs };
  }
  const elapsedMs = Math.max(0, nowMs - lastResponseAtMs);
  const progress = Math.min(1, elapsedMs / coldMs);
  const state: CacheTtlState =
    elapsedMs >= coldMs ? 'cold' : elapsedMs >= warnMs ? 'warn' : 'fresh';
  return { state, elapsedMs, progress, warnMs, coldMs };
}

/**
 * 判定当前上下文占用所处预警级别（默认 75% 变黄，90% 变红）。
 */
export function resolveContextLoad(
  usedFraction: number | null | undefined,
  prefs: Pick<ResolvedMonitorPrefs, 'contextWarnPct' | 'contextDangerPct'> = DEFAULT_MONITOR_PREFS,
): ContextLoadLevel {
  if (typeof usedFraction !== 'number' || !Number.isFinite(usedFraction) || usedFraction < 0) {
    return 'normal';
  }
  const pct = usedFraction * 100;
  if (pct >= prefs.contextDangerPct) return 'danger';
  if (pct >= prefs.contextWarnPct) return 'warn';
  return 'normal';
}

/**
 * 根据本轮首字等待记录与实时等待起点，计算是否触发黄色等待告警胶囊。
 */
export function summarizeActiveWaitAlert(
  turnQueue: FirstTokenWaitMetrics | null | undefined,
  nowMs: number,
  thresholdSeconds: number = DEFAULT_MONITOR_PREFS.firstTokenWaitSeconds,
): ActiveWaitAlertSummary {
  if (!turnQueue || thresholdSeconds <= 0) {
    return { active: false, count: 0, currentWaitSec: null, maxWaitSec: 0, isWaitingNow: false };
  }
  const completedOver = (Array.isArray(turnQueue.waits) ? turnQueue.waits : []).filter(
    (s) => typeof s === 'number' && Number.isFinite(s) && s >= thresholdSeconds,
  );
  let currentWaitSec: number | null = null;
  if (
    !turnQueue.turnTerminal &&
    typeof turnQueue.waitingSinceMs === 'number' &&
    Number.isFinite(turnQueue.waitingSinceMs) &&
    turnQueue.waitingSinceMs > 0
  ) {
    const elapsedSec = Math.max(0, (nowMs - turnQueue.waitingSinceMs) / 1000);
    if (elapsedSec >= thresholdSeconds) {
      currentWaitSec = elapsedSec;
    }
  }
  const count = completedOver.length + (currentWaitSec !== null ? 1 : 0);
  const maxCompleted = completedOver.length ? Math.max(...completedOver) : 0;
  const maxWaitSec = Math.max(maxCompleted, currentWaitSec ?? 0);
  return {
    active: count > 0,
    count,
    currentWaitSec,
    maxWaitSec,
    isWaitingNow: currentWaitSec !== null,
  };
}

/**
 * 将毫秒耗时格式化为紧凑的短时长文本（如 `42s`、`3m 12s`、`12m+`）。
 */
export function formatCompactElapsedMs(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  }
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}
