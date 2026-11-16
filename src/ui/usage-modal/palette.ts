import type { UsageSummarySnapshot } from '../../contracts/index.ts';
import {
  buildAccentColor,
  contrastRatio,
  luminance,
  rgbToHsl,
  type RgbTuple,
} from '../../shared/color.ts';
import type { ModelViewMode } from './types.ts';

const MODEL_TOKEN_CASE: Record<string, string> = {
  claude: 'Claude',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  gemini: 'Gemini',
  flash: 'Flash',
  pro: 'Pro',
  argon: 'Argon',
  hydrogen: 'Hydrogen',
  carbon: 'Carbon',
  gpt: 'GPT',
  oss: 'OSS',
};

const PAREN_SUFFIX_RE =
  /\s*\((?:xhigh|high|medium|low|thinking|tiered|trial|preview(?:\b[^)]*)?|exp(?:erimental)?(?:\b[^)]*)?|fast|lite|quality|\d{4}-\d{2}-\d{2})\)\s*$/i;
const BARE_SUFFIX_RE =
  /(?:[\s-]+(?:xhigh|high|medium|low|thinking|tiered|trial|preview(?:[\s-]+[a-z0-9]{1,10})*|exp(?:erimental)?(?:[\s-]+[a-z0-9]{1,10})*|latest|n|\d{4}-\d{2}-\d{2}|\d{8}))$/i;

const baseModelCache = new Map<string, string>();

export function formatModelName(model: string): string {
  return model
    .replace(/-n$/, '')
    .replace(/^gemini-/i, 'Gemini ')
    .replace(/^claude-/i, 'Claude ')
    .replace(/^gpt-/i, 'GPT ')
    .replace(/-/g, ' ');
}

export function baseModelName(rawModel: string | null | undefined): string {
  const raw = String(rawModel || '').trim();
  if (!raw) return '';
  const cached = baseModelCache.get(raw);
  if (cached !== undefined) return cached;
  let current = raw;
  for (let i = 0; i < 8; i++) {
    const next = current.replace(PAREN_SUFFIX_RE, '').replace(BARE_SUFFIX_RE, '').trim();
    if (next === current || !next) break;
    current = next;
  }
  current = current.replace(/(?<![\d.])(\d)-(\d)(?![\d.])/g, '$1.$2');
  current = current.replace(/-(?![^(]*\))/g, ' ').replace(/\s+/g, ' ').trim();
  current = current
    .split(' ')
    .map((tok) => MODEL_TOKEN_CASE[tok.toLowerCase()] || (/^\d+b$/i.test(tok) ? tok.toUpperCase() : tok))
    .join(' ');
  const out = current || raw;
  if (baseModelCache.size > 2000) baseModelCache.clear();
  baseModelCache.set(raw, out);
  return out;
}

export function effectiveModelKey(rawModel: string, modelViewMode: ModelViewMode): string {
  return modelViewMode === 'simple' ? baseModelName(rawModel) : rawModel;
}

export function modelLabel(key: string, modelViewMode: ModelViewMode): string {
  return modelViewMode === 'simple' ? key : formatModelName(key);
}

export function variantLabel(rawModel: string, groupKey: string): string {
  const formatted = formatModelName(rawModel);
  return formatted.toLowerCase() === groupKey.toLowerCase() && formatted !== rawModel
    ? `${formatted} (${rawModel})`
    : formatted;
}

export class UsagePalette {
  private readonly targetEl: () => Element;
  private paletteKey = '';
  private readonly modelColors = new Map<string, string>();
  private readonly groupColors = new Map<string, string>();
  private readonly userColors = new Map<string, string>();
  private readonly colorContext: CanvasRenderingContext2D | null;

  constructor(targetEl: () => Element) {
    this.targetEl = targetEl;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    this.colorContext = canvas.getContext('2d', { willReadFrequently: true });
  }

