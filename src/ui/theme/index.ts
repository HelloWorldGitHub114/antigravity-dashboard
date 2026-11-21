// Shared theme controller for the injected Shadow DOM and the SDK side panel.
import type { HostThemeConfig } from '../../contracts/ipc.ts';
import {
  contrastRatio as contrast,
  luminance,
  mixRgb,
  normalizeHostTheme,
  readableColor,
  rgbToCss,
  type RgbTuple,
} from '../../shared/color.ts';
import {
  PALETTES,
  css,
  explicitTheme,
  shadowCss,
  type PaletteKey,
  type ThemeMode,
} from './palettes.ts';

export type { ThemeMode } from './palettes.ts';

export interface AttachThemeOptions {
  embedded?: boolean;
}

export interface AgPulseThemeAttachment {
  update: () => ThemeMode | undefined;
  setHostTheme: (value: unknown) => ThemeMode | undefined;
  dispose: () => void;
}

export interface AgPulseThemeController {
  css: (selector: string) => string;
  shadowCss: () => string;
  attach: (target: HTMLElement, options?: AttachThemeOptions) => AgPulseThemeAttachment;
  normalizeHostTheme: (value: unknown) => HostThemeConfig;
}

const HEX3_RE = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX4_RE = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX8_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RGB_COMMA_RE =
  /^rgba?\(\s*([+-]?(?:\d+\.?\d*|\.\d+)%?)\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+)%?)\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+)%?)(?:\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+)%?))?\s*\)$/i;
const RGB_SPACE_RE =
  /^rgba?\(\s*([+-]?(?:\d+\.?\d*|\.\d+)%?)\s+([+-]?(?:\d+\.?\d*|\.\d+)%?)\s+([+-]?(?:\d+\.?\d*|\.\d+)%?)(?:\s*\/\s*([+-]?(?:\d+\.?\d*|\.\d+)%?))?\s*\)$/i;

const MAX_RGB_CACHE = 256;
const FALLBACK_POLL_MS = 4000;
const WATCHED_STYLE_PROPS = [
  '--background',
  '--color-background',
  '--popover',
  '--card',
  '--color-card',
  '--foreground',
  '--color-foreground',
  '--primary',
  '--color-primary',
  'background',
  'background-color',
  'color-scheme',
] as const;

function parseAlphaByte(token: string | undefined): number {
  if (token === undefined) return 255;
  const isPct = token.endsWith('%');
  const raw = parseFloat(token);
  if (!Number.isFinite(raw)) return -1;
  const scaled = isPct ? (raw / 100) * 255 : raw * 255;
  return Math.max(0, Math.min(255, Math.round(scaled)));
}

function parseRgbChannel(token: string, isPercent: boolean): number {
  const raw = parseFloat(token);
  if (!Number.isFinite(raw)) return -1;
  const scaled = isPercent ? (raw / 100) * 255 : raw;
  return Math.max(0, Math.min(255, Math.round(scaled)));
}

function parseFastColor(trimmed: string): RgbTuple | null | undefined {
  if (trimmed.toLowerCase() === 'transparent') return null;
  const c0 = trimmed.charCodeAt(0);
  if (c0 === 35 /* '#' */) {
    const len = trimmed.length;
    if (len === 7) {
      const m = HEX6_RE.exec(trimmed);
      if (!m) return undefined;
      return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    }
    if (len === 4) {
      const m = HEX3_RE.exec(trimmed);
      if (!m) return undefined;
      return [parseInt(m[1], 16) * 17, parseInt(m[2], 16) * 17, parseInt(m[3], 16) * 17];
    }
    if (len === 9) {
      const m = HEX8_RE.exec(trimmed);
      if (!m) return undefined;
      if (parseInt(m[4], 16) < 250) return null;
      return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    }
    if (len === 5) {
      const m = HEX4_RE.exec(trimmed);
      if (!m) return undefined;
      if (parseInt(m[4], 16) * 17 < 250) return null;
      return [parseInt(m[1], 16) * 17, parseInt(m[2], 16) * 17, parseInt(m[3], 16) * 17];
    }
    return undefined;
  }
  if (c0 === 114 /* 'r' */ || c0 === 82 /* 'R' */) {
    const m = RGB_COMMA_RE.exec(trimmed) || RGB_SPACE_RE.exec(trimmed);
    if (!m) return undefined;
    const p1 = m[1].endsWith('%');
    const p2 = m[2].endsWith('%');
    const p3 = m[3].endsWith('%');
    if (p1 !== p2 || p2 !== p3) return undefined;
    const alpha = parseAlphaByte(m[4]);
    if (alpha < 0) return undefined;
    if (alpha < 250) return null;
    const r = parseRgbChannel(m[1], p1);
    const g = parseRgbChannel(m[2], p2);
    const b = parseRgbChannel(m[3], p3);
    if (r < 0 || g < 0 || b < 0) return undefined;
    return [r, g, b];
  }
  return undefined;
}

