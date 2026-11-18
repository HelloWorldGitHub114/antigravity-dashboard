import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHostTheme } from '../ui/theme/host-theme.ts';
import {
  RuntimeUi,
  bindWindowFactory,
  invokeCjsFactory,
  makeEsmExportFromCjs,
  makeRendererSource,
  type RuntimePreferencesBridge,
} from '../ui/runtime-ui/index.ts';
import type {
  DeleteManualUsageRequest,
  IntegrationHealth,
  ManualUsageInput,
  MetricsRequestInput,
  MetricsSnapshot,
  PreferencesUpdateInput,
  SwitchAccountRequest,
} from '../contracts/index.ts';
import {
  applyDebugLaunch,
  getDebugLaunchStatus,
  resolveHostAppVersion,
} from '../lifecycle/debug-launch.ts';
import { platformPaths } from '../platform/paths.ts';
import { discoverDevToolsTargets } from '../platform/devtools.ts';
import { PreferencesStore } from '../platform/preferences-store.ts';
import { SidecarOwner } from '../platform/sidecar-owner.ts';
import { AntigravityClient } from './client/index.ts';
import { HostLivenessWatchdog } from './host-watchdog.ts';
import { LazyVertexController } from './lazy-vertex.ts';
import {
  DesktopUsage,
  UsageLedger,
  queryProjectConversationDetail,
  queryProjectUsageOverview,
} from './ledger/index.ts';
import { panelAppSource, panelPageSource } from './panel-source.ts';
import { startPreviewServer } from './preview-server.ts';
import { defaultConversationsDir, discoverLocalConversations } from './reader/local-conversations.ts';
import { TranscriptReader } from './reader/transcript.ts';
import { loadSidecarSdk } from './sdk.ts';
import { SessionHistory } from './store/history.ts';
import { MetricsStore } from './store/index.ts';
import { AppUpdater } from './updater.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const paths = platformPaths();
const isSidecar = Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
const ownership = isSidecar ? new SidecarOwner(paths.data) : null;
if (ownership && !(await ownership.claim())) process.exit(0);

const COMPAT_DIR = join(HERE, '..', '..', 'compat');
const CONFIG_FILE = join(homedir(), '.gemini', 'config', 'config.json');
const readCompat = (name: string, cache: Map<string, string> | null): string => {
  if (cache?.has(name)) return cache.get(name)!;
  const text = readFileSync(join(COMPAT_DIR, name), 'utf8');
  cache?.set(name, text);
  return text;
};
const buildExtras = (cache: Map<string, string> | null): string =>
  bindWindowFactory('__agPulseUpdateFactory', readCompat('update-ui.cjs', cache), 'update-ui') +
  bindWindowFactory('__agPulseUsageFactory', readCompat('usage-ui.cjs', cache), 'usage-ui');

const GUID = /^(?:[a-zA-Z0-9_.-]+\/)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const compatCache = new Map<string, string>();
const createTheme = createRequire(import.meta.url)('../../compat/theme.cjs') as () => { css(selector: string): string };
const themeCss = (): string => createTheme().css(':root');
const preferences = new PreferencesStore();
const initialPrefs = await preferences.snapshot().catch(() => null);
const initialTimeline = Boolean(initialPrefs && 'modelTimelineEnabled' in initialPrefs && initialPrefs.modelTimelineEnabled === true);
const store = new MetricsStore(undefined, {
  dataDir: paths.data,
  modelTimelineEnabled: initialTimeline,
  owns: () => !ownership || ownership.running,
});
let timelineEnabled = initialTimeline;
let vertexController: LazyVertexController<MetricsStore, DesktopUsage, RuntimeUi> | null = null;
const syncTimelinePreference = (enabled: boolean): void => {
  const next = enabled === true;
  timelineEnabled = next;
  store.setModelTimelineEnabled(next);
  vertexController?.getStore()?.setModelTimelineEnabled(next);
};
const livePreferences: Required<RuntimePreferencesBridge> = {
  get: () => preferences.get(),
  snapshot: () => preferences.snapshot(),
  set: async (input: PreferencesUpdateInput) => {
    const saved = await preferences.set(input);
    syncTimelinePreference(saved.modelTimelineEnabled === true);
    return saved;
  },
};
let settingsCache: { value: Record<string, unknown> | null; at: number } = { value: null, at: 0 };
const runtimeSettings = (): Record<string, unknown> => {
  const now = Date.now();
  if (settingsCache.value && now - settingsCache.at < 1000) return settingsCache.value;
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(readFileSync(paths.settings, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>; } catch {}
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '')) as {
      plugins?: Record<string, { enabled?: boolean }>;
    };
    if (cfg.plugins?.['antigravity-pulse']?.enabled === false) settings.enabled = false;
  } catch {}
  settingsCache = { value: settings, at: now };
  return settings;
};
const isEnabled = (): boolean => {
  const s = runtimeSettings();
  return s.enabled !== false && s.inline !== false && s.mode !== 'legacy';
};
const usage = new DesktopUsage(store, undefined, {
  host: 'app',
  owns: () => (!ownership || ownership.running) && runtimeSettings().enabled !== false,
});
store.onTrajectory = (scope, id, raw) => usage.ingest(scope, id, raw);
store.onAccount = (scope, meta) => usage.ledger.registerAccount(scope, meta);
const updater = new AppUpdater({ pluginDir: join(HERE, '..', '..'), dataDir: paths.data });

