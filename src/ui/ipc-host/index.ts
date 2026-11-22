// Serialized into Antigravity's main process. Only the app's own local renderer
// can obtain sanitized Antigrative Dashboard metrics; no API credentials enter the renderer.
import type * as fsModule from 'node:fs';
import type * as fsPromisesModule from 'node:fs/promises';
import type * as httpModule from 'node:http';
import type * as osModule from 'node:os';
import type * as pathModule from 'node:path';
import type * as urlModule from 'node:url';
import type {
  DiagnosticReportInput,
  DiagnosticStage,
  MetricsRequestInput,
} from '../../contracts/ipc.ts';
import type { MetricsSnapshot } from '../../contracts/metrics.ts';
import type {
  PreferencesSnapshot,
  PreferencesUpdateInput,
} from '../../contracts/preferences.ts';
import {
  PREFERENCE_KEYS,
  validateFontScaleInput,
  validateMonitorPrefsInput,
  validatePricingOverridesInput,
} from '../../contracts/preferences.ts';
import { appendBoundedLogLine } from '../../shared/logger.ts';
import { createHostStatusHelpers, type FsWithPromises } from './helpers.ts';
import type {
  AuthoritiesMap,
  ElectronIpcMainEvent,
  ElectronMainApi,
  PreferenceStoreLike,
} from './types.ts';
import { registerUsageIpcHandlers } from './usage-handlers.ts';

declare const __dirname: string | undefined;
declare function require(id: string): unknown;

export type {
  AuthoritiesMap,
  ElectronIpcMain,
  ElectronIpcMainEvent,
  ElectronMainApi,
  ElectronSender,
  ElectronSenderFrame,
} from './types.ts';

