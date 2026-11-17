import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import {
  OPENSOURCE_EXCLUDED_DIRS,
  OPENSOURCE_EXCLUDED_REL_FILES,
  OPENSOURCE_EXCLUDED_SUFFIXES,
  OPENSOURCE_TEXT_EXTENSIONS,
} from '../platform/manifest.ts';
import {
  auditOpenSourcePrivacy,
  syncAndAuditOpenSource,
  type SanitizerPatternInput,
} from '../platform/native-bridge.ts';
import { readJsonObjectSync } from './fs-helpers.ts';

export interface ForbiddenPatternSpec {
  regex: RegExp;
  label: string;
}

export interface LocalExportConfig {
  defaultDest?: string;
  defaultGdriveDest?: string;
  forbiddenPatterns?: Array<{ pattern: string; flags?: string; label: string }>;
}

const GENERIC_SECRET_PATTERNS: readonly ForbiddenPatternSpec[] = [
  { regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, label: 'private key block' },
];

const ALL_ACCOUNTS_LABEL_RE =
  /accounts\.push\(\s*\{\s*id:\s*(['"])all\1\s*,\s*name:\s*(['"])(?:全部账号 \(汇总\)|\\u5168\\u90E8\\u8D26\\u53F7 \(\\u6C47\\u603B\))\2\s*,\s*email:\s*(['"])(?:全部账号 \(汇总\)|\\u5168\\u90E8\\u8D26\\u53F7 \(\\u6C47\\u603B\))\3\s*,\s*active:\s*activeScope\s*===\s*(['"])all\4\s*\}\s*\);/gi;

export function sanitizeUsageMjs(text: string): string {
  return text.replace(
    ALL_ACCOUNTS_LABEL_RE,
    'accounts.push({ id: "all", name: "All Accounts (Aggregated)", email: "All Accounts (Aggregated)", active: activeScope === "all" });',
  );
}

export function sanitizeAccountsTs(text: string): string {
  return text.replace(
    ALL_ACCOUNTS_LABEL_RE,
    "accounts.push({ id: 'all', name: 'All Accounts (Aggregated)', email: 'All Accounts (Aggregated)', active: activeScope === 'all' });",
  );
}

export function sanitizeMultiAccountTest(text: string): string {
  return text.replace(
    "assert.equal(accounts[0].name, '全部账号 (汇总)');",
    "assert.equal(accounts[0].name, 'All Accounts (Aggregated)');",
  );
}

const SANITIZERS: Record<string, (text: string) => string> = {
  'sidecars/panel/usage.mjs': sanitizeUsageMjs,
  'src/telemetry/ledger/accounts.ts': sanitizeAccountsTs,
  'sidecars/panel/tests/multi-account-features.test.mjs': sanitizeMultiAccountTest,
};

function parseLegacyPythonExportConfig(rootDir: string): LocalExportConfig {
  const pyPath = join(resolve(rootDir), 'tools', 'export-opensource.py');
  if (!existsSync(pyPath)) return {};
  try {
    const text = readFileSync(pyPath, 'utf8');
    const destMatch = text.match(/DEFAULT_DEST\s*=\s*Path\(r'([^']+)'\)/);
    const gdriveMatch = text.match(/DEFAULT_GDRIVE_DEST\s*=\s*Path\(r'([^']+)'\)/);
    const forbiddenPatterns: Array<{ pattern: string; flags?: string; label: string }> = [];
    const patternRe = /\(re\.compile\(r'([^']+)'(\s*,\s*re\.IGNORECASE)?\),\s*'([^']+)'\)/g;
    let match: RegExpExecArray | null;
    while ((match = patternRe.exec(text)) !== null) {
      const rawPattern = (match[1] ?? '').replace(/\\\\\\\\/g, '\\\\+');
      const flags = match[2] ? 'i' : '';
      const label = match[3] ?? '';
      if (rawPattern && label) {
        forbiddenPatterns.push({ pattern: rawPattern, flags, label });
      }
    }
    return {
      defaultDest: destMatch?.[1],
      defaultGdriveDest: gdriveMatch?.[1],
      forbiddenPatterns: forbiddenPatterns.length > 0 ? forbiddenPatterns : undefined,
    };
  } catch {
    return {};
  }
}

export function loadLocalExportConfig(rootDir: string): LocalExportConfig {
  const fallback = parseLegacyPythonExportConfig(rootDir);
  const configPath = join(resolve(rootDir), '.data', 'export-opensource.local.json');
  if (!existsSync(configPath)) return fallback;
  const local = readJsonObjectSync<LocalExportConfig>(configPath, {});
  return {
    defaultDest: local.defaultDest ?? fallback.defaultDest,
    defaultGdriveDest: local.defaultGdriveDest ?? fallback.defaultGdriveDest,
    forbiddenPatterns:
      local.forbiddenPatterns && local.forbiddenPatterns.length > 0
        ? local.forbiddenPatterns
        : fallback.forbiddenPatterns,
  };
}

export function buildForbiddenPatterns(
  rootDir: string,
  extraPatterns: readonly ForbiddenPatternSpec[] = [],
): ForbiddenPatternSpec[] {
  const local = loadLocalExportConfig(rootDir);
  const compiledLocal: ForbiddenPatternSpec[] = [];
  for (const item of local.forbiddenPatterns ?? []) {
    if (!item?.pattern || !item?.label) continue;
    compiledLocal.push({
      regex: new RegExp(item.pattern, item.flags ?? ''),
      label: item.label,
    });
  }
  return [...GENERIC_SECRET_PATTERNS, ...compiledLocal, ...extraPatterns];
}

export function isExcludedFromOpenSource(relPosix: string): boolean {
  if (relPosix === 'cli/bin' || relPosix.startsWith('cli/bin/')) return true;
  const parts = relPosix.split('/').filter(Boolean);
  if (parts.some((part) => OPENSOURCE_EXCLUDED_DIRS.has(part))) return true;
  if (OPENSOURCE_EXCLUDED_REL_FILES.has(relPosix)) return true;
  const baseName = parts[parts.length - 1] ?? '';
  if (baseName.startsWith('.env')) return true;
  const ext = extname(baseName).toLowerCase();
  return ext.length > 0 && OPENSOURCE_EXCLUDED_SUFFIXES.has(ext);
}

export function collectSanitizedFiles(rootDir: string): string[] {
  const root = resolve(rootDir);
  const files: string[] = [];

  function walk(absDir: string, relPrefix: string): void {
    const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relPosix = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (isExcludedFromOpenSource(relPosix)) continue;
      const absChild = join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(absChild, relPosix);
      } else if (entry.isFile()) {
        files.push(relPosix);
      }
    }
  }

  walk(root, '');
  return files.sort();
}

function pruneStaleDestinationFiles(destRoot: string, expectedSet: ReadonlySet<string>, absDir: string, relPrefix: string): void {
  if (!existsSync(absDir)) return;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name === '.git' && relPrefix === '') continue;
    const relPosix = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (relPosix.split('/').includes('.git')) continue;
    const absChild = join(absDir, entry.name);
    if (entry.isDirectory()) {
      pruneStaleDestinationFiles(destRoot, expectedSet, absChild, relPosix);
      try {
        if (readdirSync(absChild).length === 0) {
          rmSync(absChild, { recursive: true, force: true });
        }
      } catch {
        // Ignore non-empty or locked dirs
      }
    } else if (!expectedSet.has(relPosix)) {
      unlinkSync(absChild);
    }
  }
}

/**
 * Syncs open-source safe files from `sourceDir` into `destDir` with sanitizer transforms applied.
 */
export function syncSanitizedTree(sourceDir: string, destDir: string): string[] {
  const source = resolve(sourceDir);
  const dest = resolve(destDir);
  mkdirSync(dest, { recursive: true });

  const files = collectSanitizedFiles(source);
  const expectedSet = new Set(files);
  pruneStaleDestinationFiles(dest, expectedSet, dest, '');

  for (const relPosix of files) {
    const srcFile = join(source, ...relPosix.split('/'));
    const dstFile = join(dest, ...relPosix.split('/'));
    mkdirSync(dirname(dstFile), { recursive: true });
    const transform = SANITIZERS[relPosix];
    if (transform) {
      const text = readFileSync(srcFile, 'utf8');
      writeFileSync(dstFile, transform(text), 'utf8');
    } else {
      copyFileSync(srcFile, dstFile);
    }
  }

  return files;
}

function buildNativeFilterPayload(patterns: readonly ForbiddenPatternSpec[]): {
  excludedDirs: string[];
  excludedRelFiles: string[];
  excludedSuffixes: string[];
  textExtensions: string[];
  patterns: SanitizerPatternInput[];
} {
  return {
    excludedDirs: [...OPENSOURCE_EXCLUDED_DIRS],
    excludedRelFiles: [...OPENSOURCE_EXCLUDED_REL_FILES],
    excludedSuffixes: [...OPENSOURCE_EXCLUDED_SUFFIXES],
    textExtensions: [...OPENSOURCE_TEXT_EXTENSIONS],
    patterns: patterns.map((spec) => ({
      pattern: spec.regex.source,
      flags: spec.regex.flags,
      label: spec.label,
    })),
  };
}

/**
 * Audits exported or source files against forbidden privacy/secret patterns.
 */
export function auditPrivacy(
  rootDir: string,
  files: readonly string[],
  patterns: readonly ForbiddenPatternSpec[],
): string[] {
  const root = resolve(rootDir);
  const nativeResult = auditOpenSourcePrivacy({
    rootDir: root,
    files,
    ...buildNativeFilterPayload(patterns),
  });
  if (nativeResult) {
    return nativeResult.findings;
  }

  const findings: string[] = [];

  for (const relPosix of files) {
    const parts = relPosix.split('/');
    const baseName = parts[parts.length - 1] ?? '';
    const ext = extname(baseName).toLowerCase();
    if (!OPENSOURCE_TEXT_EXTENSIONS.has(ext) && !OPENSOURCE_TEXT_EXTENSIONS.has(baseName)) {
      continue;
    }
    const filePath = join(root, ...parts);
    let text: string;
    try {
      const bytes = readFileSync(filePath);
      text = bytes.toString('utf8');
      if (text.includes('\uFFFD')) continue;
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx]!;
      for (const spec of patterns) {
        spec.regex.lastIndex = 0;
        if (spec.regex.test(line)) {
          findings.push(`${relPosix}:${idx + 1} (${spec.label})`);
        }
      }
    }
  }

  return findings;
}