  themeSignature(host: Element | null | undefined): string {
    const style = getComputedStyle(host || this.targetEl());
    return [
      style.getPropertyValue('--pulse-accent'),
      style.getPropertyValue('--pulse-background'),
      (host as HTMLElement | null | undefined)?.dataset.pulseTheme,
    ].join('|');
  }

  private resolveRgb(cssColor: string): RgbTuple {
    if (!this.colorContext) return [133, 168, 255];
    this.colorContext.clearRect(0, 0, 1, 1);
    this.colorContext.fillStyle = '#000';
    this.colorContext.fillStyle = cssColor;
    this.colorContext.fillRect(0, 0, 1, 1);
    const data = this.colorContext.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2]];
  }

  sync(
    value: UsageSummarySnapshot | null,
    modelViewMode: ModelViewMode,
    host: Element | null | undefined,
  ): void {
    const rawSet = new Set(value?.models || []);
    for (const day of value?.days || []) {
      for (const model of Object.keys(day?.models || {})) rawSet.add(model);
    }
    const models = [...rawSet].sort();
    const groupModels = [...new Set(models.map(baseModelName))].sort();
    const users = [...(value?.users || [])].sort();
    const key = [
      this.themeSignature(host),
      modelViewMode,
      models.join('|'),
      groupModels.join('|'),
      users.join('|'),
    ].join('|');
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    this.modelColors.clear();
    this.groupColors.clear();
    this.userColors.clear();

    const style = getComputedStyle(host || this.targetEl());
    const base = this.resolveRgb(style.getPropertyValue('--pulse-accent').trim() || '#85a8ff');
    const background = this.resolveRgb(style.getPropertyValue('--pulse-background').trim() || '#1c1d1f');
    const [hue, rawSat] = rgbToHsl(base);
    const dark = luminance(background) < 0.35;
    const offsets = [0, -18, 18, -36, 36, -9, 9, -27, 27];
    const tones = dark ? [0.64, 0.52, 0.73, 0.59, 0.68] : [0.43, 0.33, 0.51, 0.38, 0.47];
    const towardLight = contrastRatio([255, 255, 255], background) > contrastRatio([0, 0, 0], background);
    const sat = rawSat < 0.08 ? 0.07 : Math.max(0.28, Math.min(0.55, rawSat * 0.72));

    models.forEach((model, i) => {
      this.modelColors.set(
        model,
        buildAccentColor((hue + offsets[i % offsets.length] + 360) % 360, sat, tones[i % tones.length], background, towardLight),
      );
    });
    groupModels.forEach((group, i) => {
      this.groupColors.set(
        group,
        buildAccentColor((hue + offsets[i % offsets.length] + 360) % 360, sat, tones[i % tones.length], background, towardLight),
      );
    });
    users
      .filter((u) => u !== 'legacy')
      .forEach((u, i) => {
        this.userColors.set(
          u,
          buildAccentColor((hue + offsets[i % offsets.length] + 180) % 360, sat, tones[i % tones.length], background, towardLight),
        );
      });
    this.userColors.set('legacy', 'var(--pulse-muted)');
  }

  modelColor(model: string, modelViewMode: ModelViewMode): string {
    return (
      (modelViewMode === 'simple'
        ? this.groupColors.get(model) || this.modelColors.get(model)
        : this.modelColors.get(model) || this.groupColors.get(model)) || 'var(--pulse-accent)'
    );
  }

  userColor(userKey: string): string {
    return this.userColors.get(userKey) || (userKey === 'legacy' ? 'var(--pulse-muted)' : 'var(--pulse-accent)');
  }

  userDisplayName(userKey: string, value: UsageSummarySnapshot | null, w: (cn: string, en: string) => string): string {
    if (userKey === 'legacy') return w('早期历史未区分用量', 'Legacy unassigned');
    return value?.userMeta?.[userKey]?.email || value?.userMeta?.[userKey]?.name || userKey;
  }
}
