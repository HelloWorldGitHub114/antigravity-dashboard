import { Agent, request, type RequestOptions } from 'node:http';
import { TrajectoryJson } from '../projector/trajectory-json.ts';
import type { ServerEndpoint } from './server-discovery.ts';

export interface RpcMetricsEvent {
  method: string;
  bytes: number;
  retainedBytes: number;
  ms: number;
}

export interface SnapshotPageBounds {
  startIndex: number;
  endIndexExclusive: number;
}

export interface SnapshotCallOptions {
  modelTimelineEnabled?: boolean;
  initialStepsPageBounds?: SnapshotPageBounds;
  initialGeneratorMetadatasPageBounds?: SnapshotPageBounds;
}

interface UnrefableTimer {
  unref?: () => void;
}

export const SERVICE = '/exa.language_server_pb.LanguageServerService/';
const PROJECTED_METHODS = new Set([
  'GetCascadeTrajectory',
  'GetCascadeTrajectorySteps',
  'GetCascadeTrajectoryGeneratorMetadata',
]);
const keepAliveAgent = new Agent({ keepAlive: true, maxSockets: 8 });

export function statusError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * Execute a single unary Connect-JSON RPC call against the local Antigravity endpoint,
 * using streaming `TrajectoryJson` projection for large trajectory payloads.
 */
export function executeRpcCall<T = Record<string, unknown>>(
  server: ServerEndpoint,
  method: string,
  body: Record<string, unknown>,
  timelineEnabled: boolean,
  now: () => number,
  onRpc: ((event: RpcMetricsEvent) => void) | null,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const data = JSON.stringify(body);
    const projection = PROJECTED_METHODS.has(method);
    const started = now();
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: unknown, value?: T): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = (error: Error): void => {
      finish(error);
      if (!req.destroyed) req.destroy(error);
    };
    const reqOptions = {
      hostname: '127.0.0.1',
      port: server.port,
      method: 'POST',
      path: SERVICE + method,
      agent: projection ? false : keepAliveAgent,
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': server.csrf,
        'Content-Length': Buffer.byteLength(data),
      },
    } as RequestOptions & { agent: unknown };
    const req = request(reqOptions, (res) => {
      const projected = projection ? new TrajectoryJson({ modelTimelineEnabled: timelineEnabled }) : null;
      let text = '';
      let bytes = 0;
      let failed = false;
      const fail = (error: Error): void => {
        if (failed) return;
        failed = true;
        abort(error);
      };
      res.setEncoding?.('utf8');
      res.on('error', (error: unknown) => {
        if (!failed) finish(error);
      });
      res.on('data', (chunk: string | Buffer) => {
        if (failed) return;
        const textChunk = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        bytes += Buffer.byteLength(textChunk);
        if (!(projected && res.statusCode === 200) && bytes > 32 * 1024 * 1024) {
          fail(new Error('接口响应超过采集上限'));
          return;
        }
        try {
          if (projected && res.statusCode === 200) projected.write(textChunk);
          else text += textChunk;
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      res.on('end', () => {
        if (failed) return;
        if (res.statusCode !== 200) {
          finish(statusError(`Antigravity 接口 ${method} 返回 ${res.statusCode}`, res.statusCode ?? 0));
          return;
        }
        try {
          const value = projected ? projected.end<T>() : (JSON.parse(text) as T);
          try {
            onRpc?.({
              method,
              bytes,
              retainedBytes: projected?.retained ?? Buffer.byteLength(text),
              ms: now() - started,
            });
          } catch {
            // Ignore RPC telemetry observer failures.
          }
          finish(null, value);
        } catch (error) {
          finish(projected ? error : new Error('Antigravity 接口返回了无法解析的数据'));
        }
      });
    });
    req.on('error', (error: unknown) => finish(error));
    req.setTimeout(12000, () => abort(new Error('Antigravity 本地接口超时')));
    deadline = setTimeout(() => abort(new Error('Antigravity 本地接口超时')), 30000);
    (deadline as unknown as UnrefableTimer).unref?.();
    req.once('close', () => {
      if (deadline !== undefined) clearTimeout(deadline);
    });
    req.end(data);
  });
}
