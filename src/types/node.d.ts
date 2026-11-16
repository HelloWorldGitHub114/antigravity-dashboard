declare namespace NodeJS {
  interface Dict<T> {
    [key: string]: T | undefined;
  }

  interface ProcessEnv extends Dict<string> {}

  interface ErrnoException extends Error {
    errno?: number;
    code?: string;
    path?: string;
    syscall?: string;
  }

  interface Timer {
    ref(): this;
    unref(): this;
    refresh(): this;
    hasRef?(): boolean;
  }

  interface Timeout extends Timer {}
  interface Immediate extends Timer {}

  interface ReadableStream {
    isTTY?: boolean;
    setEncoding?(encoding: BufferEncoding): this;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    read?(size?: number): string | Buffer | null;
    [Symbol.asyncIterator](): AsyncIterableIterator<string | Buffer>;
  }

  interface WritableStream {
    isTTY?: boolean;
    columns?: number;
    rows?: number;
    write(chunk: string | Uint8Array, cb?: (err?: Error | null) => void): boolean;
    write(chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (err?: Error | null) => void): boolean;
    end(cb?: () => void): this;
  }

  interface Process {
    readonly argv: string[];
    readonly execPath: string;
    readonly execArgv: string[];
    readonly env: ProcessEnv;
    readonly platform: string;
    readonly arch: string;
    readonly pid: number;
    readonly ppid: number;
    readonly version: string;
    readonly versions: Record<string, string | undefined>;
    readonly stdin: ReadableStream;
    readonly stdout: WritableStream;
    readonly stderr: WritableStream;
    exitCode?: number | string;
    cwd(): string;
    chdir(directory: string): void;
    exit(code?: number): never;
    uptime(): number;
    hrtime: {
      (time?: [number, number]): [number, number];
      bigint(): bigint;
    };
    memoryUsage(): {
      rss: number;
      heapTotal: number;
      heapUsed: number;
      external: number;
      arrayBuffers: number;
    };
    kill(pid: number, signal?: string | number): true;
    nextTick(callback: (...args: any[]) => void, ...args: any[]): void;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
  }
}

type BufferEncoding =
  | 'ascii'
  | 'utf8'
  | 'utf-8'
  | 'utf16le'
  | 'utf-16le'
  | 'ucs2'
  | 'ucs-2'
  | 'base64'
  | 'base64url'
  | 'latin1'
  | 'binary'
  | 'hex';

interface Buffer extends Uint8Array<ArrayBuffer> {
  write(string: string, offset?: number, length?: number, encoding?: BufferEncoding): number;
  toString(encoding?: BufferEncoding, start?: number, end?: number): string;
  toJSON(): { type: 'Buffer'; data: number[] };
  equals(otherBuffer: Uint8Array<ArrayBufferLike>): boolean;
  compare(target: Uint8Array<ArrayBufferLike>, targetStart?: number, targetEnd?: number, sourceStart?: number, sourceEnd?: number): number;
  copy(target: Uint8Array<ArrayBufferLike>, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
  slice(start?: number, end?: number): Buffer;
  subarray(start?: number, end?: number): Buffer;
  indexOf(value: string | number | Uint8Array<ArrayBufferLike>, byteOffset?: number, encoding?: BufferEncoding): number;
  lastIndexOf(value: string | number | Uint8Array<ArrayBufferLike>, byteOffset?: number, encoding?: BufferEncoding): number;
  includes(value: string | number | Uint8Array<ArrayBufferLike>, byteOffset?: number, encoding?: BufferEncoding): boolean;
  readUInt8(offset?: number): number;
  writeUInt8(value: number, offset?: number): number;
  readUInt16LE(offset?: number): number;
  writeUInt16LE(value: number, offset?: number): number;
  readUInt32BE(offset?: number): number;
  readUInt32LE(offset?: number): number;
  writeUInt32BE(value: number, offset?: number): number;
  writeUInt32LE(value: number, offset?: number): number;
}

interface BufferConstructor {
  new (arrayBuffer: ArrayBufferLike, byteOffset?: number, length?: number): Buffer;
  from(arrayBuffer: ArrayBufferLike, byteOffset?: number, length?: number): Buffer;
  from(data: Uint8Array<ArrayBufferLike> | readonly number[]): Buffer;
  from(str: string, encoding?: BufferEncoding): Buffer;
  alloc(size: number, fill?: string | Uint8Array<ArrayBufferLike> | number, encoding?: BufferEncoding): Buffer;
  allocUnsafe(size: number): Buffer;
  concat(list: ReadonlyArray<Uint8Array<ArrayBufferLike>>, totalLength?: number): Buffer;
  isBuffer(obj: unknown): obj is Buffer;
  byteLength(string: string | ArrayBufferView | ArrayBufferLike, encoding?: BufferEncoding): number;
}

declare var Buffer: BufferConstructor;
declare var process: NodeJS.Process;

declare function setImmediate(callback: (...args: any[]) => void, ...args: any[]): NodeJS.Immediate;
declare function clearImmediate(immediateId: NodeJS.Immediate | undefined): void;

declare module 'node:fs' {
  export interface Stats {
    dev: number;
    ino: number;
    mode: number;
    nlink: number;
    uid: number;
    gid: number;
    rdev: number;
    size: number;
    blksize: number;
    blocks: number;
    atimeMs: number;
    mtimeMs: number;
    ctimeMs: number;
    birthtimeMs: number;
    atime: Date;
    mtime: Date;
    ctime: Date;
    birthtime: Date;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }

