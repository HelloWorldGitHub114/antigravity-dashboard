import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { MetricsStore } from './store.mjs';
import { AntigravityClient } from './client.mjs';
import { SessionHistory } from './history.mjs';
import { TranscriptReader } from './transcript.mjs';
import { DesktopUsage, UsageLedger } from './usage.mjs';
import { discoverLocalConversations } from './local-conversations.mjs';
import { loadSidecarSdk } from './sdk.mjs';
import { RuntimeUi, makeRendererSource } from '../../compat/runtime-ui.mjs';
import { platformPaths } from '../../compat/platform.mjs';
import { PreferencesStore } from '../../compat/preferences.mjs';
import { SidecarOwner } from '../../compat/sidecar-owner.mjs';
import { readHostTheme } from '../../compat/host-theme.mjs';
import { panelAppSource,panelPageSource } from './panel-source.mjs';
import { AppUpdater } from './updater.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const paths = platformPaths();
const isSidecar = Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
const ownership = isSidecar ? new SidecarOwner(paths.data) : null;
if (ownership && !await ownership.claim()) process.exit(0);

const COMPAT_DIR = join(HERE, '..', '..', 'compat');
const CONFIG_FILE = join(homedir(), '.gemini', 'config', 'config.json');
const readCompat = (name, cache) => {
  if (cache?.has(name)) return cache.get(name);
  const text = readFileSync(join(COMPAT_DIR, name), 'utf8');
  cache?.set(name, text);
  return text;
};
const extractExport = s => s.slice(s.indexOf('module.exports = ') + 17).trim().replace(/;$/, '');
const buildExtras = cache =>
  `window.__agPulseUpdateFactory=(${extractExport(readCompat('update-ui.cjs', cache))});` +
  `window.__agPulseUsageFactory=(${extractExport(readCompat('usage-ui.cjs', cache))});`;

