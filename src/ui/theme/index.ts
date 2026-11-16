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

export default function createAgPulseTheme(): AgPulseThemeController {
  function attach(
    target: HTMLElement,
    { embedded = false }: AttachThemeOptions = {},
  ): AgPulseThemeAttachment {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    let stopped = false;
    let hostTheme: HostThemeConfig = {};

    function rgb(color: string | undefined): RgbTuple | null {
      if (!color || !context || !CSS.supports('color', color)) return null;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = 'transparent';
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      if (a < 250) return null; // Transparent surfaces do not define a theme.
      return [r, g, b];
    }

    function fromColor(color: string): ThemeMode | null {
      const values = rgb(color);
      return values
        ? 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2] >= 145
          ? 'light'
          : 'dark'
        : null;
    }

    function resolve(): ThemeMode {
      const root = document.documentElement;
      // App settings override the OS, including when the app uses a fixed theme.
      const declared = explicitTheme(document.body) || explicitTheme(root);
      if (declared) return declared;
      // The sidecar SDK pushes --background on theme-change messages.
      const sdk = fromColor(getComputedStyle(root).getPropertyValue('--background').trim());
      if (sdk) return sdk;
      if (embedded) {
        for (let element = target.parentElement; element; element = element.parentElement) {
          const theme = explicitTheme(element) || fromColor(getComputedStyle(element).backgroundColor);
          if (theme) return theme;
        }
        const scheme = getComputedStyle(root).colorScheme;
        if (scheme === 'light' || scheme === 'dark') return scheme;
      }
      if (hostTheme.mode === 'light' || hostTheme.mode === 'dark') return hostTheme.mode;
      return media.matches ? 'dark' : 'light';
    }

    function hostColor(tokens: readonly string[]): RgbTuple | null {
      // The renderer's active primary wins over saved seeds: a user may have
      // switched back to a preset while retaining custom-theme settings.
      const elements = embedded
        ? [target.parentElement, document.body, document.documentElement]
        : [document.documentElement, document.body];
      for (const element of elements.filter((el): el is HTMLElement => Boolean(el))) {
        const style = getComputedStyle(element);
        for (const token of tokens) {
          const value = style.getPropertyValue(token).trim();
          if (!value) continue;
          const color = rgb(value) || rgb(`hsl(${value})`);
          if (color) return color;
        }
      }
      return null;
    }

    function surfaceColors(theme: ThemeMode): Partial<Record<PaletteKey, string>> {
      let background =
        hostColor(['--background', '--color-background']) || rgb(hostTheme[theme]?.background);
      if (!background && embedded) {
        for (let element = target.parentElement; element; element = element.parentElement) {
          background = rgb(getComputedStyle(element).backgroundColor);
          if (background) break;
        }
      }
      if (!background) return {};
      const bg = background;
      // Use actual host card surfaces (including color-mix/OKLCH) where available.
      // If only a seed exists, derive a subtle raised surface in the same hue.
      const dark = luminance(bg) < 0.35;
      const end: RgbTuple = dark ? [255, 255, 255] : [0, 0, 0];
      let card =
        hostColor(['--popover', '--card', '--color-card']) || mixRgb(bg, end, dark ? 0.05 : 0.015);
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
      const foreground =
        hostColor(['--foreground', '--color-foreground']) ||
        rgb(hostTheme[theme]?.foregroundOverride) ||
        rgb(PALETTES[dark ? 'dark' : 'light'].foreground);
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

    function update(): ThemeMode | undefined {
      if (stopped) return undefined;
      const theme = resolve();
      if (target.dataset.pulseTheme !== theme) target.dataset.pulseTheme = theme;
      const values = surfaceColors(theme);
      const surfaces = [
        values.card || PALETTES[theme].card,
        values.background || PALETTES[theme].background,
        values.control || PALETTES[theme].control,
      ]
        .map(rgb)
        .filter((item): item is RgbTuple => item !== null);
      const primary = hostColor(['--primary', '--color-primary']) || rgb(hostTheme[theme]?.primary);
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
      for (const key of Object.keys(PALETTES[theme]) as PaletteKey[]) {
        const property = `--pulse-${key}`;
        const value = values[key];
        if (value) {
          if (target.style.getPropertyValue(property) !== value) {
            target.style.setProperty(property, value);
          }
        } else if (target.style.getPropertyValue(property)) {
          target.style.removeProperty(property);
        }
      }
      return theme;
    }

    const observer = new MutationObserver(update);
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
    media.addEventListener('change', update);
    // Catch stylesheet replacement and reparented composers without observing chat text.
    const timer = setInterval(update, 1500);
    update();
    return {
      update,
      setHostTheme(value: unknown): ThemeMode | undefined {
        hostTheme = normalizeHostTheme(value);
        return update();
      },
      dispose(): void {
        stopped = true;
        observer.disconnect();
        media.removeEventListener('change', update);
        clearInterval(timer);
      },
    };
  }

  return { css, shadowCss, attach, normalizeHostTheme };
}
