import { open, readFile, stat } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { platformPaths } from '../../compat/platform.mjs';
import { discoverProcesses } from './discovery.mjs';
import { TrajectoryJson } from './trajectory-json.mjs';
import { TrajectoryReader } from './trajectory-reader.mjs';

const SERVICE = '/exa.language_server_pb.LanguageServerService/';
const PORT_LOG_LINE = /listening on random port at (\d+) for HTTP(?:\s|$)/;
const PORT_LOG_GLOBAL = /listening on random port at (\d+) for HTTP(?:\s|$)/g;
const LOG_TAIL_BYTES = 256 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const keepAliveAgent = new Agent({ keepAlive: true, maxSockets: 8 });

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err?.code === 'EPERM'; }
}

async function readFileSlice(file, start, end) {
  const handle = await open(file, 'r');
  try {
    const length = Math.max(0, end - start);
    if (!length) return '';
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return buffer.toString('utf8', 0, offset);
  } finally {
    await handle.close();
  }
}

async function readLogWithStats(file) {
  const info = await stat(file);
  if (info.size <= LOG_TAIL_BYTES) {
    return { text: await readFile(file, 'utf8'), size: info.size, mtimeMs: info.mtimeMs };
  }
  const tail = await readFileSlice(file, info.size - LOG_TAIL_BYTES, info.size);
  if (PORT_LOG_LINE.test(tail)) {
    return { text: tail, size: info.size, mtimeMs: info.mtimeMs };
  }
  return { text: await readFile(file, 'utf8'), size: info.size, mtimeMs: info.mtimeMs };
}
export function serverFromDiscovery(log, processes) {
  const rows = (Array.isArray(processes) ? processes : [processes]).filter(p => /--standalone\b/.test(p.CommandLine || ''));
  if (!rows.length) throw new Error('未找到 Antigravity 桌面后台');
  const logPorts = [...log.matchAll(/listening on random port at (\d+) for HTTP(?:\s|$)/g)].reverse().map(m=>Number(m[1]));
  let matchedRow = null, port = null;
  for (const candidate of logPorts) {
    const owners = rows.filter(r => [r.Ports].flat().map(Number).includes(candidate));
    if (owners.length === 1) { matchedRow = owners[0]; port = candidate; break; }
  }
  if (!matchedRow) throw new Error('等待 Antigravity 本地接口启动');
  const csrf = matchedRow.CommandLine.match(/--csrf_token(?:=|\s+)"?([^\s"]+)/)?.[1];
  if (!csrf) throw new Error('当前版本未提供可用的本地检测凭据');
  return {port,csrf,pid:matchedRow.ProcessId};
}
export class AntigravityClient {
  constructor({paths=platformPaths,readLog=readFile,processes=discoverProcesses,now=Date.now,onRpc=null,modelTimelineEnabled=false}={}) {
    this.paths=paths;this.readLog=readLog;this.processes=processes;this.now=now;this.onRpc=onRpc;
    this.modelTimelineEnabled=modelTimelineEnabled===true;
    this.reader=new TrajectoryReader(this,{modelTimelineEnabled:this.modelTimelineEnabled});
  }
  setModelTimelineEnabled(enabled){
    this.modelTimelineEnabled=enabled===true;
    this.reader?.setModelTimelineEnabled?.(this.modelTimelineEnabled);
    return this.modelTimelineEnabled;
  }
  server = null;
  serverSource = null;
  discoveredAt = 0;
  discovering = null;
  lastScanAt = -Infinity;
  retryAt = 0;
  discoveryFailures = 0;
  discoveryError = null;

  async canReuseCurrentServer() {
    if (!this.server || this.processes !== discoverProcesses || this.readLog !== readFile) return false;
    if (!this.serverSource?.file || !isPidAlive(this.server.pid)) return false;
    const candidates = this.paths()?.logCandidates || [this.paths()?.log].filter(Boolean);
    for (const file of candidates) {
      try {
        const info = await stat(file);
        if (file !== this.serverSource.file) return false;
        if (info.size === this.serverSource.size && info.mtimeMs === this.serverSource.mtimeMs) return true;
        if (info.size < this.serverSource.size) return false;
        const deltaStart = Math.max(0, this.serverSource.size - 128);
        const appended = await readFileSlice(file, deltaStart, info.size);
        const matches = [...appended.matchAll(PORT_LOG_GLOBAL)];
        if (!matches.length || Number(matches.at(-1)[1]) === this.server.port) {
          this.serverSource = { file, size: info.size, mtimeMs: info.mtimeMs };
          return true;
        }
        return false;
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return false;
      }
    }
    return false;
  }

