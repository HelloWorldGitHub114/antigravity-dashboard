import type {
  ModelPriceRates,
  ModelPricingOverrides,
  UsageBucketCounts,
  UsageDayBucket,
  UsageSummarySnapshot,
} from '../contracts/index.ts';
import { sanitizePricingOverrides } from '../contracts/preferences.ts';

export interface ScheduledPriceTier {
  /** 生效起始日期（YYYY-MM-DD，包含当天） */
  effectiveFrom: string;
  rates: ModelPriceRates;
}

export interface BuiltinModelPricingSpec {
  key: string;
  label: string;
  /** 默认或起始价格（USD / 1M tokens） */
  rates: ModelPriceRates;
  /** 按生效日期排序的调价档位（例如优惠期结束切回标准价） */
  schedule?: readonly ScheduledPriceTier[];
  /** 中文简短计价备注（如调价日期说明） */
  noteZh?: string;
  /** 英文简短计价备注 */
  noteEn?: string;
}

export interface ResolvedModelPricing {
  key: string;
  label: string;
  rates: ModelPriceRates;
  source: 'override' | 'builtin';
  scheduledChange?: { effectiveFrom: string; rates: ModelPriceRates } | null;
  noteZh?: string;
  noteEn?: string;
}

export interface CostAggregate {
  costUsd: number;
  pricedTokens: number;
  unpricedTokens: number;
  hasUnpriced: boolean;
}

export interface SnapshotPeriodCosts {
  today: CostAggregate;
  week: CostAggregate;
  month: CostAggregate;
  total: CostAggregate;
}

export interface ConfigurablePricingRow {
  key: string;
  label: string;
  builtin: boolean;
  isOverridden: boolean;
  effectiveRates: ModelPriceRates;
  defaultRates: ModelPriceRates | null;
  noteZh?: string;
  noteEn?: string;
}

const ONE_MILLION = 1_000_000;

/**
 * 公开 API 参考单价表（USD / 1M tokens，Global 端点标准口径，思考 Token 计入输出）。
 * 含明确优惠结束日期的模型按请求所在日期自动切换单价，也可通过用户偏好随时覆写。
 */
export const BUILTIN_MODEL_PRICING: readonly BuiltinModelPricingSpec[] = [
  {
    key: 'gemini-4-neon',
    label: 'Gemini 4 Neon',
    rates: { input: 3.0, cacheRead: 0.15, cacheWrite: 3.75, output: 15.0 },
  },
  {
    key: 'gemini-4-carbon',
    label: 'Gemini 4 Carbon',
    rates: { input: 2.0, cacheRead: 0.1, cacheWrite: 2.0, output: 10.0 },
    schedule: [
      {
        effectiveFrom: '2026-12-01',
        rates: { input: 4.0, cacheRead: 0.2, cacheWrite: 4.0, output: 20.0 },
      },
    ],
    noteZh: '11/30 前优惠价 $2/$10，12/1 起标准价 $4/$20',
    noteEn: 'Intro $2/$10 through Nov 30; $4/$20 from Dec 1',
  },
  {
    key: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    rates: { input: 2.0, cacheRead: 0.1, cacheWrite: 2.0, output: 10.0 },
    schedule: [
      {
        effectiveFrom: '2026-12-01',
        rates: { input: 4.0, cacheRead: 0.2, cacheWrite: 4.0, output: 20.0 },
      },
    ],
    noteZh: '11/30 前优惠价 $2/$10，12/1 起标准价 $4/$20',
    noteEn: 'Intro $2/$10 through Nov 30; $4/$20 from Dec 1',
  },
  {
    key: 'gemini-4-hydrogen',
    label: 'Gemini 4 Hydrogen',
    rates: { input: 1.5, cacheRead: 0.075, cacheWrite: 1.5, output: 7.5 },
  },
  {
    key: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    rates: { input: 0.75, cacheRead: 0.075, cacheWrite: 0.75, output: 3.75 },
    schedule: [
      {
        effectiveFrom: '2027-01-01',
        rates: { input: 1.5, cacheRead: 0.15, cacheWrite: 1.5, output: 7.5 },
      },
    ],
    noteZh: '2026 年底前优惠价 $0.75/$3.75，2027/1/1 起 $1.5/$7.5',
    noteEn: 'Intro $0.75/$3.75 through Dec 31; $1.5/$7.5 from Jan 1',
  },
  {
    key: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash Lite',
    rates: { input: 0.3, cacheRead: 0.03, cacheWrite: 0.3, output: 2.5 },
  },
  {
    key: 'claude-opus-5.5',
    label: 'Claude Opus 5.5',
    rates: { input: 4.0, cacheRead: 0.2, cacheWrite: 5.0, output: 20.0 },
  },
  {
    key: 'claude-sonnet-5.5',
    label: 'Claude Sonnet 5.5',
    rates: { input: 2.0, cacheRead: 0.1, cacheWrite: 2.5, output: 10.0 },
  },
  {
    key: 'gpt-oss-120b',
    label: 'GPT-OSS 120B',
    rates: { input: 0.15, cacheRead: 0.075, cacheWrite: 0.15, output: 0.6 },
    noteZh: '开源权重模型，参考主流托管基准价',
    noteEn: 'Open-weight baseline reference rate',
  },
] as const;

