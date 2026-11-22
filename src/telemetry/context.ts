import type { ContextBreakdown, ContextMetrics } from '../contracts/metrics.ts';

// The current request's host-reported capacity is the occupancy denominator.
// Provider specifications are separately sourced references, never overrides.

export interface ModelContextReference {
  tokens: number | null;
  label: string;
  kind: string;
  source: string;
  checkedAt: string;
}

export interface ContextMetricsOptions {
  model?: unknown;
  sampledAt?: unknown;
  source?: string;
  compacted?: boolean;
  preCompactionUsedTokens?: unknown;
  compactionCount?: unknown;
  breakdown?: unknown;
}

const count = (value: unknown): number | null =>
  (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : null;

const aliases = new Map<string, string>([
  ['model_placeholder_m668', 'Orchestrator (Argon)'],
  ['model_placeholder_m669', 'Gemini Flash'],
  ['model_placeholder_m670', 'Gemini 4 Carbon'],
  ['model_placeholder_m417', 'Gemini 4 Argon (High)'],
  ['model_placeholder_m418', 'Gemini 4 Argon (Medium)'],
  ['model_placeholder_m419', 'Gemini 4 Argon (Low)'],
  ['model_placeholder_m525', 'Gemini 4 Hydrogen (High)'],
  ['model_placeholder_m526', 'Gemini 4 Hydrogen (Medium)'],
  ['model_placeholder_m527', 'Gemini 4 Hydrogen (Low)'],
  ['model_placeholder_m528', 'Gemini 4 Hydrogen (XHigh)'],
  ['model_placeholder_m530', 'Gemini 4 Hydrogen (High)'],
  ['model_placeholder_m532', 'Gemini 4 Neon (High)'],
  ['model_placeholder_m533', 'Gemini 4 Neon (Medium)'],
  ['model_placeholder_m535', 'Gemini 4 Neon (XHigh)'],
  ['model_placeholder_m537', 'Orchestrator (Neon)'],
  ['model_placeholder_m198', 'Gemini 3.5 Flash Lite'],
  ['model_placeholder_m400', 'Claude Opus 5.5 (Low)'],
  ['model_placeholder_m401', 'Claude Opus 5.5 (Medium)'],
  ['model_placeholder_m402', 'Claude Opus 5.5 (High)'],
  ['model_placeholder_m403', 'Claude Sonnet 5.5 (Low)'],
  ['model_placeholder_m404', 'Claude Sonnet 5.5 (Medium)'],
  ['model_placeholder_m405', 'Claude Sonnet 5.5 (High)'],
  ['model_placeholder_m318', 'Gemini 3.8 Flash (High)'],
  ['model_placeholder_m319', 'Gemini 3.8 Flash (Medium)'],
  ['model_placeholder_m320', 'Gemini 3.8 Flash (Low)'],
  ['model_placeholder_m35', 'Claude Sonnet 4.6 (Thinking)'],
  ['model_placeholder_m26', 'Claude Opus 4.6 (Thinking)'],
  ['model_openai_gpt_oss_120b_medium', 'GPT-OSS 120B (Medium)'],
  ['gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'],
  ['gemini-pro-orchestrator-g1-pro', 'Orchestrator (Argon)'],
  ['gemini-flash-worker-agy', 'Gemini Flash'],
]);

const tierLabels: Record<string, string> = {
  thinking: 'Thinking',
  xhigh: 'XHigh',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const titleCase = (word: string): string =>
  tierLabels[word] || (word ? word[0].toUpperCase() + word.slice(1) : '');

// Placeholder aliases above were checked against the installed host's model
// catalog on 2026-11-14. Unknown placeholders stay unknown, not a family guess.
function identify(model: unknown): { key: string | null; display: string } | null {
  if (typeof model !== 'string') return null;
  let name = model.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 256);
  if (!name) return null;
  name = aliases.get(name.toLowerCase()) || name;
  const normalized = name
    .toLowerCase()
    .replace(/(\d)[._-](\d)/g, '$1.$2')
    .replace(/[\s()_]+/g, '-')
    .replace(/-+$/, '');
  if (normalized === 'orchestrator-argon') {
    return { key: 'orchestrator-argon', display: 'Orchestrator (Argon)' };
  }
  if (normalized === 'gemini-flash') {
    return { key: 'gemini-flash', display: 'Gemini Flash' };
  }
  let match = normalized.match(/^gemini-4-(argon|hydrogen|carbon|neon)(?:-(xhigh|high|medium|low))?$/);
  if (match) {
    return {
      key: `gemini-4-${match[1]}`,
      display: `Gemini 4 ${titleCase(match[1])}` + (match[2] ? ` (${titleCase(match[2])})` : ''),
    };
  }
  match = normalized.match(/^gemini-3\.8-flash(?:-(n|high|medium|low))?$/);
  if (match) {
    return {
      key: 'gemini-3.8-flash',
      display: 'Gemini 3.8 Flash' + (match[1] && match[1] !== 'n' ? ` (${titleCase(match[1])})` : ''),
    };
  }
  match = normalized.match(/^claude-(sonnet|opus)-(4\.6|5\.5)(?:-(thinking|high|medium|low))?(?:-\d{8})?$/);
  if (match) {
    return {
      key: `claude-${match[1]}-${match[2]}`,
      display: `Claude ${titleCase(match[1])} ${match[2]}` + (match[3] ? ` (${titleCase(match[3])})` : ''),
    };
  }
  match = normalized.match(/^gpt-oss-120b(?:-(high|medium|low))?$/);
  if (match) {
    return {
      key: 'gpt-oss-120b',
      display: 'GPT-OSS 120B' + (match[1] ? ` (${titleCase(match[1])})` : ''),
    };
  }
  return { key: null, display: name };
}

export function formatModelName(model: unknown): string | null {
  return identify(model)?.display || null;
}

export function normalizeModelId(model: unknown): string | null {
  const display = formatModelName(model);
  if (!display) return null;
  return (
    display
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, '-')
      .replace(/^-+|-+$/g, '') || display.toLowerCase()
  );
}

