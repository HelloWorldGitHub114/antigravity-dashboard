export type ThemeMode = 'dark' | 'light';

export const PALETTES = {
  dark: {
    scheme: 'dark',
    page: '#121315',
    background: '#1c1d1f',
    card: '#2a2c2f',
    'card-end': '#303235',
    foreground: '#e1e3e7',
    chip: '#aaaeb6',
    muted: '#adb2ba',
    subtle: '#a3aab5',
    label: '#b8bdc5',
    hover: '#292b2e',
    'hover-text': '#d9dce2',
    accent: '#85a8ff',
    emphasis: '#dbe5ff',
    border: '#41454d',
    separator: '#ffffff15',
    track: '#ffffff15',
    control: '#383b3f',
    'control-text': '#c2c7d1',
    menu: '#303338',
    selected: '#444950',
    ring: '#9fadc7',
    'ring-track': '#565c67',
    dot: '#777c84',
    success: '#8bb19b',
    warning: '#d7b079',
    danger: '#e99b9b',
    shadow: '#0005',
  },
  light: {
    scheme: 'light',
    page: '#f5f6f8',
    background: '#ffffff',
    card: '#ffffff',
    'card-end': '#f5f7fa',
    foreground: '#202631',
    chip: '#485261',
    muted: '#596575',
    subtle: '#626d7c',
    label: '#515c6b',
    hover: '#e9edf3',
    'hover-text': '#172333',
    accent: '#315fc4',
    emphasis: '#284e9b',
    border: '#ccd3df',
    separator: '#18253b20',
    track: '#dce2ec',
    control: '#e8edf4',
    'control-text': '#354255',
    menu: '#ffffff',
    selected: '#e4ebf6',
    ring: '#4667a0',
    'ring-track': '#c5cedd',
    dot: '#707b8a',
    success: '#347451',
    warning: '#8b601b',
    danger: '#b13c3c',
    shadow: '#14234026',
  },
} as const;

export type PaletteKey = keyof (typeof PALETTES)['dark'];

function declarations(theme: ThemeMode): string {
  return Object.entries(PALETTES[theme])
    .map(([key, value]) => `--pulse-${key}:${value}`)
    .join(';');
}

export function css(selector: string): string {
  return `${selector}{${declarations('dark')}}${selector}[data-pulse-theme="light"]{${declarations('light')}}@media(prefers-color-scheme:light){${selector}:not([data-pulse-theme]){${declarations('light')}}}`;
}

// Shadow selectors need the attribute inside :host(), unlike ordinary DOM.
export function shadowCss(): string {
  return `:host{${declarations('dark')}}:host([data-pulse-theme="light"]){${declarations('light')}}`;
}

export function explicitTheme(element: Element | null): ThemeMode | null {
  if (!element) return null;
  for (const key of ['data-theme', 'data-color-mode', 'data-theme-mode', 'data-vscode-theme-kind']) {
    const value = element.getAttribute(key)?.toLowerCase() ?? '';
    if (/^(light|light-theme|vs|vscode-light|hc-light)$/.test(value)) return 'light';
    if (/^(dark|dark-theme|vs-dark|vscode-dark|hc-black|hc-dark)$/.test(value)) return 'dark';
  }
  const classes = element.classList;
  const light = ['light', 'light-theme', 'theme-light', 'vscode-light', 'vs'].some((value) =>
    classes.contains(value),
  );
  const dark = ['dark', 'dark-theme', 'theme-dark', 'vscode-dark', 'vs-dark', 'hc-black'].some(
    (value) => classes.contains(value),
  );
  return light === dark ? null : light ? 'light' : 'dark';
}
