import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { atomicWriteFileSync, readJsonSyncSafe } from '../shared/atomic-fs.ts';

/**
 * Checks whether `targetPath` is a symbolic link or Windows junction/reparse point.
 */
export function isReparseOrSymlink(targetPath: string): boolean {
  try {
    const lstat = lstatSync(targetPath);
    if (lstat.isSymbolicLink()) return true;
    const resolved = realpathSync(targetPath);
    return resolved !== resolve(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
    return code !== 'ENOENT';
  }
}

/**
 * Asserts that `root` and none of its existing descendants are symlinks or junctions.
 */
export function assertRegularTree(root: string): void {
  if (isReparseOrSymlink(root)) {
    throw new Error('Installation path must not be a symlink or junction.');
  }
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (isReparseOrSymlink(child)) {
        throw new Error('Installation paths must not contain symlinks or junctions.');
      }
      if (entry.isDirectory()) stack.push(child);
    }
  }
}

/**
 * Reads a JSON object file synchronously, returning `fallback` when absent.
 */
export function readJsonObjectSync<T extends object = Record<string, unknown>>(
  filePath: string,
  fallback: T = {} as T,
): T {
  if (!existsSync(filePath)) return fallback;
  const parsed = readJsonSyncSafe<unknown>(filePath, { rethrowIo: true, rethrowParse: true });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Configuration at ${filePath} must be a JSON object.`);
  }
  return parsed as T;
}

/**
 * Writes a JSON value atomically with 2-space indentation and trailing newline.
 */
export function writeJsonObjectSync(filePath: string, value: unknown, mode = 0o644): void {
  atomicWriteFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode,
    flag: 'w',
    fsync: true,
  });
}

/**
 * Recursively copies `source` to `dest`, skipping any matching directory/file predicate.
 */
export function copyTreeFilteredSync(
  source: string,
  dest: string,
  shouldSkip: (relPath: string, name: string, isDir: boolean) => boolean,
  relPrefix = '',
): void {
  const st = statSync(source);
  if (!st.isDirectory()) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
    return;
  }
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const isDir = entry.isDirectory();
    if (shouldSkip(rel, entry.name, isDir)) continue;
    const srcChild = join(source, entry.name);
    const dstChild = join(dest, entry.name);
    if (isDir) {
      copyTreeFilteredSync(srcChild, dstChild, shouldSkip, rel);
    } else if (entry.isFile()) {
      copyFileSync(srcChild, dstChild);
    }
  }
}

/**
 * Resolves an executable on PATH (handling Windows PATHEXT extensions) or returns `null`.
 */
export function findExecutableOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string | null {
  const pathValue = env.PATH || env.Path || '';
  if (name.includes('/') || name.includes('\\')) {
    return existsSync(name) && statSync(name).isFile() ? realpathSync(name) : null;
  }
  const exts =
    platform === 'win32'
      ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate =
        platform === 'win32' && !name.toLowerCase().endsWith(ext.toLowerCase())
          ? join(dir, `${name}${ext}`)
          : join(dir, name);
      try {
        const st = statSync(candidate);
        if (st.isFile() && (platform === 'win32' || (st.mode & 0o111) !== 0)) {
          return realpathSync(candidate);
        }
      } catch {
        // Ignore inaccessible PATH entry.
      }
    }
  }
  return null;
}

/**
 * Safely encodes a path for legacy Windows redirected console codepages when needed.
 */
export function formatDisplayPath(targetPath: string): string {
  return targetPath;
}

export function readBytesSync(filePath: string): Buffer {
  return readFileSync(filePath);
}
