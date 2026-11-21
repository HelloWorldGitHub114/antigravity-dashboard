import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { platformPaths } from '../../platform/paths.ts';
import { discoverProcesses, type DiscoveredProcess } from '../discovery.ts';
import type { RemoteUpdateLike, TrajectoryReaderClient, TrajectoryResult } from '../reader/types.ts';
import { TrajectoryReader, type ReadTrajectoryOptions } from '../reader/trajectory-reader.ts';
import {
  createNoLocalCredentialsError,
  discoverServerEndpoint,
  isNoLocalCredentialsError,
  isPidAlive,
  parseEnvCredentials,
  PORT_LOG_GLOBAL,
  readFileSlice,
  readLogWithStats,
  serverFromDiscovery,
  type DiscoveryEnv,
  type ProcessCandidate,
  type ServerEndpoint,
  type ServerSource,
} from './server-discovery.ts';

export { serverFromDiscovery };
import { streamAgentStateSnapshot } from './snapshot-stream.ts';
import {
  executeRpcCall,
  type RpcMetricsEvent,
  type SnapshotCallOptions,
} from './transport.ts';

export interface ClientPathInfo {
  home?: string;
  profile?: string;
  data?: string;
  log?: string;
  logCandidates?: string[];
  conversationsDir?: string;
}

export interface AntigravityClientOptions {
  paths?: () => ClientPathInfo;
  readLog?: (file: string, encoding: BufferEncoding) => Promise<string>;
  processes?: () => Promise<ProcessCandidate | readonly ProcessCandidate[] | DiscoveredProcess[]>;
  env?: DiscoveryEnv;
  now?: () => number;
  onRpc?: ((event: RpcMetricsEvent) => void) | null;
  modelTimelineEnabled?: boolean;
  conversationsDir?: string | null;
}

const ENDPOINT_LOST_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTCONN']);
const defaultReadLog: (file: string, encoding: BufferEncoding) => Promise<string> = readFile;

function isEndpointLost(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { status?: unknown; code?: unknown };
  return (
    (typeof e.status === 'number' && (e.status === 401 || e.status === 403)) ||
    (typeof e.code === 'string' && ENDPOINT_LOST_CODES.has(e.code))
  );
}

function isAuthStatusError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { status?: unknown; isConnectTrailer?: unknown };
  if (e.isConnectTrailer === true) return false;
  return typeof e.status === 'number' && (e.status === 401 || e.status === 403);
}

function envCredentialKey(server: ServerEndpoint): string {
  return createHash('sha256').update(`${server.pid}:${server.port}:${server.csrf}`).digest('hex');
}

/**
 * Local RPC & streaming snapshot client for Antigravity's standalone `language_server`.
 */
export class AntigravityClient implements TrajectoryReaderClient {
  paths: () => ClientPathInfo;
  readLog: (file: string, encoding: BufferEncoding) => Promise<string>;
  processes: () => Promise<ProcessCandidate | readonly ProcessCandidate[] | DiscoveredProcess[]>;
  env: DiscoveryEnv;
  now: () => number;
  onRpc: ((event: RpcMetricsEvent) => void) | null;
  modelTimelineEnabled: boolean;
  conversationsDir: string | null;
  reader: TrajectoryReader;
  server: ServerEndpoint | null = null;
  serverSource: ServerSource | null = null;
  discoveredAt = 0;
  discovering: Promise<ServerEndpoint> | null = null;
  lastScanAt = -Infinity;
  retryAt = 0;
  discoveryFailures = 0;
  discoveryError: unknown = null;
  private envServers = new WeakSet<ServerEndpoint>();
  private rejectedEnvCredentials = new Set<string>();

