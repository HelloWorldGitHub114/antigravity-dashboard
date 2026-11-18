import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFontScale } from '../contracts/preferences.ts';
import { platformPaths } from '../platform/paths.ts';
import { installCli, statusCli, uninstallCli } from './cli-installer.ts';
import {
  applyDebugLaunch,
  getDebugLaunchStatus,
  launchDesktopWithDebug,
} from './debug-launch.ts';
import { readJsonObjectSync, writeJsonObjectSync } from './fs-helpers.ts';
import {
  installDesktop,
  type LifecycleInstanceTarget,
  setDesktopEnabled,
  statusDesktop,
  uninstallDesktop,
} from './installer.ts';
import { packageDesktopRelease, packageIdeVsix } from './packager.ts';
import { exportOpenSource } from './sanitizer.ts';

function saveDebugLaunchPrefSync(home: string, enabled: boolean): void {
  const prefsFile = join(dirname(platformPaths({ home }).settings), 'preferences.json');
  const raw = readJsonObjectSync<Record<string, unknown>>(prefsFile, {});
  const prevRev = typeof raw.revision === 'number' && Number.isSafeInteger(raw.revision) ? raw.revision : 0;
  writeJsonObjectSync(prefsFile, {
    schema: 1,
    language: raw.language === 'en' || raw.language === 'zh-CN' ? raw.language : null,
    languageGuideDismissed: raw.languageGuideDismissed === true,
    usageGuideDismissed: raw.usageGuideDismissed === true,
    modelTimelineEnabled: raw.modelTimelineEnabled === true,
    debugLaunchEnabled: enabled,
    usageFontScale: resolveFontScale(raw.usageFontScale),
    sidebarFontScale: resolveFontScale(raw.sidebarFontScale),
    inlineFontScale: resolveFontScale(raw.inlineFontScale),
    revision: Math.max(Date.now(), prevRev + 1),
  });
}

function takeFlagValue(argv: string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return next;
}

export function runManageCli(argv = process.argv.slice(2)): number {
  let command: string | undefined;
  let subAction: string | undefined;
  let home: string | undefined;
  let appPath: string | undefined;
  let panelOnly = false;
  let enableDebugLaunch = false;
  let instance: LifecycleInstanceTarget = 'all';
  let nodeCandidate: string | undefined;
  let language: string | undefined;
  let output: string | undefined;
  let dest: string | undefined;
  let exportAll = false;
  let exportCheck = false;
  let skipTests = false;
  let requireNative: boolean | undefined;

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
    } else if (arg === '--enable-debug-launch') {
      enableDebugLaunch = true;
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
    } else if (arg === '--require-native') {
      requireNative = true;
    } else if (!arg.startsWith('-') && !command) {
      command = arg;
    } else if (!arg.startsWith('-') && command === 'debug-launch' && !subAction) {
      subAction = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!command) {
    console.error(
      'Usage: node manage.mjs <install|enable|disable|status|uninstall|launch|debug-launch|install-cli|uninstall-cli|status-cli|package|package-ide|export-opensource> [options]',
    );
    return 1;
  }

  const rootDir = dirname(fileURLToPath(import.meta.url));
  const resolvedHome = home ?? homedir();

  if (command === 'install') {
    installDesktop({
      sourceRoot: rootDir,
      home: resolvedHome,
      appPath,
      panelOnly,
      instance,
      enableDebugLaunch,
    });
    if (enableDebugLaunch) {
      saveDebugLaunchPrefSync(resolvedHome, true);
    }
    return 0;
  }
  if (command === 'launch') {
    launchDesktopWithDebug({ home: resolvedHome, appPath });
    return 0;
  }
  if (command === 'debug-launch') {
    const action = subAction || 'status';
    if (action === 'status') {
      console.log(JSON.stringify(getDebugLaunchStatus({ home: resolvedHome, appPath }), null, 2));
      return 0;
    }
    if (action === 'on' || action === 'off') {
      const enabled = action === 'on';
      const outcome = applyDebugLaunch(enabled, { home: resolvedHome, appPath });
      saveDebugLaunchPrefSync(resolvedHome, enabled);
      console.log(JSON.stringify(outcome, null, 2));
      return 0;
    }
    throw new Error(`Unknown debug-launch action: ${action}`);
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
    const result = packageDesktopRelease(rootDir, output, { requireNative });
    console.log('Package:', result.archive);
    console.log('SHA256:', result.sha256);
    return 0;
  }
  if (command === 'package-ide') {
    const result = packageIdeVsix(rootDir, output, { requireNative });
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
