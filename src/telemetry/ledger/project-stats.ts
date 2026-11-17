import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
  ProjectConversationDetail,
  ProjectConversationItem,
  ProjectKind,
  ProjectUsageDayBucket,
  ProjectUsageItem,
  ProjectUsageOverview,
  UsageBucketCounts,
  UsageRecord,
} from '../../contracts/usage.ts';
import {
  readSqliteConversationSummaries,
  type SqliteConversationSummaryRow,
} from '../../platform/native-bridge.ts';
import { isErrno, mapPool, recordSum, sha256, validRow } from './helpers.ts';
import type { UsageLedger } from './summary.ts';
import { dateTimeParts } from './timezone.ts';
import {
  GUID_RE,
  HASH_RE,
  LEDGER_FILE_RE,
  MAX_RECORD_FILE_BYTES,
  type LedgerDocument,
} from './types.ts';

export interface ProjectStatsStoreLike {
  identity?: { accountScope?: string | null; email?: string | null } | string | null;
  rawSummaries?: Record<string, unknown> | null;
}

export interface ProjectUsageQueryOptions {
  ledger: UsageLedger;
  store?: ProjectStatsStoreLike | null;
  profileDir?: string | null;
  scope?: string | null;
  from?: string | null;
  to?: string | null;
  timeZone?: string | null;
  readSummaries?: ((dbPath: string) => SqliteConversationSummaryRow[] | null) | null;
}

export interface ProjectDetailQueryOptions extends ProjectUsageQueryOptions {
  projectKey: string;
}

interface SummaryMetaEntry {
  cid: string;
  title: string;
  preview: string;
  lastModifiedTime: number;
  workspaceUris: string[];
  projectId: string;
  parentConversationId: string;
  source: string;
  agentName: string;
}

interface ResolvedProject {
  projectKey: string;
  name: string;
  kind: ProjectKind;
  workspacePath?: string;
}

interface DirentLike {
  name: string;
  isFile(): boolean;
}

const MAX_PARENT_HOPS = 16;
const WORKTREE_RE =
  /(?:^|\/)(?:\.gemini\/antigravity|\.antigravity|\.git)\/worktrees\/([^/]+)(?:\/|$)/i;
const GENERIC_WORKTREE_RE = /\/worktrees\/([^/]+)\//i;

function addBucket(target: UsageBucketCounts, rec: UsageRecord): void {
  const total = recordSum(rec);
  target.uncached += rec.uncached ?? 0;
  target.cacheRead += rec.cacheRead ?? 0;
  target.cacheWrite += rec.cacheWrite ?? 0;
  target.output += rec.output ?? 0;
  target.total += total;
  target.requests += 1;
}

function emptyBucket(): UsageBucketCounts {
  return { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, requests: 0 };
}

function cleanText(raw: string | undefined | null): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

function truncateLabel(text: string, maxLen = 64): string {
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function parseWorkspaceUris(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v || '').trim()).filter(Boolean);
  }
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

function normalizeUriPath(uri: string): string {
  let out = uri.trim();
  if (!out || out === 'outside-of-project' || out === 'default-cli-project') return '';
  if (out.startsWith('file://')) {
    out = out.slice('file://'.length);
    if (out.startsWith('/') && /^\/[a-zA-Z](?:%3A|:)/.test(out)) {
      out = out.slice(1);
    }
    try {
      out = decodeURIComponent(out);
    } catch {
      // Keep original string if URI percent-encoding is malformed.
    }
  }
  out = out.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-zA-Z]:/.test(out)) {
    out = `${out[0].toLowerCase()}${out.slice(1)}`;
  }
  return out;
}

function extractWorktreeRepo(normalizedPath: string): string {
  const m1 = WORKTREE_RE.exec(normalizedPath);
  if (m1?.[1]) return m1[1];
  const m2 = GENERIC_WORKTREE_RE.exec(normalizedPath);
  return m2?.[1] || '';
}

