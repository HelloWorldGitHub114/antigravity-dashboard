// 轻量级本地 SQLite 尾部诊断读取器：
// 仅按需读取当前轮次的步骤状态跃迁、执行终止原因与最近几次请求的 retryInfos 报错文本，
// 用于支撑精准的请求失败归类、首字等待计时与本轮汇总，不依赖重新编译原生二进制。
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';

export interface SqliteTurnStep {
  idx: number;
  stepType: number;
  status: number;
  createdAtMs: number | null;
  inputStartedAtMs: number | null;
  generatingAtMs: number | null;
  recordedCompletedAtMs: number | null;
  terminalAtMs: number | null;
  executionId: string;
}

export interface SqliteExecutorRecord {
  reason: number;
  lastStepIndex: number;
  executionId: string;
}

export interface SqliteGenErrorTail {
  idx: number;
  stepIndices: number[];
  lastStepIndex: number;
  ttftSeconds: number | null;
  retryErrorText: string;
}

export interface SqliteTurnDiagnostics {
  userStepIndex: number | null;
  latestUserStepIndex: number | null;
  turnSteps: SqliteTurnStep[];
  executors: SqliteExecutorRecord[];
  recentRequests: SqliteGenErrorTail[];
  lastStepEpochMs: number | null;
}

interface DatabaseSyncLike {
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Array<Record<string, unknown>>;
  };
  close(): void;
}

type DatabaseSyncCtor = new (path: string, options: { readOnly: boolean }) => DatabaseSyncLike;

let cachedDbCtor: DatabaseSyncCtor | null | undefined;

function getDatabaseSyncCtor(): DatabaseSyncCtor | null {
  if (cachedDbCtor !== undefined) return cachedDbCtor;
  try {
    const req = createRequire(import.meta.url);
    const mod = req('node:sqlite') as { DatabaseSync?: DatabaseSyncCtor } | null;
    cachedDbCtor = typeof mod?.DatabaseSync === 'function' ? mod.DatabaseSync : null;
  } catch {
    cachedDbCtor = null;
  }
  return cachedDbCtor;
}

function readVarint(buf: Buffer, offset: number): [number, number] {
  let val = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length && i - offset < 10) {
    const b = buf[i++];
    if (i - offset === 10 && b > 1) throw new RangeError('Invalid protobuf varint');
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [Number(val), i];
    shift += 7n;
  }
  throw new RangeError('Truncated protobuf varint');
}

type PbFieldVal = number | Buffer;

