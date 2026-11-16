import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import supportedIde from './host.ts';

interface IpcChildProcess extends ChildProcess {
  send?(message: unknown): boolean;
}

interface UnrefableTimeout {
  unref?: () => void;
}

interface IntegrationHealthFile {
  checkedAt?: string;
  state?: string;
}

let child: IpcChildProcess | null = null;
let output: vscode.OutputChannel | undefined;
let activeStop: (() => void) | null = null;

/**
 * Activates the Antigravity IDE dashboard collector extension.
 */
export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Antigrative Dashboard IDE');
  if (!supportedIde(vscode.env)) {
    output.appendLine('This adapter supports the standalone Antigravity IDE only.');
    context.subscriptions.push(output);
    return;
  }

  const profile = resolve(context.globalStorageUri.fsPath, '../../..');

  function stop(): void {
    if (!child) return;
    const prior = child;
    child = null;
    try {
      prior.send?.({ type: 'stop' });
    } catch {
      prior.kill();
    }
    const deadline = setTimeout(() => prior.kill(), 2000);
    (deadline as unknown as UnrefableTimeout).unref?.();
    prior.once('exit', () => clearTimeout(deadline));
  }

  function start(): void {
    stop();
    if (!vscode.workspace.getConfiguration('antigrativeDashboard.ide').get('enabled', true)) return;
    if (!existsSync(join(profile, 'DevToolsActivePort'))) {
      output?.appendLine(
        'Renderer connection unavailable. Fully quit the IDE, then start with --remote-debugging-port=0 --remote-debugging-address=127.0.0.1. See the extension README.',
      );
      return;
    }

    const launched: IpcChildProcess = spawn(
      process.execPath,
      [join(context.extensionPath, 'ide', 'main.mjs')],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          AG_PULSE_IDE_PROFILE: profile,
          AG_PULSE_IDE_DATA: context.globalStorageUri.fsPath,
        },
      },
    );
    child = launched;

    // Never echo API responses, command lines or credentials into IDE logs.
    launched.stdout?.resume();
    launched.stderr?.resume();
    launched.once('error', () => output?.appendLine('IDE collector could not start.'));
    launched.once('exit', (code: number | null) => {
      output?.appendLine(`IDE collector stopped (${code ?? 'signal'}).`);
      if (child === launched) child = null;
    });
    output?.appendLine('IDE collector started.');
  }

  activeStop = stop;
  context.subscriptions.push(
    output,
    { dispose: stop },
    vscode.commands.registerCommand('antigrativeDashboard.ide.openHealth', () => {
      let status = 'Waiting for a fresh IDE renderer connection';
      try {
        const value = JSON.parse(
          readFileSync(join(context.globalStorageUri.fsPath, 'integration-state.json'), 'utf8'),
        ) as IntegrationHealthFile;
        const age = Date.now() - Date.parse(value.checkedAt ?? '');
        if (age >= 0 && age < 15000 && typeof value.state === 'string') {
          status = value.state === 'mounted' ? 'Dashboard attached to the Agent composer' : value.state;
        }
      } catch {
        // Keep waiting message when integration state is absent or unreadable.
      }
      output?.appendLine(status);
      output?.show(true);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('antigrativeDashboard.ide.enabled')) start();
    }),
  );

  start();
}

/**
 * Stops the background IDE collector process on extension deactivation.
 */
export function deactivate(): void {
  activeStop?.();
}