  export interface Dirent {
    name: string;
    parentPath?: string;
    path?: string;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }

  export interface ReadStream extends NodeJS.ReadableStream {
    close(callback?: (err?: Error | null) => void): void;
    destroy(error?: Error): this;
  }

  export interface WriteStream extends NodeJS.WritableStream {
    close(callback?: (err?: Error | null) => void): void;
    destroy(error?: Error): this;
  }

  export type PathLike = string | Buffer | URL;

  export function existsSync(path: PathLike): boolean;
  export function readFileSync(path: PathLike | number, options?: { encoding?: null; flag?: string } | null): Buffer;
  export function readFileSync(path: PathLike | number, options: { encoding: BufferEncoding; flag?: string } | BufferEncoding): string;
  export function readFileSync(path: PathLike | number, options?: { encoding?: BufferEncoding | null; flag?: string } | BufferEncoding | null): string | Buffer;
  export function writeFileSync(file: PathLike | number, data: string | ArrayBufferView, options?: { encoding?: BufferEncoding | null; mode?: number; flag?: string } | BufferEncoding): void;
  export function appendFileSync(path: PathLike | number, data: string | Uint8Array, options?: { encoding?: BufferEncoding | null; mode?: number; flag?: string } | BufferEncoding): void;
  export function mkdirSync(path: PathLike, options?: { recursive?: boolean; mode?: number } | number): string | undefined;
  export function readdirSync(path: PathLike, options?: { encoding?: BufferEncoding | null; withFileTypes?: false; recursive?: boolean } | BufferEncoding | null): string[];
  export function readdirSync(path: PathLike, options: { encoding?: BufferEncoding | null; withFileTypes: true; recursive?: boolean }): Dirent[];
  export function statSync(path: PathLike, options?: { bigint?: false; throwIfNoEntry?: true }): Stats;
  export function statSync(path: PathLike, options: { bigint?: false; throwIfNoEntry: false }): Stats | undefined;
  export function lstatSync(path: PathLike, options?: { bigint?: false; throwIfNoEntry?: true }): Stats;
  export function lstatSync(path: PathLike, options: { bigint?: false; throwIfNoEntry: false }): Stats | undefined;
  export function renameSync(oldPath: PathLike, newPath: PathLike): void;
  export function unlinkSync(path: PathLike): void;
  export function rmSync(path: PathLike, options?: { force?: boolean; recursive?: boolean; maxRetries?: number; retryDelay?: number }): void;
  export function copyFileSync(src: PathLike, dest: PathLike, mode?: number): void;
  export function cpSync(src: PathLike, dest: PathLike, options?: { recursive?: boolean; force?: boolean; filter?: (src: string, dest: string) => boolean }): void;
  export function chmodSync(path: PathLike, mode: string | number): void;
  export function symlinkSync(target: PathLike, path: PathLike, type?: 'dir' | 'file' | 'junction'): void;
  export function readlinkSync(path: PathLike, options?: { encoding?: BufferEncoding | null } | BufferEncoding): string;
  export function realpathSync(path: PathLike, options?: { encoding?: BufferEncoding | null } | BufferEncoding): string;
  export function openSync(path: PathLike, flags: string | number, mode?: number): number;
  export function closeSync(fd: number): void;
  export function fsyncSync(fd: number): void;
  export function readSync(fd: number, buffer: ArrayBufferView, offset: number, length: number, position: number | null): number;
  export function writeSync(fd: number, buffer: ArrayBufferView | string, position?: number | null, encoding?: BufferEncoding): number;
  export function createReadStream(path: PathLike, options?: string | { encoding?: BufferEncoding; start?: number; end?: number; highWaterMark?: number }): ReadStream;
  export function createWriteStream(path: PathLike, options?: string | { encoding?: BufferEncoding; flags?: string; mode?: number }): WriteStream;
  export function watch(filename: PathLike, options?: { persistent?: boolean; recursive?: boolean; encoding?: BufferEncoding }, listener?: (eventType: string, filename: string | null) => void): { close(): void; ref?(): void; unref?(): void };
}

declare module 'node:fs/promises' {
  import type { Stats, Dirent, PathLike } from 'node:fs';

