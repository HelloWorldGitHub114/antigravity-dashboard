// Discover IDs and local SQLite paths; SQLite bodies are read on demand via native-bridge.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const conversationId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export type ConversationHost = 'app' | 'ide';

export interface LocalConversationEntry {
  id: string;
  signature: string;
  readSignature: () => Promise<string | null>;
  dbPath?: string;
}

/**
 * Returns the default local `conversations/` directory for an Antigravity host (`app` or `ide`).
 */
export function defaultConversationsDir(
  host: ConversationHost = 'app',
  home: string = homedir(),
): string {
  return join(home, '.gemini', host === 'ide' ? 'antigravity-ide' : 'antigravity', 'conversations');
}

/**
 * Resolves the absolute `.db` file path for a conversation ID if it exists on disk.
 */
export function resolveLocalConversationDbPath(
  id: string,
  conversationsDir: string | null | undefined = defaultConversationsDir(),
): string | null {
  if (typeof id !== 'string' || !conversationId.test(id)) return null;
  if (!conversationsDir || typeof conversationsDir !== 'string') return null;
  const candidate = join(conversationsDir, `${id.toLowerCase()}.db`);
  if (existsSync(candidate)) return candidate;
  if (id !== id.toLowerCase()) {
    const exactCandidate = join(conversationsDir, `${id}.db`);
    if (existsSync(exactCandidate)) return exactCandidate;
  }
  return null;
}

export interface DiscoverLocalConversationsOptions {
  host?: string;
  home?: string;
  limit?: number;
}

export interface DiscoverLocalConversationsResult {
  conversations: LocalConversationEntry[];
  errors: number;
}

interface ConversationPart {
  file: string;
  directory: boolean;
}

interface BigIntStatLike {
  size: bigint | number;
  mtimeNs?: bigint;
  ctimeNs?: bigint;
  mtimeMs?: number;
  ctimeMs?: number;
  ino: bigint | number;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function isMissingCode(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function stamp(file: string, directory = false): Promise<string | null> {
  try {
    const s = (await (lstat as (p: string, opts: { bigint: true }) => Promise<BigIntStatLike>)(
      file,
      { bigint: true },
    ));
    if (s.isSymbolicLink() || !(directory ? s.isDirectory() : s.isFile())) return null;
    return [s.size, s.mtimeNs ?? s.mtimeMs ?? 0, s.ctimeNs ?? s.ctimeMs ?? 0, s.ino]
      .map(String)
      .join(':');
  } catch (error) {
    if (isMissingCode(error)) return null;
    throw error;
  }
}

/**
 * Discover local conversation IDs and metadata-only change signatures for a host installation.
 */
export async function discoverLocalConversations({
  host,
  home = homedir(),
  limit = 20000,
}: DiscoverLocalConversationsOptions = {}): Promise<DiscoverLocalConversationsResult> {
  if (host !== 'app' && host !== 'ide') {
    throw new Error('Explicit conversation host is required');
  }
  const base = join(home, '.gemini', host === 'ide' ? 'antigravity-ide' : 'antigravity');
  const files = new Map<string, ConversationPart[]>();
  let errors = 0;
  let visited = 0;
  let baseChecked = false;
  let baseOk = false;

  const roots: ReadonlyArray<readonly [string, boolean]> = [
    ['conversations', false],
    ['brain', true],
  ];

  for (const [name, directory] of roots) {
    const root = join(base, name);
    try {
      // Do not follow a redirected host root into another installation.
      if (!baseChecked) {
        baseOk = Boolean(await stamp(base, true));
        baseChecked = true;
      }
      if (!baseOk || !(await stamp(root, true))) continue;
      const dir = await opendir(root);
      for await (const entry of dir) {
        if (++visited > limit) throw new Error('Conversation discovery budget exceeded');
        if (entry.isSymbolicLink() || !(directory ? entry.isDirectory() : entry.isFile())) continue;
        const id = directory
          ? entry.name
          : entry.name.endsWith('.db')
            ? entry.name.slice(0, -3)
            : '';
        if (!conversationId.test(id)) continue;
        const key = id.toLowerCase();
        const parts = files.get(key) || [];
        parts.push({ file: join(root, entry.name), directory });
        files.set(key, parts);
      }
    } catch (error) {
      if (!isMissingCode(error)) errors++;
    }
    if (visited > limit) break;
  }

  const entries = [...files.entries()];
  const slots = new Array<LocalConversationEntry | undefined>(entries.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < entries.length) {
      const index = cursor++;
      const [id, parts] = entries[index];
      const readSignature = async (): Promise<string | null> => {
        const rows = await Promise.all(
          parts.map(async ({ file, directory }): Promise<Array<[string, string | null]> | null> => {
            if (directory) {
              const value = await stamp(file, true);
              return value === null ? null : [['brain', value]];
            }
            const [value, wal] = await Promise.all([stamp(file, false), stamp(`${file}-wal`)]);
            return value === null ? null : [['db', value], ['wal', wal]];
          }),
        );
        const values: Array<[string, string | null]> = [];
        for (const row of rows) {
          if (row === null) return null;
          values.push(...row);
        }
        return digest(JSON.stringify(values));
      };
      try {
        const signature = await readSignature();
        if (signature) {
          const dbPart = parts.find((p) => !p.directory && p.file.toLowerCase().endsWith('.db'));
          slots[index] = dbPart
            ? { id, signature, readSignature, dbPath: dbPart.file }
            : { id, signature, readSignature };
        }
      } catch {
        errors++;
      }
    }
  };

  const poolSize = Math.min(16, entries.length);
  if (poolSize > 0) {
    await Promise.all(Array.from({ length: poolSize }, worker));
  }

  const conversations: LocalConversationEntry[] = [];
  for (const item of slots) {
    if (item) conversations.push(item);
  }
  return { conversations, errors };
}
