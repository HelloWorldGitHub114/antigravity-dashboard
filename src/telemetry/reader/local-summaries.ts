import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ConversationSummary } from '../../contracts/metrics.ts';
import {
  isNativeAccelAvailable,
  readSqliteConversationMeta,
  readSqliteConversationSummaries,
  type SqliteConversationSummaryRow,
} from '../../platform/native-bridge.ts';
import { conversationId, defaultConversationsDir } from './local-conversations.ts';

export interface LocalSummaryRecord {
  summary?: string;
  lastModifiedTime: string;
  status: string;
  stepCount?: number;
  workspaces?: Array<{ workspaceFolderAbsoluteUri: string }>;
  trajectoryMetadata?: {
    parentConversationId?: string;
    rootConversationId?: string;
    nestingDepth?: number;
    subagentRole?: string;
    subagentSpec?: {
      typeName?: string;
      role?: string;
      inherit?: boolean;
      model?: string;
      modelTier?: string;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface LocalSummariesResult {
  rawSummaries: Record<string, LocalSummaryRecord>;
  summaries: ConversationSummary[];
}

interface SummaryCacheEntry {
  stamp: string;
  result: LocalSummariesResult;
}

const summaryCache = new Map<string, SummaryCacheEntry>();

function normalizeMs(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function parseWorkspaceUris(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v || '').trim()).filter(Boolean);
    } catch {
      // Fall through to delimiter splitting.
    }
  }
  return trimmed
    .split(/[\r\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Compute a lightweight stat signature across a SQLite `.db` file and its optional `-wal` companion.
 */
export async function statSqliteDbStamp(dbPath: string): Promise<string | null> {
  if (!dbPath) return null;
  let mainStat: { size: number; mtimeMs: number };
  try {
    const info = await stat(dbPath);
    if (!info.isFile()) return null;
    mainStat = { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
  let walPart = '0:0';
  try {
    const wal = await stat(`${dbPath}-wal`);
    if (wal.isFile()) walPart = `${wal.size}:${Math.trunc(wal.mtimeMs)}`;
  } catch {
    // Missing WAL file is normal for checkpointed databases.
  }
  return `${mainStat.size}:${Math.trunc(mainStat.mtimeMs)}|${walPart}`;
}

function readSummaryDbWithNodeSqlite(dbPath: string): SqliteConversationSummaryRow[] | null {
  if (!dbPath || !existsSync(dbPath)) return null;
  try {
    const req = createRequire(import.meta.url);
    const mod = req('node:sqlite') as {
      DatabaseSync?: new (
        path: string,
        opts?: { readOnly?: boolean },
      ) => { prepare(sql: string): { all(): Array<Record<string, unknown>> }; close(): void };
    };
    const DatabaseSync = mod.DatabaseSync;
    if (typeof DatabaseSync !== 'function') return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT conversation_id, COALESCE(title, '') AS title, COALESCE(preview, '') AS preview,
                  COALESCE(last_modified_time, 0) AS last_modified_time, COALESCE(workspace_uris, '') AS workspace_uris,
                  COALESCE(project_id, '') AS project_id, COALESCE(parent_conversation_id, '') AS parent_conversation_id,
                  COALESCE(source, '') AS source, COALESCE(agent_name, '') AS agent_name
           FROM conversation_summaries`,
        )
        .all();
      return rows.map((r) => {
        const vals = Object.values(r);
        return {
          conversationId: String(r.conversation_id ?? vals[0] ?? ''),
          title: String(r.title ?? vals[1] ?? ''),
          preview: String(r.preview ?? vals[2] ?? ''),
          lastModifiedTime: normalizeMs(r.last_modified_time ?? vals[3]),
          workspaceUris: String(r.workspace_uris ?? vals[4] ?? ''),
          projectId: String(r.project_id ?? vals[5] ?? ''),
          parentConversationId: String(r.parent_conversation_id ?? vals[6] ?? ''),
          source: String(r.source ?? vals[7] ?? ''),
          agentName: String(r.agent_name ?? vals[8] ?? ''),
        };
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function rowsToSummaries(rows: readonly SqliteConversationSummaryRow[]): LocalSummariesResult {
  const rawSummaries: Record<string, LocalSummaryRecord> = {};
  const list: Array<{ ts: number; item: ConversationSummary }> = [];
  for (const row of rows) {
    const id = typeof row.conversationId === 'string' ? row.conversationId.trim() : '';
    if (!id) continue;
    const ts = normalizeMs(row.lastModifiedTime);
    const modifiedAt = ts > 0 ? new Date(ts).toISOString() : '';
    const cleanTitle = (row.title || '').replace(/\s+/g, ' ').trim();
    const agentName = (row.agentName || '').replace(/\s+/g, ' ').trim();
    const displayTitle = cleanTitle || agentName || '未命名会话';
    const parentId = (row.parentConversationId || '').trim();
    const uris = parseWorkspaceUris(row.workspaceUris);
    const trajectoryMetadata: NonNullable<LocalSummaryRecord['trajectoryMetadata']> = {
      ...(parentId ? { parentConversationId: parentId } : {}),
      ...(agentName ? { subagentRole: agentName } : {}),
    };
    const raw: LocalSummaryRecord = {
      ...(cleanTitle ? { summary: cleanTitle } : {}),
      lastModifiedTime: modifiedAt,
      status: '',
      ...(uris.length ? { workspaces: uris.map((u) => ({ workspaceFolderAbsoluteUri: u })) } : {}),
      ...(Object.keys(trajectoryMetadata).length ? { trajectoryMetadata } : {}),
    };
    rawSummaries[id] = raw;
    list.push({
      ts,
      item: {
        id,
        title: displayTitle,
        modifiedAt,
        status: '',
        stepCount: 0,
      },
    });
  }
  list.sort((a, b) => b.ts - a.ts);
  return { rawSummaries, summaries: list.map((r) => r.item) };
}

async function fallbackScanConversationsDir(conversationsDir: string): Promise<LocalSummariesResult> {
  const rawSummaries: Record<string, LocalSummaryRecord> = {};
  const entries: Array<{ id: string; dbPath: string; ts: number }> = [];
  try {
    const names = await readdir(conversationsDir);
    for (const name of names) {
      if (!name.endsWith('.db')) continue;
      const id = name.slice(0, -3);
      if (!conversationId.test(id)) continue;
      const dbPath = join(conversationsDir, name);
      try {
        const main = await stat(dbPath);
        if (!main.isFile()) continue;
        let ts = main.mtimeMs;
        try {
          const wal = await stat(`${dbPath}-wal`);
          if (wal.isFile() && wal.mtimeMs > ts) ts = wal.mtimeMs;
        } catch {
          // No WAL file.
        }
        entries.push({ id, dbPath, ts });
      } catch {
        // Skip disappearing files.
      }
    }
  } catch {
    return { rawSummaries: {}, summaries: [] };
  }
  entries.sort((a, b) => b.ts - a.ts);
  const top = entries.slice(0, 64);
  const summaries: ConversationSummary[] = [];
  const canReadMeta = isNativeAccelAvailable();
  for (const item of top) {
    const modifiedAt = item.ts > 0 ? new Date(item.ts).toISOString() : '';
    const meta = canReadMeta ? readSqliteConversationMeta(item.dbPath, item.id) : null;
    const specRole =
      (typeof meta?.subagentSpec?.role === 'string' && meta.subagentSpec.role.trim()) ||
      (typeof meta?.subagentSpec?.typeName === 'string' && meta.subagentSpec.typeName.trim()) ||
      '';
    const trajectoryMetadata: NonNullable<LocalSummaryRecord['trajectoryMetadata']> = {
      ...(meta?.parentConversationId ? { parentConversationId: meta.parentConversationId } : {}),
      ...(meta?.rootConversationId ? { rootConversationId: meta.rootConversationId } : {}),
      ...(typeof meta?.nestingDepth === 'number' ? { nestingDepth: meta.nestingDepth } : {}),
      ...(meta?.subagentSpec ? { subagentSpec: meta.subagentSpec } : {}),
    };
    const raw: LocalSummaryRecord = {
      lastModifiedTime: modifiedAt,
      status: '',
      ...(typeof meta?.stepCount === 'number' ? { stepCount: meta.stepCount } : {}),
      ...(Object.keys(trajectoryMetadata).length ? { trajectoryMetadata } : {}),
    };
    rawSummaries[item.id] = raw;
    summaries.push({
      id: item.id,
      title: specRole || '未命名会话',
      modifiedAt,
      status: '',
      stepCount: typeof meta?.stepCount === 'number' ? meta.stepCount : 0,
    });
  }
  return { rawSummaries, summaries };
}

/**
 * Resolve the host's local `.gemini/antigravity` root directory from a client instance.
 * Returns `null` for synthetic mock clients (`Object.hasOwn(client, 'call')`) unless an explicit
 * `conversationsDir` was provided, preventing tests from ever touching the developer's home directory.
 */
export function resolveLocalAntigravityDir(client: unknown): {
  rootDir: string;
  conversationsDir: string;
} | null {
  if (!client || typeof client !== 'object') return null;
  const c = client as {
    conversationsDir?: string | null;
    reader?: { conversationsDir?: string | null } | null;
    paths?: () => { home?: string; conversationsDir?: string };
    profile?: unknown;
  };
  const explicitDir = c.conversationsDir ?? c.reader?.conversationsDir ?? null;
  if (typeof explicitDir === 'string' && explicitDir.length > 0) {
    return { rootDir: dirname(explicitDir), conversationsDir: explicitDir };
  }
  if (Object.hasOwn(c, 'call') || typeof c.paths !== 'function') {
    return null;
  }
  try {
    const p = c.paths();
    if (typeof p?.conversationsDir === 'string' && p.conversationsDir.length > 0) {
      return { rootDir: dirname(p.conversationsDir), conversationsDir: p.conversationsDir };
    }
    if (typeof p?.home === 'string' && p.home.length > 0) {
      const host = typeof c.profile === 'string' && c.profile.length > 0 ? 'ide' : 'app';
      const conversationsDir = defaultConversationsDir(host, p.home);
      return { rootDir: dirname(conversationsDir), conversationsDir };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Read local conversation summaries from `conversation_summaries.db` (falling back to scanning
 * `conversations/*.db`) without calling any `language_server` RPC.
 */
export async function readLocalConversationSummaries(
  rootDir: string,
  options: {
    conversationsDir?: string;
    force?: boolean;
    readSummaries?: ((dbPath: string) => SqliteConversationSummaryRow[] | null) | null;
  } = {},
): Promise<LocalSummariesResult> {
  const conversationsDir = options.conversationsDir || join(rootDir, 'conversations');
  const dbPath = join(rootDir, 'conversation_summaries.db');
  const stamp = await statSqliteDbStamp(dbPath);
  if (stamp) {
    const cached = !options.force && !options.readSummaries ? summaryCache.get(dbPath) : undefined;
    if (cached && cached.stamp === stamp) {
      return cached.result;
    }
    let rows = options.readSummaries
      ? options.readSummaries(dbPath)
      : readSqliteConversationSummaries(dbPath);
    if (rows === null && !options.readSummaries) {
      rows = readSummaryDbWithNodeSqlite(dbPath);
    }
    if (rows && rows.length > 0) {
      const result = rowsToSummaries(rows);
      if (!options.readSummaries) {
        if (summaryCache.size >= 8) summaryCache.clear();
        summaryCache.set(dbPath, { stamp, result });
      }
      return result;
    }
  }
  return fallbackScanConversationsDir(conversationsDir);
}