  export interface FileHandle {
    readonly fd: number;
    read(buffer: ArrayBufferView, offset?: number, length?: number, position?: number | null): Promise<{ bytesRead: number; buffer: ArrayBufferView }>;
    readFile(options?: { encoding?: null; flag?: string } | null): Promise<Buffer>;
    readFile(options: { encoding: BufferEncoding; flag?: string } | BufferEncoding): Promise<string>;
    writeFile(data: string | Uint8Array, options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<void>;
    stat(): Promise<Stats>;
    sync(): Promise<void>;
    datasync(): Promise<void>;
    close(): Promise<void>;
  }

  export function open(path: PathLike, flags?: string | number, mode?: number): Promise<FileHandle>;
  export function readFile(path: PathLike, options?: { encoding?: null; flag?: string; signal?: AbortSignal } | null): Promise<Buffer>;
  export function readFile(path: PathLike, options: { encoding: BufferEncoding; flag?: string; signal?: AbortSignal } | BufferEncoding): Promise<string>;
  export function readFile(path: PathLike, options?: { encoding?: BufferEncoding | null; flag?: string; signal?: AbortSignal } | BufferEncoding | null): Promise<string | Buffer>;
  export function writeFile(file: PathLike, data: string | Uint8Array, options?: { encoding?: BufferEncoding | null; mode?: number; flag?: string; signal?: AbortSignal } | BufferEncoding): Promise<void>;
  export function appendFile(path: PathLike, data: string | Uint8Array, options?: { encoding?: BufferEncoding | null; mode?: number; flag?: string } | BufferEncoding): Promise<void>;
  export function mkdir(path: PathLike, options?: { recursive?: boolean; mode?: number } | number): Promise<string | undefined>;
  export function readdir(path: PathLike, options?: { encoding?: BufferEncoding | null; withFileTypes?: false; recursive?: boolean } | BufferEncoding | null): Promise<string[]>;
  export function readdir(path: PathLike, options: { encoding?: BufferEncoding | null; withFileTypes: true; recursive?: boolean }): Promise<Dirent[]>;
  export function stat(path: PathLike): Promise<Stats>;
  export function lstat(path: PathLike): Promise<Stats>;
  export function rename(oldPath: PathLike, newPath: PathLike): Promise<void>;
  export function unlink(path: PathLike): Promise<void>;
  export function rm(path: PathLike, options?: { force?: boolean; recursive?: boolean; maxRetries?: number; retryDelay?: number }): Promise<void>;
  export function copyFile(src: PathLike, dest: PathLike, mode?: number): Promise<void>;
  export function cp(src: PathLike, dest: PathLike, options?: { recursive?: boolean; force?: boolean; filter?: (src: string, dest: string) => boolean }): Promise<void>;
  export function chmod(path: PathLike, mode: string | number): Promise<void>;
  export function symlink(target: PathLike, path: PathLike, type?: 'dir' | 'file' | 'junction'): Promise<void>;
  export interface Dir extends AsyncIterable<Dirent> {
    readonly path: string;
    read(): Promise<Dirent | null>;
    close(): Promise<void>;
  }

