import { deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipInputEntry {
  name: string;
  data: Uint8Array | string;
  compress?: boolean;
  mtime?: Date;
}

export interface ZipReadEntry {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  readBytes(): Buffer;
  readText(encoding?: BufferEncoding): string;
}

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * Computes standard IEEE 802.3 CRC-32 checksum for a byte buffer.
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function normalizeZipName(raw: string): string {
  const normalized = raw.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`Invalid ZIP entry path: ${raw}`);
  }
  return normalized;
}

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { dosTime, dosDate };
}

function toBuffer(data: Uint8Array | string): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Builds a dependency-free PKZIP archive buffer (compatible with `.zip` and `.vsix`).
 */
export function createZipArchive(entries: readonly ZipInputEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  const defaultDate = new Date();

  for (const entry of entries) {
    const name = normalizeZipName(entry.name);
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate ZIP entry: ${name}`);
    }
    seen.add(key);

    const nameBuf = Buffer.from(name, 'utf8');
    const raw = toBuffer(entry.data);
    const checksum = crc32(raw);
    const useDeflate = entry.compress !== false && raw.length > 0;
    const payload = useDeflate ? deflateRawSync(raw) : raw;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const { dosTime, dosDate } = toDosDateTime(entry.mtime ?? defaultDate);
    const flags = 0x0800; // UTF-8 filename flag

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    localParts.push(local, payload);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(CENTRAL_DIR_HEADER_SIG, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    centralParts.push(central);
    offset += local.length + payload.length;
  }

  const centralDirSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIR_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function findEocdOffset(buf: Buffer): number {
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === END_OF_CENTRAL_DIR_SIG) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) return i;
    }
  }
  throw new Error('Invalid ZIP archive: EOCD signature not found');
}

/**
 * Parses a ZIP buffer and returns an indexed map of entries supporting STORE and DEFLATE.
 */
export function readZipArchive(data: Uint8Array): Map<string, ZipReadEntry> {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const eocdOffset = findEocdOffset(buf);
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const centralSize = buf.readUInt32LE(eocdOffset + 12);
  const centralOffset = buf.readUInt32LE(eocdOffset + 16);
  if (centralOffset + centralSize > eocdOffset) {
    throw new Error('Invalid ZIP archive: corrupt central directory bounds');
  }

  const result = new Map<string, ZipReadEntry>();
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > eocdOffset || buf.readUInt32LE(cursor) !== CENTRAL_DIR_HEADER_SIG) {
      throw new Error('Invalid ZIP archive: corrupt central directory entry');
    }
    const method = buf.readUInt16LE(cursor + 10);
    const expectedCrc = buf.readUInt32LE(cursor + 16);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;

    const readBytes = (): Buffer => {
      if (localHeaderOffset + 30 > centralOffset || buf.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIG) {
        throw new Error(`Invalid local header for ${name}`);
      }
      const lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > centralOffset) {
        throw new Error(`Compressed payload out of bounds for ${name}`);
      }
      const compressed = buf.subarray(dataStart, dataEnd);
      let out: Buffer;
      if (method === METHOD_STORE) {
        out = Buffer.from(compressed);
      } else if (method === METHOD_DEFLATE) {
        out = inflateRawSync(compressed);
      } else {
        throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
      }
      if (out.length !== uncompressedSize || crc32(out) !== expectedCrc) {
        throw new Error(`CRC or size mismatch for ZIP entry ${name}`);
      }
      return out;
    };

    result.set(name, {
      name,
      method,
      crc32: expectedCrc,
      compressedSize,
      uncompressedSize,
      readBytes,
      readText: (encoding = 'utf8') => readBytes().toString(encoding),
    });
  }
  return result;
}
