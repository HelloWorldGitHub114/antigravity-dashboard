import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageIdeVsix } from './packager.ts';

export function runIdePackageCli(argv = process.argv.slice(2)): number {
  let output: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--output') {
      output = argv[i + 1];
      if (!output) throw new Error('Missing value for --output');
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const result = packageIdeVsix(rootDir, output);
  console.log(result.vsix);
  return 0;
}

if (typeof process !== 'undefined' && process.argv[1]?.replace(/\\/g, '/').endsWith('ide/package.mjs')) {
  process.exitCode = runIdePackageCli();
}
