import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonObjectSync } from './fs-helpers.ts';

export const LEGACY_ADAPTER_MARKER = '// AG_PULSE_INLINE_V1';

interface AsarFileEntry {
  offset?: string;
  size?: number;
  unpacked?: boolean;
  files?: Record<string, AsarFileEntry>;
}

interface BackupPatchNote {
  patchedSha256?: string;
  originalSha256?: string;
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Parses an Electron ASAR archive buffer and returns its JSON header and payload base offset.
 */
export function parseAsarArchive(data: Buffer): { header: AsarFileEntry; baseOffset: number } {
  if (data.length < 16) {
    throw new Error('Invalid ASAR archive: header too short');
  }
  const size1 = data.readUInt32LE(4);
  const headerLen = data.readUInt32LE(12);
  if (16 + headerLen > data.length) {
    throw new Error('Invalid ASAR archive: header out of bounds');
  }
  const header = JSON.parse(data.subarray(16, 16 + headerLen).toString('utf8')) as AsarFileEntry;
  return { header, baseOffset: 8 + size1 };
}

/**
 * Locates a verified unpatched `app.asar` backup matching the current patched archive hash.
 */
export function findOriginalBackupForCurrent(current: Buffer, backupsDir: string): Buffer | null {
  if (!existsSync(backupsDir)) return null;
  const digest = sha256Hex(current);
  const entries = readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const name of entries) {
    const dir = join(backupsDir, name);
    const notePath = join(dir, 'patch.json');
    if (!existsSync(notePath)) continue;
    const note = readJsonObjectSync<BackupPatchNote>(notePath);
    if (note.patchedSha256 !== digest) continue;
    const original = readFileSync(join(dir, 'app.asar'));
    if (sha256Hex(original) !== note.originalSha256) {
      throw new Error('Original application backup failed its integrity check.');
    }
    return original;
  }
  return null;
}

/**
 * Checks whether a patched ASAR archive still carries the legacy preload marker.
 */
export function hasLegacyPreloadMarker(current: Buffer): boolean {
  try {
    const { header, baseOffset } = parseAsarArchive(current);
    const preload = header.files?.dist?.files?.['preload.js'];
    if (!preload || preload.offset === undefined || typeof preload.size !== 'number') {
      return current.includes(LEGACY_ADAPTER_MARKER);
    }
    const start = baseOffset + Number(preload.offset);
    const end = start + preload.size;
    return current.subarray(start, end).includes(LEGACY_ADAPTER_MARKER);
  } catch {
    return current.includes(LEGACY_ADAPTER_MARKER);
  }
}

/**
 * Restores a verified legacy `app.asar` backup when present; throws if unknown patches remain.
 */
export function restoreVerifiedLegacyAdapter(
  appAsarPath: string,
  backupsDir: string,
  { onRestoreErrorMessage, onUnknownChangeMessage }: {
    onRestoreErrorMessage?: string;
    onUnknownChangeMessage?: string;
  } = {},
): boolean {
  if (!existsSync(appAsarPath)) return false;
  const current = readFileSync(appAsarPath);
  const original = findOriginalBackupForCurrent(current, backupsDir);
  if (original !== null) {
    writeFileSync(appAsarPath, original);
    if (!readFileSync(appAsarPath).equals(original)) {
      throw new Error(onRestoreErrorMessage ?? 'Legacy adapter restoration verification failed.');
    }
    return true;
  }
  if (current.includes(LEGACY_ADAPTER_MARKER) && hasLegacyPreloadMarker(current)) {
    throw new Error(
      onUnknownChangeMessage ??
        'The legacy adapter has unknown app changes; refusing to overwrite them. Inspect its backup first.',
    );
  }
  return false;
}