const GUID = /^(?:[a-zA-Z0-9_.-]+\/)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const compatCache = new Map();
const createTheme = createRequire(import.meta.url)('../../compat/theme.cjs');
const themeCss = () => createTheme().css(':root');
const preferences = new PreferencesStore();
const initialPrefs = await preferences.snapshot().catch(() => null);
const initialTimeline = initialPrefs?.modelTimelineEnabled === true;
const store = new MetricsStore(undefined, {
  dataDir: paths.data,
  modelTimelineEnabled: initialTimeline,
  owns: () => !ownership || ownership.running,
});
let vStore = null;
const syncTimelinePreference = enabled => {
  const next = enabled === true;
  store.setModelTimelineEnabled(next);
  vStore?.setModelTimelineEnabled?.(next);
};
const livePreferences = {
  get: () => preferences.get(),
  snapshot: () => preferences.snapshot(),
  set: async input => {
    const saved = await preferences.set(input);
    syncTimelinePreference(saved.modelTimelineEnabled === true);
    return saved;
  },
};
let settingsCache = { value: null, at: 0 };
const runtimeSettings = () => {
  const now = Date.now();
  if (settingsCache.value && now - settingsCache.at < 1000) return settingsCache.value;
  let settings = {};
  try { settings = JSON.parse(readFileSync(paths.settings, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  try { if (JSON.parse(readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '')).plugins?.['antigravity-pulse']?.enabled === false) settings.enabled = false; } catch {}
  settingsCache = { value: settings, at: now };
  return settings;
};
const isEnabled = () => { const s = runtimeSettings(); return s.enabled !== false && s.inline !== false && s.mode !== 'legacy'; };
const usage = new DesktopUsage(store, undefined, { host: 'app', owns: () => (!ownership || ownership.running) && runtimeSettings().enabled !== false });
store.onTrajectory = (scope, id, raw) => usage.ingest(scope, id, raw);
store.onAccount = (scope, meta) => usage.ledger.registerAccount(scope, meta);
const updater = new AppUpdater({ pluginDir: join(HERE, '..', '..'), dataDir: paths.data });

const createMetrics = (targetStore, targetUsage, getHealth) => async input => {
  const [prefs, theme] = await Promise.all([
    livePreferences.snapshot(),
    readHostTheme(),
  ]);
  targetStore.setModelTimelineEnabled?.(prefs?.modelTimelineEnabled === true);
  const base = await targetStore.snapshot(input);
  if (input?.force) void targetUsage.sync(true);
  return { ...base, usage: await targetUsage.snapshot(), preferences: prefs, theme, integration: getHealth() };
};

const staticFiles = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/format.mjs': ['format.mjs', 'text/javascript'] };
const inlineSource = (cache = isSidecar ? compatCache : null) => {
  const file = readCompat('inline-widget.cjs', cache);
  const i18n = readCompat('i18n.cjs', cache);
  const theme = readCompat('theme.cjs', cache);
  return buildExtras(cache) + `window.__agPulseI18nFactory=(${extractExport(i18n)});window.__agPulseThemeFactory=(${extractExport(theme)});(${extractExport(file)})();`;
};
const i18nModule = (cache = isSidecar ? compatCache : null) => 'export const createI18n=' + readCompat('i18n.cjs', cache).slice(readCompat('i18n.cjs', cache).indexOf('module.exports = ') + 17);
const themeModule = (cache = isSidecar ? compatCache : null) => 'export const createTheme=' + readCompat('theme.cjs', cache).slice(readCompat('theme.cjs', cache).indexOf('module.exports = ') + 17);

const sharedI18n = readCompat('i18n.cjs', compatCache);
const sharedInline = readCompat('inline-widget.cjs', compatCache);
const sharedTheme = readCompat('theme.cjs', compatCache);
const sharedExtras = buildExtras(compatCache);

const metrics = createMetrics(store, usage, () => integration.health);
const integration = new RuntimeUi({
  snapshot: input => metrics(input),
  preferences: livePreferences,
  updater,
  owner: ownership?.token, owns: () => ownership ? (ownership.running && ownership.isOwner()) : true,
  source: makeRendererSource(sharedI18n, sharedInline, sharedTheme, ownership?.token, ownership?.startedAt, sharedExtras),
  dataDir: paths.data,
  enabled: isEnabled,
  addManualUsage: input => usage.addManualUsage(input?.scope, input?.data || input),
  deleteManualUsage: input => usage.deleteManualUsage(input?.scope, input?.id || input),
  getAccounts: () => usage.getAccounts(),
  switchAccount: input => usage.switchAccount(input),
  clearTimeline: input => store.clearTimeline(input?.conversationId || null),
});

const vertexRoot = join(homedir(), '.antigravity-vertex');
const vertexHome = join(vertexRoot, 'home');
const vertexProfile = join(vertexRoot, 'user-data');
let vertexIntegration = null, vertexUsage = null;
if (existsSync(vertexProfile) && homedir().toLowerCase() !== vertexHome.toLowerCase()) {
  const vDataDir = join(vertexHome, '.gemini', 'antigravity', 'sidecar_data', 'antigravity-pulse', 'panel', 'data');
  const vPathsValue = platformPaths({ home: vertexHome, env: { ...process.env, USERPROFILE: vertexHome, HOME: vertexHome, AG_PULSE_PROFILE: vertexProfile, ANTIGRAVITY_EXECUTABLE_DATA_DIR: vDataDir } });
  const vPaths = () => vPathsValue;
  const vClient = new AntigravityClient({ paths: vPaths });
  vStore = new MetricsStore(vClient, {
    dataDir: vDataDir,
    modelTimelineEnabled: initialTimeline,
    owns: () => !ownership || ownership.running,
    history: new SessionHistory(join(vDataDir, 'history-v1')),
    transcripts: new TranscriptReader({ root: join(vertexHome, '.gemini', 'antigravity', 'brain') }),
  });
  vertexUsage = new DesktopUsage(vStore, new UsageLedger(join(vDataDir, 'usage-v1')), {
    host: 'app',
    discoverLocal: () => discoverLocalConversations({ host: 'app', home: vertexHome }),
    owns: () => (!ownership || ownership.running) && runtimeSettings().enabled !== false,
  });
  vStore.onTrajectory = (scope, id, raw) => vertexUsage.ingest(scope, id, raw);
  vStore.onAccount = (scope, meta) => vertexUsage.ledger.registerAccount(scope, meta);
  const vToken = ownership?.token ? ownership.token + '-vertex' : null;
  const vMetrics = createMetrics(vStore, vertexUsage, () => vertexIntegration.health);
  vertexIntegration = new RuntimeUi({
    profile: vertexProfile,
    snapshot: input => vMetrics(input),
    preferences: livePreferences,
    updater,
    owner: vToken, owns: () => ownership ? (ownership.running && ownership.isOwner()) : true,
    source: makeRendererSource(sharedI18n, sharedInline, sharedTheme, vToken, ownership?.startedAt, sharedExtras),
    dataDir: vDataDir,
    enabled: isEnabled,
    addManualUsage: input => vertexUsage.addManualUsage(input?.scope, input?.data || input),
    deleteManualUsage: input => vertexUsage.deleteManualUsage(input?.scope, input?.id || input),
    getAccounts: () => vertexUsage.getAccounts(),
    switchAccount: input => vertexUsage.switchAccount(input),
    clearTimeline: input => vStore.clearTimeline(input?.conversationId || null),
  });
}

if (isSidecar) {
  const { SidecarApp, Response } = await loadSidecarSdk();
  const app = new SidecarApp();
  const cachedPage = panelPageSource();
  const cachedApp = panelAppSource();
  const cachedI18n = i18nModule(compatCache);
  const cachedTheme = themeModule(compatCache);
  const cachedCss = themeCss();
  for (const [path, [file, type]] of Object.entries(staticFiles)) {
    const content = path === '/' ? cachedPage : readFileSync(join(HERE, file), 'utf8');
    app.api(path, () => new Response(content, { contentType: type, headers: { 'Cache-Control': 'no-store' } }), 'GET');
  }
  app.page('/app.js', () => new Response(cachedApp, { contentType: 'application/javascript', headers: { 'Cache-Control': 'no-store' } }));
  app.page('/i18n.js', () => cachedI18n);
  app.page('/theme.js', () => cachedTheme);
  app.api('/theme.css', () => new Response(cachedCss, { contentType: 'text/css' }), 'GET');
  app.api('/api/metrics', data => metrics({ conversationId: data.conversationId || null, force: data.force === true || data.force === '1' }), 'GET');
  app.api('/api/integration', () => integration.health, 'GET');
  app.api('/api/preferences',()=>livePreferences.snapshot(),'GET');
  app.api('/api/preferences',async data=>{try{return await livePreferences.set(data);}catch(error){return new Response(JSON.stringify({error:error?.message==='Invalid timeline preference'?error.message:'Language preference could not be saved'}),{status:400,contentType:'application/json'});}},'POST');
  app.api('/api/timeline/clear',async data=>{
    try {
      if (data != null && (typeof data !== 'object' || Array.isArray(data))) throw new Error('Invalid clear timeline request');
      if (data?.conversationId != null && !GUID.test(data.conversationId)) throw new Error('Invalid conversation ID');
      return await store.clearTimeline(data?.conversationId || null);
    } catch (error) {
      return new Response(JSON.stringify({error:error?.message||'Timeline cache could not be cleared'}),{status:400,contentType:'application/json'});
    }
  },'POST');
  app.run();
  integration.start();
  vertexIntegration?.start();
  const shutdown=async()=>{
    usage.dispose();
    vertexUsage?.dispose();
    const exitTimer=setTimeout(()=>process.exit(0),2000);exitTimer.unref();
    await integration.stop();await vertexIntegration?.stop();ownership.stop();process.exit(0);
  };
  ownership.watch(shutdown);
  updater.onReload=()=>void shutdown();
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => {
    void shutdown();
  });
} else {
  // A dependency-free local preview uses the same collector and frontend.
  const port = Number(process.env.AG_PULSE_PORT || 17891);
  const server = createServer(async (req, res) => {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname === '/api/preferences') {
      const sameOrigin=req.headers.origin===`http://${host}`;
      if(req.headers.origin&&!sameOrigin){res.writeHead(403);res.end();return;}
      res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');
      if(req.method==='GET'){res.end(JSON.stringify(await livePreferences.snapshot()));return;}
      if(req.method==='POST'&&sameOrigin&&String(req.headers['content-type']).startsWith('application/json')){
        let body='';
        try {for await(const chunk of req){body+=chunk;if(body.length>1024)throw new Error('Preference payload too large');}
          res.end(JSON.stringify(await livePreferences.set(JSON.parse(body))));
        }catch(error){res.writeHead(400);res.end(JSON.stringify({error:error?.message==='Invalid timeline preference'?error.message:'Language preference could not be saved'}));}
        return;
      }
      res.writeHead(405);res.end();return;
    }
    if (url.pathname === '/api/timeline/clear') {
      const sameOrigin = req.headers.origin === `http://${host}`;
      if (req.headers.origin && !sameOrigin) { res.writeHead(403); res.end(); return; }
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.method === 'POST' && sameOrigin) {
        let body = '';
        try {
          for await (const chunk of req) { body += chunk; if (body.length > 1024) throw new Error('Payload too large'); }
          let parsed = {};
          if (body.trim()) {
            if (!String(req.headers['content-type']).startsWith('application/json')) throw new Error('Invalid content type');
            parsed = JSON.parse(body);
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid clear timeline request');
          if (parsed.conversationId != null && !GUID.test(parsed.conversationId)) throw new Error('Invalid conversation ID');
          res.end(JSON.stringify(await store.clearTimeline(parsed.conversationId || null)));
        } catch (error) {
          res.writeHead(400); res.end(JSON.stringify({ error: error?.message || 'Timeline cache could not be cleared' }));
        }
        return;
      }
      res.writeHead(405); res.end(); return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (url.pathname === '/api/metrics') {
      if (req.headers.origin && req.headers.origin !== `http://${host}`) { res.writeHead(403); res.end(); return; }
      try { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(await metrics({ conversationId: url.searchParams.get('conversationId'), force: url.searchParams.get('force') === '1' }))); }
      catch { res.writeHead(500); res.end('{"error":"数据暂时不可用"}'); }
      return;
    }
    if (url.pathname === '/api/integration') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(integration.health)); return; }
    if (url.pathname === '/preload.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('// Standalone preview: no host bridge.'); return; }
    if(url.pathname==='/i18n.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(i18nModule());return;}
    if(url.pathname==='/theme.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(themeModule());return;}
    if(url.pathname==='/theme.css'){res.writeHead(200,{'Content-Type':'text/css; charset=utf-8'});res.end(themeCss());return;}
    if(url.pathname==='/inline-widget.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(inlineSource());return;}
    if(url.pathname==='/app.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(panelAppSource());return;}
    if(url.pathname.startsWith('/toolbar-preview')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(readFileSync(join(HERE,'toolbar-preview.html')));return;}
    const file = staticFiles[url.pathname];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); res.end(url.pathname==='/'?panelPageSource():readFileSync(join(HERE, file[0])));
  });
  server.listen(port, '127.0.0.1', () => console.log(`Antigrative Dashboard: http://127.0.0.1:${port}`));
}