  export function opendir(path: PathLike, options?: { encoding?: BufferEncoding; bufferSize?: number; recursive?: boolean }): Promise<Dir>;
  export function readlink(path: PathLike, options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<string>;
  export function realpath(path: PathLike): Promise<string>;
  export function access(path: PathLike, mode?: number): Promise<void>;
}

declare module 'node:path' {
  export interface ParsedPath {
    root: string;
    dir: string;
    base: string;
    ext: string;
    name: string;
  }

  export const sep: '/' | '\\';
  export const delimiter: ';' | ':';
  export function basename(path: string, suffix?: string): string;
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function normalize(path: string): string;
  export function parse(path: string): ParsedPath;
  export function format(pathObject: Partial<ParsedPath>): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
  export const posix: typeof import('node:path');
  export const win32: typeof import('node:path');
}

declare module 'node:os' {
  export function homedir(): string;
  export function tmpdir(): string;
  export function platform(): string;
  export function arch(): string;
  export function hostname(): string;
  export function cpus(): Array<{ model: string; speed: number }>;
  export function totalmem(): number;
  export function freemem(): number;
  export const EOL: string;
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: string | Uint8Array, inputEncoding?: BufferEncoding): this;
    digest(): Buffer;
    digest(encoding: 'hex' | 'base64' | 'base64url' | 'latin1' | 'binary'): string;
  }

  export function createHash(algorithm: string): Hash;
  export function randomUUID(): string;
  export function randomBytes(size: number): Buffer;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module 'node:events' {
  export class EventEmitter {
    on(eventName: string | symbol, listener: (...args: any[]) => void): this;
    once(eventName: string | symbol, listener: (...args: any[]) => void): this;
    off(eventName: string | symbol, listener: (...args: any[]) => void): this;
    addListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
    removeListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
    removeAllListeners(eventName?: string | symbol): this;
    emit(eventName: string | symbol, ...args: any[]): boolean;
    listenerCount(eventName: string | symbol): number;
  }
}

declare module 'node:stream' {
  import type { EventEmitter } from 'node:events';

  export class Readable extends EventEmitter {
    setEncoding(encoding: BufferEncoding): this;
    read(size?: number): any;
    pause(): this;
    resume(): this;
    destroy(error?: Error): this;
    pipe<T extends Writable>(destination: T): T;
    [Symbol.asyncIterator](): AsyncIterableIterator<any>;
  }

  export class Writable extends EventEmitter {
    write(chunk: any, cb?: (error?: Error | null) => void): boolean;
    write(chunk: any, encoding?: BufferEncoding, cb?: (error?: Error | null) => void): boolean;
    end(cb?: () => void): this;
    end(chunk: any, cb?: () => void): this;
    end(chunk: any, encoding?: BufferEncoding, cb?: () => void): this;
    destroy(error?: Error): this;
  }

  export class Duplex extends Readable {
    write(chunk: any, cb?: (error?: Error | null) => void): boolean;
    write(chunk: any, encoding?: BufferEncoding, cb?: (error?: Error | null) => void): boolean;
    end(cb?: () => void): this;
    end(chunk: any, cb?: () => void): this;
    end(chunk: any, encoding?: BufferEncoding, cb?: () => void): this;
  }

  export class Transform extends Duplex {}
  export function pipeline(...streams: Array<Readable | Writable | Duplex | Transform | ((err: Error | null) => void)>): any;
}

declare module 'node:net' {
  import type { EventEmitter } from 'node:events';
  import type { Duplex } from 'node:stream';

