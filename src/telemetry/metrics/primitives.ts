export interface RequestCacheBreakdown {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  uncachedTokens: number;
}

export function safeAdd(a: number, b: number): number {
  const sum = a + b;
  return Number.isSafeInteger(sum) && sum >= 0 ? sum : Number.MAX_SAFE_INTEGER;
}

export function seconds(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+(?:\.\d+)?s$/.test(value)) {
    const n = Number(value.slice(0, -1));
    return Number.isFinite(n) ? n : null;
  }
  if (value && typeof value === 'object') {
    const obj = value as { seconds?: unknown; nanos?: unknown };
    if (obj.seconds === undefined && obj.nanos === undefined) return null;
    const whole = Number(obj.seconds ?? 0);
    const nanos = Number(obj.nanos ?? 0);
    if (
      !Number.isSafeInteger(whole) ||
      whole < 0 ||
      !Number.isInteger(nanos) ||
      nanos < 0 ||
      nanos >= 1e9
    ) {
      return null;
    }
    const n = whole + nanos / 1e9;
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

export function tokenCount(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) {
    return null;
  }
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

const CACHE_PROVIDER_RE =
  /^(?:API_PROVIDER_)?(?:GOOGLE_(?:GEMINI|VERTEX|EVERGREEN)|OPENAI(?:_VERTEX|_RESPONSES_VERTEX)?|ANTHROPIC(?:_VERTEX)?|INTERNAL)$/;

export function isSupportedCacheProvider(provider: unknown): boolean {
  return typeof provider === 'string' && CACHE_PROVIDER_RE.test(provider);
}

export function requestCacheMetrics(usage: unknown): RequestCacheBreakdown | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const input = tokenCount(u.inputTokens);
  if (
    (u.cacheReadTokens !== undefined && tokenCount(u.cacheReadTokens) === null) ||
    (u.cacheWriteTokens !== undefined && tokenCount(u.cacheWriteTokens) === null)
  ) {
    return null;
  }
  const read = tokenCount(u.cacheReadTokens) ?? 0;
  const write = tokenCount(u.cacheWriteTokens) ?? 0;
  const provider = String(u.apiProvider || '');
  if (input === null) return null;
  // Antigravity ModelUsageStats normalizes inputTokens to uncached input,
  // including Gemini (verified against live records with cacheRead > input).
  // These are NOT upstream Gemini/OpenAI prompt_tokens. Add the separate
  // cache read/write counts exactly once for this local interface.
  const total = input + read + write;
  // A tool follow-up can explicitly report zero input. It is a valid neutral
  // sample, even though an all-zero denominator cannot produce a hit ratio.
  if (!Number.isSafeInteger(total) || total < 0 || read + write > total) return null;
  // A provider label is unnecessary for a validated zero denominator: it
  // contributes neither numerator nor denominator and never invents a ratio.
  if (total > 0 && !isSupportedCacheProvider(provider)) return null;
  return {
    inputTokens: total,
    cachedTokens: read,
    cacheWriteTokens: write,
    uncachedTokens: total - read - write,
  };
}

export function unionSeconds(intervals: readonly [number, number][]): number {
  const sorted = intervals
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let start: number | null = null;
  let end: number | null = null;
  for (const [a, b] of sorted) {
    if (start === null || end === null) {
      start = a;
      end = b;
    } else if (a <= end) {
      end = Math.max(end, b);
    } else {
      total += end - start;
      start = a;
      end = b;
    }
  }
  if (start !== null && end !== null) total += end - start;
  return total / 1000;
}