export function isOrchestratorModel(model: unknown): boolean {
  const info = identify(model);
  return info?.key === 'orchestrator-argon' || /\borchestrator\b/i.test(info?.display || '');
}

export function modelContextReference(model: unknown): ModelContextReference | null {
  const key = identify(model)?.key;
  if (key === 'gemini-3.8-flash') {
    return {
      tokens: 1048576,
      label: '1,048,576',
      kind: 'provider-input-limit',
      source: 'https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash',
      checkedAt: '2026-10-14',
    };
  }
  if (key === 'gpt-oss-120b') {
    return {
      tokens: 131072,
      label: '131,072',
      kind: 'provider-context-window',
      source: 'https://developers.openai.com/api/docs/models/gpt-oss-120b',
      checkedAt: '2026-10-14',
    };
  }
  if (/^claude-(sonnet|opus)-(4\.6|5\.5)$/.test(key || '')) {
    return {
      tokens: null,
      label: '1M',
      kind: 'provider-context-window',
      source: `https://platform.claude.com/docs/en/models/${key!.slice(7).replace('.', '-')}/overview`,
      checkedAt: '2026-10-14',
    };
  }
  // Claude's inspected pages state "1M"; preserve that label rather than
  // inventing a precise 1,048,576-token limit or applying it to this host.
  return null;
}

export function modelContextCapacity(model: unknown): number | null {
  return modelContextReference(model)?.tokens ?? null;
}

export function modelCompressionLimit(_model?: unknown): number | null {
  // The inspected host schema has no compaction-threshold field. Neither the
  // provider's capacity nor the host's maxContextTokens proves a trigger value.
  return null;
}

function safeContextBreakdown(value: unknown): ContextBreakdown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const baselineTokens = count(raw.baselineTokens);
  const readTokens = count(raw.readTokens);
  const thinkingTokens = count(raw.thinkingTokens);
  const outputTokens = count(raw.outputTokens);
  const totalTokens = count(raw.totalTokens);
  if (
    baselineTokens === null ||
    readTokens === null ||
    thinkingTokens === null ||
    outputTokens === null ||
    totalTokens === null ||
    totalTokens <= 0
  ) {
    return null;
  }
  return { baselineTokens, readTokens, thinkingTokens, outputTokens, totalTokens };
}

export function contextMetrics(
  metadata: unknown,
  {
    model = null,
    sampledAt = null,
    source = 'Antigravity context window metadata',
    compacted = false,
    preCompactionUsedTokens = null,
    compactionCount = null,
    breakdown = null,
  }: ContextMetricsOptions = {},
): ContextMetrics | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const meta = metadata as Record<string, unknown>;
  const usedTokens = count(meta.estimatedTokensUsed);
  const rawMax = count(meta.maxContextTokens);
  if (usedTokens === null) return null;
  const maxTokens = rawMax !== null && rawMax > 0 ? rawMax : null;
  const reference = modelContextReference(model);
  const safePreCompaction = count(preCompactionUsedTokens);
  const safeCompactions = count(compactionCount);
  const safeBreakdown = compacted === true ? null : safeContextBreakdown(breakdown);
  const isCompacted = compacted === true;
  return {
    usedTokens,
    maxTokens,
    remainingTokens: maxTokens === null ? null : Math.max(0, maxTokens - usedTokens),
    usedFraction: maxTokens === null ? null : usedTokens / maxTokens,
    remainingFraction: maxTokens === null ? null : Math.max(0, 1 - usedTokens / maxTokens),
    capacitySource: maxTokens === null ? null : 'host-reported',
    providerMaxTokens: reference?.tokens ?? null,
    providerCapacityLabel: reference?.label ?? null,
    providerCapacitySource: reference?.source ?? null,
    providerCapacityKind: reference?.kind ?? null,
    providerCapacityCheckedAt: reference?.checkedAt ?? null,
    compressionLimit: null,
    compressionFraction: null,
    compressionSource: null,
    model: formatModelName(model),
    sampledAt:
      typeof sampledAt === 'string' && Number.isFinite(Date.parse(sampledAt))
        ? new Date(sampledAt).toISOString()
        : null,
    source: isCompacted ? 'Post-compaction estimate' : source,
    estimated: true,
    ...(isCompacted ? { compacted: true, preCompactionUsedTokens: safePreCompaction } : {}),
    ...(safeCompactions !== null && safeCompactions > 0 ? { compactionCount: safeCompactions } : {}),
    ...(safeBreakdown ? { breakdown: safeBreakdown } : {}),
  };
}

export function safeContext(value: unknown): ContextMetrics | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  // Recalculate all derived fields and provider references. Never trust ratios,
  // arbitrary source URLs, unsupported limits or additional saved properties.
  return contextMetrics(
    { estimatedTokensUsed: raw.usedTokens, maxContextTokens: raw.maxTokens },
    {
      model: raw.model,
      sampledAt: raw.sampledAt,
      compacted: raw.compacted === true,
      preCompactionUsedTokens: raw.preCompactionUsedTokens,
      compactionCount: raw.compactionCount,
      breakdown: raw.breakdown,
    },
  );
}
