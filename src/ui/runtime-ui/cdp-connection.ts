import type {
  CdpConnectionOptions,
  CdpContextCandidate,
  CdpEventMessage,
  RuntimeSessionConnection,
  WebSocketConstructor,
  WebSocketLike,
  WebSocketMessageEvent,
} from './types.ts';

interface PendingCommand {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CdpConnection implements RuntimeSessionConnection {
  url: string;
  WebSocketImpl: WebSocketConstructor | undefined;
  timeout: number;
  onEvent: (message: CdpEventMessage) => void;
  onClose: () => void;
  pending: Map<number, PendingCommand>;
  nextId: number;
  closed: boolean;
  ws?: WebSocketLike;
  origin?: string;
  frameId?: string;
  contexts?: Set<number>;
  contextCandidates?: Map<number, CdpContextCandidate>;
  inflight?: number;
  mounted?: boolean;
  guardedSource?: string;
  script?: string;

  constructor(
    url: string,
    {
      WebSocketImpl = globalThis.WebSocket as unknown as WebSocketConstructor | undefined,
      timeout = 5000,
      onEvent = () => {},
      onClose = () => {},
    }: CdpConnectionOptions = {},
  ) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.timeout = timeout;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
  }

  async open(): Promise<this> {
    if (!this.WebSocketImpl) throw new Error('This Node runtime has no WebSocket support');
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    ws.addEventListener('message', (event: WebSocketMessageEvent) => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 2097152) return;
        const message = JSON.parse(event.data) as CdpEventMessage;
        if (message.id) {
          const item = this.pending.get(message.id);
          if (!item) return;
          this.pending.delete(message.id);
          clearTimeout(item.timer);
          if (message.error) {
            item.reject(new Error('Renderer command failed: ' + message.error.code));
          } else {
            item.resolve(message.result || {});
          }
        } else if (message.method) {
          this.onEvent(message);
        }
      } catch {
        // Ignore unrelated/malformed renderer events, without logging page data.
      }
    });
    ws.addEventListener('close', () => this.disconnect());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error('Renderer connection timeout'));
      }, this.timeout);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          this.close();
          reject(new Error('Renderer connection failed'));
        },
        { once: true },
      );
    });
    return this;
  }

  command(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.closed || this.ws?.readyState !== 1) {
      return Promise.reject(new Error('Renderer disconnected'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Renderer command timeout'));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws!.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Renderer disconnected'));
    }
    this.pending.clear();
    this.onClose();
  }

  close(): void {
    this.disconnect();
    this.ws?.close();
  }
}
