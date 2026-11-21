import type { QuotaGroup, QuotaWindow, QuotaWindowUsage } from '../contracts/index.ts';

export type QuotaWindowKey = '5h' | 'weekly';
export type QuotaPaceKind = 'idle' | 'slow' | 'steady' | 'fast';
export type QuotaOutlookKind = 'idle' | 'ok' | 'tight' | 'exhaust';

export interface QuotaForecastResult {
  remaining: number;
  used: number;
  timeRemaining: number | null;
  pace: QuotaPaceKind;
  paceDelta: number;
  forecastReady: boolean;
  warmingUp: boolean;
  projectedUsed: number | null;
  projectedRemaining: number | null;
  willExhaust: boolean;
  exhaustInMs: number | null;
  earlyByMs: number | null;
  outlook: QuotaOutlookKind | null;
}

export interface GroupQuotaPaceResult {
  pace: QuotaOutlookKind;
  delta: number;
  window: QuotaWindowKey;
  critical: boolean;
  labelKey: 'paceIdle' | 'outlookOk' | 'outlookTight' | 'outlookExhaust';
  windowKey: 'five' | 'week';
}

export interface QuotaWindowSpec {
  id: string;
  groupId: string;
  window: QuotaWindowKey;
  startAt: number;
  endAt: number;
  resetMinute: number;
  remaining: number | null;
  idle: boolean;
}

export interface QuotaWindowGroupInfo {
  id: string;
  name: string;
}

export interface QuotaWindowRawCount {
  observedTokens: number;
  requests: number;
}

export type QuotaWindowMetaMap = Record<string, { resetMinute: number; idle: boolean }>;

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SAMPLE_5H_MS = 5 * 60 * 1000;
const MIN_SAMPLE_WEEKLY_MS = 60 * 60 * 1000;

/**
 * 提取合法的额度剩余比例（0..1）；未启用或不可用窗口返回 null。
 */
