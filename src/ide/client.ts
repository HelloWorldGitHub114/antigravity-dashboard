import { AntigravityClient, type ServerEndpoint } from '../telemetry/client/index.ts';
import { discoverIdeLog, discoverIdeProcesses, type IdeProcessRow } from './discovery.ts';

export interface IdeDiscoveredProcess extends IdeProcessRow {
  Ports: number[];
}

export interface IdeClientOptions {
  profile?: string;
  debugPort?: () => number;
  processes?: (debugPort: number) => Promise<IdeDiscoveredProcess>;
  logPort?: (profile: string, ports: readonly number[]) => Promise<number>;
}

/**
 * Local RPC & streaming snapshot client bound to a specific Antigravity IDE instance.
 */
export class IdeClient extends AntigravityClient {
  profile: string;
  debugPort: () => number;
  ideProcesses: (debugPort: number) => Promise<IdeDiscoveredProcess>;
  logPort: (profile: string, ports: readonly number[]) => Promise<number>;

  constructor({
    profile = '',
    debugPort = () => 0,
    processes = discoverIdeProcesses,
    logPort = discoverIdeLog,
  }: IdeClientOptions = {}) {
    super();
    this.profile = profile;
    this.debugPort = debugPort;
    this.ideProcesses = processes;
    this.logPort = logPort;
  }

  override async discoverNow(): Promise<ServerEndpoint> {
    this.server = null;
    const row = await this.ideProcesses(this.debugPort());
    const port = await this.logPort(this.profile, row.Ports);
    const csrf = row.CommandLine?.match(/--csrf_token(?:=|\s+)"?([^\s"]+)/)?.[1];
    if (!csrf) throw new Error('IDE local API credential unavailable');
    this.server = { port, csrf, pid: row.ProcessId };
    this.discoveredAt = this.now();
    return this.server;
  }
}
