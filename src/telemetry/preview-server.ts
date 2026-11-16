import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { IntegrationHealth, MetricsRequestInput, MetricsSnapshot, PreferencesUpdateInput } from '../contracts/index.ts';
import type { RuntimePreferencesBridge } from '../../compat/runtime-ui.mjs';
import { panelAppSource, panelPageSource } from './panel-source.ts';
import type { MetricsStore } from './store/index.ts';

export interface PreviewServerOptions {
  here: string;
  port: number;
  guidPattern: RegExp;
  staticFiles: Record<string, [string, string]>;
  livePreferences: RuntimePreferencesBridge;
  store: MetricsStore;
  metrics: (input?: MetricsRequestInput) => Promise<MetricsSnapshot>;
  getHealth: () => IntegrationHealth;
  i18nModule: () => string;
  themeModule: () => string;
  themeCss: () => string;
  inlineSource: () => string;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const prefError = (error: unknown): string =>
  errorMessage(error) === 'Invalid timeline preference' ? 'Invalid timeline preference' : 'Language preference could not be saved';

function parseClearConversationId(data: unknown, guidPattern: RegExp): string | null {
  if (data != null && (typeof data !== 'object' || Array.isArray(data))) throw new Error('Invalid clear timeline request');
  const cid = (data as { conversationId?: unknown } | null)?.conversationId;
  if (cid != null && (typeof cid !== 'string' || !guidPattern.test(cid))) throw new Error('Invalid conversation ID');
  return typeof cid === 'string' ? cid : null;
}

async function readJsonBody(
  req: { [Symbol.asyncIterator](): AsyncIterableIterator<unknown> },
  maxBytes: number,
  tooLargeMsg: string,
): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > maxBytes) throw new Error(tooLargeMsg);
  }
  return body;
}

export function startPreviewServer(options: PreviewServerOptions): void {
  const {
    here, port, guidPattern, staticFiles, livePreferences, store,
    metrics, getHealth, i18nModule, themeModule, themeCss, inlineSource,
  } = options;
  const server = createServer(async (req, res) => {
    const rawHost = req.headers.host;
    const host = Array.isArray(rawHost) ? rawHost[0] || '' : rawHost || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url || '/', `http://${host}`);
    const sameOrigin = req.headers.origin === `http://${host}`;
    if (url.pathname === '/api/preferences' || url.pathname === '/api/timeline/clear') {
      if (req.headers.origin && !sameOrigin) { res.writeHead(403); res.end(); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (url.pathname === '/api/preferences' && req.method === 'GET') {
        res.end(JSON.stringify(await livePreferences.snapshot()));
        return;
      }
      if (req.method === 'POST' && sameOrigin) {
        const isJson = String(req.headers['content-type']).startsWith('application/json');
        if (url.pathname === '/api/preferences' && !isJson) { res.writeHead(405); res.end(); return; }
        try {
          const body = await readJsonBody(req, 1024, url.pathname === '/api/preferences' ? 'Preference payload too large' : 'Payload too large');
          if (url.pathname === '/api/preferences') {
            res.end(JSON.stringify(await livePreferences.set(JSON.parse(body) as PreferencesUpdateInput)));
          } else {
            let parsed: unknown = {};
            if (body.trim()) {
              if (!isJson) throw new Error('Invalid content type');
              parsed = JSON.parse(body);
            }
            res.end(JSON.stringify(await store.clearTimeline(parseClearConversationId(parsed, guidPattern))));
          }
        } catch (error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: url.pathname === '/api/preferences' ? prefError(error) : (errorMessage(error) || 'Timeline cache could not be cleared') }));
        }
        return;
      }
      res.writeHead(405); res.end(); return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (url.pathname === '/api/metrics') {
      if (req.headers.origin && !sameOrigin) { res.writeHead(403); res.end(); return; }
      try {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(await metrics({ conversationId: url.searchParams.get('conversationId'), force: url.searchParams.get('force') === '1' })));
      } catch { res.writeHead(500); res.end('{"error":"数据暂时不可用"}'); }
      return;
    }
    if (url.pathname === '/api/integration') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(getHealth())); return; }
    if (url.pathname === '/preload.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('// Standalone preview: no host bridge.'); return; }
    if (url.pathname === '/i18n.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(i18nModule()); return; }
    if (url.pathname === '/theme.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(themeModule()); return; }
    if (url.pathname === '/theme.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }); res.end(themeCss()); return; }
    if (url.pathname === '/inline-widget.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(inlineSource()); return; }
    if (url.pathname === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(panelAppSource()); return; }
    if (url.pathname.startsWith('/toolbar-preview')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(readFileSync(join(here, 'toolbar-preview.html'), 'utf8')); return; }
    const file = staticFiles[url.pathname];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` });
    res.end(url.pathname === '/' ? panelPageSource() : readFileSync(join(here, file[0]), 'utf8'));
  });
  server.listen(port, '127.0.0.1', () => console.log(`Antigrative Dashboard: http://127.0.0.1:${port}`));
}