function parsePbMap(buf: Buffer): Map<number, PbFieldVal[]> {
  const fields = new Map<number, PbFieldVal[]>();
  let i = 0;
  while (i < buf.length) {
    try {
      const [tag, nextI] = readVarint(buf, i);
      i = nextI;
      const fn = tag >>> 3;
      const wt = tag & 7;
      if (fn === 0) break;
      let list = fields.get(fn);
      if (!list) {
        list = [];
        fields.set(fn, list);
      }
      if (wt === 0) {
        const [val, nI] = readVarint(buf, i);
        i = nI;
        list.push(val);
      } else if (wt === 2) {
        const [len, nI] = readVarint(buf, i);
        i = nI;
        if (len < 0 || i + len > buf.length) break;
        list.push(buf.subarray(i, i + len));
        i += len;
      } else if (wt === 5) {
        if (i + 4 > buf.length) break;
        list.push(buf.subarray(i, i + 4));
        i += 4;
      } else if (wt === 1) {
        if (i + 8 > buf.length) break;
        list.push(buf.subarray(i, i + 8));
        i += 8;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return fields;
}

function toBuffer(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  return Buffer.alloc(0);
}

function pbEpochMs(raw: PbFieldVal | undefined): number | null {
  if (!Buffer.isBuffer(raw) || raw.length === 0) return null;
  const parts = parsePbMap(raw);
  const sec = parts.get(1)?.[0];
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return null;
  const nanos = typeof parts.get(2)?.[0] === 'number' ? (parts.get(2)![0] as number) : 0;
  const ms = sec * 1000 + nanos / 1e6;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function pbDurationSeconds(raw: PbFieldVal | undefined): number | null {
  if (!Buffer.isBuffer(raw) || raw.length === 0) return null;
  const parts = parsePbMap(raw);
  const sec = typeof parts.get(1)?.[0] === 'number' ? (parts.get(1)![0] as number) : 0;
  const nanos = typeof parts.get(2)?.[0] === 'number' ? (parts.get(2)![0] as number) : 0;
  const total = sec + nanos / 1e9;
  return Number.isFinite(total) && total >= 0 ? total : null;
}

function parseGenTail(idx: number, raw: unknown): SqliteGenErrorTail | null {
  const buf = toBuffer(raw);
  if (!buf.length) return null;
  const top = parsePbMap(buf);
  const chatBuf = top.get(1)?.[0];
  if (!Buffer.isBuffer(chatBuf)) return null;

  const stepIndices: number[] = [];
  for (const val of top.get(2) || []) {
    if (typeof val === 'number') {
      stepIndices.push(val);
    } else if (Buffer.isBuffer(val)) {
      let off = 0;
      while (off < val.length) {
        try {
          const [n, next] = readVarint(val, off);
          stepIndices.push(n);
          off = next;
        } catch {
          break;
        }
      }
    }
  }

  const chat = parsePbMap(chatBuf);
  const ttftSeconds = pbDurationSeconds(chat.get(11)?.[0]);

  // 仅读取最后一条 retry_infos 的 error 字段（ChatModelMetadata.17 -> RetryInfo.3），
  // 避免前序失败重试在最终成功后残留误报。
  const retries = chat.get(17) || [];
  const lastRetry = retries.at(-1);
  let retryErrorText = '';
  if (Buffer.isBuffer(lastRetry)) {
    const errVal = parsePbMap(lastRetry).get(3)?.[0];
    if (Buffer.isBuffer(errVal)) {
      retryErrorText = errVal.toString('utf8').trim();
    }
  }

  let lastStepIndex = -1;
  for (const kvVal of chat.get(20) || []) {
    if (!Buffer.isBuffer(kvVal)) continue;
    const kv = parsePbMap(kvVal);
    const kBuf = kv.get(1)?.[0];
    const vBuf = kv.get(2)?.[0];
    if (Buffer.isBuffer(kBuf) && Buffer.isBuffer(vBuf) && kBuf.toString('utf8') === 'last_step_index') {
      const n = Number(vBuf.toString('utf8'));
      if (Number.isInteger(n) && n >= 0) lastStepIndex = n;
      break;
    }
  }

  return { idx, stepIndices, lastStepIndex, ttftSeconds, retryErrorText };
}

function fileStampKey(path: string): string | null {
  try {
    const s = statSync(path);
    if (!s.isFile() || s.size === 0) return null;
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
}

interface CacheEntry {
  key: string;
  value: SqliteTurnDiagnostics;
}

const MAX_CACHE_ENTRIES = 12;
const diagCache = new Map<string, CacheEntry>();

function readRawDiagnostics(dbPath: string): SqliteTurnDiagnostics | null {
  const DbCtor = getDatabaseSyncCtor();
  if (!DbCtor) return null;
  const db = new DbCtor(dbPath, { readOnly: true });
  try {
    const userRow = db
      .prepare('SELECT idx FROM steps WHERE step_type = 14 AND status != 11 ORDER BY idx DESC LIMIT 1')
      .get();
    const latestUserRow = db
      .prepare('SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx DESC LIMIT 1')
      .get();
    const userStepIndex = typeof userRow?.idx === 'number' ? userRow.idx : null;
    const latestUserStepIndex = typeof latestUserRow?.idx === 'number' ? latestUserRow.idx : null;
    const firstTurnStep =
      userStepIndex !== null && latestUserStepIndex !== null
        ? Math.min(userStepIndex, latestUserStepIndex)
        : (userStepIndex ?? latestUserStepIndex);

    const turnSteps: SqliteTurnStep[] = [];
    if (firstTurnStep !== null) {
      const rows = db
        .prepare('SELECT idx, step_type, status, metadata FROM steps WHERE idx >= ? ORDER BY idx ASC')
        .all(firstTurnStep);
      for (const row of rows) {
        const idx = Number(row.idx);
        const stepType = Number(row.step_type);
        const status = Number(row.status);
        const fields = parsePbMap(toBuffer(row.metadata));
        const createdAtMs = pbEpochMs(fields.get(1)?.[0]);
        const recordedCompletedAtMs = pbEpochMs(fields.get(8)?.[0]) ?? pbEpochMs(fields.get(7)?.[0]);
        const execBuf = fields.get(12)?.[0];
        const executionId = Buffer.isBuffer(execBuf) ? execBuf.toString('utf8') : '';

        const transitionsBuf = fields.get(26)?.[0];
        const transitions = Buffer.isBuffer(transitionsBuf)
          ? (parsePbMap(transitionsBuf).get(1) || [])
              .filter((v): v is Buffer => Buffer.isBuffer(v))
              .map((v) => parsePbMap(v))
          : [];

        const generatingTimes: number[] = [];
        const terminalTimes: number[] = [];
        let inputStartedAtMs: number | null = null;
        for (const item of transitions) {
          const st = item.get(1)?.[0];
          const ts = pbEpochMs(item.get(2)?.[0]);
          if (typeof st !== 'number' || ts === null) continue;
          if (st === 8) generatingTimes.push(ts);
          if (st === 3 || st === 6 || st === 7 || st === 12) terminalTimes.push(ts);
          if (stepType === 14) {
            // 排队中的消息创建时间早于真正开始消费的时间，仅从非排队态起算首字等待
            if (st === 11) inputStartedAtMs = null;
            else if ((st === 2 || st === 3) && inputStartedAtMs === null) inputStartedAtMs = ts;
          }
        }

        turnSteps.push({
          idx,
          stepType,
          status,
          createdAtMs,
          inputStartedAtMs,
          generatingAtMs: generatingTimes.length ? Math.min(...generatingTimes) : null,
          recordedCompletedAtMs,
          terminalAtMs: terminalTimes.length ? Math.max(...terminalTimes) : null,
          executionId,
        });
      }
    }

    const executors: SqliteExecutorRecord[] = [];
    const hasExecTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='executor_metadata'")
      .get();
    if (hasExecTable) {
      const execRows = db.prepare('SELECT data FROM executor_metadata ORDER BY idx ASC').all();
      for (const row of execRows) {
        const fields = parsePbMap(toBuffer(row.data));
        if (!fields.size) continue;
        const reason = typeof fields.get(1)?.[0] === 'number' ? (fields.get(1)![0] as number) : 0;
        const lastStepIndex =
          typeof fields.get(3)?.[0] === 'number' ? (fields.get(3)![0] as number) : 0;
        const execBuf = fields.get(9)?.[0];
        const executionId = Buffer.isBuffer(execBuf) ? execBuf.toString('utf8') : '';
        executors.push({ reason, lastStepIndex, executionId });
      }
    }

    const genRows = db
      .prepare('SELECT idx, data FROM gen_metadata ORDER BY idx DESC LIMIT 8')
      .all()
      .reverse();
    const recentRequests: SqliteGenErrorTail[] = [];
    for (const row of genRows) {
      const parsed = parseGenTail(Number(row.idx), row.data);
      if (parsed) recentRequests.push(parsed);
    }

    let lastStepEpochMs: number | null = null;
    const latestStepRow = db.prepare('SELECT metadata FROM steps ORDER BY idx DESC LIMIT 1').get();
    if (latestStepRow?.metadata) {
      const sm = parsePbMap(toBuffer(latestStepRow.metadata));
      lastStepEpochMs = pbEpochMs(sm.get(8)?.[0]) ?? pbEpochMs(sm.get(7)?.[0]) ?? pbEpochMs(sm.get(1)?.[0]);
    }

    return {
      userStepIndex,
      latestUserStepIndex,
      turnSteps,
      executors,
      recentRequests,
      lastStepEpochMs,
    };
  } finally {
    db.close();
  }
}

/**
 * 读取本地会话 SQLite 的尾部诊断信息，按 `.db` 与 `-wal` 文件指纹做轻量 LRU 缓存。
 * 任何只读打开冲突或运行环境缺少 `node:sqlite` 时返回 `null`，不影响主统计流程。
 */
export function readSqliteTurnDiagnostics(dbPath: string | null | undefined): SqliteTurnDiagnostics | null {
  if (!dbPath || typeof dbPath !== 'string') return null;
  const dbKey = fileStampKey(dbPath);
  if (!dbKey) {
    diagCache.delete(dbPath);
    return null;
  }
  const key = `${dbKey}|${fileStampKey(`${dbPath}-wal`) || 'no-wal'}`;
  const cached = diagCache.get(dbPath);
  if (cached && cached.key === key) {
    diagCache.delete(dbPath);
    diagCache.set(dbPath, cached);
    return cached.value;
  }
  try {
    const value = readRawDiagnostics(dbPath);
    if (!value) return cached?.value ?? null;
    diagCache.delete(dbPath);
    diagCache.set(dbPath, { key, value });
    if (diagCache.size > MAX_CACHE_ENTRIES) {
      const oldest = diagCache.keys().next().value;
      if (oldest) diagCache.delete(oldest);
    }
    return value;
  } catch {
    return cached?.value ?? null;
  }
}