  export interface AddressInfo {
    address: string;
    family: string;
    port: number;
  }

  export class Socket extends Duplex {
    remoteAddress?: string;
    remotePort?: number;
    localAddress?: string;
    localPort?: number;
    setTimeout(timeout: number, callback?: () => void): this;
    setNoDelay(noDelay?: boolean): this;
    unref(): this;
    ref(): this;
  }

  export class Server extends EventEmitter {
    listen(port?: number, host?: string, listeningListener?: () => void): this;
    listen(options: { port?: number; host?: string; path?: string }, listeningListener?: () => void): this;
    close(callback?: (err?: Error) => void): this;
    address(): AddressInfo | string | null;
    unref(): this;
    ref(): this;
  }

  export function createServer(connectionListener?: (socket: Socket) => void): Server;
  export function createConnection(options: { port: number; host?: string; timeout?: number }, connectionListener?: () => void): Socket;
  export function connect(options: { port: number; host?: string; timeout?: number }, connectionListener?: () => void): Socket;
}

declare module 'node:http' {
  import type { EventEmitter } from 'node:events';
  import type { Readable, Writable } from 'node:stream';
  import type { AddressInfo, Server as NetServer, Socket } from 'node:net';

  export interface IncomingHttpHeaders {
    [header: string]: string | string[] | undefined;
  }

  export class IncomingMessage extends Readable {
    headers: IncomingHttpHeaders;
    method?: string;
    url?: string;
    statusCode?: number;
    statusMessage?: string;
    socket: Socket;
  }

  export class ServerResponse extends Writable {
    statusCode: number;
    statusMessage: string;
    headersSent: boolean;
    setHeader(name: string, value: number | string | readonly string[]): this;
    getHeader(name: string): number | string | string[] | undefined;
    removeHeader(name: string): void;
    writeHead(statusCode: number, headers?: Record<string, number | string | readonly string[]>): this;
    writeHead(statusCode: number, statusMessage?: string, headers?: Record<string, number | string | readonly string[]>): this;
    end(data?: string | Uint8Array, cb?: () => void): this;
    end(data?: string | Uint8Array, encoding?: BufferEncoding, cb?: () => void): this;
  }

  export class ClientRequest extends Writable {
    destroyed: boolean;
    setTimeout(timeout: number, callback?: () => void): this;
    abort(): void;
  }

  export interface AgentOptions {
    keepAlive?: boolean;
    maxSockets?: number;
    maxFreeSockets?: number;
    timeout?: number;
  }

  export class Agent {
    constructor(options?: AgentOptions);
    destroy(): void;
  }

  export class Server extends EventEmitter {
    listen(port?: number, host?: string, listeningListener?: () => void): this;
    close(callback?: (err?: Error) => void): this;
    closeAllConnections?(): void;
    address(): AddressInfo | string | null;
    unref(): this;
    ref(): this;
  }

  export interface RequestOptions {
    protocol?: string;
    hostname?: string;
    host?: string;
    port?: number | string;
    path?: string;
    method?: string;
    headers?: Record<string, number | string | readonly string[]>;
    timeout?: number;
    signal?: AbortSignal;
    agent?: Agent | boolean;
  }

  export function createServer(requestListener?: (req: IncomingMessage, res: ServerResponse) => void): Server;
  export function request(url: string | URL, options?: RequestOptions, callback?: (res: IncomingMessage) => void): ClientRequest;
  export function request(options: RequestOptions, callback?: (res: IncomingMessage) => void): ClientRequest;
  export function get(url: string | URL, options?: RequestOptions, callback?: (res: IncomingMessage) => void): ClientRequest;
  export function get(options: RequestOptions, callback?: (res: IncomingMessage) => void): ClientRequest;
}

declare module 'node:child_process' {
  import type { EventEmitter } from 'node:events';
  import type { Readable, Writable } from 'node:stream';