function removePycacheDirs(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') {
        rmSync(full, { recursive: true, force: true });
      } else {
        removePycacheDirs(full);
      }
    }
  }
}

export function verifyReleaseTree(destDir: string, nodeExe = process.execPath): void {
  const dest = resolve(destDir);
  const testDirs = [
    join(dest, 'sidecars', 'panel', 'tests'),
    join(dest, 'cli', 'tests'),
    join(dest, 'ide', 'tests'),
  ];
  const nodeTests: string[] = [];
  for (const dir of testDirs) {
    if (!existsSync(dir)) continue;
    const relPrefix = dir.slice(dest.length + 1).replace(/\\/g, '/');
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.test.mjs')) nodeTests.push(`${relPrefix}/${name}`);
    }
  }
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  if (nodeTests.length > 0) {
    execFileSync(nodeExe, ['--test', ...nodeTests], { cwd: dest, env, stdio: 'inherit' });
  }
  if (existsSync(join(dest, 'tests'))) {
    const pyExe = process.platform === 'win32' ? 'python' : 'python3';
    try {
      execFileSync(pyExe, ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-v'], {
        cwd: dest,
        env,
        stdio: 'inherit',
      });
    } finally {
      removePycacheDirs(dest);
    }
  }
}

function syncAndAuditDestination(
  source: string,
  dest: string,
  patterns: readonly ForbiddenPatternSpec[],
): { exported: number; findings: string[] } {
  const nativeResult = syncAndAuditOpenSource({
    sourceDir: source,
    destDir: dest,
    ...buildNativeFilterPayload(patterns),
  });
  if (nativeResult) {
    return { exported: nativeResult.exported, findings: nativeResult.findings };
  }
  const files = syncSanitizedTree(source, dest);
  const findings = auditPrivacy(dest, files, patterns);
  return { exported: files.length, findings };
}

