import type { ContextBreakdown, RequestErrorInfo, RequestErrorKind, TurnState } from '../../contracts/metrics.ts';
import { compact, percent } from '../../shared/format.ts';
import type {
  ActiveWaitAlertSummary,
  TurnCacheSummary,
} from '../../shared/request-alerts.ts';

type Translator = (key: string, params?: Record<string, string | number>) => string;

export interface ErrorKindCopy {
  label: string;
  desc: string;
}

export function errorKindCopy(kind: RequestErrorKind, t: Translator): ErrorKindCopy {
  switch (kind) {
    case 'request_timeout':
      return { label: t('alertErrorTimeout'), desc: t('alertErrorTimeoutDesc') };
    case 'network_error':
      return { label: t('alertErrorNetwork'), desc: t('alertErrorNetworkDesc') };
    case 'rate_limited':
      return { label: t('alertErrorRateLimit'), desc: t('alertErrorRateLimitDesc') };
    case 'quota_exhausted':
      return { label: t('alertErrorQuota'), desc: t('alertErrorQuotaDesc') };
    case 'context_overflow':
      return { label: t('alertErrorOverflow'), desc: t('alertErrorOverflowDesc') };
    case 'auth_error':
      return { label: t('alertErrorAuth'), desc: t('alertErrorAuthDesc') };
    case 'service_unavailable':
      return { label: t('alertErrorUnavailable'), desc: t('alertErrorUnavailableDesc') };
    case 'canceled':
      return { label: t('alertErrorCanceled'), desc: t('alertErrorCanceledDesc') };
    default:
      return { label: t('alertErrorUnknown'), desc: t('alertErrorUnknownDesc') };
  }
}

export interface TurnCacheDisplay {
  visible: boolean;
  status: TurnCacheSummary['status'];
  headline: string;
  meta: string;
  barPct: number;
}

/**
 * 生成“本轮缓存命中”区块的主标题文案、进度条宽度与首击/末次明细。
 */
export function formatTurnCacheDisplay(summary: TurnCacheSummary, t: Translator): TurnCacheDisplay {
  if (summary.status === 'idle' || summary.hitRate === null) {
    return { visible: false, status: 'idle', headline: '—', meta: '', barPct: 0 };
  }
  const rateText = percent(summary.hitRate);
  const statusLabel =
    summary.status === 'hot'
      ? t('turnCacheHot')
      : summary.status === 'warm'
        ? t('turnCacheWarm')
        : t('turnCacheCold');
  const headline = `${rateText} · ${statusLabel}`;
  const tokPart = `${compact(summary.cachedTokens)} / ${compact(summary.inputTokens)} tok`;
  const parts: string[] = [];
  if (summary.measuredRequests >= 2 && summary.firstHitRate !== null && summary.lastHitRate !== null) {
    parts.push(
      t('turnCacheRange', {
        first: percent(summary.firstHitRate),
        last: percent(summary.lastHitRate),
      }),
    );
  }
  parts.push(tokPart);
  return {
    visible: true,
    status: summary.status,
    headline,
    meta: parts.join(' · '),
    barPct: Math.round(summary.hitRate * 100),
  };
}

export function formatTurnStateLabel(state: TurnState | undefined, t: Translator): string {
  switch (state) {
    case 'running':
      return t('turnStateRunning');
    case 'queued':
      return t('turnStateQueued');
    case 'completed':
      return t('turnStateCompleted');
    case 'failed':
      return t('turnStateFailed');
    case 'interrupted':
      return t('turnStateInterrupted');
    default:
      return '';
  }
}

export interface AlertBadgeView {
  visible: boolean;
  severity: 'none' | 'wait' | 'error';
  label: string;
}

/**
 * 汇总第三告警胶囊的展示文案与级别：同时存在请求失败和首字等待时，优先显示请求失败（红标）。
 */
export function resolveAlertBadge(
  error: RequestErrorInfo | null | undefined,
  waitAlert: ActiveWaitAlertSummary,
  t: Translator,
): AlertBadgeView {
  if (error && error.kind !== 'none' && error.kind !== 'canceled') {
    return {
      visible: true,
      severity: 'error',
      label: errorKindCopy(error.kind, t).label,
    };
  }
  if (waitAlert.active) {
    const displaySec = Math.max(
      1,
      Math.round(waitAlert.currentWaitSec ?? waitAlert.maxWaitSec),
    );
    const label =
      waitAlert.count > 1
        ? t('alertWaitChipMulti', { n: waitAlert.count, sec: displaySec })
        : t('alertWaitChip', { sec: displaySec });
    return {
      visible: true,
      severity: 'wait',
      label,
    };
  }
  return { visible: false, severity: 'none', label: '' };
}

export interface ContextBreakdownSegment {
  key: 'baseline' | 'read' | 'thinking' | 'output';
  labelKey: 'contextSegBaseline' | 'contextSegRead' | 'contextSegThinking' | 'contextSegOutput';
  tokens: number;
  pct: number;
}

export function buildContextBreakdownSegments(
  breakdown: ContextBreakdown | null | undefined,
): ContextBreakdownSegment[] {
  if (!breakdown || breakdown.totalTokens <= 0) return [];
  const total = breakdown.totalTokens;
  const pct = (n: number): number => Math.min(100, Math.max(0, (n / total) * 100));
  return [
    { key: 'baseline', labelKey: 'contextSegBaseline', tokens: breakdown.baselineTokens, pct: pct(breakdown.baselineTokens) },
    { key: 'read', labelKey: 'contextSegRead', tokens: breakdown.readTokens, pct: pct(breakdown.readTokens) },
    { key: 'thinking', labelKey: 'contextSegThinking', tokens: breakdown.thinkingTokens, pct: pct(breakdown.thinkingTokens) },
    { key: 'output', labelKey: 'contextSegOutput', tokens: breakdown.outputTokens, pct: pct(breakdown.outputTokens) },
  ];
}
