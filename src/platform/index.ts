export {
  platformPaths,
  instancePaths,
  allInstancePaths,
  appAsarCandidates,
  resolveAppAsar,
  agentExecutables,
  installedAgentExecutable,
  type PlatformName,
  type InstanceKind,
  type PlatformPathOptions,
  type AgentExecutableOptions,
  type PlatformPaths,
  type InstancePaths,
} from './paths.ts';
export {
  validateLanguage,
  PreferencesStore,
  type PreferencesStoreOptions,
} from './preferences-store.ts';
export {
  SidecarOwner,
  type SidecarOwnerRecord,
  type SidecarOwnerOptions,
} from './sidecar-owner.ts';
export {
  isLoopbackHost,
  isValidDevToolsTarget,
  readDevToolsPort,
  fetchDevToolsTargets,
  discoverDevToolsTargets,
  type DevToolsTargetMode,
  type DevToolsTarget,
  type ReadDevToolsPortOptions,
  type FetchDevToolsTargetsOptions,
  type DiscoverDevToolsTargetsOptions,
  type DevToolsDiscoveryResult,
} from './devtools.ts';
export * from './manifest.ts';
export {
  isNativeAccelAvailable,
  extractSqliteUsageRecords,
  readSqliteTrajectory,
  readSqliteConversationMeta,
  type SqliteSubagentSpec,
  type SqliteConversationMeta,
} from './native-bridge.ts';
