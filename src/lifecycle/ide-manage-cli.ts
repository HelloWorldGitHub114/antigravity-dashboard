import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manageIde } from './installer.ts';

function takeFlagValue(argv: string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return next;
}

export function runIdeManageCli(argv = process.argv.slice(2)): number {
  let action: 'install' | 'launch' | 'uninstall' | undefined;
  let executable = '';
  let vsix: string | undefined;
  let workspace: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--exe') {
      executable = takeFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === '--vsix') {
      vsix = takeFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === '--workspace') {
      workspace = takeFlagValue(argv, i, arg);
      i += 1;
    } else if ((arg === 'install' || arg === 'launch' || arg === 'uninstall') && !action) {
      action = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!action || !executable) {
    throw new Error('Usage: node ide/manage.mjs <install|launch|uninstall> --exe <path> [--vsix <path>] [--workspace <path>]');
  }

  const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  manageIde({
    action,
    executable,
    sourceRoot: rootDir,
    vsix,
    workspace,
  });
  return 0;
}

if (typeof process !== 'undefined' && process.argv[1]?.replace(/\\/g, '/').endsWith('ide/manage.mjs')) {
  process.exitCode = runIdeManageCli();
}