export function quotaRemaining(bucket: QuotaWindow | null | undefined): number | null {
  if (!bucket || bucket.available !== true || bucket.disabled === true) return null;
  const value = bucket.remaining;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

/**
 * 返回模型所属的额度分组类型，用于将本地请求账本归入对应的额度池。
 */
export function quotaModelFamily(value: string | null | undefined): 'gemini-argon' | 'gemini' | '3p' | null {
  const text = String(value || '');
  if (/(?:^|[^a-z])argon(?:$|[^a-z])/i.test(text)) return 'gemini-argon';
  if (/gemini|hydrogen|carbon|neon|orchestrator/i.test(text)) return 'gemini';
  if (
    /claude|sonnet|opus|haiku|anthropic|gpt|openai/i.test(text) ||
    /(?:^|[^a-z0-9])o[134](?:$|[^a-z0-9])/i.test(text) ||
    /^3p(?:$|[-_])/i.test(text)
  ) {
    return '3p';
  }
  return null;
}

/**
 * 根据模型名匹配对应的额度分组 ID；若存在独立 Argon 分组优先匹配，否则回落到共享 Gemini 分组。
 */
export function classifyQuotaGroupId(
  groups: ReadonlyArray<QuotaWindowGroupInfo> | null | undefined,
  model: string | null | undefined,
): string | null {
  const list = Array.isArray(groups) ? groups.filter((g) => g && typeof g.id === 'string') : [];
  if (!list.length) return null;
  const kind = quotaModelFamily(model);
  const specific = kind ? list.find((g) => quotaModelFamily(`${g.id} ${g.name || ''}`) === kind) : undefined;
  if (specific) return specific.id;
  if (kind === 'gemini-argon') {
    const shared = list.find((g) => g.id === 'gemini' && quotaModelFamily(`${g.id} ${g.name || ''}`) === 'gemini');
    if (shared) return shared.id;
  }
  return kind ? null : list[0].id;
}

/**
 * 格式化简短预计耗尽/提前时长（例如 45m、2h 15m、3d 4h）。
 */
export function shortEta(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  const totalMin = Math.max(1, Math.round(ms / 60000));
  if (totalMin < 60) return `${totalMin}m`;
  if (totalMin < 1440) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}h${m ? ` ${m}m` : ''}`;
  }
  const totalH = Math.round(ms / 3600000);
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  return `${d}d${h ? ` ${h}h` : ''}`;
}

/**
 * 基于当前窗口已流逝时长与已消耗比例，做线性耗尽预测与节奏评估。
 * 窗口刚开启且消耗不足 10% 时进入采样预热态，避免极小分母导致误报警。
 */
export function quotaForecast(
  bucket: QuotaWindow | null | undefined,
  windowKey: QuotaWindowKey,
  now: number = Date.now(),
): QuotaForecastResult | null {
  const remaining = quotaRemaining(bucket);
  if (remaining === null) return null;
  const used = Math.max(0, Math.min(1, 1 - remaining));
  const resetAt = bucket && bucket.available === true ? bucket.resetAt : null;
  const resetMs = typeof resetAt === 'string' ? Date.parse(resetAt) : NaN;
  if (!Number.isFinite(resetMs) || resetMs <= now) {
    return used === 0
      ? {
          remaining: 1,
          used: 0,
          timeRemaining: null,
          pace: 'idle',
          paceDelta: 0,
          forecastReady: false,
          warmingUp: false,
          projectedUsed: 0,
          projectedRemaining: 1,
          willExhaust: false,
          exhaustInMs: null,
          earlyByMs: null,
          outlook: 'idle',
        }
      : null;
  }

  const durationMs = windowKey === '5h' ? FIVE_HOUR_MS : WEEKLY_MS;
  const leftMs = Math.max(0, Math.min(durationMs, resetMs - now));
  const elapsedMs = durationMs - leftMs;
  const timeRemaining = leftMs / durationMs;
  const elapsed = elapsedMs / durationMs;
  const paceDelta = remaining - timeRemaining;

  let pace: QuotaPaceKind =
    used < 0.0005 ? 'idle' : paceDelta < -0.05 ? 'fast' : paceDelta > 0.08 ? 'slow' : 'steady';
  const minSampleMs = windowKey === '5h' ? MIN_SAMPLE_5H_MS : MIN_SAMPLE_WEEKLY_MS;

  let forecastReady = false;
  let warmingUp = false;
  let projectedUsed: number | null = null;
  let projectedRemaining: number | null = null;
  let willExhaust = false;
  let exhaustInMs: number | null = null;

  if (used < 0.0005) {
    forecastReady = true;
    projectedUsed = 0;
    projectedRemaining = 1;
  } else if (elapsedMs < minSampleMs && used < 0.1) {
    warmingUp = true;
  } else {
    const rawProjectedUsed = elapsed > 0 ? used / elapsed : Infinity;
    projectedUsed = Math.min(1, rawProjectedUsed);
    projectedRemaining = Math.max(0, 1 - rawProjectedUsed);
    willExhaust = rawProjectedUsed > 1.005;
    exhaustInMs = willExhaust && used > 0 ? Math.max(60000, Math.round(elapsedMs * (remaining / used))) : null;
    forecastReady = true;
    if (willExhaust) pace = 'fast';
  }

  const earlyByMs = willExhaust && exhaustInMs !== null ? Math.max(60000, leftMs - exhaustInMs) : null;
  const outlook: QuotaOutlookKind | null =
    used < 0.0005 ? 'idle' : !forecastReady ? null : willExhaust ? 'exhaust' : (projectedRemaining ?? 1) < 0.2 ? 'tight' : 'ok';

  return {
    remaining,
    used,
    timeRemaining,
    pace,
    paceDelta,
    forecastReady,
    warmingUp,
    projectedUsed,
    projectedRemaining,
    willExhaust,
    exhaustInMs,
    earlyByMs,
    outlook,
  };
}

/**
 * 综合评估某个额度分组下 5h / 周窗口中最紧张的消耗节奏，用于渲染分组节奏徽标。
 */
export function groupQuotaPace(
  group: QuotaGroup | null | undefined,
  now: number = Date.now(),
): GroupQuotaPaceResult | null {
  if (!group) return null;
  const windows: QuotaWindowKey[] = (['5h', 'weekly'] as const).filter(
    (key) => group.windows?.[key]?.available === true,
  );
  const activeWindows = windows.length ? windows : (['5h', 'weekly'] as const);
  const items = activeWindows
    .map((w) => ({ w, f: quotaForecast(group.windows?.[w], w, now) }))
    .filter((x): x is { w: QuotaWindowKey; f: QuotaForecastResult } => Boolean(x.f && typeof x.f.timeRemaining === 'number'));

  if (!items.length) return null;
  if (items.every((x) => x.f.outlook === 'idle')) {
    return {
      pace: 'idle',
      delta: 0,
      window: items[0].w,
      critical: false,
      labelKey: 'paceIdle',
      windowKey: items[0].w === '5h' ? 'five' : 'week',
    };
  }

  const rank: Record<'exhaust' | 'tight' | 'ok', number> = { exhaust: 0, tight: 1, ok: 2 };
  const ready = items
    .filter((x): x is { w: QuotaWindowKey; f: QuotaForecastResult & { outlook: 'exhaust' | 'tight' | 'ok' } } =>
      x.f.outlook === 'exhaust' || x.f.outlook === 'tight' || x.f.outlook === 'ok',
    )
    .sort(
      (a, b) =>
        rank[a.f.outlook] - rank[b.f.outlook] ||
        (a.f.projectedRemaining ?? 1) - (b.f.projectedRemaining ?? 1),
    );
  if (!ready.length) return null;

  const chosen = ready[0];
  const f = chosen.f;
  const labelKey = f.outlook === 'exhaust' ? 'outlookExhaust' : f.outlook === 'tight' ? 'outlookTight' : 'outlookOk';
  const critical =
    f.remaining < 0.1 ||
    (f.willExhaust && f.exhaustInMs !== null && f.exhaustInMs < (chosen.w === '5h' ? 3600000 : 86400000));

  return {
    pace: f.outlook,
    delta: f.paceDelta,
    window: chosen.w,
    critical,
    labelKey,
    windowKey: chosen.w === '5h' ? 'five' : 'week',
  };
}

/**
 * 从宿主返回的额度分组构建周期时间窗口规格，用于统计本周期实测 Token。
 */
export function buildQuotaWindowSpecs(groups: ReadonlyArray<QuotaGroup> | null | undefined): {
  specs: QuotaWindowSpec[];
  groupInfos: QuotaWindowGroupInfo[];
} {
  const specs: QuotaWindowSpec[] = [];
  const groupInfos: QuotaWindowGroupInfo[] = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g || typeof g.id !== 'string') continue;
    groupInfos.push({ id: g.id, name: String(g.name || '') });
    for (const win of ['5h', 'weekly'] as const) {
      const b = g.windows?.[win];
      if (!b || b.available !== true || b.disabled === true) continue;
      const endAt = typeof b.resetAt === 'string' ? Date.parse(b.resetAt) : NaN;
      if (!Number.isFinite(endAt)) continue;
      const dur = win === '5h' ? FIVE_HOUR_MS : WEEKLY_MS;
      const remaining = quotaRemaining(b);
      const idle = remaining !== null && remaining >= 1;
      specs.push({
        id: `${g.id}:${win}`,
        groupId: g.id,
        window: win,
        startAt: endAt - dur,
        endAt,
        resetMinute: Math.round(endAt / 60000),
        remaining,
        idle,
      });
    }
  }
  return { specs, groupInfos };
}

export function quotaWindowMeta(specs: ReadonlyArray<QuotaWindowSpec>): QuotaWindowMetaMap {
  return Object.fromEntries(specs.map((s) => [s.id, { resetMinute: s.resetMinute, idle: s.idle }]));
}

/**
 * 将本周期实测 Token 计数与实时剩余额度合并，计算按比例推算的满额参考容量。
 * 消耗比例低于 5% 时不输出满额推算，防止微小误差被放大。
 */
export function finalizeQuotaWindows(
  specs: ReadonlyArray<QuotaWindowSpec>,
  counts: Record<string, QuotaWindowRawCount> = {},
  meta: QuotaWindowMetaMap | null = null,
): Record<string, QuotaWindowUsage> {
  const out: Record<string, QuotaWindowUsage> = {};
  for (const spec of specs) {
    const prev = meta?.[spec.id];
    if (prev) {
      if (spec.idle !== prev.idle) continue;
      if (!spec.idle && Math.abs(prev.resetMinute - spec.resetMinute) > 2) continue;
    }
    const c = counts[spec.id];
    if (!c || !c.requests) continue;
    const usedFraction = typeof spec.remaining === 'number' ? Math.max(0, Math.min(1, 1 - spec.remaining)) : null;
    const estimatedFullTokens =
      c.observedTokens > 0 && usedFraction !== null && usedFraction >= 0.05
        ? Math.round(c.observedTokens / usedFraction)
        : null;
    out[spec.id] = {
      observedTokens: c.observedTokens,
      estimatedFullTokens,
      requests: c.requests,
      usedFraction,
    };
  }
  return out;
}
