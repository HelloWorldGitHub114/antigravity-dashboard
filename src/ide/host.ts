// VSIX format alone does not establish support for other VS Code-based hosts.

export interface IdeHostEnv {
  appName?: unknown;
  uiKind?: unknown;
}

/**
 * Checks whether the current extension host is the native Antigravity IDE desktop app.
 */
export default function supportedIde(env: IdeHostEnv | null | undefined): boolean {
  return Boolean(env && env.appName === 'Antigravity IDE' && env.uiKind === 1);
}