  constructor({
    paths = platformPaths,
    readLog = defaultReadLog,
    processes = discoverProcesses,
    env = process.env,
    now = Date.now,
    onRpc = null,
    modelTimelineEnabled = false,
    conversationsDir = null,
  }: AntigravityClientOptions = {}) {
    this.paths = paths;
    this.readLog = readLog;
    this.processes = processes;
    this.env = env;
    this.now = now;
    this.onRpc = onRpc;
    this.modelTimelineEnabled = modelTimelineEnabled === true;
    this.conversationsDir = conversationsDir;
    this.reader = new TrajectoryReader(this, {
      modelTimelineEnabled: this.modelTimelineEnabled,
      conversationsDir,
    });
  }

  setModelTimelineEnabled(enabled: boolean): boolean {
    this.modelTimelineEnabled = enabled === true;
    this.reader?.setModelTimelineEnabled?.(this.modelTimelineEnabled);
    return this.modelTimelineEnabled;
  }

  async canReuseCurrentServer(): Promise<boolean> {
    if (!this.server || this.processes !== discoverProcesses || this.readLog !== defaultReadLog) return false;
    if (!this.serverSource?.file || !isPidAlive(this.server.pid)) return false;
    const pathInfo = this.paths();
    const candidates = pathInfo?.logCandidates || [pathInfo?.log].filter((v): v is string => Boolean(v));
    for (const file of candidates) {
      try {
        const info = await stat(file);
        if (file !== this.serverSource.file) return false;
        if (info.size === this.serverSource.size && info.mtimeMs === this.serverSource.mtimeMs) return true;
        if (info.size < this.serverSource.size) return false;
        const deltaStart = Math.max(0, this.serverSource.size - 128);
        const appended = await readFileSlice(file, deltaStart, info.size);
        const matches = [...appended.matchAll(PORT_LOG_GLOBAL)];
        if (!matches.length || Number(matches.at(-1)![1]) === this.server.port) {
          this.serverSource = { file, size: info.size, mtimeMs: info.mtimeMs };
          return true;
        }
        return false;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return false;
      }
    }
    return false;
  }

  async discover(force = false): Promise<ServerEndpoint> {
    if (!force && this.server && this.now() - this.discoveredAt < 15000) return this.server;
    if (this.discovering) return this.discovering;
    if (!force && this.discoveryError && this.now() < this.retryAt) throw this.discoveryError;
    this.lastScanAt = this.now();
    this.discovering = (async () => {
      if (!force && (await this.canReuseCurrentServer()) && this.server) return this.server;
      return this.discoverNow();
    })()
      .then((server) => {
        this.discoveredAt = this.now();
        this.discoveryFailures = 0;
        this.discoveryError = null;
        this.retryAt = 0;
        return server;
      })
      .catch((error: unknown) => {
        this.discoveryError = error;
        this.discoveryFailures++;
        this.retryAt = this.now() + Math.min(30000, 3000 * 2 ** Math.min(4, this.discoveryFailures - 1));
        throw error;
      })
      .finally(() => {
        this.discovering = null;
      });
    return this.discovering;
  }

  private resolveDiscoveryFromLog(
    log: string,
    parsed: ProcessCandidate | readonly ProcessCandidate[],
  ): ServerEndpoint {
    const { server, source } = discoverServerEndpoint(log, parsed, this.env);
    if (source === 'env') {
      if (this.rejectedEnvCredentials.has(envCredentialKey(server))) {
        throw createNoLocalCredentialsError(server.pid, server.port);
      }
      this.envServers.add(server);
    }
    return server;
  }