const BUILTIN_BY_KEY = new Map<string, BuiltinModelPricingSpec>(
  BUILTIN_MODEL_PRICING.map((spec) => [spec.key, spec]),
);

const SUFFIX_CLEAN_RE =
  /\s*\((?:xhigh|high|medium|low|thinking|tiered|trial|preview(?:\b[^)]*)?|exp(?:erimental)?(?:\b[^)]*)?|fast|quality|orchestrator|\d{4}-\d{2}-\d{2})\)\s*$/i;
const BARE_SUFFIX_CLEAN_RE =
  /(?:[\s-]+(?:xhigh|high|medium|low|thinking|tiered|trial|preview(?:[\s-]+[a-z0-9]{1,10})*|exp(?:erimental)?(?:[\s-]+[a-z0-9]{1,10})*|latest|n|\d{4}-\d{2}-\d{2}|\d{8}))$/i;

/**
 * 将原始模型名（含思考档位后缀或 Orchestrator 包装名）归一化为计价键。
 */
export function resolvePricingKey(rawModel: string | null | undefined): string {
  const raw = String(rawModel || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();

  // 优先匹配明确的模型家族，覆盖如 "Orchestrator (Neon)" / "gemini-3.8-flash-tiered" 等变体
  if (/\bneon\b/.test(lower)) return 'gemini-4-neon';
  if (/\bcarbon\b/.test(lower)) return 'gemini-4-carbon';
  if (/\bargon\b/.test(lower)) return 'gemini-4-argon';
  if (/\bhydrogen\b/.test(lower)) return 'gemini-4-hydrogen';
  if (/gemini[\s-]*3[.-]8[\s-]*flash/.test(lower)) return 'gemini-3.8-flash';
  if (/gemini[\s-]*3[.-]5[\s-]*flash[\s-]*lite/.test(lower)) return 'gemini-3.5-flash-lite';
  if (/claude[\s-]*opus[\s-]*5[.-]5|opus[\s-]*5[.-]5/.test(lower)) return 'claude-opus-5.5';
  if (/claude[\s-]*sonnet[\s-]*5[.-]5|sonnet[\s-]*5[.-]5/.test(lower)) return 'claude-sonnet-5.5';
  if (/gpt[\s-]*oss[\s-]*120b/.test(lower)) return 'gpt-oss-120b';

  // 未收录模型：剥离思考档位后缀后转 kebab-case 作为自定义定价键
  let cleaned = raw;
  for (let i = 0; i < 6; i++) {
    const next = cleaned.replace(SUFFIX_CLEAN_RE, '').replace(BARE_SUFFIX_CLEAN_RE, '').trim();
    if (next === cleaned || !next) break;
    cleaned = next;
  }
  cleaned = cleaned.replace(/(?<![\d.])(\d)-(\d)(?![\d.])/g, '$1.$2');
  return cleaned
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 根据日期解析内置模型在该日生效的官方单价。
 */
export function resolveBuiltinRatesForDate(
  spec: BuiltinModelPricingSpec,
  dateStr?: string | null,
): ModelPriceRates {
  let active = spec.rates;
  if (spec.schedule?.length && dateStr) {
    for (const tier of spec.schedule) {
      if (dateStr >= tier.effectiveFrom) active = tier.rates;
    }
  }
  return active;
}

/**
 * 解析模型在指定日期的生效单价（优先采用用户自定义覆写，其次内置官方表；未收录返回 null）。
 */
export function resolveModelPricing(
  rawModel: string | null | undefined,
  dateStr?: string | null,
  overrides?: ModelPricingOverrides | null,
): ResolvedModelPricing | null {
  const key = resolvePricingKey(rawModel);
  if (!key) return null;
  const spec = BUILTIN_BY_KEY.get(key);
  const custom = overrides?.[key];
  if (custom) {
    return {
      key,
      label: spec?.label || String(rawModel || key),
      rates: custom,
      source: 'override',
      noteZh: spec?.noteZh,
      noteEn: spec?.noteEn,
    };
  }
  if (!spec) return null;
  const rates = resolveBuiltinRatesForDate(spec, dateStr);
  const nextScheduled =
    dateStr && spec.schedule
      ? spec.schedule.find((tier) => dateStr < tier.effectiveFrom) ?? null
      : null;
  return {
    key: spec.key,
    label: spec.label,
    rates,
    source: 'builtin',
    scheduledChange: nextScheduled,
    noteZh: spec.noteZh,
    noteEn: spec.noteEn,
  };
}

/**
 * 按 4 类 Token（未缓存输入 / 缓存读取 / 缓存写入 / 输出）精确计算单条或单桶等效美元花费。
 * 未匹配到公开单价或自定义单价的模型返回 null，避免无依据估价。
 */
export function calculateBucketCost(
  rawModel: string,
  counts: Pick<UsageBucketCounts, 'uncached' | 'cacheRead' | 'cacheWrite' | 'output'>,
  dateStr?: string | null,
  overrides?: ModelPricingOverrides | null,
): number | null {
  const resolved = resolveModelPricing(rawModel, dateStr, overrides);
  if (!resolved) return null;
  const { rates } = resolved;
  const cacheWriteRate = rates.cacheWrite ?? rates.input;
  const usd =
    ((counts.uncached || 0) * rates.input +
      (counts.cacheRead || 0) * rates.cacheRead +
      (counts.cacheWrite || 0) * cacheWriteRate +
      (counts.output || 0) * rates.output) /
    ONE_MILLION;
  return Number.isFinite(usd) && usd >= 0 ? usd : 0;
}

function startOfWeekUtc(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function emptyCostAggregate(): CostAggregate {
  return { costUsd: 0, pricedTokens: 0, unpricedTokens: 0, hasUnpriced: false };
}

function addDayToAggregate(
  target: CostAggregate,
  day: UsageDayBucket,
  overrides?: ModelPricingOverrides | null,
): void {
  for (const [model, counts] of Object.entries(day.models || {})) {
    const cost = calculateBucketCost(model, counts, day.date, overrides);
    if (cost === null) {
      if ((counts.total || 0) > 0) {
        target.unpricedTokens += counts.total || 0;
        target.hasUnpriced = true;
      }
    } else {
      target.costUsd += cost;
      target.pricedTokens += counts.total || 0;
    }
  }
}

/**
 * 计算快照的今日 / 本周 / 本月 / 累计四档等效 API 花费，口径与 UsageLedger 周期划分保持一致。
 */
export function summarizeSnapshotPeriodCosts(
  value: UsageSummarySnapshot | null | undefined,
  overrides?: ModelPricingOverrides | null,
): SnapshotPeriodCosts {
  const today = emptyCostAggregate();
  const week = emptyCostAggregate();
  const month = emptyCostAggregate();
  const total = emptyCostAggregate();
  if (!value?.today) return { today, week, month, total };

  const todayStr = value.today;
  const weekStartStr = startOfWeekUtc(todayStr);
  const monthPrefix = todayStr.slice(0, 7);

  for (const day of value.days || []) {
    if (!day?.date) continue;
    addDayToAggregate(total, day, overrides);
    if (day.date === todayStr) addDayToAggregate(today, day, overrides);
    if (day.date >= weekStartStr && day.date <= todayStr) addDayToAggregate(week, day, overrides);
    if (day.date.slice(0, 7) === monthPrefix && day.date <= todayStr) {
      addDayToAggregate(month, day, overrides);
    }
  }
  if ((value.unknownTokens || 0) > 0) {
    total.unpricedTokens += value.unknownTokens;
    total.hasUnpriced = true;
  }
  return { today, week, month, total };
}

/**
 * 格式化美元金额；支持紧凑展示（$44.06 / <$0.01）与高精度悬浮提示（$44.0612）。
 */
export function formatUsd(
  amount: number | null | undefined,
  options: { precise?: boolean; approx?: boolean } = {},
): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return '—';
  const prefix = options.approx ? '≈ ' : '';
  if (amount === 0) return `${prefix}$0.00`;
  if (options.precise) {
    const digits = amount < 0.01 ? 4 : amount < 1 ? 3 : 2;
    return `${prefix}$${amount.toLocaleString('en-US', {
      minimumFractionDigits: Math.min(2, digits),
      maximumFractionDigits: digits,
    })}`;
  }
  if (amount < 0.01) return `${prefix}<$0.01`;
  return `${prefix}$${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * 格式化模型单价简短说明，用于表格与弹窗悬浮提示。
 */
export function formatRateSummary(rates: ModelPriceRates, zh = true): string {
  const num = (v: number): string => `$${Number(v.toFixed(4))}`;
  const writePart =
    rates.cacheWrite !== undefined && rates.cacheWrite !== rates.input
      ? zh
        ? ` · 缓存写 ${num(rates.cacheWrite)}`
        : ` · write ${num(rates.cacheWrite)}`
      : '';
  return zh
    ? `输入 ${num(rates.input)} · 缓存读 ${num(rates.cacheRead)}${writePart} · 输出 ${num(rates.output)} / 1M tok`
    : `In ${num(rates.input)} · Cache ${num(rates.cacheRead)}${writePart} · Out ${num(rates.output)} / 1M tok`;
}

/**
 * 生成单价配置弹窗的行列表：包含全部内置模型 + 账本中出现的未内置模型 + 已保存的自定义项。
 */
export function listConfigurablePricingRows(
  knownModels: ReadonlyArray<string>,
  overrides: ModelPricingOverrides | null | undefined,
  dateStr?: string | null,
): ConfigurablePricingRow[] {
  const safeOverrides = sanitizePricingOverrides(overrides);
  const rows: ConfigurablePricingRow[] = [];
  const seen = new Set<string>();

  for (const spec of BUILTIN_MODEL_PRICING) {
    seen.add(spec.key);
    const defaultRates = resolveBuiltinRatesForDate(spec, dateStr);
    const custom = safeOverrides[spec.key];
    rows.push({
      key: spec.key,
      label: spec.label,
      builtin: true,
      isOverridden: Boolean(custom),
      effectiveRates: custom ? { ...custom } : { ...defaultRates },
      defaultRates: { ...defaultRates },
      noteZh: spec.noteZh,
      noteEn: spec.noteEn,
    });
  }

  // 补充账本中未在内置表里的模型，方便用户随时为其定价
  const extraLabelByKey = new Map<string, string>();
  for (const rawModel of knownModels) {
    const key = resolvePricingKey(rawModel);
    if (!key || seen.has(key) || extraLabelByKey.has(key)) continue;
    extraLabelByKey.set(key, rawModel);
  }
  for (const key of Object.keys(safeOverrides)) {
    if (!seen.has(key) && !extraLabelByKey.has(key)) {
      extraLabelByKey.set(key, key);
    }
  }
  for (const [key, label] of [...extraLabelByKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const custom = safeOverrides[key];
    rows.push({
      key,
      label,
      builtin: false,
      isOverridden: Boolean(custom),
      effectiveRates: custom
        ? { ...custom }
        : { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      defaultRates: null,
    });
  }

  return rows;
}
