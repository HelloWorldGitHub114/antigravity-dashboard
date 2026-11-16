// Custom-scheme sidecars load a classic, self-contained script. Keep the
// editable modules as the single source, with explicit dependency boundaries.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Read the prebuilt self-contained classic `/app.js` script served to the sidecar panel webview.
 */
export function panelAppSource(): string {
  return readFileSync(join(HERE, 'app.js'), 'utf8');
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
