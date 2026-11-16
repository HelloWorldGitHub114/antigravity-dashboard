import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  DIST_RELEASE_FILES,
  IDE_PACKAGE_NAME,
  IDE_PUBLISHER,
  IDE_VSIX_MODULES,
  IDE_VSIX_STATIC_FILES,
  PACKAGER_IGNORED_NAMES,
  PACKAGER_IGNORED_SUFFIXES,
  RELEASE_VSIX_REQUIRED_FILES,
  RELEASE_ZIP_REQUIRED_FILES,
  UPDATE_REPO,
} from '../platform/manifest.ts';
import { createZipArchive, readZipArchive, type ZipInputEntry } from '../shared/zip.ts';
import { readJsonObjectSync } from './fs-helpers.ts';

export interface PackageDesktopResult {
  version: string;
  archive: string;
  checksum: string;
  sha256: string;
  files: number;
}

export interface PackageVsixResult {
  version: string;
  vsix: string;
  checksum: string;
  sha256: string;
  entries: number;
}

export interface CheckedReleaseAssets {
  version: string;
  zip: string;
  zipChecksum: string;
  vsix: string;
  vsixChecksum: string;
  notes: string;
}

export interface ReleaseAssetUpload {
  path: string;
  name: string;
  contentType: string;
}

export interface GitHubReleaseClient {
  find?(tag: string): Promise<Record<string, unknown> | null>;
  request(
    method: string,
    url: string,
    body?: Uint8Array | string | Record<string, unknown>,
    contentType?: string,
  ): Promise<Record<string, unknown> | Array<Record<string, unknown>> | null>;
}

const VSIX_CONTENT_TYPES_XML =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="json" ContentType="application/json"/>' +
  '<Default Extension="mjs" ContentType="text/javascript"/>' +
  '<Default Extension="cjs" ContentType="text/javascript"/>' +
  '<Default Extension="py" ContentType="text/plain"/>' +
  '<Default Extension="md" ContentType="text/markdown"/>' +
  '<Default Extension="vsixmanifest" ContentType="text/xml"/>' +
  '<Override PartName="/extension/LICENSE" ContentType="text/plain"/>' +
  '</Types>';

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildVsixManifest(meta: Record<string, unknown>): string {
  const publisher = xmlEscape(String(meta.publisher ?? ''));
  const name = xmlEscape(String(meta.name ?? ''));
  const version = xmlEscape(String(meta.version ?? '0.0.0'));
  const displayName = xmlEscape(String(meta.displayName ?? meta.name ?? ''));
  const description = xmlEscape(String(meta.description ?? ''));
  const engines = (meta.engines ?? {}) as { vscode?: unknown };
  const vscodeEngine = xmlEscape(String(engines.vscode ?? '*'));
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">',
    `<Metadata><Identity Language="en-US" Id="${name}" Version="${version}" Publisher="${publisher}"/>`,
    `<DisplayName>${displayName}</DisplayName><Description xml:space="preserve">${description}</Description>`,
    '<Tags>antigravity,dashboard</Tags><Categories>Other</Categories>',
    `<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${vscodeEngine}"/></Properties></Metadata>`,
    '<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>',
    '<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>',
    '<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>',
    '<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/></Assets></PackageManifest>',
  ].join('\n');
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeSha256Sidecar(archivePath: string, bytes: Uint8Array, ext: '.zip.sha256' | '.vsix.sha256'): { checksum: string; sha256: string } {
  const digest = sha256Hex(bytes);
  const checksumPath = archivePath.replace(/\.(zip|vsix)$/i, '') + ext;
  writeFileSync(checksumPath, `${digest}  ${basename(archivePath)}\n`, 'utf8');
  return { checksum: checksumPath, sha256: digest };
}

function verifyChecksumFile(archivePath: string, checksumPath: string, label: string): void {
  if (!existsSync(checksumPath)) {
    throw new Error(`Missing ${label} checksum: ${checksumPath}`);
  }
  const actual = sha256Hex(readFileSync(archivePath));
  const parts = readFileSync(checksumPath, 'utf8').trim().split(/\s+/);
  if (parts.length !== 2 || parts[0] !== actual || parts[1] !== basename(archivePath)) {
    throw new Error(`${label} checksum mismatch`);
  }
}

