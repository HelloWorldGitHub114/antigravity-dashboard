// The CLI contract is independent of desktop ModelUsageStats semantics.

export type CliAgentState = 'idle' | 'thinking' | 'working' | 'tool_use' | 'initializing';

export interface CliModelInfo {
  id?: unknown;
  display_name?: unknown;
}

export interface CliCurrentUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

export interface CliContextWindow {
  used_percentage?: unknown;
  remaining_percentage?: unknown;
  context_window_size?: unknown;
  current_usage?: unknown;
}

export interface CliQuotaEntry {
  remaining_fraction?: unknown;
  reset_in_seconds?: unknown;
  reset_time?: unknown;
}

export interface CliStatusPayload {
  version?: unknown;
  model?: unknown;
  agent_state?: unknown;
  terminal_width?: unknown;
  context_window?: unknown;
  quota?: unknown;
}

export interface CliCacheRate {
  percentage: number | null;
  basis: string | null;
  reason: string | null;
}

export interface CliQuotaWindow {
  id: string;
  remaining: number | null;
  resetInSeconds: number | null;
  resetTime: number | null;
}

export interface CliNormalizedMetrics {
  model: string | null;
  state: CliAgentState | null;
  width: number;
  context: {
    usedPercentage: number | null;
    capacity: number | null;
  };
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  cacheRate: CliCacheRate;
  inputTokens: number | null;
  outputTokens: number | null;
  quotas: CliQuotaWindow[];
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const nonNegativeNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const tokenCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export const states: readonly CliAgentState[] = [
  'idle',
  'thinking',
  'working',
  'tool_use',
  'initializing',
];

const BUSY_STATES = new Set<string>(['thinking', 'working', 'tool_use', 'initializing']);
const VERIFIED_CLI_VERSIONS = new Set<string>(['1.3.2', '1.3.3']);

// Empirical statusLine policy: Sonnet 4.6 / GPT-OSS 120B / Gemini 3.8 Flash High,
// cache writes zero. Do not reuse desktop or cumulative token semantics.
function cacheRate(
  model: Record<string, unknown>,
  version: unknown,
  input: number | null,
  read: number | null,
  write: number | null,
  state: unknown,
): CliCacheRate {
  const unavailable = (reason: string): CliCacheRate => ({
    percentage: null,
    basis: null,
    reason,
  });
  if (input === null || read === null || write === null) {
    return unavailable('missing-or-invalid-counts');
  }
  // During generation/tool execution a zero read may be a transient reset,
  // not a completed model request. The contract exposes no request-ready flag.
  if (read === 0 && typeof state === 'string' && BUSY_STATES.has(state)) {
    return unavailable('awaiting-stable-usage');
  }
  const total = input + read + write;
  if (!Number.isSafeInteger(total)) return unavailable('unsafe-total');
  if (total === 0) return unavailable('empty-input');
  if (read === 0) return { percentage: 0, basis: 'zero-read', reason: null };
  if (write !== 0) return unavailable('unverified-cache-write');
  if (typeof version !== 'string' || !VERIFIED_CLI_VERSIONS.has(version)) {
    return unavailable('unverified-cli-version');
  }
  // A supplied ID is authoritative. A conflicting display name cannot opt in.
  const identity =
    typeof model.id === 'string' && model.id.trim()
      ? model.id.trim()
      : model.display_name;
  const sonnet =
    typeof identity === 'string' &&
    /^claude(?:-| )sonnet(?:-| )4(?:-|\.)6(?: \(thinking\))?$/i.test(identity);
  const gpt =
    typeof identity === 'string' &&
    /^gpt-oss(?:-| )120b(?:-medium| \(medium\))?$/i.test(identity);
  const gemini =
    typeof identity === 'string' &&
    /^(?:gemini-3\.8-flash-high|gemini 3\.8 flash \(high\))$/i.test(identity);
  const supported = sonnet || gpt || (gemini && version === '1.3.3');
  if (!supported) return unavailable('unverified-model');
  return {
    percentage: (read / total) * 100,
    basis: `separate-input-cli-${version}`,
    reason: null,
  };
}

/**
 * Strips ANSI escape sequences, control characters, and bidi overrides from CLI strings.
 */
export function cleanText(value: unknown, limit = 120): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/**
 * Normalizes and whitelists raw Antigravity CLI statusLine JSON payloads.
 */
export function normalize(payload: unknown): CliNormalizedMetrics {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid status payload');
  }
  const raw = payload as CliStatusPayload;
  const context = asRecord(raw.context_window);
  const usage = asRecord(context.current_usage);
  const model = asRecord(raw.model);