  async discover(force = false) {
    if (!force && this.server && this.now() - this.discoveredAt < 15000) return this.server;
    if (this.discovering) return this.discovering;
    if (!force && this.discoveryError && this.now() < this.retryAt) throw this.discoveryError;
    this.lastScanAt=this.now();
    this.discovering = (async () => {
      if (!force && await this.canReuseCurrentServer()) return this.server;
      return this.discoverNow();
    })().then(server=>{
      this.discoveredAt=this.now();this.discoveryFailures=0;this.discoveryError=null;this.retryAt=0;return server;
    }).catch(error=>{
      this.discoveryError=error;this.discoveryFailures++;
      this.retryAt=this.now()+Math.min(30000,3000*2**Math.min(4,this.discoveryFailures-1));throw error;
    }).finally(() => { this.discovering = null; });
    return this.discovering;
  }

  async discoverNow() {
    this.server=null;
    this.serverSource=null;
    // A sidecar can outlive a renderer/backend restart. Its injected token may
    // then refer to the previous LS instance; pair the current log port with
    // the current standalone process credential instead of mixing generations.
    const parsed = await this.processes();
    if (!parsed || Array.isArray(parsed) && !parsed.length) throw new Error('请先打开 Antigravity');
    // Credentials stay in process memory. They are never logged, persisted, or
    // returned to a browser; all calls go exclusively to 127.0.0.1.
    let foundLog=false,lastError=null;
    const paths=this.paths();
    for(const file of paths.logCandidates||[paths.log]) {
      try {
        if (this.readLog === readFile) {
          const { text, size, mtimeMs } = await readLogWithStats(file);
          foundLog = true;
          this.server = serverFromDiscovery(text, parsed);
          this.serverSource = { file, size, mtimeMs };
          break;
        }
        const log=await this.readLog(file,'utf8');foundLog=true;
        this.server=serverFromDiscovery(log,parsed);break;
      } catch(error) {
        if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')lastError=error;
      }
    }
    if(!this.server)throw lastError||new Error(foundLog?'等待 Antigravity 本地接口启动':'未找到 Antigravity 语言服务日志，请检查日志路径');
    this.discoveredAt = this.now();
    return this.server;
  }

