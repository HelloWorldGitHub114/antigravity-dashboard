import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCli, statusCli, uninstallCli } from './cli-installer.ts';
import {
  installDesktop,
  type LifecycleInstanceTarget,
  setDesktopEnabled,
  statusDesktop,
  uninstallDesktop,
} from './installer.ts';
import { packageDesktopRelease, packageIdeVsix } from './packager.ts';
import { exportOpenSource } from './sanitizer.ts';

function takeFlagValue(argv: string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return next;
}

export function runManageCli(argv = process.argv.slice(2)): number {
  let command: string | undefined;
  let home: string | undefined;
  let appPath: string | undefined;
  let panelOnly = false;
  let instance: LifecycleInstanceTarget = 'all';
  let nodeCandidate: string | undefined;
  let language: string | undefined;
  let output: string | undefined;
  let dest: string | undefined;
  let exportAll = false;
  let exportCheck = false;
  let skipTests = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--home') {
      home = takeFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === '--app-path') {
      appPath = takeFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === '--panel-only') {
      panelOnly = true;
    } else if (arg === '--instance') {
      const value = takeFlagValue(argv, i, arg);
      if (value !== 'all' && value !== 'pro' && value !== 'vertex') {
        throw new Error(`Invalid --instance value: ${value}`);
      }
      instance = value;
      i += 1;
    } else if (arg === '--node') {
      nodeCandidate = takeFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === '--language') {
      language = takeFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === '--output') {
      output = takeFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === '--dest') {
      dest = takeFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === '--all') {
      exportAll = true;
    } else if (arg === '--check') {
      exportCheck = true;
    } else if (arg === '--skip-tests') {
      skipTests = true;
    } else if (!arg.startsWith('-') && !command) {
      command = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!command) {
    console.error(
      'Usage: node manage.mjs <install|enable|disable|status|uninstall|install-cli|uninstall-cli|status-cli|package|package-ide|export-opensource> [options]',
    );
    return 1;
  }

  const rootDir = dirname(fileURLToPath(import.meta.url));
  const resolvedHome = home ?? homedir();

  if (command === 'install') {
    installDesktop({ sourceRoot: rootDir, home: resolvedHome, appPath, panelOnly, instance });
    return 0;
  }
  if (command === 'enable') {
    setDesktopEnabled(true, { sourceRoot: rootDir, home: resolvedHome, appPath, instance });
    return 0;
  }
  if (command === 'disable') {
    setDesktopEnabled(false, { sourceRoot: rootDir, home: resolvedHome, appPath, instance });
    return 0;
  }
  if (command === 'status') {
    statusDesktop({ sourceRoot: rootDir, home: resolvedHome, appPath, instance });
    return 0;
  }
  if (command === 'uninstall') {
    uninstallDesktop({ sourceRoot: rootDir, home: resolvedHome, appPath, instance });
    return 0;
  }
  if (command === 'install-cli') {
    const resolvedLanguage =
      language ??
      (JSON.parse(readFileSync(join(rootDir, 'plugin.json'), 'utf8')) as { language?: string }).language;
    installCli(rootDir, resolvedHome, nodeCandidate, resolvedLanguage);
    return 0;
  }
  if (command === 'uninstall-cli') {
    uninstallCli(resolvedHome);
    return 0;
  }
  if (command === 'status-cli') {
    statusCli(resolvedHome);
    return 0;
  }
  if (command === 'package') {
    const result = packageDesktopRelease(rootDir, output);
    console.log('Package:', result.archive);
    console.log('SHA256:', result.sha256);
    return 0;
  }
  if (command === 'package-ide') {
    const result = packageIdeVsix(rootDir, output);
    console.log(result.vsix);
    return 0;
  }
  if (command === 'export-opensource') {
    const outcome = exportOpenSource({
      sourceDir: rootDir,
      destDir: dest,
      all: exportAll,
      check: exportCheck,
      skipTests,
    });
    if (outcome.findings.length > 0) {
      console.error('Privacy audit failed! Found forbidden references:');
      for (const item of outcome.findings) console.error(`  - ${item}`);
      return 1;
    }
    if (exportCheck) {
      console.log(`Privacy check passed (${outcome.checked} source files scanned).`);
    } else {
      console.log(`Exported ${outcome.exported} sanitized files to ${outcome.dest} (privacy audit passed).`);
    }
    return 0;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('manage.mjs')) {
  process.exitCode = runManageCli();
}