function shouldIgnorePackageEntry(name: string): boolean {
  if (PACKAGER_IGNORED_NAMES.has(name)) return true;
  for (const suffix of PACKAGER_IGNORED_SUFFIXES) {
    if (name.endsWith(suffix)) return true;
  }
  return false;
}

function collectPackageEntries(source: string, zipPrefix: string, entries: ZipInputEntry[]): void {
  const st = statSync(source);
  if (!st.isDirectory()) {
    entries.push({ name: zipPrefix, data: readFileSync(source) });
    return;
  }
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (shouldIgnorePackageEntry(entry.name)) continue;
    const childPath = join(source, entry.name);
    const childPrefix = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collectPackageEntries(childPath, childPrefix, entries);
    } else if (entry.isFile()) {
      entries.push({ name: childPrefix, data: readFileSync(childPath) });
    }
  }
}

/**
 * Builds `dist/antigrative-dashboard-<version>.zip` and `.zip.sha256` from `DIST_RELEASE_FILES`.
 */
export function packageDesktopRelease(rootDir: string, outputFile?: string): PackageDesktopResult {
  const root = resolve(rootDir);
  const pluginMeta = readJsonObjectSync<{ version?: string }>(join(root, 'plugin.json'));
  const version = String(pluginMeta.version ?? '0.0.0');
  const archivePath = resolve(outputFile ?? join(root, 'dist', `antigrative-dashboard-${version}.zip`));
  mkdirSync(dirname(archivePath), { recursive: true });

  const entries: ZipInputEntry[] = [];
  for (const item of DIST_RELEASE_FILES) {
    const src = join(root, item);
    if (!existsSync(src)) {
      throw new Error(`Required release file missing: ${item}`);
    }
    collectPackageEntries(src, `antigrative-dashboard/${item}`, entries);
  }

  const zipBytes = createZipArchive(entries);
  writeFileSync(archivePath, zipBytes);
  const { checksum, sha256 } = writeSha256Sidecar(archivePath, zipBytes, '.zip.sha256');
  return { version, archive: archivePath, checksum, sha256, files: entries.length };
}

/**
 * Builds `dist/<idePackageName>-<version>.vsix` and `.vsix.sha256` from `IDE_VSIX_MODULES` and `IDE_VSIX_STATIC_FILES`.
 */
export function packageIdeVsix(rootDir: string, outputFile?: string): PackageVsixResult {
  const root = resolve(rootDir);
  const meta = readJsonObjectSync<Record<string, unknown>>(join(root, 'ide', 'package.json'));
  const name = String(meta.name ?? IDE_PACKAGE_NAME);
  const version = String(meta.version ?? '0.0.0');
  const vsixPath = resolve(outputFile ?? join(root, 'dist', `${name}-${version}.vsix`));
  mkdirSync(dirname(vsixPath), { recursive: true });

  const entries: ZipInputEntry[] = [
    { name: 'extension.vsixmanifest', data: buildVsixManifest(meta) },
    { name: '[Content_Types].xml', data: VSIX_CONTENT_TYPES_XML },
    { name: 'extension/package.json', data: `${JSON.stringify(meta, null, 2)}\n` },
  ];

  for (const relPath of IDE_VSIX_STATIC_FILES) {
    const fullPath = join(root, relPath);
    if (!existsSync(fullPath)) {
      throw new Error(`Missing IDE package file: ${relPath}`);
    }
    const targetName = relPath === 'ide/README.md' ? 'extension/README.md' : `extension/${relPath}`;
    entries.push({ name: targetName, data: readFileSync(fullPath) });
  }

  for (const relModule of IDE_VSIX_MODULES) {
    const fullPath = join(root, relModule);
    if (!existsSync(fullPath)) {
      throw new Error(`Missing VSIX module required by manifest: ${relModule}`);
    }
    entries.push({ name: `extension/${relModule}`, data: readFileSync(fullPath) });
  }

  const zipBytes = createZipArchive(entries);
  writeFileSync(vsixPath, zipBytes);
  const { checksum, sha256 } = writeSha256Sidecar(vsixPath, zipBytes, '.vsix.sha256');
  return { version, vsix: vsixPath, checksum, sha256, entries: entries.length };
}

