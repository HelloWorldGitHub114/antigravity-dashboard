import type { HostThemeConfig, HostThemeMode, HostThemeSeed } from '../contracts/ipc.ts';

export type RgbTuple = [number, number, number];
export type { HostThemeConfig, HostThemeMode, HostThemeSeed };
export type HostThemePaletteSeed = HostThemeSeed;
export type HostTheme = HostThemeConfig;

const LUMINANCE_WEIGHTS: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const THEME_MODES = new Set<HostThemeMode>(['dark', 'light', 'system']);
const THEME_SEED_KEYS = ['primary', 'background', 'foregroundOverride'] as const;

/**
 * Computes WCAG 2.x relative luminance for an sRGB `[r, g, b]` tuple (0..255).
 */
export function luminance(rgb: readonly [number, number, number]): number {
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const channel = rgb[i] / 255;
    const linear =
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    sum += linear * LUMINANCE_WEIGHTS[i];
  }
  return sum;
}

/**
 * Computes WCAG contrast ratio (`1..21`) between two sRGB tuples.
 */
export function contrastRatio(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Alias for {@link contrastRatio}.
 */
export function contrast(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return contrastRatio(a, b);
}

/**
 * Linearly interpolates between two RGB tuples by `amount` (`0..1`).
 */
export function mixRgb(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  amount: number,
): RgbTuple {
  return [
    Math.round(a[0] + (b[0] - a[0]) * amount),
    Math.round(a[1] + (b[1] - a[1]) * amount),
    Math.round(a[2] + (b[2] - a[2]) * amount),
  ];
}

/**
 * Formats an RGB tuple as space-separated CSS `rgb(r g b)`.
 */
export function rgbToCss(color: readonly [number, number, number]): string {
  return `rgb(${color[0]} ${color[1]} ${color[2]})`;
}

/**
 * Converts an sRGB tuple (`0..255`) into `[hue (0..360), saturation (0..1), lightness (0..1)]`.
 */
export function rgbToHsl(rgb: readonly [number, number, number]): [number, number, number] {
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  const d = hi - lo;
  const l = (hi + lo) / 2;
  const h = d
    ? (hi === r ? (g - b) / d + (g < b ? 6 : 0) : hi === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60
    : 0;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return [h, s, l];
}

/**
 * Converts HSL (`hue` in degrees, `sat` and `light` in `0..1`) into an sRGB `[r, g, b]` tuple.
 */
export function hslToRgb(hue: number, sat: number, light: number): RgbTuple {
  const h = ((hue % 360) + 360) % 360;
  const a = sat * Math.min(light, 1 - light);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}

/**
 * Nudges `color` toward black or white until it meets `minContrast` against all `surfaces`.
 */
export function readableColor(
  color: readonly [number, number, number],
  surfaces: readonly (readonly [number, number, number])[],
  minContrast = 4.5,
): string {
  const isReadable = (values: readonly [number, number, number]) =>
    surfaces.every((surface) => contrastRatio(values, surface) >= minContrast);
  if (isReadable(color)) return rgbToCss(color);

  const white: RgbTuple = [255, 255, 255];
  const black: RgbTuple = [0, 0, 0];
  const score = (values: readonly [number, number, number]) =>
    Math.min(...surfaces.map((surface) => contrastRatio(values, surface)));
  const end = score(white) >= score(black) ? white : black;

  for (let step = 1; step <= 100; step++) {
    const mixed = mixRgb(color, end, step / 100);
    if (isReadable(mixed)) return rgbToCss(mixed);
  }
  return rgbToCss(end);
}

/**
 * Synthesizes an accessible chart/accent color from HSL seeds against `bg`.
 */
export function buildAccentColor(
  hue: number,
  sat: number,
  light: number,
  bg: readonly [number, number, number],
  towardLight: boolean | number,
  minContrast = 3,
): string {
  const stepDelta = towardLight ? 0.005 : -0.005;
  let currentLight = light;
  let rgb = hslToRgb(hue, sat, currentLight);
  for (let step = 0; contrastRatio(rgb, bg) < minContrast && step < 100; step++) {
    currentLight = Math.max(0, Math.min(1, currentLight + stepDelta));
    rgb = hslToRgb(hue, sat, currentLight);
  }
  return rgbToCss(rgb);
}

/**
 * Validates and normalizes `#rgb` / `#rrggbb` hex strings to lowercase `#rrggbb`, or `null`.
 */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string' || !HEX_COLOR_RE.test(value)) return null;
  if (value.length === 4) {
    return (
      '#' +
      value[1] +
      value[1] +
      value[2] +
      value[2] +
      value[3] +
      value[3]
    ).toLowerCase();
  }
  return value.toLowerCase();
}

/**
 * Filters and normalizes a raw host theme configuration object, rejecting unsafe CSS values.
 */
export function normalizeHostTheme(value: unknown): HostTheme {
  const result: HostTheme = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const raw = value as Record<string, unknown>;
  if (typeof raw.mode === 'string' && THEME_MODES.has(raw.mode as HostThemeMode)) {
    result.mode = raw.mode as HostThemeMode;
  }
  for (const mode of ['dark', 'light'] as const) {
    const rawPalette = raw[mode];
    if (!rawPalette || typeof rawPalette !== 'object' || Array.isArray(rawPalette)) {
      continue;
    }
    const paletteObj = rawPalette as Record<string, unknown>;
    for (const key of THEME_SEED_KEYS) {
      const normalized = normalizeHexColor(paletteObj[key]);
      if (!normalized) continue;
      (result[mode] ??= {})[key] = normalized;
    }
  }
  return result;
}