const hostVersion = resolveHostAppVersion(paths.appAsar);
const createMetrics = (
  targetStore: MetricsStore,
  targetUsage: DesktopUsage,
  getHealth: () => IntegrationHealth,
  targetProfile: string,
) => async (input?: MetricsRequestInput): Promise<MetricsSnapshot> => {
  const [prefs, theme] = await Promise.all([livePreferences.snapshot(), readHostTheme()]);
  targetStore.setModelTimelineEnabled(Boolean(prefs && 'modelTimelineEnabled' in prefs && prefs.modelTimelineEnabled === true));
  const base = await targetStore.snapshot(input);
  if (input?.force) void targetUsage.sync(true);
  const debugStatus = getDebugLaunchStatus();
  const integration: IntegrationHealth = {
    ...getHealth(),
    hostVersion,
    activePortPresent: existsSync(join(targetProfile, 'DevToolsActivePort')),
    debugLaunchEnabled:
      prefs && !('error' in prefs) ? prefs.debugLaunchEnabled === true : debugStatus.enabled,
    debugLaunchConfigured: debugStatus.configured,
  };
  return { ...base, usage: await targetUsage.snapshot(), preferences: prefs, theme, integration };
};

const staticFiles: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html'],
  '/styles.css': ['styles.css', 'text/css'],
  '/format.mjs': ['format.mjs', 'text/javascript'],
  '/logo.svg': ['../../assets/logo.svg', 'image/svg+xml'],
};
const inlineSource = (cache: Map<string, string> | null = isSidecar ? compatCache : null): string => {
  const file = readCompat('inline-widget.cjs', cache);
  const i18n = readCompat('i18n.cjs', cache);
  const theme = readCompat('theme.cjs', cache);
  return (
    buildExtras(cache) +
    bindWindowFactory('__agPulseI18nFactory', i18n, 'i18n') +
    bindWindowFactory('__agPulseThemeFactory', theme, 'theme') +
    invokeCjsFactory(file, 'inline-widget')
  );
};
const i18nModule = (cache: Map<string, string> | null = isSidecar ? compatCache : null): string =>
  makeEsmExportFromCjs('createI18n', readCompat('i18n.cjs', cache), 'i18n');
const themeModule = (cache: Map<string, string> | null = isSidecar ? compatCache : null): string =>
  makeEsmExportFromCjs('createTheme', readCompat('theme.cjs', cache), 'theme');

const sharedI18n = readCompat('i18n.cjs', compatCache);
const sharedInline = readCompat('inline-widget.cjs', compatCache);
const sharedTheme = readCompat('theme.cjs', compatCache);
const sharedExtras = buildExtras(compatCache);