  async call(method, body = {}, retry = true, options = null) {
    const server = await this.discover();
    const timelineEnabled = options?.modelTimelineEnabled === undefined ? this.modelTimelineEnabled : options.modelTimelineEnabled === true;
    try {
      return await new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const projection=['GetCascadeTrajectory','GetCascadeTrajectorySteps','GetCascadeTrajectoryGeneratorMetadata'].includes(method);
        const started=this.now();
        // A rejected stream destroys its socket. Do not leave that socket in
        // the shared agent where an immediate quota refresh could reuse it.
        const req = request({ hostname: '127.0.0.1', port: server.port, method: 'POST', path: SERVICE + method, agent: projection ? false : keepAliveAgent,
          headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': server.csrf, 'Content-Length': Buffer.byteLength(data) } }, res => {
          const projected=projection?new TrajectoryJson({ modelTimelineEnabled: timelineEnabled }):null;
          let text = '',bytes=0,failed=false;
          const fail=error=>{if(failed)return;failed=true;req.destroy(error);reject(error);};
          res.setEncoding('utf8');
          res.on('error',error=>{if(!failed)reject(error);});
          res.on('data', chunk => {
            if(failed)return;bytes+=Buffer.byteLength(chunk);
            // Projected streams have no whole-response byte ceiling. The
            // retained statistics budget, parser depth and time bound work.
            if(!(projected&&res.statusCode===200)&&bytes>32*1024*1024){fail(new Error('接口响应超过采集上限'));return;}
            try { if(projected&&res.statusCode===200)projected.write(chunk);else text+=chunk; }
            catch(error){fail(error);}
          });
          res.on('end', () => {
            if(failed)return;
            if (res.statusCode !== 200) return reject(Object.assign(new Error(`Antigravity 接口 ${method} 返回 ${res.statusCode}`),{status:res.statusCode}));
            try {
              const value=projected?projected.end():JSON.parse(text);
              try{this.onRpc?.({method,bytes,retainedBytes:projected?.retained??Buffer.byteLength(text),ms:this.now()-started});}catch{}
              resolve(value);
            }
            catch(error) { reject(projected?error:new Error('Antigravity 接口返回了无法解析的数据')); }
          });
        });
        req.on('error', reject);
        const abortTimeout=()=>{const err=new Error('Antigravity 本地接口超时');req.destroy(err);reject(err);};
        req.setTimeout(12000, abortTimeout);
        // Bound wall time as well as idle time for slow large streams.
        const deadline=setTimeout(abortTimeout,30000);deadline.unref();
        req.once('close',()=>clearTimeout(deadline));
        req.end(data);
      });
    } catch (error) {
      // A missing historical cascade, busy API or malformed response does not
      // prove the process/credential changed. Do not launch CIM scans for it.
      const endpointLost=[401,403].includes(error.status)||['ECONNREFUSED','ECONNRESET','EPIPE','ENOTCONN'].includes(error.code);
      if(!endpointLost)throw error;
      // A late failure from an old endpoint cannot invalidate a newer one.
      if(this.server===server){
        this.server=null;this.serverSource=null;this.discoveryError=error;
        this.retryAt=Math.max(this.retryAt,this.lastScanAt+3000);
      }
      if(retry){await this.discover();return this.call(method,body,false,options);}
      throw error;
    }
  }

  async readAgentStateSnapshot(conversationId, options = {}, retry = true) {
    if (typeof options === 'boolean') { retry = options; options = {}; }
    const server = await this.discover();
    try {
      return await new Promise((resolve, reject) => {
        const body = {
          conversationId,
          subscriberId: `pulse-snapshot-${this.now()}`,
          trajectoryVerbosity: 3,
          ...(options?.initialStepsPageBounds ? { initialStepsPageBounds: options.initialStepsPageBounds } : {}),
          ...(options?.initialGeneratorMetadatasPageBounds ? { initialGeneratorMetadatasPageBounds: options.initialGeneratorMetadatasPageBounds } : {}),
        };
        const payload = Buffer.from(JSON.stringify(body), 'utf8');
        const header = Buffer.alloc(5);
        header.writeUInt8(0, 0);
        header.writeUInt32BE(payload.length, 1);
        const frame = Buffer.concat([header, payload]);
        let done = false;
        const finish = (err, res) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          req.destroy();
          if (err) reject(err);
          else resolve(res);
        };
        const timer = setTimeout(() => finish(new Error('Antigravity 本地接口超时')), 60000);
        timer.unref();

        const req = request({
          hostname: '127.0.0.1',
          port: server.port,
          method: 'POST',
          path: SERVICE + 'StreamAgentStateUpdates',
          agent: false,
          headers: {
            'Content-Type': 'application/connect+json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': server.csrf,
            'Content-Length': frame.length,
          },
        }, res => {
          if (res.statusCode !== 200) {
            return finish(Object.assign(new Error(`Antigravity 接口 StreamAgentStateUpdates 返回 ${res.statusCode}`), { status: res.statusCode }));
          }
          let chunks = [], buffered = 0, expected = 5;
          res.on('data', chunk => {
            if (done || !chunk?.length) return;
            chunks.push(chunk);
            buffered += chunk.length;
            if (buffered > MAX_SNAPSHOT_BYTES) {
              return finish(new Error('接口响应超过采集上限'));
            }
            if (buffered < expected) return;
            let buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered);
            chunks = [];
            buffered = 0;
            expected = 5;
            while (buf.length >= 5) {
              const flag = buf.readUInt8(0);
              const len = buf.readUInt32BE(1);
              if (len > MAX_SNAPSHOT_BYTES) {
                return finish(new Error('接口响应超过采集上限'));
              }
              if (buf.length < 5 + len) {
                expected = 5 + len;
                chunks = [buf];
                buffered = buf.length;
                return;
              }
              const data = buf.subarray(5, 5 + len);
              buf = buf.subarray(5 + len);
              if (flag === 0) {
                try {
                  const parsed = JSON.parse(data.toString('utf8'));
                  if (parsed.update) return finish(null, parsed.update);
                } catch {
                  return finish(new Error('Antigravity 接口返回了无法解析的数据'));
                }
              } else if (flag & 2) {
                try {
                  const parsed = JSON.parse(data.toString('utf8'));
                  if (parsed.error) {
                    const msg = parsed.error.message || parsed.error.code || '远程会话访问受限';
                    return finish(Object.assign(new Error(msg), { status: 403 }));
                  }
                } catch {}
              }
            }
            if (buf.length > 0) {
              chunks = [buf];
              buffered = buf.length;
            }
          });
          res.on('error', finish);
          res.on('end', () => finish(new Error('会话暂时没有可用统计')));
        });
        req.on('error', finish);
        req.end(frame);
      });
    } catch (error) {
      const endpointLost = [401, 403].includes(error.status) || ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTCONN'].includes(error.code);
      if (!endpointLost) throw error;
      if (this.server === server) {
        this.server = null;
        this.serverSource = null;
        this.discoveryError = error;
        this.retryAt = Math.max(this.retryAt, this.lastScanAt + 3000);
      }
      if (retry) {
        await this.discover();
        return this.readAgentStateSnapshot(conversationId, options, false);
      }
      throw error;
    }
  }

  resetTrajectories(){this.reader.reset();}
  trajectory(id,options){return this.reader.read(id,options);}
}
