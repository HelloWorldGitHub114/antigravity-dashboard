// Custom-scheme sidecars load a classic, self-contained script. Keep the
// editable modules as the single source, with explicit dependency boundaries.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const PANEL_IMPORTS = [
  "import { percent, rate, count, elapsed, countdown, resetDate } from './format.mjs';",
  "import { createI18n } from './i18n.js';",
  "import { createTheme } from './theme.js';",
] as const;

/**
 * Assemble the classic self-contained `/app.js` script served to the sidecar panel webview.
 */
export function panelAppSource(): string {
  const read = (name: string): string => readFileSync(join(HERE, name), 'utf8');
  const factory = (name: 'i18n' | 'theme'): string => {
    const source = read(`../../compat/${name}.cjs`);
    const prefix = 'module.exports = ';
    const index = source.indexOf(prefix);
    if (index < 0) throw new Error(`Panel factory format changed: ${name}`);
    return source.slice(index + prefix.length).trim().replace(/;$/, '');
  };

  let app = read('app.js');
  for (const line of PANEL_IMPORTS) {
    if (!app.includes(line)) throw new Error('Panel dependency list changed');
    app = app.replace(line, '');
  }
  const format = read('format.mjs').replace(/^export function /gm, 'function ');
  if (/^\s*(?:import|export)\b/m.test(app + format)) {
    throw new Error('Unsupported panel module dependency');
  }
  return `(()=>{'use strict';\n${format}\nconst createI18n=(${factory('i18n')});\nconst createTheme=(${factory('theme')});\n${app}\n})();`;
}

/**
 * Render `index.html` with a content-addressed cache-busting query version across panel assets.
 */
export function panelPageSource(): string {
  const assets = /(href|src)="\/(theme\.css|styles\.css|app\.js)(?:\?[^"]*)?"/g;
  const html = readFileSync(join(HERE, 'index.html'), 'utf8')
    .replace(/<meta name="ag-pulse-panel-assets"[^>]*>/g, '')
    .replace(assets, '$1="/$2"');
  const version = createHash('sha256')
    .update(html)
    .update(panelAppSource())
    .update(readFileSync(join(HERE, 'styles.css'), 'utf8'))
    .update(readFileSync(join(HERE, '../../compat/theme.cjs'), 'utf8'))
    .digest('hex')
    .slice(0, 16);
  return html
    .replace(assets, (_match, attribute: string, path: string) => `${attribute}="/${path}?v=${version}"`)
    .replace('</head>', `<meta name="ag-pulse-panel-assets" content="${version}"></head>`);
}
