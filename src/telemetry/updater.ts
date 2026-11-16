// Manual updates only. Public release metadata is fetched by the bounded
// Python worker, which uses the user's existing proxy configuration.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  UpdatePluginRequest,
  UpdatePluginState,
  UpdateProgress,
  UpdateProgressPhase,
} from '../contracts/ipc.ts';
import { atomicWriteJson } from '../shared/atomic-fs.ts';

export type SpawnImpl = (command: string, args?: readonly string[], options?: SpawnOptions) => ChildProcess;

export interface RunUpdateWorkerOptions {
  spawnImpl?: SpawnImpl;
  platform?: string;
  onProgress?: ((progress: UpdateProgress) => void) | null;
}

export interface UpdatePlan extends Record<string, unknown> {
  host?: string;
  currentVersion?: string;
  latestVersion?: string;
  hasUpdate?: boolean;
  notes?: string;
  verified?: boolean;
  version?: string;
  expires?: number;
}

export type UpdateRunner = (worker: string, args: string[], options?: RunUpdateWorkerOptions) => Promise<UpdatePlan>;

export interface AppUpdaterOptions {
  pluginDir: string;
  dataDir: string;
  worker?: string;
  run?: UpdateRunner;
  onReload?: (() => void) | null;
  now?: () => number;
}

const PROGRESS_PHASES = new Set<UpdateProgressPhase>([
  'check', 'download', 'verify', 'extract', 'backup', 'install', 'recover', 'complete',
]);
const WORKER_ERRORS = new Set<string>(['network', 'busy', 'verification', 'rollback']);
const PUBLIC_ERRORS = new Set<string>(['python', 'network', 'busy', 'verification', 'rollback']);
const VERSION_PATTERN =
  /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})(?:-(?:0|[1-9]\d{0,5}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d{0,5}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null | undefined)?.code;

function safeProgress(value: unknown): UpdateProgress | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<UpdateProgress>;
  if (!candidate.phase || !PROGRESS_PHASES.has(candidate.phase)) return null;
  const result: UpdateProgress = { phase: candidate.phase };
  if (
    candidate.phase === 'download' &&
    typeof candidate.received === 'number' && Number.isSafeInteger(candidate.received) && candidate.received >= 0 &&
    typeof candidate.total === 'number' && Number.isSafeInteger(candidate.total) && candidate.total > 0 &&
    candidate.total <= 64 * 1024 * 1024 && candidate.received <= candidate.total
  ) {
    result.received = candidate.received;
    result.total = candidate.total;
  }
  return result;
}

/**
 * Invoke the bounded Python update worker and validate its JSON stdout/stderr events.
 */