function pathBasename(pathStr: string): string {
  const cleaned = pathStr.replace(/\/+$/, '');
  const idx = cleaned.lastIndexOf('/');
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function normalizeMs(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

async function readDbWithNodeSqlite(dbPath: string): Promise<SqliteConversationSummaryRow[] | null> {
  if (!dbPath || !existsSync(dbPath)) return null;
  try {
    const req = createRequire(import.meta.url);
    const mod = req('node:sqlite') as { DatabaseSync?: new (path: string, opts?: { readOnly?: boolean }) => { prepare(sql: string): { all(): Array<Record<string, unknown>> }; close(): void } };
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
        .all() as Array<Record<string, unknown>>;
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

async function loadSummaryMeta(
  dbPath: string | null,
  rawSummaries: Record<string, unknown> | null | undefined,
  customReader?: ((dbPath: string) => SqliteConversationSummaryRow[] | null) | null,
): Promise<Map<string, SummaryMetaEntry>> {
  const byCid = new Map<string, SummaryMetaEntry>();
  let dbRows: SqliteConversationSummaryRow[] | null = null;
  if (dbPath && existsSync(dbPath)) {
    dbRows = customReader ? customReader(dbPath) : readSqliteConversationSummaries(dbPath);
    if (dbRows === null && !customReader) {
      dbRows = await readDbWithNodeSqlite(dbPath);
    }
  }
  for (const row of dbRows || []) {
    const cid = cleanText(row.conversationId);
    if (!cid) continue;
    byCid.set(cid.toLowerCase(), {
      cid,
      title: cleanText(row.title),
      preview: cleanText(row.preview),
      lastModifiedTime: normalizeMs(row.lastModifiedTime),
      workspaceUris: parseWorkspaceUris(row.workspaceUris),
      projectId: cleanText(row.projectId),
      parentConversationId: cleanText(row.parentConversationId),
      source: cleanText(row.source),
      agentName: cleanText(row.agentName),
    });
  }
  if (rawSummaries && typeof rawSummaries === 'object') {
    for (const [cid, val] of Object.entries(rawSummaries)) {
      if (!val || typeof val !== 'object') continue;
      const obj = val as Record<string, unknown>;
      const tMeta =
        obj.trajectoryMetadata && typeof obj.trajectoryMetadata === 'object'
          ? (obj.trajectoryMetadata as Record<string, unknown>)
          : null;
      const spec =
        tMeta?.subagentSpec && typeof tMeta.subagentSpec === 'object'
          ? (tMeta.subagentSpec as Record<string, unknown>)
          : null;
      const key = cid.toLowerCase();
      const existing = byCid.get(key);
      const urisFromRaw = Array.isArray(obj.workspaces)
        ? obj.workspaces
            .map((w) =>
              w && typeof w === 'object'
                ? String((w as Record<string, unknown>).workspaceFolderAbsoluteUri || '')
                : '',
            )
            .filter(Boolean)
        : [];
      byCid.set(key, {
        cid: existing?.cid || cid,
        title: existing?.title || cleanText(obj.summary as string),
        preview: existing?.preview || '',
        lastModifiedTime: Math.max(existing?.lastModifiedTime || 0, normalizeMs(obj.lastModifiedTime)),
        workspaceUris: existing?.workspaceUris.length ? existing.workspaceUris : urisFromRaw,
        projectId: existing?.projectId || '',
        parentConversationId:
          existing?.parentConversationId || cleanText(tMeta?.parentConversationId as string),
        source: existing?.source || '',
        agentName: existing?.agentName || cleanText(spec?.role as string),
      });
    }
  }
  return byCid;
}

function buildProjectResolver(metaByCid: Map<string, SummaryMetaEntry>) {
  const canonicalPathByProjectId = new Map<string, string>();
  const canonicalPathByBasename = new Map<string, string>();
  const resolvedCache = new Map<string, ResolvedProject>();

  for (const meta of metaByCid.values()) {
    for (const uri of meta.workspaceUris) {
      const normalized = normalizeUriPath(uri);
      if (!normalized || extractWorktreeRepo(normalized)) continue;
      const base = pathBasename(normalized).toLowerCase();
      if (base && !canonicalPathByBasename.has(base)) {
        canonicalPathByBasename.set(base, normalized);
      }
      if (
        meta.projectId &&
        meta.projectId !== 'outside-of-project' &&
        meta.projectId !== 'default-cli-project' &&
        !canonicalPathByProjectId.has(meta.projectId)
      ) {
        canonicalPathByProjectId.set(meta.projectId, normalized);
      }
    }
  }

  function resolve(cid: string, doc?: LedgerDocument | null): ResolvedProject {
    const key = cid.toLowerCase();
    const cached = resolvedCache.get(key);
    if (cached && !doc) return cached;

    if (doc?.metadata?.source === 'remote-manual') {
      const name = cleanText(doc.metadata.projectName) || 'remote';
      return { projectKey: `remote:${name.toLowerCase()}`, name, kind: 'remote' };
    }

    let chosenMeta: SummaryMetaEntry | undefined = metaByCid.get(key);
    let projectId = chosenMeta?.projectId || '';
    let source = chosenMeta?.source || '';
    let uris = chosenMeta?.workspaceUris || [];

    // Inherit workspace/project from parent chain when a subagent omits them.
    let cursor = chosenMeta?.parentConversationId;
    const seen = new Set<string>([key]);
    let hops = 0;
    while (cursor && hops < MAX_PARENT_HOPS) {
      const pKey = cursor.toLowerCase();
      if (seen.has(pKey)) break;
      seen.add(pKey);
      const pMeta = metaByCid.get(pKey);
      if (!pMeta) break;
      if (!uris.length && pMeta.workspaceUris.length) uris = pMeta.workspaceUris;
      if (!projectId && pMeta.projectId) projectId = pMeta.projectId;
      if (!source && pMeta.source) source = pMeta.source;
      if (uris.length && projectId) break;
      cursor = pMeta.parentConversationId;
      hops += 1;
    }

    const isRemote = cid.includes('/');
    let out: ResolvedProject;
    if (
      projectId === 'default-cli-project' ||
      source === 'CORTEX_TRAJECTORY_SOURCE_CLI' ||
      uris.some((u) => u.trim() === 'default-cli-project')
    ) {
      out = { projectKey: 'cli', name: 'cli', kind: 'cli' };
    } else {
      const normalizedList = uris.map(normalizeUriPath).filter(Boolean);
      const primaryNonWorktree = normalizedList.find((p) => !extractWorktreeRepo(p));
      const mappedFromProjectId = projectId ? canonicalPathByProjectId.get(projectId) : undefined;
      const resolvedPath = primaryNonWorktree || mappedFromProjectId;

      if (resolvedPath) {
        out = {
          projectKey: `project:${resolvedPath.toLowerCase()}`,
          name: pathBasename(resolvedPath) || resolvedPath,
          kind: isRemote ? 'remote' : 'project',
          workspacePath: resolvedPath,
        };
      } else {
        const worktreeRepo = normalizedList.map(extractWorktreeRepo).find(Boolean);
        if (worktreeRepo) {
          const matchedPath = canonicalPathByBasename.get(worktreeRepo.toLowerCase());
          if (matchedPath) {
            out = {
              projectKey: `project:${matchedPath.toLowerCase()}`,
              name: pathBasename(matchedPath) || worktreeRepo,
              kind: 'project',
              workspacePath: matchedPath,
            };
          } else {
            out = {
              projectKey: `project:worktree:${worktreeRepo.toLowerCase()}`,
              name: worktreeRepo,
              kind: 'project',
            };
          }
        } else if (isRemote) {
          const prefix = cid.slice(0, cid.indexOf('/'));
          const cleanPid =
            projectId && projectId !== 'outside-of-project' ? projectId : '';
          out = {
            projectKey: `remote:${(cleanPid || prefix).toLowerCase()}`,
            name: cleanPid || `remote (${prefix})`,
            kind: 'remote',
          };
        } else {
          out = { projectKey: 'conversations', name: 'conversations', kind: 'conversations' };
        }
      }
    }

    if (!doc) resolvedCache.set(key, out);
    return out;
  }

  return { resolve };
}

function resolveRootAncestor(
  cid: string,
  metaByCid: Map<string, SummaryMetaEntry>,
): { rootId: string | null; rootTitle: string | null } {
  const meta = metaByCid.get(cid.toLowerCase());
  if (!meta?.parentConversationId) return { rootId: null, rootTitle: null };

  let current = meta.parentConversationId;
  let rootKey = current.toLowerCase();
  const seen = new Set<string>([cid.toLowerCase()]);
  for (let i = 0; i < MAX_PARENT_HOPS && current; i++) {
    const key = current.toLowerCase();
    if (seen.has(key)) break;
    seen.add(key);
    rootKey = key;
    const pMeta = metaByCid.get(key);
    if (!pMeta?.parentConversationId) break;
    current = pMeta.parentConversationId;
  }

  const rootMeta = metaByCid.get(rootKey);
  const rootId = rootMeta?.cid || current || rootKey;
  const rootTitle = rootMeta
    ? rootMeta.title || (rootMeta.preview ? truncateLabel(rootMeta.preview, 64) : null)
    : null;
  return { rootId, rootTitle };
}

function resolveConversationTitle(
  cid: string,
  metaByCid: Map<string, SummaryMetaEntry>,
  doc?: LedgerDocument | null,
): string {
  const meta = metaByCid.get(cid.toLowerCase());
  if (meta?.title) return meta.title;
  if (meta?.preview) return truncateLabel(meta.preview, 64);

  if (meta?.parentConversationId) {
    let cursor: string | undefined = meta.parentConversationId;
    const seen = new Set<string>([cid.toLowerCase()]);
    for (let i = 0; i < MAX_PARENT_HOPS && cursor; i++) {
      const pKey = cursor.toLowerCase();
      if (seen.has(pKey)) break;
      seen.add(pKey);
      const pMeta = metaByCid.get(pKey);
      if (!pMeta) break;
      const pTitle = pMeta.title || (pMeta.preview ? truncateLabel(pMeta.preview, 40) : '');
      if (pTitle) {
        return meta.agentName ? `${pTitle} · ${meta.agentName}` : `${pTitle} · subagent`;
      }
      cursor = pMeta.parentConversationId;
    }
    if (meta.agentName) return `${meta.agentName} (${cid.slice(0, 8)})`;
  }

  const docNote = cleanText(doc?.metadata?.note);
  if (docNote && !HASH_RE.test(docNote)) return truncateLabel(docNote, 64);
  const docProj = cleanText(doc?.metadata?.projectName);
  if (docProj && !HASH_RE.test(docProj)) return truncateLabel(docProj, 64);

  if (meta?.projectId === 'default-cli-project' || meta?.source === 'CORTEX_TRAJECTORY_SOURCE_CLI') {
    return `cli · ${cid.slice(0, 8)}`;
  }
  if (cid.includes('/')) {
    const slash = cid.indexOf('/');
    const prefix = cid.slice(0, slash);
    const tail = cid.slice(slash + 1);
    return `${prefix} · ${tail.slice(0, 8)}`;
  }
  return `Session ${cid.slice(0, 8)}`;
}

async function readLedgerDoc(
  ledger: UsageLedger,
  filePath: string,
): Promise<LedgerDocument | null> {
  try {
    const text = await ledger.fs.readFile(filePath, 'utf8');
    if (text.length > MAX_RECORD_FILE_BYTES) return null;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const doc = parsed as LedgerDocument;
    return Array.isArray(doc.records) ? doc : null;
  } catch (err) {
    if (isErrno(err, 'ENOENT', 'ENOTDIR')) return null;
    return null;
  }
}

async function listScopeLedgerFiles(
  ledger: UsageLedger,
  scope: string,
): Promise<Array<{ fileHash: string; filePath: string }>> {
  const scopeDir = join(ledger.directory, scope);
  try {
    const entries = (await ledger.fs.readdir(scopeDir, { withFileTypes: true })) as DirentLike[];
    const out: Array<{ fileHash: string; filePath: string }> = [];
    for (const ent of entries) {
      if (!ent?.name || !LEDGER_FILE_RE.test(ent.name)) continue;
      if (typeof ent.isFile === 'function' && !ent.isFile()) continue;
      out.push({
        fileHash: ent.name.slice(0, -5),
        filePath: join(scopeDir, ent.name),
      });
    }
    return out;
  } catch (err) {
    if (isErrno(err, 'ENOENT', 'ENOTDIR')) return [];
    throw err;
  }
}

function resolveRange(opts: ProjectUsageQueryOptions): { from: string; to: string; timeZone: string } {
  const timeZone = opts.timeZone || opts.ledger.timeZone || 'Asia/Shanghai';
  const today = dateTimeParts(Date.now(), timeZone).date;
  const from = typeof opts.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : '';
  const to = typeof opts.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.to) ? opts.to : from || today;
  return { from: from || to, to: from ? to : today, timeZone };
}

function inDateRange(date: string, from: string, to: string, hasExplicitRange: boolean): boolean {
  if (!hasExplicitRange) return true;
  return date >= from && date <= to;
}

function resolveScope(opts: ProjectUsageQueryOptions): string | null {
  if (opts.scope !== undefined && opts.scope !== null) return opts.scope;
  const id = opts.store?.identity;
  if (typeof id === 'string') return id;
  if (id && typeof id === 'object' && id.accountScope) return id.accountScope;
  return opts.ledger.scope ?? null;
}

/**
 * Queries Level-1 per-project usage aggregated across the currently signed-in
 * account's visible conversations within `[from, to]`.
 */
export async function queryProjectUsageOverview(
  opts: ProjectUsageQueryOptions,
): Promise<ProjectUsageOverview> {
  const scope = resolveScope(opts);
  const timeZone = opts.timeZone || opts.ledger.timeZone || 'Asia/Shanghai';
  const hasExplicitRange = Boolean(
    (typeof opts.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.from)) ||
      (typeof opts.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.to)),
  );
  const { from, to } = resolveRange(opts);
  const updatedAt = new Date().toISOString();

  if (!scope || !HASH_RE.test(scope)) {
    return { accountKey: '', from, to, projects: [], days: [], totalTokens: 0, requests: 0, updatedAt };
  }

  const dbPath = opts.profileDir ? join(opts.profileDir, 'conversation_summaries.db') : null;
  const rawSummaries = opts.store?.rawSummaries;
  const [metaByCid, ownership, files] = await Promise.all([
    loadSummaryMeta(dbPath, rawSummaries, opts.readSummaries),
    opts.ledger.ownership().catch(() => ({}) as Record<string, string>),
    listScopeLedgerFiles(opts.ledger, scope),
  ]);

  const cidByHash = new Map<string, string>();
  for (const meta of metaByCid.values()) {
    if (!meta.cid) continue;
    cidByHash.set(sha256(meta.cid), meta.cid);
    cidByHash.set(sha256(meta.cid.toLowerCase()), meta.cid);
  }
  const resolver = buildProjectResolver(metaByCid);
  const rawSet = new Set(Object.keys(rawSummaries || {}).map((c) => c.toLowerCase()));

  const eligible = files.filter(({ fileHash }) => {
    const owner = ownership[fileHash];
    const cid = cidByHash.get(fileHash);
    if (owner && owner !== scope && !(cid && rawSet.has(cid.toLowerCase()))) return false;
    return true;
  });

  const projectMap = new Map<string, ProjectUsageItem & { cids: Set<string> }>();
  const dayMap = new Map<string, Record<string, UsageBucketCounts>>();
  let grandTotal = 0;
  let grandRequests = 0;

  await mapPool(eligible, 16, async ({ fileHash, filePath }) => {
    const doc = await readLedgerDoc(opts.ledger, filePath);
    if (!doc) return;
    const cid = doc.id || cidByHash.get(fileHash) || fileHash;
    if (ownership[fileHash] && ownership[fileHash] !== scope && !rawSet.has(cid.toLowerCase())) {
      return;
    }

    const proj = resolver.resolve(cid, doc);
    let matchedInFile = false;
    for (const rec of doc.records) {
      if (!validRow(rec)) continue;
      const at = Number(rec.at ?? 0);
      const d = dateTimeParts(at, timeZone).date;
      if (!inDateRange(d, from, to, hasExplicitRange)) continue;
      matchedInFile = true;

      let pEntry = projectMap.get(proj.projectKey);
      if (!pEntry) {
        pEntry = {
          projectKey: proj.projectKey,
          name: proj.name,
          kind: proj.kind,
          ...(proj.workspacePath ? { workspacePath: proj.workspacePath } : {}),
          conversationCount: 0,
          ...emptyBucket(),
          cids: new Set<string>(),
        };
        projectMap.set(proj.projectKey, pEntry);
      }
      addBucket(pEntry, rec);

      let dayProjects = dayMap.get(d);
      if (!dayProjects) {
        dayProjects = {};
        dayMap.set(d, dayProjects);
      }
      const dayBucket = dayProjects[proj.projectKey] || (dayProjects[proj.projectKey] = emptyBucket());
      addBucket(dayBucket, rec);

      grandTotal += recordSum(rec);
      grandRequests += 1;
    }

    if (matchedInFile) {
      const pEntry = projectMap.get(proj.projectKey);
      if (pEntry) pEntry.cids.add(cid.toLowerCase());
    }
  });

  const projects: ProjectUsageItem[] = Array.from(projectMap.values())
    .filter((p) => p.total > 0 || p.requests > 0)
    .map(({ cids, ...rest }) => ({ ...rest, conversationCount: cids.size }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const days: ProjectUsageDayBucket[] = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, projectsByDate]) => ({ date, projects: projectsByDate }));

  return {
    accountKey: scope,
    from,
    to,
    projects,
    days,
    totalTokens: grandTotal,
    requests: grandRequests,
    updatedAt,
  };
}

