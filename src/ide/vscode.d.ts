declare module 'vscode' {
  export interface Disposable {
    dispose(): unknown;
  }

  export interface OutputChannel extends Disposable {
    appendLine(value: string): void;
    show(preserveFocus?: boolean): void;
  }

  export interface ExtensionContext {
    readonly extensionPath: string;
    readonly globalStorageUri: { readonly fsPath: string };
    readonly subscriptions: Disposable[];
  }

  export interface Environment {
    readonly appName: string;
    readonly uiKind: number;
  }

  export interface WorkspaceConfiguration {
    get<T>(section: string, defaultValue: T): T;
    get<T>(section: string): T | undefined;
  }

  export interface ConfigurationChangeEvent {
    affectsConfiguration(section: string): boolean;
  }

  export const env: Environment;

  export namespace window {
    export function createOutputChannel(name: string): OutputChannel;
  }

  export namespace workspace {
    export function getConfiguration(section?: string): WorkspaceConfiguration;
    export function onDidChangeConfiguration(
      listener: (e: ConfigurationChangeEvent) => unknown,
    ): Disposable;
  }

  export namespace commands {
    export function registerCommand(
      command: string,
      callback: (...args: unknown[]) => unknown,
    ): Disposable;
  }
}