const ALLOWED_PREFERENCE_KEYS = new Set<string>(PREFERENCE_KEYS);
const DIAGNOSTIC_STAGES = new Set<DiagnosticStage>(['boot', 'mounted', 'mount-error']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const GUID_RE =
  /^(?:[a-zA-Z0-9_.-]+\/)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function installAgPulseIpc(
  electron: ElectronMainApi,
  authorities: AuthoritiesMap,
): void {
  const http = require('node:http') as typeof httpModule;
  const fs = require('node:fs') as FsWithPromises;
  const path = require('node:path') as typeof pathModule;
  const os = require('node:os') as typeof osModule;
  const { pathToFileURL } = require('node:url') as typeof urlModule;

  const local =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');

  const offline = (message: string): MetricsSnapshot => ({
    connection: 'offline',
    error: message,
    groups: [],
    speed: null,
    serverTime: new Date().toISOString(),
  });

  const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  const settingsFile = path.join(local, 'AntigravityPulse', 'settings.json');
  const configFile = path.join(os.homedir(), '.gemini', 'config', 'config.json');
  const diagLogDir = path.join(
    os.homedir(),
    '.gemini',
    'antigravity',
    'sidecar_data',
    'antigravity-pulse',
    'panel',
    'logs',
  );
  const sidecarLogFile = path.join(diagLogDir, 'sidecar.log');
  const diagLogFile = path.join(diagLogDir, 'widget.log');

  const { isDisabled, getFallbackEndpoint, resetFallbackEndpoint } = createHostStatusHelpers(
    fs,
    settingsFile,
    configFile,
    sidecarLogFile,
  );

  const validateOrigin = (event: ElectronIpcMainEvent): URL => {
    const origin = new URL(event.senderFrame?.url || event.sender.getURL());
    if (
      !LOOPBACK_HOSTS.has(origin.hostname) ||
      !['http:', 'https:'].includes(origin.protocol)
    ) {
      throw new Error('Invalid origin');
    }
    return origin;
  };

  let preferenceStore: Promise<PreferenceStoreLike> | null = null;
  electron.ipcMain.handle(
    'ag-pulse:preferences',
    async (event, rawInput: unknown = {}): Promise<PreferencesSnapshot> => {
      try {
        validateOrigin(event);
        const input = (rawInput ?? {}) as Record<string, unknown>;
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).some((key) => !ALLOWED_PREFERENCE_KEYS.has(key))
        ) {
          throw new Error('Invalid preference input');
        }
        if (
          Object.hasOwn(input, 'modelTimelineEnabled') &&
          typeof input.modelTimelineEnabled !== 'boolean'
        ) {
          throw new Error('Invalid timeline preference');
        }
        validateFontScaleInput(input);
        validatePricingOverridesInput(input);
        validateMonitorPrefsInput(input);
        if (!preferenceStore) {
          const file = path.join(
            os.homedir(),
            '.gemini',
            'config',
            'plugins',
            'antigravity-pulse',
            'compat',
            'preferences.mjs',
          );
          preferenceStore = import(pathToFileURL(file).href).then((mod: unknown) => {
            const { PreferencesStore } = mod as { PreferencesStore: new () => PreferenceStoreLike };
            return new PreferencesStore();
          });
        }
        const store = await preferenceStore;
        return Object.keys(input).length
          ? await store.set(input as PreferencesUpdateInput)
          : await store.get();
      } catch {
        preferenceStore = null;
        return { error: 'Language preference could not be saved or read' };
      }
    },
  );

  electron.ipcMain.on('ag-pulse:diagnostic', (event, rawState: unknown = {}) => {
    try {
      const origin = new URL(event.senderFrame?.url || event.sender.getURL());
      if (!LOOPBACK_HOSTS.has(origin.hostname)) return;
      const state = (rawState ?? {}) as Partial<DiagnosticReportInput>;
      if (!state.stage || !DIAGNOSTIC_STAGES.has(state.stage)) return;
      const safe: DiagnosticReportInput = {
        stage: state.stage,
        hostFound: state.hostFound === true,
        editorFound: state.editorFound === true,
        composerFound: state.composerFound === true,
      };
      const line = `${new Date().toISOString()} ${JSON.stringify(safe)}\n`;
      void appendBoundedLogLine(diagLogFile, line, {
        maxBytes: 2 * 1024 * 1024,
        keepLines: 2000,
        allowNative: false,
      }).catch(() => {
        // Diagnostic logging failures must not interfere with renderer IPC.
      });
    } catch {
      // Diagnostic logging failures must not interfere with renderer IPC.
    }
  });

  electron.ipcMain.handle(
    'ag-pulse:metrics',
    async (event, rawInput: unknown = {}): Promise<MetricsSnapshot> => {
      let origin: URL;
      try {
        origin = new URL(event.senderFrame?.url || event.sender.getURL());
      } catch {
        return offline('来源不可用');
      }
      if (
        !LOOPBACK_HOSTS.has(origin.hostname) ||
        !['http:', 'https:'].includes(origin.protocol)
      ) {
        return offline('仅允许 Antigravity 本地界面');
      }
      if (await isDisabled()) {
        return { ...offline('Antigrative Dashboard 已停用'), enabled: false };
      }
      const input = (rawInput ?? {}) as MetricsRequestInput;
      if (input.conversationId && !GUID_RE.test(input.conversationId)) {
        return offline('会话标识无效');
      }
      let endpoint = [...authorities].find(([key]) =>
        key.startsWith('antigravity-pulse--panel-'),
      )?.[1];
      let usedFallback = false;
      if (!endpoint) {
        // The native UI feature may be hidden, but the installed plugin process
        // still runs. Its own SDK log announces the loopback port.
        endpoint = (await getFallbackEndpoint()) ?? undefined;
        usedFallback = Boolean(endpoint);
      }
      if (!endpoint) return offline('等待 Antigrative Dashboard 后台启动');
      const url = new URL(endpoint);
      if (!LOOPBACK_HOSTS.has(url.hostname) || url.protocol !== 'http:') {
        return offline('控件接口地址无效');
      }
      url.hostname = '127.0.0.1';
      url.pathname = '/api/metrics';
      url.search = '';
      if (input.conversationId) url.searchParams.set('conversationId', input.conversationId);
      if (input.force === true) url.searchParams.set('force', '1');
      return new Promise<MetricsSnapshot>((resolve) => {
        let settled = false;
        const finish = (value: MetricsSnapshot, failed = false): void => {
          if (settled) return;
          settled = true;
          if (failed && usedFallback) resetFallbackEndpoint();
          resolve(value);
        };
        const req = http.get(
          {
            hostname: '127.0.0.1',
            port: url.port || 80,
            path: url.pathname + url.search,
            agent: keepAliveAgent,
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              body += chunk;
              if (body.length > 1048576) req.destroy(new Error('Metrics too large'));
            });
            res.on('error', () => finish(offline('控件暂时不可用'), true));
            res.on('end', () => {
              try {
                if (res.statusCode !== 200) throw new Error();
                const metrics = JSON.parse(body) as MetricsSnapshot;
                if (!['live', 'stale', 'offline'].includes(metrics.connection)) throw new Error();
                finish(metrics);
              } catch {
                finish(offline('控件暂时不可用'), true);
              }
            });
          },
        );
        req.on('error', () => finish(offline('等待 Antigrative Dashboard 重新连接'), true));
        req.setTimeout(15000, () => req.destroy(new Error('Metrics timeout')));
      });
    },
  );

  registerUsageIpcHandlers({
    electron,
    fs,
    os,
    path,
    pathToFileURL,
    baseDir: typeof __dirname === 'string' ? __dirname : '',
    validateOrigin,
  });
}
