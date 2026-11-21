// Read only whitelisted primary/background/foreground seeds; never expose the customization config.
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { HostThemeConfig, HostThemeMode } from '../../contracts/ipc.ts';
import { platformPaths } from '../../platform/paths.ts';
import { normalizeHostTheme } from '../../shared/color.ts';

export interface ReadHostThemeOptions {
  file?: string;
  read?: (path: string, encoding: BufferEncoding) => Promise<string>;
}

interface HostThemeCacheEntry {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
  value: HostThemeConfig;
}

const MAX_CACHE_ENTRIES = 32;
const hostThemeCache = new Map<string, HostThemeCacheEntry>();

function cloneHostTheme(value: HostThemeConfig): HostThemeConfig {
  const out: HostThemeConfig = {};
  if (value.mode) out.mode = value.mode;
  if (value.dark) out.dark = { ...value.dark };
  if (value.light) out.light = { ...value.light };
  return out;
}

const THEME_MODES: Record<string, HostThemeMode> = {
  THEME_MODE_DARK: 'dark',
  THEME_MODE_LIGHT: 'light',
  THEME_MODE_SYSTEM: 'system',
  dark: 'dark',
  light: 'light',
  system: 'system',
};

interface RawConfig {
  userSettings?: {
    themeMode?: string;
    customThemeSeedsDark?: unknown;
    customThemeSeedsLight?: unknown;
  };
}

function parseHostThemeText(text: string): HostThemeConfig {
  if (text.length > 1048576) return {};
  const settings = (JSON.parse(text.replace(/^\uFEFF/, '')) as RawConfig | null)?.userSettings;
  const mode = settings?.themeMode ? THEME_MODES[settings.themeMode] : undefined;
  return normalizeHostTheme({
    mode,
    dark: settings?.customThemeSeedsDark,
    light: settings?.customThemeSeedsLight,
  });
}

/**
 * Read and sanitize host theme seeds from `config.json` without exposing unrelated settings.
 */
export async function readHostTheme({
  file = platformPaths().pluginConfig,
  read = readFile,
}: ReadHostThemeOptions = {}): Promise<HostThemeConfig> {
  if (read !== readFile) {
    try {
      return parseHostThemeText(await read(file, 'utf8'));
    } catch {
      return {};
    }
  }
  const key = resolve(file);
  try {
    const info = await stat(key);
    const cached = hostThemeCache.get(key);
    if (
      cached &&
      cached.mtimeMs === info.mtimeMs &&
      cached.ctimeMs === info.ctimeMs &&
      cached.size === info.size &&
      cached.ino === info.ino
    ) {
      return cloneHostTheme(cached.value);
    }
    const text = await readFile(key, 'utf8');
    const parsed = parseHostThemeText(text);
    if (hostThemeCache.size >= MAX_CACHE_ENTRIES) hostThemeCache.clear();
    hostThemeCache.set(key, {
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      size: info.size,
      ino: info.ino,
      value: parsed,
    });
    return cloneHostTheme(parsed);
  } catch {
    hostThemeCache.delete(key);
    return {};
  }
}
