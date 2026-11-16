import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MetricsRequestInput, MetricsSnapshot, PreferencesUpdateInput } from '../contracts/index.ts';
import { PreferencesStore } from '../platform/preferences-store.ts';
import { SidecarOwner } from '../platform/sidecar-owner.ts';
import { DesktopUsage as LocalUsage, UsageLedger } from '../telemetry/ledger/index.ts';
import { TranscriptReader, transcriptBrainRoot } from '../telemetry/reader/transcript.ts';
import { SessionHistory } from '../telemetry/store/history.ts';
import { MetricsStore } from '../telemetry/store/index.ts';
import {
  RuntimeUi,
  bindWindowFactory,
  invokeCjsFactory,
  makeRendererSource,
  type RuntimePreferencesBridge,
} from '../ui/runtime-ui/index.ts';
import { IdeClient } from './client.ts';
import { ideTargets } from './runtime.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = process.env.AG_PULSE_IDE_PROFILE;
if (!profile) throw new Error('IDE profile is required');

const data =
  process.env.AG_PULSE_IDE_DATA ||
  join(profile, 'User', 'globalStorage', 'shzbz.antigrative-dashboard-ide');

let debugPort = 0;
const client = new IdeClient({ profile, debugPort: () => debugPort });
const ownership = new SidecarOwner(data);
if (!(await ownership.claim())) process.exit(0);

const store = new MetricsStore(client, {
  dataDir: data,
  owns: () => ownership.running,
  history: new SessionHistory(join(data, 'history-v1')),
  transcripts: new TranscriptReader({ root: transcriptBrainRoot('ide') }),
});
const usage = new LocalUsage(store, new UsageLedger(join(data, 'usage-v1'), { source: 'ide-local' }), {
  host: 'ide',
  owns: () => ownership.running,
});
store.onTrajectory = (scope, id, raw) => usage.ingest(scope, id, raw);

const preferences = new PreferencesStore({ file: join(data, 'preferences.json') });
const livePreferences: RuntimePreferencesBridge = {
  get: () => preferences.get(),
  snapshot: () => preferences.snapshot(),
  set: async (input: PreferencesUpdateInput) => {
    const saved = await preferences.set(input);
    store.setModelTimelineEnabled(saved.modelTimelineEnabled === true);
    return saved;
  },
};

const files = await Promise.all(
  ['compat/i18n.cjs', 'compat/inline-widget.cjs', 'compat/theme.cjs', 'ide/surface.cjs', 'compat/usage-ui.cjs'].map(
    (file) => readFile(join(root, file), 'utf8'),
  ),
);
const initialPrefs = await livePreferences.snapshot?.().catch(() => null);
store.setModelTimelineEnabled(
  Boolean(initialPrefs && 'modelTimelineEnabled' in initialPrefs && initialPrefs.modelTimelineEnabled === true),
);

const usageSource = bindWindowFactory('__agPulseUsageFactory', files[4], 'usage-ui');
const owner = ownership.token;
const source = makeRendererSource(files[0], files[1], files[2], owner, ownership.startedAt, usageSource);
const adapter = `window.__agPulseSurface=${invokeCjsFactory(files[3], 'surface')}`;

// Each workbench has its own bridge request ID and DOM conversation ID. Empty
// composers request account quota only; no most-recent-conversation fallback.
const snapshot = async (input: MetricsRequestInput = {}): Promise<MetricsSnapshot> => {
  const prefs = await livePreferences.snapshot!();
  store.setModelTimelineEnabled(
    Boolean(prefs && 'modelTimelineEnabled' in prefs && prefs.modelTimelineEnabled === true),
  );
  let value: MetricsSnapshot;
  if (input.conversationId) {
    value = await store.snapshot(input);
  } else {
    try {
      const server = await client.discover();
      if (server.pid !== store.serverPid) {
        store.epoch++;
        store.transcripts?.reset();
        store.identity = null;
        store.quota = null;
        store.quotaAt = 0;
        store.sessions.clear();
        store.serverPid = server.pid;
      }
      await store.refreshQuota(input.force);
      value = {
        connection: 'live',
        error: null,
        serverTime: new Date().toISOString(),
        speed: null,
        groups: store.quota || [],
        quotaUpdatedAt: new Date(store.quotaAt).toISOString(),
      };
    } catch {
      value = {
        connection: 'offline',
        error: 'IDE local API unavailable',
        serverTime: new Date().toISOString(),
        speed: null,
        groups: [],
      };
    }
  }
  if (input.force) void usage.sync(true);
  return { ...value, usage: await usage.snapshot(), enabled: true, preferences: prefs };
};

const ui = new RuntimeUi({
  profile,
  source: adapter + source,
  owner,
  owns: () => ownership.running && ownership.isOwner(),
  preferences: livePreferences,
  snapshot,
  dataDir: data,
  clearTimeline: (input) => store.clearTimeline(input?.conversationId || null),
  targetOrigin: () => 'vscode-file://vscode-app',
  discover: async () => {
    const result = await ideTargets(profile);
    debugPort = result.port;
    await client.discover();
    return result.targets;
  },
});

await mkdir(data, { recursive: true });
await writeFile(
  join(data, 'runtime.json'),
  JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), mode: 'ide' }),
);
ui.start();

const keepAlive = setInterval(() => {}, 60000);
async function stop(): Promise<void> {
  usage.dispose();
  clearInterval(keepAlive);
  await ui.stop();
  ownership.stop();
  process.exit(0);
}

ownership.watch(stop);
process.on('message', (message: unknown) => {
  if ((message as { type?: unknown } | null)?.type === 'stop') void stop();
});
if ((process as NodeJS.Process & { connected?: boolean }).connected) {
  process.once('disconnect', () => {
    void stop();
  });
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void stop();
  });
}