function rgbKey(color: RgbTuple | null): string {
  return color ? `${color[0]},${color[1]},${color[2]}` : '';
}

function readWatchedInlineStyle(el: HTMLElement): string {
  const style = el.style;
  let out = '';
  for (let i = 0; i < WATCHED_STYLE_PROPS.length; i++) {
    out += `${style.getPropertyValue(WATCHED_STYLE_PROPS[i])}\0`;
  }
  return out;
}

export default function createAgPulseTheme(): AgPulseThemeController {
  function attach(
    target: HTMLElement,
    { embedded = false }: AttachThemeOptions = {},
  ): AgPulseThemeAttachment {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const rgbCache = new Map<string, RgbTuple | null>();
    let context: CanvasRenderingContext2D | null | undefined;
    let stopped = false;
    let hostTheme: HostThemeConfig = {};
    let lastSignature: string | null = null;
    let lastTargetWatchedStyle = readWatchedInlineStyle(target);
    let timer: ReturnType<typeof setInterval> | null = null;
    let scheduledRaf: number | null = null;
    let scheduledMicrotask = false;

    function getCanvasContext(): CanvasRenderingContext2D | null {
      if (context !== undefined) return context;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        context = canvas.getContext('2d', { willReadFrequently: true });
      } catch {
        context = null;
      }
      return context;
    }

    function cacheRgb(key: string, value: RgbTuple | null): RgbTuple | null {
      if (rgbCache.size >= MAX_RGB_CACHE) rgbCache.clear();
      rgbCache.set(key, value);
      return value;
    }

    function rgb(color: string | undefined): RgbTuple | null {
      if (!color) return null;
      const trimmed = color.trim();
      if (!trimmed) return null;
      if (rgbCache.has(trimmed)) return rgbCache.get(trimmed) ?? null;
      const fast = parseFastColor(trimmed);
      if (fast !== undefined) return cacheRgb(trimmed, fast);
      if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || !CSS.supports('color', trimmed)) {
        return cacheRgb(trimmed, null);
      }
      const ctx = getCanvasContext();
      if (!ctx) return null;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = 'transparent';
      ctx.fillStyle = trimmed;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      // Transparent surfaces do not define a theme.
      return cacheRgb(trimmed, a < 250 ? null : [r, g, b]);
    }

    function fromColor(color: string): ThemeMode | null {
      const values = rgb(color);
      return values
        ? 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2] >= 145
          ? 'light'
          : 'dark'
        : null;
    }

    interface ResolvedStyles {
      root: CSSStyleDeclaration;
      body: CSSStyleDeclaration | null;
      parent: CSSStyleDeclaration | null;
    }

    function collectStyles(): ResolvedStyles {
      return {
        root: getComputedStyle(document.documentElement),
        body: document.body ? getComputedStyle(document.body) : null,
        parent: embedded && target.parentElement ? getComputedStyle(target.parentElement) : null,
      };
    }

    function resolve(styles: ResolvedStyles): ThemeMode {
      const root = document.documentElement;
      // App settings override the OS, including when the app uses a fixed theme.
      const declared = explicitTheme(document.body) || explicitTheme(root);
      if (declared) return declared;
      // The sidecar SDK pushes --background on theme-change messages.
      const sdk = fromColor(styles.root.getPropertyValue('--background').trim());
      if (sdk) return sdk;
      if (embedded) {
        for (let element = target.parentElement; element; element = element.parentElement) {
          const theme = explicitTheme(element) || fromColor(getComputedStyle(element).backgroundColor);
          if (theme) return theme;
        }
        const scheme = styles.root.colorScheme;
        if (scheme === 'light' || scheme === 'dark') return scheme;
      }
      if (hostTheme.mode === 'light' || hostTheme.mode === 'dark') return hostTheme.mode;
      return media.matches ? 'dark' : 'light';
    }

    function hostColor(tokens: readonly string[], styles: ResolvedStyles): RgbTuple | null {
      // The renderer's active primary wins over saved seeds: a user may have
      // switched back to a preset while retaining custom-theme settings.
      const ordered = embedded
        ? [styles.parent, styles.body, styles.root]
        : [styles.root, styles.body];
      for (const style of ordered) {
        if (!style) continue;
        for (const token of tokens) {
          const value = style.getPropertyValue(token).trim();
          if (!value) continue;
          const color = rgb(value) || rgb(`hsl(${value})`);
          if (color) return color;
        }
      }
      return null;
    }

    function surfaceColors(
      bg: RgbTuple | null,
      cardSeed: RgbTuple | null,
      foregroundSeed: RgbTuple | null,
    ): Partial<Record<PaletteKey, string>> {
      if (!bg) return {};
      // Use actual host card surfaces (including color-mix/OKLCH) where available.
      // If only a seed exists, derive a subtle raised surface in the same hue.
      const dark = luminance(bg) < 0.35;
      const end: RgbTuple = dark ? [255, 255, 255] : [0, 0, 0];
      let card = cardSeed || mixRgb(bg, end, dark ? 0.05 : 0.015);
      // Wildly incompatible host tokens must not make shared text unreadable.
      const commonContrast = (candidate: RgbTuple) =>
        Math.max(
          ...([
            [255, 255, 255],
            [0, 0, 0],
          ] as const).map((fg) => Math.min(contrast(fg, bg), contrast(fg, candidate))),
        );
      if (commonContrast(card) < 4.5) card = mixRgb(bg, end, dark ? 0.05 : 0.015);
      const hover = mixRgb(card, end, 0.06);
      const control = mixRgb(card, end, 0.08);
      const selected = mixRgb(card, end, 0.12);
      const surfaces: RgbTuple[] = [bg, card, hover, control, selected];
      const foreground = foregroundSeed || rgb(PALETTES[dark ? 'dark' : 'light'].foreground);
      const text = foreground ? rgb(readableColor(foreground, surfaces)) : null;
      const resolvedText: RgbTuple = text ?? (dark ? [255, 255, 255] : [0, 0, 0]);
      const values: Record<string, RgbTuple> = {
        page: bg,
        background: bg,
        card,
        'card-end': card,
        menu: card,
        hover,
        control,
        selected,
        foreground: resolvedText,
        chip: mixRgb(card, resolvedText, 0.8),
        muted: mixRgb(card, resolvedText, 0.75),
        subtle: mixRgb(card, resolvedText, 0.7),
        label: mixRgb(card, resolvedText, 0.8),
        'hover-text': resolvedText,
        'control-text': mixRgb(card, resolvedText, 0.85),
        border: mixRgb(card, resolvedText, 0.24),
        separator: mixRgb(card, resolvedText, 0.14),
        track: mixRgb(card, resolvedText, 0.14),
        'ring-track': mixRgb(card, resolvedText, 0.24),
        dot: mixRgb(card, resolvedText, 0.6),
      };
      for (const key of ['chip', 'muted', 'subtle', 'label', 'control-text']) {
        const readable = rgb(readableColor(values[key], surfaces));
        if (readable) values[key] = readable;
      }
      return Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, rgbToCss(value)]),
      ) as Partial<Record<PaletteKey, string>>;
    }

    function cancelScheduled(): void {
      if (scheduledRaf !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(scheduledRaf);
      }
      scheduledRaf = null;
      scheduledMicrotask = false;
    }

    function scheduleUpdate(): void {
      if (stopped || scheduledRaf !== null || scheduledMicrotask) return;
      if (typeof requestAnimationFrame === 'function' && !document.hidden) {
        scheduledRaf = requestAnimationFrame(() => {
          scheduledRaf = null;
          update();
        });
      } else {
        scheduledMicrotask = true;
        queueMicrotask(() => {
          if (!scheduledMicrotask) return;
          scheduledMicrotask = false;
          update();
        });
      }
    }

    function update(): ThemeMode | undefined {
      if (stopped) return undefined;
      cancelScheduled();
      const styles = collectStyles();
      const theme = resolve(styles);
      let bg = hostColor(['--background', '--color-background'], styles) || rgb(hostTheme[theme]?.background);
      if (!bg && embedded) {
        for (let element = target.parentElement; element; element = element.parentElement) {
          bg = rgb(getComputedStyle(element).backgroundColor);
          if (bg) break;
        }
      }
      const cardSeed = bg ? hostColor(['--popover', '--card', '--color-card'], styles) : null;
      const fgSeed = bg
        ? hostColor(['--foreground', '--color-foreground'], styles) ||
          rgb(hostTheme[theme]?.foregroundOverride)
        : null;
      const primary = hostColor(['--primary', '--color-primary'], styles) || rgb(hostTheme[theme]?.primary);
      const signature = `${theme}|${rgbKey(bg)}|${rgbKey(cardSeed)}|${rgbKey(fgSeed)}|${rgbKey(primary)}`;
      if (signature === lastSignature && target.dataset.pulseTheme === theme) {
        return theme;
      }
      lastSignature = signature;

      if (target.dataset.pulseTheme !== theme) target.dataset.pulseTheme = theme;
      const values = surfaceColors(bg, cardSeed, fgSeed);
      const surfaces = [
        values.card || PALETTES[theme].card,
        values.background || PALETTES[theme].background,
        values.control || PALETTES[theme].control,
      ]
        .map(rgb)
        .filter((item): item is RgbTuple => item !== null);
      if (primary) {
        values.accent = rgbToCss(primary);
        values.ring = rgbToCss(primary);
      }
      if (primary || values.card) {
        const seed = primary || rgb(PALETTES[theme].emphasis);
        if (seed) values.emphasis = readableColor(seed, surfaces);
      }
      // Severity text must also remain readable on custom surfaces.
      if (values.card) {
        for (const key of ['success', 'warning', 'danger'] as const) {
          const seed = rgb(PALETTES[theme][key]);
          if (seed) values[key] = readableColor(seed, surfaces);
        }
      }
      let wroteStyle = false;
      for (const key of Object.keys(PALETTES[theme]) as PaletteKey[]) {
        const property = `--pulse-${key}`;
        const value = values[key];
        if (value) {
          if (target.style.getPropertyValue(property) !== value) {
            target.style.setProperty(property, value);
            wroteStyle = true;
          }
        } else if (target.style.getPropertyValue(property)) {
          target.style.removeProperty(property);
          wroteStyle = true;
        }
      }
      if (wroteStyle) {
        lastTargetWatchedStyle = readWatchedInlineStyle(target);
        observer.takeRecords();
      }
      return theme;
    }

    const observer = new MutationObserver((records) => {
      if (stopped) return;
      let relevant = false;
      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (
          record.type === 'attributes' &&
          record.attributeName === 'style' &&
          record.target === target
        ) {
          const nextWatched = readWatchedInlineStyle(target);
          if (nextWatched !== lastTargetWatchedStyle) {
            lastTargetWatchedStyle = nextWatched;
            relevant = true;
            break;
          }
          continue;
        }
        relevant = true;
        break;
      }
      if (relevant) scheduleUpdate();
    });
    const attributes = [
      'class',
      'style',
      'data-theme',
      'data-color-mode',
      'data-theme-mode',
      'data-vscode-theme-kind',
    ];
    const elements = new Set<Element | null>([document.documentElement, document.body]);
    if (embedded) {
      for (let element = target.parentElement; element; element = element.parentElement) {
        elements.add(element);
      }
    }
    for (const element of elements) {
      if (element) observer.observe(element, { attributes: true, attributeFilter: attributes });
    }
    if (document.head) {
      observer.observe(document.head, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href', 'media', 'disabled'],
      });
    }
    const onMediaChange = (): void => {
      update();
    };
    const stopTimer = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const startTimer = (): void => {
      if (stopped || document.hidden || timer !== null) return;
      // Catch stylesheet replacement and reparented composers without observing chat text.
      timer = setInterval(update, FALLBACK_POLL_MS);
    };
    const onVisibilityChange = (): void => {
      if (stopped) return;
      if (document.hidden) {
        stopTimer();
        cancelScheduled();
      } else {
        update();
        startTimer();
      }
    };
    media.addEventListener('change', onMediaChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    update();
    startTimer();
    return {
      update,
      setHostTheme(value: unknown): ThemeMode | undefined {
        hostTheme = normalizeHostTheme(value);
        return update();
      },
      dispose(): void {
        stopped = true;
        cancelScheduled();
        observer.disconnect();
        media.removeEventListener('change', onMediaChange);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        stopTimer();
      },
    };
  }

  return { css, shadowCss, attach, normalizeHostTheme };
}
