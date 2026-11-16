export type LazyVertexState = 'dormant' | 'starting' | 'active' | 'disposed';

export interface LazyVertexStoreLike {
  setModelTimelineEnabled?: (enabled: boolean) => unknown;
  dispose?: () => void;
}

export interface LazyVertexUsageLike {
  dispose?: () => void;
}

export interface LazyVertexIntegrationLike {
  sessions?: { size: number };
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
}

export interface LazyVertexInstance<
  TStore extends LazyVertexStoreLike = LazyVertexStoreLike,
  TUsage extends LazyVertexUsageLike = LazyVertexUsageLike,
  TIntegration extends LazyVertexIntegrationLike = LazyVertexIntegrationLike,
> {
  store: TStore;
  usage: TUsage;
  integration: TIntegration;
  onDispose?: () => Promise<void> | void;
}

export interface LazyVertexControllerOptions<
  TStore extends LazyVertexStoreLike = LazyVertexStoreLike,
  TUsage extends LazyVertexUsageLike = LazyVertexUsageLike,
  TIntegration extends LazyVertexIntegrationLike = LazyVertexIntegrationLike,
> {
  createInstance: () =>
    | Promise<LazyVertexInstance<TStore, TUsage, TIntegration>>
    | LazyVertexInstance<TStore, TUsage, TIntegration>;
  canActivate?: () => boolean;
  probeActive?: () => Promise<boolean> | boolean;
  idleTtlMs?: number;
  probeIntervalMs?: number;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

interface UnrefableTimer {
  unref?: () => void;
}

export const DEFAULT_LAZY_VERTEX_IDLE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_LAZY_VERTEX_PROBE_INTERVAL_MS = 5 * 1000;

/**
 * Lazily activates `.antigravity-vertex` telemetry & RuntimeUi only when an active
 * Vertex window/process or explicit UI/IPC query occurs, and hibernates back to
 * `'dormant'` after `idleTtlMs` of inactivity so V8 can reclaim `vStore` and caches.
 */
export class LazyVertexController<
  TStore extends LazyVertexStoreLike = LazyVertexStoreLike,
  TUsage extends LazyVertexUsageLike = LazyVertexUsageLike,
  TIntegration extends LazyVertexIntegrationLike = LazyVertexIntegrationLike,
> {
  private readonly createInstance: () =>
    | Promise<LazyVertexInstance<TStore, TUsage, TIntegration>>
    | LazyVertexInstance<TStore, TUsage, TIntegration>;
  private readonly canActivate: (() => boolean) | null;
  private readonly probeActive: (() => Promise<boolean> | boolean) | null;
  private readonly idleTtlMs: number;
  private readonly probeIntervalMs: number;
  private readonly now: () => number;
  private readonly env: Record<string, string | undefined>;

  private state: LazyVertexState = 'dormant';
  private disposed = false;
  private instance: LazyVertexInstance<TStore, TUsage, TIntegration> | null = null;
  private startPromise: Promise<LazyVertexInstance<TStore, TUsage, TIntegration> | null> | null = null;
  private teardownPromise: Promise<void> | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private probing = false;
  private lastActivityAt = 0;
  private lastReason = '';

  constructor(options: LazyVertexControllerOptions<TStore, TUsage, TIntegration>) {
    this.createInstance = options.createInstance;
    this.canActivate = options.canActivate ?? null;
    this.probeActive = options.probeActive ?? null;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_LAZY_VERTEX_IDLE_TTL_MS;
    this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_LAZY_VERTEX_PROBE_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.env = options.env ?? process.env;
  }

  isLazyEnabled(): boolean {
    return this.env.PULSE_LAZY_VERTEX !== '0';
  }

  getState(): LazyVertexState {
    return this.state;
  }

  getInstance(): LazyVertexInstance<TStore, TUsage, TIntegration> | null {
    return this.instance;
  }

  getStore(): TStore | null {
    return this.instance?.store ?? null;
  }

  getUsage(): TUsage | null {
    return this.instance?.usage ?? null;
  }

  getIntegration(): TIntegration | null {
    return this.instance?.integration ?? null;
  }

  getLastActivityAt(): number {
    return this.lastActivityAt;
  }

  getLastReason(): string {
    return this.lastReason;
  }

  private eligible(): boolean {
    return !this.disposed && (this.canActivate ? this.canActivate() : true);
  }

  start(): void {
    if (this.disposed) return;
    if (!this.isLazyEnabled()) {
      void this.ensureStarted('env-opt-out').catch(() => {});
      return;
    }
    if (this.probeTimer !== null) return;
    if (this.probeActive && this.probeIntervalMs > 0) {
      void this.probe().catch(() => {});
      this.probeTimer = setInterval(() => {
        void this.probe().catch(() => {});
      }, this.probeIntervalMs);
      (this.probeTimer as unknown as UnrefableTimer).unref?.();
    }
  }

  async probe(): Promise<boolean> {
    if (this.disposed || this.probing || !this.probeActive || !this.eligible()) {
      return false;
    }
    this.probing = true;
    try {
      const active = await this.probeActive();
      if (this.disposed || !active) return false;
      if (this.state === 'active') {
        this.recordActivity('probe-active');
        return true;
      }
      const started = await this.ensureStarted('probe-active');
      return started !== null;
    } catch {
      return false;
    } finally {
      this.probing = false;
    }
  }

  async ensureStarted(reason = 'manual'): Promise<LazyVertexInstance<TStore, TUsage, TIntegration> | null> {
    if (!this.eligible()) return null;
    this.lastActivityAt = this.now();
    this.lastReason = reason;

    while (this.teardownPromise || this.startPromise) {
      if (this.teardownPromise) {
        await this.teardownPromise.catch(() => {});
        if (!this.eligible()) return null;
      }
      if (this.startPromise) {
        const started = await this.startPromise;
        if (!this.teardownPromise && (this.state === 'active' || started === null)) {
          return started;
        }
      }
    }

    if (this.state === 'active' && this.instance) {
      this.scheduleIdleTimer();
      return this.instance;
    }

    this.state = 'starting';
    let pending: Promise<LazyVertexInstance<TStore, TUsage, TIntegration> | null> | null = null;
    pending = (async (): Promise<LazyVertexInstance<TStore, TUsage, TIntegration> | null> => {
      let created: LazyVertexInstance<TStore, TUsage, TIntegration> | null = null;
      try {
        created = await this.createInstance();
        if (this.disposed) {
          await this.teardownInstance(created);
          return null;
        }
        await created.integration?.start?.();
        if (this.disposed) {
          await this.teardownInstance(created);
          return null;
        }
        this.instance = created;
        this.state = 'active';
        this.scheduleIdleTimer();
        return created;
      } catch (error) {
        if (created) {
          await this.teardownInstance(created).catch(() => {});
        }
        if (!this.disposed) {
          this.instance = null;
          this.state = 'dormant';
        }
        throw error;
      } finally {
        if (this.startPromise === pending) {
          this.startPromise = null;
        }
      }
    })();

    this.startPromise = pending;
    return pending;
  }

  touch(reason = 'activity'): Promise<LazyVertexInstance<TStore, TUsage, TIntegration> | null> {
    if (!this.eligible()) return Promise.resolve(null);
    this.lastActivityAt = this.now();
    this.lastReason = reason;
    if (this.state === 'active' && this.instance) {
      this.scheduleIdleTimer();
      return Promise.resolve(this.instance);
    }
    return this.ensureStarted(reason);
  }

  recordActivity(reason = 'activity'): void {
    if (this.disposed) return;
    this.lastActivityAt = this.now();
    this.lastReason = reason;
    if (this.state === 'active') {
      this.scheduleIdleTimer();
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearProbeTimer(): void {
    if (this.probeTimer !== null) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private scheduleIdleTimer(): void {
    this.clearIdleTimer();
    if (
      this.disposed ||
      this.state !== 'active' ||
      !this.isLazyEnabled() ||
      !Number.isFinite(this.idleTtlMs) ||
      this.idleTtlMs <= 0
    ) {
      return;
    }
    const elapsed = Math.max(0, this.now() - this.lastActivityAt);
    const delay = Math.max(1, this.idleTtlMs - elapsed);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.checkIdle();
    }, delay);
    (this.idleTimer as unknown as UnrefableTimer).unref?.();
  }

  private async checkIdle(): Promise<void> {
    if (this.disposed || this.state !== 'active' || !this.instance || !this.isLazyEnabled()) {
      return;
    }
    if ((this.instance.integration?.sessions?.size ?? 0) > 0) {
      this.lastActivityAt = this.now();
      this.scheduleIdleTimer();
      return;
    }
    const elapsed = this.now() - this.lastActivityAt;
    if (elapsed < this.idleTtlMs) {
      this.scheduleIdleTimer();
      return;
    }
    await this.hibernate();
  }

  async hibernate(): Promise<void> {
    this.clearIdleTimer();
    while (this.teardownPromise || this.startPromise) {
      if (this.teardownPromise) {
        await this.teardownPromise;
      }
      if (this.startPromise) {
        await this.startPromise.catch(() => null);
      }
    }
    if (this.disposed || (this.state === 'dormant' && !this.instance)) return;
    const current = this.instance;
    this.instance = null;
    let teardown: Promise<void> | null = null;
    teardown = (async () => {
      try {
        if (current) {
          await this.teardownInstance(current);
        }
      } finally {
        if (!this.disposed) {
          this.state = 'dormant';
        }
        if (this.teardownPromise === teardown) {
          this.teardownPromise = null;
        }
      }
    })();
    this.teardownPromise = teardown;
    return teardown;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.state = 'disposed';
    this.clearProbeTimer();
    this.clearIdleTimer();
    if (this.startPromise) {
      await this.startPromise.catch(() => null);
    }
    if (this.teardownPromise) {
      await this.teardownPromise.catch(() => {});
    }
    const current = this.instance;
    this.instance = null;
    if (current) {
      await this.teardownInstance(current).catch(() => {});
    }
  }

  private async teardownInstance(
    target: LazyVertexInstance<TStore, TUsage, TIntegration>,
  ): Promise<void> {
    try { target.usage?.dispose?.(); } catch {}
    try { target.store?.dispose?.(); } catch {}
    try { await target.integration?.stop?.(); } catch {}
    try { await target.onDispose?.(); } catch {}
  }
}
