import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditPrivacy,
  buildForbiddenPatterns,
  collectSanitizedFiles,
  exportOpenSource,
  loadLocalExportConfig,
} from './sanitizer.ts';

export { auditPrivacy, buildForbiddenPatterns, collectSanitizedFiles, exportOpenSource, loadLocalExportConfig };

function takeFlagValue(argv: string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return next;
}

export function runExportOpenSourceCli(argv = process.argv.slice(2)): number {
  let destDir: string | undefined;
  let all = false;
  let skipTests = false;
  let check = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--dest') {
      destDir = takeFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--skip-tests') {
      skipTests = true;
    } else if (arg === '--check') {
      check = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const outcome = exportOpenSource({
    sourceDir: rootDir,
    destDir,
    all,
    skipTests,
    check,
  });

  if (outcome.findings.length > 0) {
    console.error('Privacy audit failed! Found forbidden references:');
    for (const item of outcome.findings) console.error(`  - ${item}`);
    return 1;
  }
  if (check) {
    console.log(`Privacy check passed (${outcome.checked} source files scanned).`);
  } else {
    console.log(`Exported ${outcome.exported} sanitized files to ${outcome.dest} (privacy audit passed).`);
  }
  return 0;
}

if (typeof process !== 'undefined' && process.argv[1]?.replace(/\\/g, '/').endsWith('tools/export-opensource.mjs')) {
  process.exitCode = runExportOpenSourceCli();
}