/**
 * Verifies tag/version alignment, SHA256 checksums, and required files inside ZIP and VSIX assets.
 */
export function verifyReleaseAssets(rootDir: string, tag: string): CheckedReleaseAssets {
  const root = resolve(rootDir);
  const pluginMeta = readJsonObjectSync<{ version?: string }>(join(root, 'plugin.json'));
  const ideMeta = readJsonObjectSync<{ name?: string; version?: string; publisher?: string }>(join(root, 'ide', 'package.json'));
  const version = String(pluginMeta.version ?? '');

  if (!version || version !== String(ideMeta.version ?? '')) {
    throw new Error('plugin.json and ide/package.json versions do not match.');
  }
  if (tag !== `v${version}`) {
    throw new Error(`Tag ${tag} does not match manifest version ${version}.`);
  }

  const zipPath = join(root, 'dist', `antigrative-dashboard-${version}.zip`);
  const zipChecksum = join(root, 'dist', `antigrative-dashboard-${version}.zip.sha256`);
  const vsixPath = join(root, 'dist', `${String(ideMeta.name ?? IDE_PACKAGE_NAME)}-${version}.vsix`);
  const vsixChecksum = join(root, 'dist', `${String(ideMeta.name ?? IDE_PACKAGE_NAME)}-${version}.vsix.sha256`);
  const notesPath = join(root, 'GITHUB_RELEASE.md');

  for (const requiredFile of [zipPath, vsixPath, notesPath]) {
    if (!existsSync(requiredFile)) {
      throw new Error(`Missing release file: ${requiredFile}`);
    }
  }
  verifyChecksumFile(zipPath, zipChecksum, 'Package');
  verifyChecksumFile(vsixPath, vsixChecksum, 'IDE package');

  const zipEntries = readZipArchive(readFileSync(zipPath));
  const prefix = 'antigrative-dashboard/';
  const zippedManifestRaw = zipEntries.get(`${prefix}plugin.json`)?.readText('utf8');
  if (!zippedManifestRaw || (JSON.parse(zippedManifestRaw) as { version?: string }).version !== version) {
    throw new Error('Packaged version differs');
  }
  const missingZip = RELEASE_ZIP_REQUIRED_FILES.filter((name) => !zipEntries.has(`${prefix}${name}`));
  if (missingZip.length > 0) {
    throw new Error(`Missing files in ${zipPath}: ${missingZip.join(', ')}`);
  }

  const vsixEntries = readZipArchive(readFileSync(vsixPath));
  const vsixManifestRaw = vsixEntries.get('extension/package.json')?.readText('utf8');
  if (!vsixManifestRaw) throw new Error('Missing extension/package.json in VSIX');
  const vsixPkg = JSON.parse(vsixManifestRaw) as { version?: string; name?: string; publisher?: string };
  if (
    vsixPkg.version !== version ||
    vsixPkg.name !== IDE_PACKAGE_NAME ||
    vsixPkg.publisher !== IDE_PUBLISHER
  ) {
    throw new Error('Packaged IDE identity/version differs');
  }
  const missingVsix = RELEASE_VSIX_REQUIRED_FILES.filter((name) => !vsixEntries.has(name));
  if (missingVsix.length > 0) {
    throw new Error(`Missing files in ${vsixPath}: ${missingVsix.join(', ')}`);
  }

  return { version, zip: zipPath, zipChecksum, vsix: vsixPath, vsixChecksum, notes: notesPath };
}