  export interface ChildProcess extends EventEmitter {
    pid?: number;
    stdin: Writable | null;
    stdout: Readable | null;
    stderr: Readable | null;
    killed: boolean;
    exitCode: number | null;
    signalCode: string | null;
    kill(signal?: string | number): boolean;
    unref(): void;
    ref(): void;
  }

  export interface SpawnOptions {
    cwd?: string | URL;
    env?: NodeJS.ProcessEnv;
    stdio?: unknown;
    detached?: boolean;
    shell?: boolean | string;
    windowsHide?: boolean;
    signal?: AbortSignal;
  }

  export interface ExecFileOptions {
    cwd?: string | URL;
    env?: NodeJS.ProcessEnv;
    encoding?: BufferEncoding | 'buffer';
    stdio?: unknown;
    timeout?: number;
    maxBuffer?: number;
    windowsHide?: boolean;
    signal?: AbortSignal;
  }

  export interface SpawnSyncReturns<T> {
    pid: number;
    output: Array<T | null>;
    stdout: T;
    stderr: T;
    status: number | null;
    signal: string | null;
    error?: Error;
  }

  export function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
  export function spawnSync(command: string, args?: readonly string[], options?: SpawnOptions & { encoding?: BufferEncoding; input?: string | Uint8Array }): SpawnSyncReturns<string | Buffer>;
  export function execFile(file: string, args?: readonly string[], options?: ExecFileOptions, callback?: (error: NodeJS.ErrnoException | null, stdout: string | Buffer, stderr: string | Buffer) => void): ChildProcess;
  export function execFileSync(file: string, args: readonly string[] | undefined, options: ExecFileOptions & { encoding: BufferEncoding; input?: string | Uint8Array }): string;
  export function execFileSync(file: string, args?: readonly string[], options?: ExecFileOptions & { input?: string | Uint8Array }): string | Buffer;
}

declare module 'node:util' {
  export function promisify<TArgs extends any[], TResult>(fn: (...args: [...TArgs, (err: any, result: TResult) => void]) => void): (...args: TArgs) => Promise<TResult>;
  export function promisify<TCustom extends (...args: any[]) => any>(fn: TCustom): TCustom;
  export function inspect(object: unknown, options?: { depth?: number | null; colors?: boolean }): string;
  export function format(format?: unknown, ...param: unknown[]): string;
  export function parseArgs(config?: {
    args?: string[];
    options?: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean; default?: unknown }>;
    strict?: boolean;
    allowPositionals?: boolean;
  }): { values: Record<string, any>; positionals: string[] };
}

declare module 'node:module' {
  export interface NodeRequire {
    (id: string): any;
    resolve(id: string, options?: { paths?: string[] }): string;
  }
  export function createRequire(filename: string | URL): NodeRequire;
  export const builtinModules: string[];
}

declare module 'node:timers/promises' {
  export function setTimeout<T = void>(delay?: number, value?: T, options?: { ref?: boolean; signal?: AbortSignal }): Promise<T>;
  export function setImmediate<T = void>(value?: T, options?: { ref?: boolean; signal?: AbortSignal }): Promise<T>;
  export function setInterval<T = void>(delay?: number, value?: T, options?: { ref?: boolean; signal?: AbortSignal }): AsyncIterable<T>;
}

declare module 'node:zlib' {
  import type { Transform } from 'node:stream';

  export interface ZlibOptions {
    level?: number;
    memLevel?: number;
    strategy?: number;
    windowBits?: number;
  }

  export function gzipSync(buf: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function gunzipSync(buf: Uint8Array, options?: ZlibOptions): Buffer;
  export function deflateRawSync(buf: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function inflateRawSync(buf: Uint8Array, options?: ZlibOptions): Buffer;
  export function createGzip(options?: ZlibOptions): Transform;
  export function createGunzip(options?: ZlibOptions): Transform;
}

declare module 'node:string_decoder' {
  export class StringDecoder {
    constructor(encoding?: BufferEncoding);
    write(buffer: Uint8Array<ArrayBufferLike>): string;
    end(buffer?: Uint8Array<ArrayBufferLike>): string;
  }
}