/**
 * Queries Level-2 per-conversation breakdown on demand for a single selected
 * `projectKey` under the currently signed-in account.
 */
export async function queryProjectConversationDetail(
  opts: ProjectDetailQueryOptions,
): Promise<ProjectConversationDetail> {
  const scope = resolveScope(opts);
  const timeZone = opts.timeZone || opts.ledger.timeZone || 'Asia/Shanghai';
  const hasExplicitRange = Boolean(
    (typeof opts.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.from)) ||
      (typeof opts.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.to)),
  );
  const { from, to } = resolveRange(opts);
  const updatedAt = new Date().toISOString();
  const targetKey = opts.projectKey || 'conversations';

  const emptyDetail = (name = targetKey, kind: ProjectKind = 'project'): ProjectConversationDetail => ({
    accountKey: scope || '',
    projectKey: targetKey,
    projectName: name,
    kind,
    from,
    to,
    totalTokens: 0,
    requests: 0,
    conversations: [],
    updatedAt,
  });

  if (!scope || !HASH_RE.test(scope)) return emptyDetail();

  const dbPath = opts.profileDir ? join(opts.profileDir, 'conversation_summaries.db') : null;
  const rawSummaries = opts.store?.rawSummaries;
  const [metaByCid, ownership] = await Promise.all([
    loadSummaryMeta(dbPath, rawSummaries, opts.readSummaries),
    opts.ledger.ownership().catch(() => ({}) as Record<string, string>),
  ]);

  const resolver = buildProjectResolver(metaByCid);
  const rawSet = new Set(Object.keys(rawSummaries || {}).map((c) => c.toLowerCase()));

  let projectName = targetKey;
  let projectKind: ProjectKind = targetKey === 'conversations' ? 'conversations' : targetKey === 'cli' ? 'cli' : 'project';

  const candidateFiles: Array<{ cid: string; fileHash: string; filePath: string }> = [];
  const seenHashes = new Set<string>();
  const cidByHash = new Map<string, string>();

  for (const meta of metaByCid.values()) {
    if (!meta.cid) continue;
    cidByHash.set(sha256(meta.cid), meta.cid);
    cidByHash.set(sha256(meta.cid.toLowerCase()), meta.cid);
    const resolved = resolver.resolve(meta.cid);
    if (resolved.projectKey !== targetKey) continue;
    projectName = resolved.name;
    projectKind = resolved.kind;
    const fileHash = sha256(meta.cid.toLowerCase());
    const altHash = sha256(meta.cid);
    for (const h of fileHash === altHash ? [fileHash] : [fileHash, altHash]) {
      if (ownership[h] && ownership[h] !== scope && !rawSet.has(meta.cid.toLowerCase())) {
        continue;
      }
      if (seenHashes.has(h)) continue;
      seenHashes.add(h);
      candidateFiles.push({
        cid: meta.cid,
        fileHash: h,
        filePath: join(opts.ledger.directory, scope, `${h}.json`),
      });
    }
  }

  // Remote-manual or orphan files without summary rows are checked only if needed.
  if (targetKey.startsWith('remote:') || targetKey === 'conversations') {
    const scopeFiles = await listScopeLedgerFiles(opts.ledger, scope);
    for (const f of scopeFiles) {
      if (seenHashes.has(f.fileHash)) continue;
      if (ownership[f.fileHash] && ownership[f.fileHash] !== scope) continue;
      candidateFiles.push({
        cid: cidByHash.get(f.fileHash) || f.fileHash,
        fileHash: f.fileHash,
        filePath: f.filePath,
      });
    }
  }

  const items: ProjectConversationItem[] = [];
  let grandTotal = 0;
  let grandRequests = 0;

  await mapPool(candidateFiles, 16, async (candidate) => {
    const doc = await readLedgerDoc(opts.ledger, candidate.filePath);
    if (!doc) return;
    const cid = doc.id || candidate.cid || cidByHash.get(candidate.fileHash) || candidate.fileHash;
    if (
      ownership[candidate.fileHash] &&
      ownership[candidate.fileHash] !== scope &&
      !rawSet.has(cid.toLowerCase())
    ) {
      return;
    }

    const resolved = resolver.resolve(cid, doc);
    if (resolved.projectKey !== targetKey) return;
    projectName = resolved.name;
    projectKind = resolved.kind;

    const bucket = emptyBucket();
    let maxAt = 0;
    for (const rec of doc.records) {
      if (!validRow(rec)) continue;
      const at = Number(rec.at ?? 0);
      const d = dateTimeParts(at, timeZone).date;
      if (!inDateRange(d, from, to, hasExplicitRange)) continue;
      addBucket(bucket, rec);
      if (at > maxAt) maxAt = at;
    }
    if (bucket.total === 0 && bucket.requests === 0) return;

    const meta = metaByCid.get(cid.toLowerCase());
    const { rootId, rootTitle } = resolveRootAncestor(cid, metaByCid);
    items.push({
      id: cid,
      title: resolveConversationTitle(cid, metaByCid, doc),
      ...bucket,
      share: 0,
      lastActiveAt: maxAt > 0 ? new Date(maxAt).toISOString() : null,
      isSubagent: Boolean(meta?.parentConversationId),
      isRemote: cid.includes('/') || doc.metadata?.source === 'remote-manual',
      parentId: meta?.parentConversationId || null,
      rootId,
      rootTitle,
      agentName: meta?.agentName || null,
    });
    grandTotal += bucket.total;
    grandRequests += bucket.requests;
  });

  items.sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
  if (grandTotal > 0) {
    for (const item of items) item.share = item.total / grandTotal;
  }

  return {
    accountKey: scope,
    projectKey: targetKey,
    projectName,
    kind: projectKind,
    from,
    to,
    totalTokens: grandTotal,
    requests: grandRequests,
    conversations: items,
    updatedAt,
  };
}
