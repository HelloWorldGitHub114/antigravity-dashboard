// The plugin owns this adapter. App upgrades never need to preserve app.asar edits.
export { CdpConnection } from './cdp-connection.ts';
export {
  BINDING,
  bindWindowFactory,
  discoverTargets,
  evaluateCjsFactoryExpression,
  invokeCjsFactory,
  makeEsmExportFromCjs,
  makeRendererSource,
  validTarget,
  validatedInput,
} from './renderer-bridge.ts';
export { RuntimeUi } from './runtime-ui.ts';
export type {
  CdpConnectionOptions,
  CdpContextCandidate,
  CdpEventMessage,
  DevToolsTarget,
  RuntimePreferencesBridge,
  RuntimeSessionConnection,
  RuntimeUiOptions,
  RuntimeUpdaterBridge,
  WebSocketConstructor,
  WebSocketLike,
  WebSocketMessageEvent,
} from './types.ts';