export function createGitHubReleaseClient(token: string, repo = UPDATE_REPO): GitHubReleaseClient {
  const baseHeaders = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `${repo}-publisher`,
  };
  return {
    async request(method, url, body, contentType = 'application/json') {
      const headers: Record<string, string> = { ...baseHeaders };
      let payload: BodyInit | undefined;
      if (body !== undefined) {
        if (typeof body === 'string') {
          payload = body;
          headers['Content-Type'] = contentType;
        } else if (body instanceof Uint8Array) {
          payload = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
          headers['Content-Type'] = contentType;
        } else {
          payload = JSON.stringify(body);
          headers['Content-Type'] = 'application/json';
        }
      }
      const res = await fetch(url, { method, headers, body: payload });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`GitHub ${method} ${url} failed (${res.status}): ${text}`);
      }
      if (!text.trim()) return null;
      return JSON.parse(text) as Record<string, unknown> | Array<Record<string, unknown>>;
    },
  };
}

async function findReleaseByTag(
  client: GitHubReleaseClient,
  api: string,
  tag: string,
): Promise<Record<string, unknown> | null> {
  if (typeof client.find === 'function') {
    return client.find(tag);
  }
  for (let page = 1; ; page += 1) {
    const releases = await client.request('GET', `${api}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) return null;
    const found = releases.find((item) => item && item.tag_name === tag);
    if (found) return found;
    if (releases.length < 100) return null;
  }
}

/**
 * Stages a draft GitHub Release, replaces and verifies all assets while private, and then publishes atomically.
 * Refuses to overwrite an already-public release unless withdrawn to draft first.
 */
export async function publishRelease(
  client: GitHubReleaseClient,
  tag: string,
  commit: string,
  notes: string,
  assets: readonly ReleaseAssetUpload[],
  repo = UPDATE_REPO,
): Promise<{ releaseId: number; htmlUrl: string; tag: string }> {
  const api = `https://api.github.com/repos/${repo}`;
  const existing = await findReleaseByTag(client, api, tag);
  if (existing && !existing.draft) {
    throw new Error('Release is already public; withdraw it before replacing its package');
  }

  // All replacements happen while the release is private (draft: true).
  // Failed uploads leave a private draft, never a publicly visible broken release.
  const draftPayload: Record<string, unknown> = {
    tag_name: tag,
    target_commitish: commit,
    name: `Antigrative Dashboard ${tag}`,
    body: notes,
    draft: true,
    prerelease: false,
  };

  const release = (
    existing && typeof existing.id === 'number'
      ? await client.request('PATCH', `${api}/releases/${existing.id}`, draftPayload)
      : await client.request('POST', `${api}/releases`, draftPayload)
  ) as Record<string, unknown>;

  const existingAssets = Array.isArray(release.assets) ? (release.assets as Array<Record<string, unknown>>) : [];
  for (const oldAsset of existingAssets) {
    if (oldAsset && typeof oldAsset.id === 'number') {
      await client.request('DELETE', `${api}/releases/assets/${oldAsset.id}`);
    }
  }

  const uploadBase = String(release.upload_url ?? '').split('{')[0];
  for (const upload of assets) {
    const uploadUrl = `${uploadBase}?name=${encodeURIComponent(upload.name)}`;
    await client.request('POST', uploadUrl, readFileSync(upload.path), upload.contentType);
  }

  const uploaded = (await client.request('GET', `${api}/releases/${release.id}`)) as Record<string, unknown> | null;
  const uploadedAssets =
    uploaded && Array.isArray(uploaded.assets) ? (uploaded.assets as Array<Record<string, unknown>>) : [];
  const expectedNames = new Set(assets.map((item) => item.name));
  const actualNames = new Set(uploadedAssets.map((item) => String(item.name ?? '')));
  if (
    !uploaded ||
    expectedNames.size !== actualNames.size ||
    [...expectedNames].some((name) => !actualNames.has(name))
  ) {
    throw new Error('Uploaded release assets do not match verified local artifacts');
  }

  const published = (await client.request('PATCH', `${api}/releases/${release.id}`, {
    draft: false,
    make_latest: 'true',
  })) as Record<string, unknown>;

  return {
    releaseId: Number(published?.id ?? release.id ?? 0),
    htmlUrl: String(published?.html_url ?? release.html_url ?? ''),
    tag,
  };
}
