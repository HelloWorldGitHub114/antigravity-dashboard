import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { discoverDevToolsTargets } from '../platform/devtools.ts';
import { platformPaths } from '../platform/paths.ts';
import { discoverProcesses, type DiscoveredProcess } from './discovery.ts';

export interface HostLivenessWatchdogOptions {
  onShutdown: () => void | Promise<void>;
  probeHostAlive?: () => Promise<boolean> | boolean;
  probeRendererCount?: () => Promise<number> | number;
  hostPredicate?: (proc: DiscoveredProcess) => boolean;
  profiles?: readonly string[];
  pollIntervalMs?: number;
  absenceThresholdMs?: number;
  startupGraceMs?: number;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

export interface HostLivenessStatus {
  running: boolean;
  stopped: boolean;
  triggered: boolean;
  hasSeenHost: boolean;
  absentSince: number | null;
  startedAt: number;
}

interface UnrefableTimer {
  unref?: () => void;
}

export const DEFAULT_WATCHDOG_POLL_INTERVAL_MS = 5 * 1000;
export const DEFAULT_WATCHDOG_ABSENCE_THRESHOLD_MS = 30 * 1000;
export const DEFAULT_WATCHDOG_STARTUP_GRACE_MS = 60 * 1000;

const LANGUAGE_SERVER_CMD_RE = /(?:^|[\/\\])language_server/i;

function defaultHostPredicate(proc: DiscoveredProcess): boolean {
  if (!Number.isSafeInteger(proc.ProcessId) || proc.ProcessId <= 0) return false;
  return !proc.CommandLine || LANGUAGE_SERVER_CMD_RE.test(proc.CommandLine);
}

async function defaultProbeRenderers(profiles: readonly string[]): Promise<number> {
  let total = 0;
  for (const profile of profiles) {
    if (!profile || !existsSync(join(profile, 'DevToolsActivePort'))) continue;
    try {
      const { targets } = await discoverDevToolsTargets(profile, { mode: 'desktop', timeoutMs: 1000 });
      total += targets.length;
    } catch {
      // Stale or unreachable DevTools port counts as 0 active renderers.
    }
  }
  return total;
}

/**
 * Monitors whether any Antigravity `language_server` host process or active desktop
 * DevTools renderer page remains alive, invoking `onShutdown()` cleanly only after
 * the host disappears for `absenceThresholdMs` (guarded by `hasSeenHost` or `startupGraceMs`).
 * Never inspects or terminates unrelated processes such as `swarm_board`.
 */
export class HostLivenessWatchdog {
  private readonly onShutdown: () => void | Promise<void>;
  private readonly customProbeHostAlive: (() => Promise<boolean> | boolean) | null;
  private readonly customProbeRendererCount: (() => Promise<number> | number) | null;
  private readonly hostPredicate: (proc: DiscoveredProcess) => boolean;
  private readonly profiles: string[];
  private readonly pollIntervalMs: number;
  private readonly absenceThresholdMs: number;
  private readonly startupGraceMs: number;
  private readonly now: () => number;
  private readonly env: Record<string, string | undefined>;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;
  private triggered = false;
  private tickPromise: Promise<void> | null = null;
  private generation = 0;
  private hasSeenHost = false;
  private absentSince: number | null = null;
  private startedAt = 0;

  constructor(options: HostLivenessWatchdogOptions) {
    this.onShutdown = options.onShutdown;
    this.customProbeHostAlive = options.probeHostAlive ?? null;
    this.customProbeRendererCount = options.probeRendererCount ?? null;
    this.hostPredicate = options.hostPredicate ?? defaultHostPredicate;
    this.profiles = options.profiles?.length ? [...options.profiles] : [platformPaths().profile];
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WATCHDOG_POLL_INTERVAL_MS;
    this.absenceThresholdMs = options.absenceThresholdMs ?? DEFAULT_WATCHDOG_ABSENCE_THRESHOLD_MS;
    this.startupGraceMs = options.startupGraceMs ?? DEFAULT_WATCHDOG_STARTUP_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.env = options.env ?? process.env;
  }

  isDisabled(): boolean {
    return this.env.PULSE_DISABLE_HOST_WATCHDOG === '1';
  }

  getStatus(): HostLivenessStatus {
    return {
      running: this.running,
      stopped: this.stopped,
      triggered: this.triggered,
      hasSeenHost: this.hasSeenHost,
      absentSince: this.absentSince,
      startedAt: this.startedAt,
    };
  }

  start(): void {
    if (this.isDisabled() || this.running || this.triggered) return;
    this.generation += 1;
    this.stopped = false;
    this.running = true;
    this.startedAt = this.now();
    this.absentSince = null;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    (this.timer as unknown as UnrefableTimer).unref?.();
  }

  async tick(): Promise<void> {
    if (this.stopped || this.triggered || this.isDisabled()) return;
    if (this.tickPromise) return this.tickPromise;
    const activeGen = this.generation;
    let currentTick!: Promise<void>;
    currentTick = (async () => {
      try {
        const rendererCount = await this.safeProbeRenderers();
        let hostAlive: boolean | null = false;
        if (this.customProbeHostAlive) {
          hostAlive = await this.safeProbeHost();
        } else if (rendererCount > 0) {
          // Active Antigravity renderer window proves the host is still alive without spawning OS discovery.
          hostAlive = true;
        } else {
          hostAlive = await this.safeProbeHost();
        }

        if (this.stopped || this.triggered || this.generation !== activeGen) return;

        const currentNow = this.now();
        if (hostAlive === true || rendererCount > 0) {
          this.hasSeenHost = true;
          this.absentSince = null;
          return;
        }

        // Transient discovery error (hostAlive === null): do not advance absence timer blindly.
        if (hostAlive === null) {
          return;
        }

        const uptimeMs = currentNow - this.startedAt;
        const eligible = this.hasSeenHost || uptimeMs >= this.startupGraceMs;
        if (!eligible) {
          return;
        }

        if (this.absentSince === null) {
          this.absentSince = currentNow;
        }

        const absentDuration = currentNow - this.absentSince;
        if (absentDuration >= this.absenceThresholdMs) {
          this.triggered = true;
          this.stop();
          await this.onShutdown();
        }
      } finally {
        if (this.tickPromise === currentTick) {
          this.tickPromise = null;
        }
      }
    })();
    this.tickPromise = currentTick;
    return currentTick;
  }

  stop(): void {
    this.generation += 1;
    this.stopped = true;
    this.running = false;
    this.tickPromise = null;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async safeProbeRenderers(): Promise<number> {
    try {
      const count = this.customProbeRendererCount
        ? await this.customProbeRendererCount()
        : await defaultProbeRenderers(this.profiles);
      return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0;
    } catch {
      return 0;
    }
  }

  private async safeProbeHost(): Promise<boolean | null> {
    try {
      if (this.customProbeHostAlive) {
        return Boolean(await this.customProbeHostAlive());
      }
      const processes = await discoverProcesses();
      return processes.some(this.hostPredicate);
    } catch {
      return null;
    }
  }
}