  async discoverNow(): Promise<ServerEndpoint> {
    this.server = null;
    this.serverSource = null;
    // A sidecar can outlive a renderer/backend restart. Its injected token may
    // then refer to the previous LS instance; pair the current log port with
    // the current standalone process credential instead of mixing generations.
    const parsed = await this.processes();
    if (!parsed || (Array.isArray(parsed) && !parsed.length)) {
      throw new Error('请先打开 Antigravity');
    }
    // Credentials stay in process memory. They are never logged, persisted, or
    // returned to a browser; all calls go exclusively to 127.0.0.1.
    let foundLog = false;
    let lastError: unknown = null;
    const paths = this.paths();
    const candidates = paths.logCandidates || [paths.log].filter((v): v is string => Boolean(v));
    for (const file of candidates) {
      try {
        if (this.readLog === defaultReadLog) {
          const { text, size, mtimeMs } = await readLogWithStats(file);
          foundLog = true;
          this.server = this.resolveDiscoveryFromLog(text, parsed);
          this.serverSource = { file, size, mtimeMs };
          break;
        }
        const log = await this.readLog(file, 'utf8');
        foundLog = true;
        this.server = this.resolveDiscoveryFromLog(log, parsed);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') lastError = error;
      }
    }
    if (!this.server && !lastError && !foundLog && parseEnvCredentials(this.env)) {
      try {
        this.server = this.resolveDiscoveryFromLog('', parsed);
      } catch (error) {
        if (isNoLocalCredentialsError(error)) {
          lastError = error;
        }
      }
    }
    if (!this.server) {
      throw lastError || new Error(foundLog ? '等待 Antigravity 本地接口启动' : '未找到 Antigravity 语言服务日志，请检查日志路径');
    }
    this.discoveredAt = this.now();
    return this.server;
  }

  private invalidateServer(server: ServerEndpoint, error: unknown): boolean {
    if (this.server !== server) return false;
    this.server = null;
    this.serverSource = null;
    this.discoveryError = error;
    this.retryAt = Math.max(this.retryAt, this.lastScanAt + 3000);
    return true;
  }

  private async withEndpointRecovery<T>(
    run: (server: ServerEndpoint) => Promise<T>,
    retry: boolean,
    retryCall: () => Promise<T>,
  ): Promise<T> {
    const server = await this.discover();
    try {
      return await run(server);
    } catch (error) {
      if (!isEndpointLost(error)) throw error;
      const envAuthFailure = this.envServers.has(server) && isAuthStatusError(error);
      if (envAuthFailure) {
        this.rejectedEnvCredentials.add(envCredentialKey(server));
      }
      const invalidated = this.invalidateServer(server, error);
      if (envAuthFailure && invalidated && !retry) {
        this.discoveryError = createNoLocalCredentialsError(server.pid, server.port);
      }
      if (retry) {
        await this.discover(envAuthFailure && invalidated);
        return retryCall();
      }
      throw error;
    }
  }

  async call<T = Record<string, unknown>>(
    method: string,
    body: Record<string, unknown> = {},
    retry = true,
    options: { modelTimelineEnabled?: boolean } | null = null,
  ): Promise<T> {
    const timelineEnabled =
      options?.modelTimelineEnabled === undefined ? this.modelTimelineEnabled : options.modelTimelineEnabled === true;
    return this.withEndpointRecovery(
      (server) => executeRpcCall<T>(server, method, body, timelineEnabled, this.now, this.onRpc),
      retry,
      () => this.call<T>(method, body, false, options),
    );
  }

  async readAgentStateSnapshot(
    conversationId: string,
    options: SnapshotCallOptions | boolean = {},
    retry = true,
  ): Promise<RemoteUpdateLike> {
    let resolvedOptions: SnapshotCallOptions;
    let resolvedRetry = retry;
    if (typeof options === 'boolean') {
      resolvedRetry = options;
      resolvedOptions = {};
    } else {
      resolvedOptions = options;
    }
    const timelineEnabled =
      resolvedOptions?.modelTimelineEnabled === undefined
        ? this.modelTimelineEnabled
        : resolvedOptions.modelTimelineEnabled === true;
    return this.withEndpointRecovery(
      (server) => streamAgentStateSnapshot(server, conversationId, resolvedOptions, timelineEnabled, this.now),
      resolvedRetry,
      () => this.readAgentStateSnapshot(conversationId, resolvedOptions, false),
    );
  }

  resetTrajectories(): void {
    this.reader.reset();
  }

  trajectory(id: string, options?: ReadTrajectoryOptions): Promise<TrajectoryResult> {
    return this.reader.read(id, options);
  }
}
