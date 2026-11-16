import type { LatestRateStatus, RateReason } from '../contracts/metrics.ts';

// Summary-only timing checks: no chunk timestamps are exposed by this host.
// These flags mean unmeasurable/suspect, not proof of upstream buffering.
export const RATE_VERSION = 3;

export const RATE_REASONS: readonly RateReason[] = [
  'token-scope',
  'duplicate-scope',
  'retry-scope',
  'short-tool-window',
  'short-outlier',
  'nonfinite-rate',
];

export interface RateSample {
  responseTokens: number | null;
  rawOutput: number | null;
  duration: number | null;
  ttft: number | null;
  reasons: RateReason[];
  hasTools: boolean;
  toolOnly: boolean;
  tps: number | null;
  model: string;
  basis: 'response' | 'all-output';
  profile: string;
  outlier?: boolean;
  status?: LatestRateStatus;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const bufferedToolWindow = (sample: RateSample): boolean =>
  sample.duration !== null &&
  sample.duration > 0 &&
  sample.duration < 5 &&
  sample.responseTokens !== null &&
  sample.responseTokens > 0 &&
  (sample.hasTools || sample.toolOnly) &&
  sample.ttft !== null &&
  sample.ttft >= 1 &&
  sample.ttft / sample.duration >= 12;

export function classifyRates<T extends RateSample>(samples: T[]): T[] {
  const profiles = new Map<string, number[]>();
  for (const sample of samples) {
    if (
      sample.reasons.length ||
      sample.duration === null ||
      !(sample.duration >= 1) ||
      sample.tps === null ||
      !(sample.tps > 0) ||
      bufferedToolWindow(sample)
    ) {
      continue;
    }
    const key = sample.profile;
    let list = profiles.get(key);
    if (!list) {
      list = [];
      profiles.set(key, list);
    }
    list.push(sample.tps);
  }

  const limits = new Map<string, number>();
  for (const [key, rates] of profiles) {
    if (rates.length < 2) continue;
    const center = median(rates);
    const mad = median(rates.map((rate) => Math.abs(rate - center)));
    limits.set(key, Math.max(center * 2.5, center + 6 * mad));
  }

  for (const sample of samples) {
    if (
      !Number.isFinite(sample.tps as number) &&
      sample.duration !== null &&
      sample.duration > 0 &&
      sample.responseTokens !== null &&
      sample.responseTokens > 0
    ) {
      sample.reasons.push('nonfinite-rate');
    }
    // Buffered tool arguments (with or without a brief text preamble) can flush
    // in a short window after a much longer wait. Keep usage/TTFT, quarantine TPS.
    if (bufferedToolWindow(sample)) {
      sample.reasons.push('short-tool-window');
    }
    const limit = limits.get(sample.profile);
    sample.outlier = limit !== undefined && sample.tps !== null && sample.tps > limit;
    // Distribution alone never rejects a sustained, potentially real high rate.
    if (sample.outlier && sample.duration !== null && sample.duration < 1 && !sample.reasons.length) {
      sample.reasons.push('short-outlier');
    }
    sample.status = sample.reasons.length
      ? 'unreliable'
      : !(sample.responseTokens !== null && sample.responseTokens > 0) ||
          !(sample.duration !== null && sample.duration > 0)
        ? 'missing'
        : 'ok';
  }
  return samples;
}
