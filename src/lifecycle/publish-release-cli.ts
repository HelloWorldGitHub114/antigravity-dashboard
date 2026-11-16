import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPDATE_REPO } from '../platform/manifest.ts';
import { createGitHubReleaseClient, publishRelease, verifyReleaseAssets } from './packager.ts';

export { createGitHubReleaseClient, publishRelease, verifyReleaseAssets };

function takeFlagValue(argv: string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return next;
}

export async function runPublishReleaseCli(argv = process.argv.slice(2)): Promise<number> {
  let tag = (process.env.GITHUB_REF_NAME ?? '').trim();
  let commit = (process.env.GITHUB_SHA ?? '').trim();
  let repo = (process.env.GITHUB_REPOSITORY ?? '').trim() || UPDATE_REPO;
  let checkOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--tag') {
      tag = takeFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === '--commit') {
      commit = takeFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === '--repo') {
      repo = takeFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === '--check-only') {
      checkOnly = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!tag) {
    throw new Error('Usage: node tools/publish-release.mjs --tag <vX.Y.Z> [--commit <sha>] [--repo <owner/name>] [--check-only]');
  }

  const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const assets = verifyReleaseAssets(rootDir, tag);
  if (checkOnly) {
    console.log(JSON.stringify(assets, null, 2));
    return 0;
  }

  if (!commit) throw new Error('--commit (or GITHUB_SHA) is required unless --check-only is passed.');
  const token = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim();
  if (!token) throw new Error('GITHUB_TOKEN or GH_TOKEN is required to publish a release.');

  const notes = readFileSync(assets.notes, 'utf8');
  const client = createGitHubReleaseClient(token, repo);
  const result = await publishRelease(
    client,
    tag,
    commit,
    notes,
    [
      { path: assets.zip, name: basename(assets.zip), contentType: 'application/zip' },
      { path: assets.zipChecksum, name: basename(assets.zipChecksum), contentType: 'text/plain; charset=utf-8' },
      { path: assets.vsix, name: basename(assets.vsix), contentType: 'application/zip' },
      { path: assets.vsixChecksum, name: basename(assets.vsixChecksum), contentType: 'text/plain; charset=utf-8' },
    ],
    repo,
  );
  console.log('Published release:', result.htmlUrl);
  return 0;
}

if (typeof process !== 'undefined' && process.argv[1]?.replace(/\\/g, '/').endsWith('tools/publish-release.mjs')) {
  runPublishReleaseCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
