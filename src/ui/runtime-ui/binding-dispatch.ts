import { join } from 'node:path';
import type {
  AddManualUsageRequest,
  ClearTimelineRequest,
  ClearTimelineResult,
  DeleteManualUsageRequest,
  DiagnosticReportInput,
  DiagnosticStage,
  ManualUsageInput,
  MetricsSnapshot,
  PreferencesUpdateInput,
  SwitchAccountRequest,
  UpdatePluginRequest,
} from '../../contracts/index.ts';
import { PREFERENCE_KEYS } from '../../contracts/preferences.ts';
import { platformPaths } from '../../platform/paths.ts';
import { GUID_RE, validatedInput } from './renderer-bridge.ts';
import type { RuntimeSessionConnection, RuntimeUiOptions } from './types.ts';

const ALLOWED_PREFERENCE_KEYS = new Set<string>(PREFERENCE_KEYS);
const DIAGNOSTIC_STAGES = new Set<DiagnosticStage>(['boot', 'mounted', 'mount-error']);
const USAGE_OPERATIONS = new Set([
  'addManualUsage',
  'deleteManualUsage',
  'getAccounts',
  'switchAccount',
  'clearTimeline',
]);

export function offlineSnapshot(message: string): MetricsSnapshot {
  return {
    connection: 'offline',
    error: message,
    speed: null,
    groups: [],
    serverTime: new Date().toISOString(),
  };
}

export interface BindingPayload {
  id: number;
  type: string;
  input?: unknown;
}

export interface RuntimeDispatchHost {
  snapshot?: RuntimeUiOptions['snapshot'];
  dataDir?: string;
  preferences?: RuntimeUiOptions['preferences'];
  updater?: RuntimeUiOptions['updater'];
  enabled: () => boolean | Promise<boolean>;
  addManualUsage?: RuntimeUiOptions['addManualUsage'];
  deleteManualUsage?: RuntimeUiOptions['deleteManualUsage'];
  getAccounts?: RuntimeUiOptions['getAccounts'];
  switchAccount?: RuntimeUiOptions['switchAccount'];
  clearTimeline?: RuntimeUiOptions['clearTimeline'];
}

export async function dispatchBindingCall(
  host: RuntimeDispatchHost,
  connection: RuntimeSessionConnection,
  input: BindingPayload,
): Promise<{ handled: boolean; result?: unknown }> {
  let result: unknown = {};
  if (input.type === 'metrics') {
    if (await host.enabled()) {
      result = host.snapshot ? await host.snapshot(validatedInput(input.input)) : {};
    } else {
      result = { ...offlineSnapshot('Antigrative Dashboard 已停用'), enabled: false };
    }
  } else if (input.type === 'update' && host.updater) {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    result = await host.updater.request(input.input as UpdatePluginRequest);
  } else if (input.type === 'preferences' && host.preferences) {
    const value = input.input as Record<string, unknown> | null | undefined;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !ALLOWED_PREFERENCE_KEYS.has(key))
    ) {
      throw new Error('Invalid preferences request');
    }
    if (
      Object.hasOwn(value, 'modelTimelineEnabled') &&
      typeof value.modelTimelineEnabled !== 'boolean'
    ) {
      throw new Error('Invalid timeline preference');
    }
    result = Object.keys(value).length
      ? await host.preferences.set(value as PreferencesUpdateInput)
      : await host.preferences.get();
  } else if (
    input.type === 'diagnostic' &&
    DIAGNOSTIC_STAGES.has((input.input as Partial<DiagnosticReportInput> | undefined)?.stage as DiagnosticStage)
  ) {
    const diag = input.input as DiagnosticReportInput;
    if (diag.stage === 'mounted' && diag.editorFound && diag.composerFound) {
      connection.mounted = true;
    }
  } else if (input.type === 'addManualUsage') {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    if (typeof host.addManualUsage === 'function') {
      result = await host.addManualUsage(
        input.input as AddManualUsageRequest & { data?: ManualUsageInput },
      );
    } else {
      const { UsageLedger } = await import('../../telemetry/ledger/index.ts');
      const ledger = new UsageLedger(join(host.dataDir || platformPaths().data, 'usage-v1'));
      const raw = (input.input ?? {}) as AddManualUsageRequest;
      const scope = raw.scope || raw.account || raw.accountKey || '';
      const data = raw.data || raw;
      result = await ledger.addManualUsage(scope, data);
    }
  } else if (input.type === 'deleteManualUsage') {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    if (typeof host.deleteManualUsage === 'function') {
      result = await host.deleteManualUsage(input.input as DeleteManualUsageRequest);
    } else {
      const { UsageLedger } = await import('../../telemetry/ledger/index.ts');
      const ledger = new UsageLedger(join(host.dataDir || platformPaths().data, 'usage-v1'));
      const raw = input.input as DeleteManualUsageRequest | undefined;
      const scope =
        typeof raw === 'object' && raw !== null ? raw.scope || raw.account || raw.accountKey || '' : '';
      const id =
        typeof raw === 'string'
          ? raw
          : typeof raw === 'object' && raw !== null
            ? raw.id || ''
            : '';
      result = await ledger.deleteManualUsage(scope, id);
    }
  } else if (input.type === 'getAccounts') {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    if (typeof host.getAccounts === 'function') {
      result = await host.getAccounts(input.input);
    } else {
      const { UsageLedger } = await import('../../telemetry/ledger/index.ts');
      const ledger = new UsageLedger(join(host.dataDir || platformPaths().data, 'usage-v1'));
      const raw = (input.input ?? {}) as { active?: string | null; scope?: string | null };
      result = await ledger.getAccounts(raw.active || raw.scope || null);
    }
  } else if (input.type === 'switchAccount') {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    if (typeof host.switchAccount === 'function') {
      result = await host.switchAccount(input.input as SwitchAccountRequest);
    } else {
      const raw = input.input as SwitchAccountRequest | undefined;
      const account = typeof raw === 'string' ? raw : raw?.account || raw?.id;
      result = { success: true, active: account, activeAccount: account };
    }
  } else if (input.type === 'clearTimeline') {
    if (!(await host.enabled())) throw Error('Plugin disabled');
    const value = (input.input ?? {}) as ClearTimelineRequest;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid clear timeline request');
    }
    if (value.conversationId != null && !GUID_RE.test(value.conversationId)) {
      throw new Error('Invalid conversation ID');
    }
    const cleanInput: ClearTimelineRequest = value.conversationId
      ? { conversationId: value.conversationId }
      : {};
    if (typeof host.clearTimeline === 'function') {
      result = await host.clearTimeline(cleanInput);
    } else if (host.dataDir) {
      const { TimelineStore } = await import('../../telemetry/timeline/store.ts');
      const timelineStore = new TimelineStore(join(host.dataDir, 'timeline-v1'));
      result = await timelineStore.clearAll(null);
    } else {
      result = { cleared: false } satisfies ClearTimelineResult;
    }
  } else {
    return { handled: false };
  }

  if (JSON.stringify(result).length > 1048576) {
    result = offlineSnapshot('Metrics response too large');
  }
  return { handled: true, result };
}

export function formatBindingError(type: string, error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (type === 'preferences') {
    return {
      error:
        message === 'Invalid timeline preference'
          ? message
          : 'Language preference could not be saved or read',
    };
  }
  if (USAGE_OPERATIONS.has(type)) {
    return { error: message || 'Operation failed' };
  }
  return offlineSnapshot('等待 Antigrative Dashboard 重新连接');
}