export async function runUpdateWorker(
  worker: string,
  args: string[],
  { spawnImpl = spawn, platform = process.platform, onProgress = null }: RunUpdateWorkerOptions = {},
): Promise<UpdatePlan> {
  const candidates = platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const command of candidates) {
    try {
      return await new Promise<UpdatePlan>((resolve, reject) => {
        const child = spawnImpl(command, [worker, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let output = '';
        let overflow = false;
        let settled = false;
        // A read-only check can be cancelled safely. Installation is not terminated
        // in the middle of a filesystem transaction; its network reads are bounded.
        const timer = args[0] === 'check' ? setTimeout(() => { child.kill(); finish(new Error('network')); }, 30000) : null;
        const finish = (error: Error | null, value?: UpdatePlan): void => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          if (error) reject(error); else resolve(value ?? {});
        };
        child.stdout?.on('data', (chunk: unknown) => {
          if (overflow) return;
          output += String(chunk);
          if (output.length > 32768) {
            overflow = true;
            output = '';
            if (args[0] === 'check') child.kill();
          }
        });
        let progressLine = '';
        let discardProgress = false;
        child.stderr?.on('data', (chunk: unknown) => {
          for (const part of String(chunk).split(/(\n)/)) {
            if (part === '\n') {
              if (!discardProgress) {
                try {
                  const value = JSON.parse(progressLine) as { event?: string };
                  if (value.event === 'pulse-update-progress') {
                    const progress = safeProgress(value);
                    if (progress) onProgress?.(progress);
                  }
                } catch { /* Ignore non-JSON or unrelated diagnostic lines. */ }
              }
              progressLine = '';
              discardProgress = false;
            } else if (!discardProgress) {
              if (progressLine.length + part.length > 1024) { progressLine = ''; discardProgress = true; }
              else progressLine += part;
            }
          }
        });
        child.on('error', (error: Error) => finish(error));
        child.on('close', (code: number | null) => {
          if (overflow) { finish(new Error('verification')); return; }
          try {
            const response = JSON.parse(output.trim()) as { ok?: boolean; code?: string; result?: UpdatePlan };
            if (response.ok !== true) {
              throw new Error(response.code && (WORKER_ERRORS.has(response.code) || response.code === 'install') ? response.code : 'install');
            }
            if (code !== 0) throw new Error('install');
            finish(null, response.result ?? {});
          } catch (error) {
            const msg = errorMessage(error);
            finish(new Error(WORKER_ERRORS.has(msg) ? msg : 'install'));
          }
        });
      });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  throw new Error('python');
}

/**
 * Coordinates manual update checks, verified plan application, and reload scheduling.
 */
export class AppUpdater {
  pluginDir: string;
  dataDir: string;
  worker: string;
  run: UpdateRunner;
  onReload: (() => void) | null;
  now: () => number;
  state: UpdatePluginState = { state: 'idle', host: 'app', currentVersion: null };
  plan: UpdatePlan | null = null;
  checkPending: Promise<UpdatePluginState> | null = null;
  applyPending: Promise<UpdatePluginState> | null = null;
  job: Promise<void> | null = null;
  lastCheck = 0;

  constructor({
    pluginDir, dataDir, worker = join(pluginDir, 'compat', 'update-worker.py'),
    run = runUpdateWorker, onReload = null, now = Date.now,
  }: AppUpdaterOptions) {
    this.pluginDir = pluginDir;
    this.dataDir = join(dataDir, 'updates');
    this.worker = worker;
    this.run = run;
    this.onReload = onReload;
    this.now = now;
  }

  publicState(): UpdatePluginState {
    const { state, host, currentVersion, latestVersion, notes, error, progress } = this.state;
    return { state, host, currentVersion, latestVersion, notes, error, progress };
  }

  async current(): Promise<string> {
    const manifest = JSON.parse(await readFile(join(this.pluginDir, 'plugin.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (
      !manifest ||
      manifest.name !== 'antigravity-pulse' ||
      typeof manifest.version !== 'string' ||
      manifest.version.length > 64 ||
      !VERSION_PATTERN.test(manifest.version)
    ) {
      throw new Error('verification');
    }
    return manifest.version;
  }

  async check(): Promise<UpdatePluginState> {
    if (this.job || this.applyPending || this.state.state === 'installed' || this.state.state === 'reloading') {
      return this.publicState();
    }
    if (this.checkPending) return this.checkPending;
    if (this.lastCheck && this.now() - this.lastCheck < 15000 && (this.state.state === 'current' || this.state.state === 'available')) {
      return this.publicState();
    }
    this.checkPending = (async () => {
      this.state = { state: 'checking', host: 'app', currentVersion: null, progress: { phase: 'check' } };
      this.plan = null;
      try {
        this.state.currentVersion = await this.current();
        const result = await this.run(this.worker, ['check', '--target', this.pluginDir]);
        if (result.host !== 'app' || result.currentVersion !== this.state.currentVersion) throw new Error('verification');
        this.plan = result.hasUpdate ? { ...result, expires: this.now() + 15 * 60 * 1000 } : null;
        this.state = {
          state: result.hasUpdate ? 'available' : 'current',
          host: 'app',
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          notes: typeof result.notes === 'string' ? result.notes.slice(0, 1800) : '',
        };
      } catch (error) {
        const msg = errorMessage(error);
        this.state = { ...this.state, state: 'error', error: PUBLIC_ERRORS.has(msg) ? msg : 'install' };
      }
      this.lastCheck = this.now();
      return this.publicState();
    })().finally(() => { this.checkPending = null; });
    return this.checkPending;
  }

  async apply(version: string): Promise<UpdatePluginState> {
    if (this.job) return this.publicState();
    if (this.applyPending) return this.applyPending;
    this.applyPending = this.startApply(version);
    try { return await this.applyPending; } finally { this.applyPending = null; }
  }

  async startApply(version: string): Promise<UpdatePluginState> {
    if (
      !this.plan || this.state.state !== 'available' || version !== this.plan.latestVersion ||
      (this.plan.expires ?? -1) < this.now() || (await this.current()) !== this.plan.currentVersion
    ) {
      throw new Error('verification');
    }
    const plan = this.plan;
    this.plan = null;
    this.state = { ...this.state, state: 'installing', progress: { phase: 'verify' } };
    this.job = (async () => {
      let file: string | undefined;
      try {
        file = join(this.dataDir, `plan-${randomUUID()}.json`);
        await atomicWriteJson(file, plan, { mode: 0o600 });
        const result = await this.run(
          this.worker,
          ['apply', '--target', this.pluginDir, '--plan', file, '--updates', this.dataDir],
          {
            onProgress: (value) => {
              const progress = safeProgress(value);
              if (!progress || this.state.state !== 'installing') return;
              const old = this.state.progress;
              if (old?.phase === 'download' && progress.phase === 'download' && old.total === progress.total && (progress.received ?? 0) < (old.received ?? 0)) {
                return;
              }
              this.state = { ...this.state, progress };
            },
          },
        );
        if (result.verified !== true || result.version !== version || (await this.current()) !== version) throw new Error('verification');
        this.state = { ...this.state, state: 'installed', currentVersion: version, progress: { phase: 'complete' } };
      } catch (error) {
        const msg = errorMessage(error);
        this.state = { ...this.state, state: 'error', error: PUBLIC_ERRORS.has(msg) ? msg : 'install' };
      } finally {
        if (file) await unlink(file).catch(() => {});
      }
    })().finally(() => { this.job = null; });
    return this.publicState();
  }

  async request(input: UpdatePluginRequest): Promise<UpdatePluginState> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => k !== 'action' && k !== 'version')) {
      throw new Error('verification');
    }
    if (input.action === 'check' && input.version === undefined) {
      void this.check().catch(() => {});
      return this.publicState();
    }
    if (input.action === 'status' && input.version === undefined) return this.publicState();
    if (input.action === 'apply' && typeof input.version === 'string') return this.apply(input.version);
    if (input.action === 'reload' && input.version === undefined && this.state.state === 'reloading') return this.publicState();
    if (input.action === 'reload' && input.version === undefined && this.state.state === 'installed' && this.onReload) {
      this.state = { ...this.state, state: 'reloading' };
      setTimeout(() => this.onReload?.(), 500);
      return this.publicState();
    }
    throw new Error('verification');
  }
}