export function exportOpenSource(options: {
  sourceDir: string;
  destDir?: string;
  all?: boolean;
  check?: boolean;
  skipTests?: boolean;
  extraPatterns?: readonly ForbiddenPatternSpec[];
}): { checked?: number; exported?: number; dest?: string; findings: string[] } {
  const source = resolve(options.sourceDir);
  const patterns = buildForbiddenPatterns(source, options.extraPatterns);
  if (options.check) {
    const nativeCheck = auditOpenSourcePrivacy({
      rootDir: source,
      ...buildNativeFilterPayload(patterns),
    });
    if (nativeCheck) {
      return { checked: nativeCheck.checked, findings: nativeCheck.findings };
    }
    const files = collectSanitizedFiles(source);
    const findings = auditPrivacy(source, files, patterns);
    return { checked: files.length, findings };
  }

  const localCfg = loadLocalExportConfig(source);
  const destInput = options.destDir ?? localCfg.defaultDest;
  if (!destInput) {
    throw new Error('No --dest specified and .data/export-opensource.local.json defaultDest is not configured.');
  }
  const dest = resolve(destInput);
  const primary = syncAndAuditDestination(source, dest, patterns);
  if (primary.findings.length > 0) return { exported: primary.exported, dest, findings: primary.findings };
  if (!options.skipTests) verifyReleaseTree(dest);

  if (options.all) {
    if (!localCfg.defaultGdriveDest) {
      throw new Error('--all requested without .data/export-opensource.local.json defaultGdriveDest.');
    }
    const gdriveDest = resolve(localCfg.defaultGdriveDest);
    const parent = dirname(gdriveDest);
    if (!existsSync(parent)) {
      throw new Error(`Mounted cloud sync parent not found: ${parent}`);
    }
    const gdrive = syncAndAuditDestination(source, gdriveDest, patterns);
    if (gdrive.findings.length > 0) {
      return { exported: gdrive.exported, dest: gdriveDest, findings: gdrive.findings };
    }
  }

  return { exported: primary.exported, dest, findings: [] };
}
