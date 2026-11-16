import { request, type RequestOptions } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { TrajectoryJson } from '../projector/trajectory-json.ts';
import type { RemoteUpdateLike } from '../reader/types.ts';
import type { ServerEndpoint } from './server-discovery.ts';
import { SERVICE, statusError, type SnapshotCallOptions } from './transport.ts';

interface UnrefableTimer {
  unref?: () => void;
}

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_DECODE_CHUNK_BYTES = 64 * 1024;

/**
 * Stream the initial `StreamAgentStateUpdates` Connect frame and project it incrementally
 * through `TrajectoryJson` without buffering multi-megabyte snapshots.
 */
export function streamAgentStateSnapshot(
  server: ServerEndpoint,
  conversationId: string,
  options: SnapshotCallOptions,
  timelineEnabled: boolean,
  now: () => number,
): Promise<RemoteUpdateLike> {
  return new Promise<RemoteUpdateLike>((resolve, reject) => {
    const body = {
      conversationId,
      subscriberId: `pulse-snapshot-${now()}`,
      trajectoryVerbosity: 3,
      ...(options.initialStepsPageBounds ? { initialStepsPageBounds: options.initialStepsPageBounds } : {}),
      ...(options.initialGeneratorMetadatasPageBounds
        ? { initialGeneratorMetadatasPageBounds: options.initialGeneratorMetadatasPageBounds }
        : {}),
    };
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const header = Buffer.alloc(5);
    header.writeUInt8(0, 0);
    header.writeUInt32BE(payload.length, 1);
    const frame = Buffer.concat([header, payload]);

    let done = false;
    let projector: TrajectoryJson | null = null;
    let decoder: StringDecoder | null = null;
    let trailerChunks: Buffer[] | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (err: unknown, res?: RemoteUpdateLike): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      projector = null;
      decoder = null;
      trailerChunks = null;
      req.destroy();
      if (err) reject(err);
      else resolve(res as RemoteUpdateLike);
    };

    timer = setTimeout(() => finish(new Error('Antigravity 本地接口超时')), 60000);
    (timer as unknown as UnrefableTimer).unref?.();

    const reqOptions = {
      hostname: '127.0.0.1',
      port: server.port,
      method: 'POST',
      path: `${SERVICE}StreamAgentStateUpdates`,
      agent: false,
      headers: {
        'Content-Type': 'application/connect+json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': server.csrf,
        'Content-Length': frame.length,
      },
    } as RequestOptions & { agent: unknown };

    const req = request(reqOptions, (res) => {
      if (res.statusCode !== 200) {
        finish(statusError(`Antigravity 接口 StreamAgentStateUpdates 返回 ${res.statusCode}`, res.statusCode ?? 0));
        return;
      }
      const headerBuf = Buffer.allocUnsafe(5);
      let headerBytes = 0;
      let inFrame = false;
      let frameFlag = 0;
      let frameRemaining = 0;

      const finalizeFrame = (): void => {
        inFrame = false;
        if (frameFlag === 0) {
          try {
            const tail = decoder!.end();
            if (tail) projector!.write(tail);
            const parsed = projector!.end<{ update?: unknown }>();
            projector = null;
            decoder = null;
            if (parsed?.update && typeof parsed.update === 'object') {
              finish(null, parsed.update as RemoteUpdateLike);
            }
          } catch (error) {
            finish(error);
          }
        } else if (frameFlag & 2) {
          const chunks = trailerChunks ?? [];
          trailerChunks = null;
          try {
            const raw = (chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)).toString('utf8');
            const parsed = JSON.parse(raw) as { error?: { message?: string; code?: string } };
            if (parsed.error) {
              finish(statusError(parsed.error.message || parsed.error.code || '远程会话访问受限', 403));
            }
          } catch {
            // Ignore malformed Connect trailer frames without an error object.
          }
        }
      };

      res.on('data', (chunk: Buffer) => {
        if (done || !chunk?.length) return;
        let pos = 0;
        while (pos < chunk.length && !done) {
          if (!inFrame) {
            const take = Math.min(5 - headerBytes, chunk.length - pos);
            chunk.copy(headerBuf, headerBytes, pos, pos + take);
            headerBytes += take;
            pos += take;
            if (headerBytes < 5) break;
            frameFlag = headerBuf.readUInt8(0);
            const len = headerBuf.readUInt32BE(1);
            headerBytes = 0;
            if (len > MAX_SNAPSHOT_BYTES) {
              finish(new Error('接口响应超过采集上限'));
              return;
            }
            inFrame = true;
            frameRemaining = len;
            if (frameFlag === 0) {
              projector = new TrajectoryJson({ modelTimelineEnabled: timelineEnabled });
              decoder = new StringDecoder('utf8');
            } else if (frameFlag & 2) {
              trailerChunks = [];
            }
            if (frameRemaining === 0) finalizeFrame();
          } else {
            const take = Math.min(frameRemaining, chunk.length - pos);
            const slice = chunk.subarray(pos, pos + take);
            pos += take;
            frameRemaining -= take;
            if (frameFlag === 0) {
              try {
                for (let off = 0; off < slice.length; off += SNAPSHOT_DECODE_CHUNK_BYTES) {
                  const part = slice.subarray(off, Math.min(slice.length, off + SNAPSHOT_DECODE_CHUNK_BYTES));
                  const text = decoder!.write(part);
                  if (text) projector!.write(text);
                }
              } catch (error) {
                finish(error);
                return;
              }
            } else if ((frameFlag & 2) && slice.length) {
              trailerChunks!.push(slice);
            }
            if (frameRemaining === 0) finalizeFrame();
          }
        }
      });
      res.on('error', (error: unknown) => finish(error));
      res.on('end', () => finish(new Error('会话暂时没有可用统计')));
    });
    req.on('error', (error: unknown) => finish(error));
    req.end(frame);
  });
}
