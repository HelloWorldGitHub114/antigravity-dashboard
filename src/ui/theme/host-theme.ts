// Read only whitelisted primary/background/foreground seeds; never expose the customization config.
import { readFile } from 'node:fs/promises';
import type { HostThemeConfig, HostThemeMode } from '../../contracts/ipc.ts';
import { platformPaths } from '../../platform/paths.ts';
import { normalizeHostTheme } from '../../shared/color.ts';

export interface ReadHostThemeOptions {
  file?: string;
  read?: (path: string, encoding: BufferEncoding) => Promise<string>;
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

/**
 * Read and sanitize host theme seeds from `config.json` without exposing unrelated settings.
 */
export async function readHostTheme({
  file = platformPaths().pluginConfig,
  read = readFile,
}: ReadHostThemeOptions = {}): Promise<HostThemeConfig> {
  try {
    const text = await read(file, 'utf8');
    if (text.length > 1048576) return {};
    const settings = (JSON.parse(text.replace(/^\uFEFF/, '')) as RawConfig | null)?.userSettings;
    const mode = settings?.themeMode ? THEME_MODES[settings.themeMode] : undefined;
    return normalizeHostTheme({
      mode,
      dark: settings?.customThemeSeedsDark,
      light: settings?.customThemeSeedsLight,
    });
  } catch {
    return {};
  }
}