const metrics = createMetrics(store, usage, () => integration.health, paths.profile);
const proUsageBridge = {
  addManualUsage: (input?: { scope?: string; data?: ManualUsageInput } & Partial<ManualUsageInput>) =>
    usage.addManualUsage(input?.scope || '', (input?.data || input || {}) as ManualUsageInput),
  deleteManualUsage: (input?: DeleteManualUsageRequest) =>
    usage.deleteManualUsage(
      typeof input === 'object' && input !== null ? input.scope || '' : '',
      typeof input === 'string' ? input : input?.id || '',
    ),
  getAccounts: () => usage.getAccounts(),
  switchAccount: (input?: SwitchAccountRequest) => usage.switchAccount(input || { account: '' }),
  getProjectUsage: (input?: { scope?: string | null; from?: string; to?: string }) =>
    queryProjectUsageOverview({
      ledger: usage.ledger,
      store,
      profileDir: dirname(defaultConversationsDir('app', homedir())),
      scope: input?.scope ?? null,
      from: input?.from,
      to: input?.to,
    }),
  getProjectDetail: (input: { projectKey: string; scope?: string | null; from?: string; to?: string }) =>
    queryProjectConversationDetail({
      ledger: usage.ledger,
      store,
      profileDir: dirname(defaultConversationsDir('app', homedir())),
      projectKey: input.projectKey,
      scope: input?.scope ?? null,
      from: input?.from,
      to: input?.to,
    }),
};
const integration = new RuntimeUi({
  snapshot: (input) => metrics(input),
  preferences: livePreferences,
  updater,
  owner: ownership?.token,
  owns: () => (ownership ? ownership.running && ownership.isOwner() : true),
  source: makeRendererSource(sharedI18n, sharedInline, sharedTheme, ownership?.token, ownership?.startedAt, sharedExtras),
  dataDir: paths.data,
  enabled: isEnabled,
  addManualUsage: proUsageBridge.addManualUsage,
  deleteManualUsage: proUsageBridge.deleteManualUsage,
  getAccounts: proUsageBridge.getAccounts,
  switchAccount: proUsageBridge.switchAccount,
  getProjectUsage: proUsageBridge.getProjectUsage,
  getProjectDetail: proUsageBridge.getProjectDetail,
  clearTimeline: (input) => store.clearTimeline(input?.conversationId || null),
});

const vertexRoot = join(homedir(), '.antigravity-vertex');
const vertexHome = join(vertexRoot, 'home');
const vertexProfile = join(vertexRoot, 'user-data');
const canActivateVertex = (): boolean =>
  existsSync(vertexProfile) && homedir().toLowerCase() !== vertexHome.toLowerCase();

const createVertexInstance = () => {
  const vDataDir = join(vertexHome, '.gemini', 'antigravity', 'sidecar_data', 'antigravity-pulse', 'panel', 'data');
  const vPathsValue = platformPaths({
    home: vertexHome,
    env: { ...process.env, USERPROFILE: vertexHome, HOME: vertexHome, AG_PULSE_PROFILE: vertexProfile, ANTIGRAVITY_EXECUTABLE_DATA_DIR: vDataDir },
  });
  const vClient = new AntigravityClient({ paths: () => vPathsValue });
  const vStore = new MetricsStore(vClient, {
    dataDir: vDataDir,
    modelTimelineEnabled: timelineEnabled,
    owns: () => !ownership || ownership.running,
    history: new SessionHistory(join(vDataDir, 'history-v1')),
    transcripts: new TranscriptReader({ root: join(vertexHome, '.gemini', 'antigravity', 'brain') }),
  });
  const vertexUsage = new DesktopUsage(vStore, new UsageLedger(join(vDataDir, 'usage-v1')), {
    host: 'app',
    discoverLocal: () => discoverLocalConversations({ host: 'app', home: vertexHome }),
    owns: () => (!ownership || ownership.running) && runtimeSettings().enabled !== false,
  });
  vStore.onTrajectory = (scope, id, raw) => vertexUsage.ingest(scope, id, raw);
  vStore.onAccount = (scope, meta) => vertexUsage.ledger.registerAccount(scope, meta);
  const vToken = ownership?.token ? `${ownership.token}-vertex` : null;
  let vertexIntegration!: RuntimeUi;
  const vMetrics = createMetrics(vStore, vertexUsage, () => vertexIntegration.health, vertexProfile);
  vertexIntegration = new RuntimeUi({
    profile: vertexProfile,
    snapshot: (input) => {
      vertexController?.recordActivity('runtime-ui-snapshot');
      return vMetrics(input);
    },
    preferences: livePreferences,
    updater,
    owner: vToken,
    owns: () => (ownership ? ownership.running && ownership.isOwner() : true),
    source: makeRendererSource(sharedI18n, sharedInline, sharedTheme, vToken, ownership?.startedAt, sharedExtras),
    dataDir: vDataDir,
    enabled: isEnabled,
    addManualUsage: (input) => {
      vertexController?.recordActivity('runtime-ui-usage');
      return vertexUsage.addManualUsage(input?.scope || '', input?.data || input);
    },
    deleteManualUsage: (input) => {
      vertexController?.recordActivity('runtime-ui-usage');
      return vertexUsage.deleteManualUsage(
        typeof input === 'object' && input !== null ? input.scope || '' : '',
        typeof input === 'string' ? input : input?.id || '',
      );
    },
    getAccounts: () => {
      vertexController?.recordActivity('runtime-ui-accounts');
      return vertexUsage.getAccounts();
    },
    switchAccount: (input) => {
      vertexController?.recordActivity('runtime-ui-switch');
      return vertexUsage.switchAccount(input);
    },
    getProjectUsage: (input) => {
      vertexController?.recordActivity('runtime-ui-usage');
      return queryProjectUsageOverview({
        ledger: vertexUsage.ledger,
        store: vStore,
        profileDir: dirname(defaultConversationsDir('app', vertexHome)),
        scope: input?.scope ?? null,
        from: input?.from,
        to: input?.to,
      });
    },
    getProjectDetail: (input) => {
      vertexController?.recordActivity('runtime-ui-usage');
      return queryProjectConversationDetail({
        ledger: vertexUsage.ledger,
        store: vStore,
        profileDir: dirname(defaultConversationsDir('app', vertexHome)),
        projectKey: input.projectKey,
        scope: input?.scope ?? null,
        from: input?.from,
        to: input?.to,
      });
    },
    clearTimeline: (input) => {
      vertexController?.recordActivity('runtime-ui-timeline');
      return vStore.clearTimeline(input?.conversationId || null);
    },
  });
  return { store: vStore, usage: vertexUsage, integration: vertexIntegration };
};

