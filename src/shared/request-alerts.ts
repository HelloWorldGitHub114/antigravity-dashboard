import type { FirstTokenWaitMetrics, RequestErrorInfo, RequestErrorKind, TurnMetrics } from '../contracts/metrics.ts';
import { DEFAULT_MONITOR_PREFS, type ResolvedMonitorPrefs } from '../contracts/preferences.ts';

/**
 * 本轮真实缓存命中状态（依据实际返回中的 cacheReadTokens 与总输入比值判定）。
 */
export type TurnCacheStatusKind = 'idle' | 'hot' | 'warm' | 'cold';

export interface TurnCacheSummary {
  status: TurnCacheStatusKind;
  hitRate: number | null;
  firstHitRate: number | null;
  lastHitRate: number | null;
  measuredRequests: number;
  cachedTokens: number;
  inputTokens: number;
  /** 多请求轮次中首击显著冷启动（<20%），但后续请求已重新热命中 */
  coldStartRecovered: boolean;
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
 * 基于本轮真实返回的缓存读取与总输入 Token，评估本轮缓存命中冷热级别。
 * - >= 70%：hot（热命中）
 * - 20% ~ 70%：warm（部分命中）
 * - < 20%：cold（未命中 / 冷启动）
 */
export function resolveTurnCacheStatus(turn: TurnMetrics | null | undefined): TurnCacheSummary {
  if (!turn || turn.cacheMeasuredRequests <= 0 || turn.cacheHitRate === null || !Number.isFinite(turn.cacheHitRate)) {
    return {
      status: 'idle',
      hitRate: null,
      firstHitRate: null,
      lastHitRate: null,
      measuredRequests: turn?.cacheMeasuredRequests ?? 0,
      cachedTokens: turn?.cachedTokens ?? 0,
      inputTokens: turn?.inputTokens ?? 0,
      coldStartRecovered: false,
    };
  }
  const hitRate = Math.min(1, Math.max(0, turn.cacheHitRate));
  const firstHitRate =
    typeof turn.firstRequestCacheHitRate === 'number' && Number.isFinite(turn.firstRequestCacheHitRate)
      ? Math.min(1, Math.max(0, turn.firstRequestCacheHitRate))
      : null;
  const lastHitRate =
    typeof turn.lastRequestCacheHitRate === 'number' && Number.isFinite(turn.lastRequestCacheHitRate)
      ? Math.min(1, Math.max(0, turn.lastRequestCacheHitRate))
      : null;
  const status: TurnCacheStatusKind = hitRate >= 0.7 ? 'hot' : hitRate >= 0.2 ? 'warm' : 'cold';
  const coldStartRecovered =
    turn.cacheMeasuredRequests >= 2 && firstHitRate !== null && firstHitRate < 0.2 && hitRate >= 0.2;
  return {
    status,
    hitRate,
    firstHitRate,
    lastHitRate,
    measuredRequests: turn.cacheMeasuredRequests,
    cachedTokens: turn.cachedTokens,
    inputTokens: turn.inputTokens,
    coldStartRecovered,
  };
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