  const input = tokenCount(usage.input_tokens);
  const read = tokenCount(usage.cache_read_input_tokens);
  const write = tokenCount(usage.cache_creation_input_tokens);
  const used = nonNegativeNumber(context.used_percentage);
  const remaining = nonNegativeNumber(context.remaining_percentage);

  const quotas: CliQuotaWindow[] = Object.entries(asRecord(raw.quota))
    .slice(0, 16)
    .map(([key, item]) => {
      const value = asRecord(item);
      const fraction = nonNegativeNumber(value.remaining_fraction);
      const reset = typeof value.reset_time === 'string' ? Date.parse(value.reset_time) : NaN;
      return {
        id: cleanText(key, 64),
        remaining: fraction !== null && fraction <= 1 ? fraction * 100 : null,
        resetInSeconds: nonNegativeNumber(value.reset_in_seconds),
        resetTime: Number.isFinite(reset) ? reset : null,
      };
    })
    .filter((value) => Boolean(value.id));

  const state =
    typeof raw.agent_state === 'string' && states.includes(raw.agent_state as CliAgentState)
      ? (raw.agent_state as CliAgentState)
      : null;

  const width =
    typeof raw.terminal_width === 'number' &&
    Number.isInteger(raw.terminal_width) &&
    raw.terminal_width > 0
      ? Math.min(500, raw.terminal_width)
      : 80;

  return {
    model: cleanText(model.display_name || model.id) || null,
    state,
    width,
    context: {
      usedPercentage: used ?? (remaining !== null && remaining <= 100 ? 100 - remaining : null),
      capacity: tokenCount(context.context_window_size) || null,
    },
    cacheReadTokens: read,
    cacheCreationTokens: write,
    cacheRate: cacheRate(model, raw.version, input, read, write, raw.agent_state),
    inputTokens: input,
    outputTokens: tokenCount(usage.output_tokens),
    quotas,
  };
}

/**
 * Formats a token counter using compact K/M suffixes.
 */
export function compact(value: number | null): string {
  if (value === null) return '--';
  const [scaled, suffix] =
    value >= 1e6 ? [value / 1e6, 'M'] : value >= 1e3 ? [value / 1e3, 'K'] : [value, ''];
  return `${Number(scaled.toFixed(suffix ? 1 : 0))}${suffix}`;
}

/**
 * Formats a percentage value with 1-decimal trimming or `--` when absent.
 */
export function percentage(value: number | null): string {
  return value === null ? '--' : `${Number(value.toFixed(1))}%`;
}

/**
 * Computes human-readable reset countdown from absolute `resetTime` or `resetInSeconds`.
 */
export function countdown(quota: Pick<CliQuotaWindow, 'resetTime' | 'resetInSeconds'>, now = Date.now()): string | null {
  // Absolute time prevents a replayed reset_in_seconds from looking fresh.
  const seconds =
    quota.resetTime !== null
      ? Math.max(0, (quota.resetTime - now) / 1000)
      : quota.resetInSeconds;
  if (seconds === null) return null;
  if (seconds < 60) return '<1m';
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d${Math.floor((seconds % 86400) / 3600)}h`;
}