const probeVertexActive = async (): Promise<boolean> => {
  if (!existsSync(join(vertexProfile, 'DevToolsActivePort'))) return false;
  try {
    const { targets } = await discoverDevToolsTargets(vertexProfile, { mode: 'desktop', timeoutMs: 800 });
    return targets.length > 0;
  } catch {
    return false;
  }
};

vertexController = new LazyVertexController({
  createInstance: createVertexInstance,
  canActivate: canActivateVertex,
  probeActive: probeVertexActive,
});

const runVertexMetrics = async (input?: MetricsRequestInput): Promise<MetricsSnapshot | null> => {
  const instance = await vertexController?.ensureStarted('http-metrics');
  if (!instance) return null;
  return createMetrics(instance.store, instance.usage, () => instance.integration.health, vertexProfile)(input);
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const prefError = (error: unknown): string => {
  const msg = errorMessage(error);
  return msg === 'Invalid timeline preference' ||
    msg === 'Invalid font scale preference' ||
    msg === 'Invalid debug launch preference'
    ? msg
    : 'Language preference could not be saved';
};

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
  app.api('/api/metrics', async (data) => {
    const input = { conversationId: typeof data.conversationId === 'string' ? data.conversationId : null, force: data.force === true || data.force === '1' };
    if (data.vertex === true || data.vertex === '1' || data.instance === 'vertex') {
      const snap = await runVertexMetrics(input);
      return snap ?? new Response(JSON.stringify({ error: 'Vertex integration unavailable', state: 'disabled' }), { status: 503, contentType: 'application/json' });
    }
    return metrics(input);
  }, 'GET');
  app.api('/api/vertex/metrics', async (data) => {
    const snap = await runVertexMetrics({ conversationId: typeof data.conversationId === 'string' ? data.conversationId : null, force: data.force === true || data.force === '1' });
    return snap ?? new Response(JSON.stringify({ error: 'Vertex integration unavailable', state: 'disabled' }), { status: 503, contentType: 'application/json' });
  }, 'GET');
  app.api('/api/vertex/integration', async () => {
    const instance = await vertexController?.ensureStarted('http-integration');
    return instance ? instance.integration.health : { state: 'disabled', mode: 'runtime', message: 'Vertex profile unavailable', windows: 0 };
  }, 'GET');
  app.api('/api/integration', () => ({
    ...integration.health,
    hostVersion,
    activePortPresent: existsSync(join(paths.profile, 'DevToolsActivePort')),
    debugLaunchConfigured: getDebugLaunchStatus().configured,
  }), 'GET');
  app.api('/api/debug-launch', () => ({
    ...getDebugLaunchStatus(),
    hostVersion,
    activePortPresent: existsSync(join(paths.profile, 'DevToolsActivePort')),
  }), 'GET');
  app.api('/api/debug-launch', async (data) => {
    try {
      const enabled = (data as { enabled?: unknown } | null)?.enabled;
      if (typeof enabled !== 'boolean') throw new Error('Invalid debug launch preference');
      const outcome = applyDebugLaunch(enabled);
      const saved = await livePreferences.set({ debugLaunchEnabled: enabled });
      return {
        ...outcome,
        hostVersion,
        activePortPresent: existsSync(join(paths.profile, 'DevToolsActivePort')),
        preferences: saved,
      };
    } catch (error) {
      return new Response(JSON.stringify({ error: errorMessage(error) || 'Failed to update debug launch setting' }), {
        status: 400,
        contentType: 'application/json',
      });
    }
  }, 'POST');
  app.api('/api/usage/open', async () => {
    const openedInHost = await integration.openUsageModal();
    return { openedInHost };
  }, 'POST');
  app.api('/api/usage/accounts', () => proUsageBridge.getAccounts(), 'POST');
  app.api('/api/usage/switch-account', (data) => proUsageBridge.switchAccount(data as SwitchAccountRequest), 'POST');
  app.api('/api/usage/manual/add', (data) => proUsageBridge.addManualUsage(data as { scope?: string; data?: ManualUsageInput }), 'POST');
  app.api('/api/usage/manual/delete', (data) => proUsageBridge.deleteManualUsage(data as DeleteManualUsageRequest), 'POST');
  app.api('/api/usage/project-overview', (data) => proUsageBridge.getProjectUsage(data as { scope?: string | null; from?: string; to?: string }), 'POST');
  app.api('/api/usage/project-detail', (data) => proUsageBridge.getProjectDetail(data as { projectKey: string; scope?: string | null; from?: string; to?: string }), 'POST');
  app.api('/api/preferences', () => livePreferences.snapshot(), 'GET');
  app.api('/api/preferences', async (data) => {
    try { return await livePreferences.set(data as PreferencesUpdateInput); }
    catch (error) { return new Response(JSON.stringify({ error: prefError(error) }), { status: 400, contentType: 'application/json' }); }
  }, 'POST');
  app.api('/api/timeline/clear', async (data) => {
    try {
      if (data != null && (typeof data !== 'object' || Array.isArray(data))) throw new Error('Invalid clear timeline request');
      const cid = (data as { conversationId?: unknown } | null)?.conversationId;
      if (cid != null && (typeof cid !== 'string' || !GUID.test(cid))) throw new Error('Invalid conversation ID');
      return await store.clearTimeline(typeof cid === 'string' ? cid : null);
    } catch (error) { return new Response(JSON.stringify({ error: errorMessage(error) || 'Timeline cache could not be cleared' }), { status: 400, contentType: 'application/json' }); }
  }, 'POST');
  app.run();
  integration.start();
  vertexController.start();
  let shuttingDown = false;
  let hostWatchdog: HostLivenessWatchdog | null = null;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    hostWatchdog?.stop();
    usage.dispose();
    const exitTimer = setTimeout(() => process.exit(0), 2000) as unknown as { unref?: () => void };
    exitTimer.unref?.();
    await integration.stop();
    await vertexController?.dispose();
    ownership?.stop();
    process.exit(0);
  };
  hostWatchdog = new HostLivenessWatchdog({
    profiles: [paths.profile, vertexProfile],
    onShutdown: () => shutdown(),
  });
  hostWatchdog.start();
  ownership?.watch(shutdown);
  updater.onReload = () => void shutdown();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void shutdown(); });
} else {
  // A dependency-free local preview uses the same collector and frontend.
  startPreviewServer({
    here: HERE, port: Number(process.env.AG_PULSE_PORT || 17891), guidPattern: GUID, staticFiles,
    livePreferences, store, metrics, getHealth: () => integration.health,
    usageBridge: proUsageBridge,
    i18nModule: () => i18nModule(), themeModule: () => themeModule(), themeCss, inlineSource: () => inlineSource(),
  });
}
