import {
  discoverDevToolsTargets,
  isValidDevToolsTarget,
  type DevToolsDiscoveryResult,
  type DevToolsTarget,
} from '../platform/devtools.ts';

/**
 * Checks whether a CDP target entry belongs to an Antigravity IDE workbench page on `port`.
 */
export function validIdeTarget(
  target: DevToolsTarget | null | undefined,
  port: number,
): boolean {
  return isValidDevToolsTarget(target, port, 'ide');
}

/**
 * Discovers loopback DevTools page targets for an Antigravity IDE `profile` directory.
 */
export async function ideTargets(profile: string): Promise<DevToolsDiscoveryResult> {
  return discoverDevToolsTargets(profile, {
    mode: 'ide',
    fileErrorMessage: 'Invalid IDE renderer port',
    portErrorMessage: 'Invalid IDE renderer port',
    unavailableErrorMessage: 'IDE renderer discovery failed',
    tooLargeErrorMessage: 'IDE renderer discovery failed',
    responseErrorMessage: 'Invalid IDE renderer targets',
    filter: (target, port) => validIdeTarget(target, port),
  });
}
