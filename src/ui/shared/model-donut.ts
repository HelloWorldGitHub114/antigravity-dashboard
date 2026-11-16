import type { ModelUsageBucket, QuotaGroup } from '../../contracts/index.ts';

export const SVG_NS = 'http://www.w3.org/2000/svg';

export const ROLE_COLORS: Record<string, string> = {
  plan: 'var(--pulse-accent)',
  worker: 'var(--pulse-success)',
  subagent: 'var(--pulse-warning)',
};

export const PANEL_MIX_PALETTE = [
  'var(--pulse-accent)',
  'var(--pulse-success)',
  'var(--pulse-warning)',
  '#c084fc',
  '#38bdf8',
  '#fb7185',
] as const;

export const INLINE_MIX_PALETTE = [
  'var(--pulse-accent)',
  'var(--pulse-success)',
  'var(--pulse-warning)',
  'var(--pulse-danger)',
] as const;

export type MixMetricKind = 'total' | 'output' | 'calls';

export interface ModelColorInput {
  id?: string;
  name?: string;
  role?: string | null;
}

export interface PartitionedModelSlice {
  id: string;
  name: string;
  role: string;
  requests: number;
  outputTokens: number;
  totalTokens: number;
  value: number;
  share: number;
  color: string;
}

export interface PartitionModelOptions {
  metric?: MixMetricKind;
  maxVisible: number;
  headCount: number;
  otherLabel: string;
  otherColor?: string;
  palette?: readonly string[];
}

export interface DonutSegmentOptions {
  cx: number;
  cy: number;
  r: number;
  className: string;
  color: string;
  dasharray: string;
  dashoffset: string;
  modelId: string;
  pathLength?: number;
  tabIndex?: number;
  role?: string;
  ariaLabel?: string;
}

export function metricValueOf(
  model: Partial<ModelUsageBucket> | null | undefined,
  metric: MixMetricKind = 'total',
): number {
  if (!model) return 0;
  if (metric === 'calls') return Number(model.requests) || 0;
  if (metric === 'output') return Number(model.outputTokens) || 0;
  return Number(model.totalTokens) || 0;
}

export function assignModelColors(
  models: ReadonlyArray<string | ModelColorInput>,
  palette: readonly string[] = PANEL_MIX_PALETTE,
): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  models.forEach((entry, idx) => {
    const key = typeof entry === 'string' ? entry : entry.name || entry.id;
    if (!key || map.has(key)) return;
    const role = typeof entry === 'string' ? null : entry.role ?? null;
    const preferred = role ? ROLE_COLORS[role] : undefined;
    let chosen: string;
    if (preferred && !used.has(preferred)) {
      chosen = preferred;
    } else {
      chosen = palette.find((c) => !used.has(c)) ?? palette[idx % palette.length];
    }
    used.add(chosen);
    map.set(key, chosen);
  });
  return map;
}

export function partitionModelSlices(
  models: ReadonlyArray<ModelUsageBucket>,
  options: PartitionModelOptions,
): PartitionedModelSlice[] {
  const metric = options.metric ?? 'total';
  const sorted = [...models].sort(
    (a, b) =>
      metricValueOf(b, metric) - metricValueOf(a, metric) ||
      (Number(b?.totalTokens) || 0) - (Number(a?.totalTokens) || 0) ||
      (Number(b?.requests) || 0) - (Number(a?.requests) || 0),
  );
  const capped =
    sorted.length > options.maxVisible
      ? [
          ...sorted.slice(0, options.headCount),
          sorted.slice(options.headCount).reduce(
            (acc, m) => ({
              id: '__other__',
              name: options.otherLabel,
              role: 'model' as const,
              requests: acc.requests + (Number(m?.requests) || 0),
              outputTokens: acc.outputTokens + (Number(m?.outputTokens) || 0),
              totalTokens: acc.totalTokens + (Number(m?.totalTokens) || 0),
            }),
            { id: '__other__', name: options.otherLabel, role: 'model' as const, requests: 0, outputTokens: 0, totalTokens: 0 },
          ),
        ]
      : sorted;

  const palette = options.palette ?? PANEL_MIX_PALETTE;
  const colorMap = assignModelColors(capped, palette);
  const totalMetric = capped.reduce((sum, m) => sum + Math.max(0, metricValueOf(m, metric)), 0);

  return capped.map((m, idx) => {
    const id = String(m?.id || m?.name || idx);
    const name = String(m?.name || m?.id || '—');
    const val = Math.max(0, metricValueOf(m, metric));
    const resolvedColor =
      id === '__other__' && options.otherColor
        ? options.otherColor
        : colorMap.get(m?.name || m?.id || name) || palette[idx % palette.length];
    return {
      id,
      name,
      role: String(m?.role || 'model'),
      requests: Number(m?.requests) || 0,
      outputTokens: Number(m?.outputTokens) || 0,
      totalTokens: Number(m?.totalTokens) || 0,
      value: val,
      share: totalMetric > 0 ? val / totalMetric : 0,
      color: resolvedColor,
    };
  });
}

export function createDonutSegment(
  opts: DonutSegmentOptions,
  doc: Document = document,
): SVGCircleElement {
  const circle = doc.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('class', opts.className);
  circle.setAttribute('cx', String(opts.cx));
  circle.setAttribute('cy', String(opts.cy));
  circle.setAttribute('r', String(opts.r));
  if (opts.pathLength != null) circle.setAttribute('pathLength', String(opts.pathLength));
  circle.setAttribute('stroke-dasharray', opts.dasharray);
  circle.setAttribute('stroke-dashoffset', opts.dashoffset);
  circle.dataset.modelId = opts.modelId;
  circle.style.setProperty('stroke', opts.color);
  if (opts.tabIndex != null) circle.setAttribute('tabindex', String(opts.tabIndex));
  if (opts.role) circle.setAttribute('role', opts.role);
  if (opts.ariaLabel) circle.setAttribute('aria-label', opts.ariaLabel);
  return circle;
}

export function formatQuotaGroupLabel(
  group: Pick<QuotaGroup, 'name'> | null | undefined,
  fallback = '',
): string {
  const name = group?.name || '';
  if (/gemini/i.test(name)) return 'Gemini';
  if (/claude|gpt/i.test(name)) return 'Claude / GPT';
  return name || fallback;
}

export function selectPreferredQuotaGroup(
  groups: ReadonlyArray<QuotaGroup>,
  chosenId: string | null | undefined,
  modelName: string | null | undefined,
): QuotaGroup | undefined {
  const model = String(modelName || '').toLowerCase();
  return (
    groups.find((g) => g.id === chosenId) ??
    groups.find((g) =>
      /gemini/.test(model)
        ? /gemini/i.test(g.id)
        : /claude|gpt/.test(model)
          ? /3p|claude|gpt/i.test(g.id)
          : false,
    ) ??
    groups[0]
  );
}
