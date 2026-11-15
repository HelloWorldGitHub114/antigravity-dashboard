// Serialized into Antigravity's main process. Only the app's own local renderer
// can obtain sanitized Antigrative Dashboard metrics; no API credentials enter the renderer.
module.exports = function installAgPulseIpc(electron, authorities) {
  const http = require('node:http');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const local = process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local')
    : process.platform === 'darwin' ? path.join(os.homedir(),'Library','Application Support')
    : process.env.XDG_DATA_HOME || path.join(os.homedir(),'.local','share');
  const GUID = /^(?:[a-zA-Z0-9_.-]+\/)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const offline = message => ({ connection:'offline', error:message, groups:[],speed:null,serverTime:new Date().toISOString() });
  const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  const settingsFile = path.join(local,'AntigravityPulse','settings.json');
  const configFile = path.join(os.homedir(),'.gemini','config','config.json');
  const sidecarLogFile = path.join(os.homedir(),'.gemini','antigravity','sidecar_data','antigravity-pulse','panel','logs','sidecar.log');
  const diagLogDir = path.join(os.homedir(),'.gemini','antigravity','sidecar_data','antigravity-pulse','panel','logs');
  const diagLogFile = path.join(diagLogDir,'widget.log');
  let diagDirReady = false;
  let disabledCache = { value: false, at: 0, pending: null };
  let fallbackCache = { endpoint: null, at: 0, pending: null };

  const isDisabled = async () => {
    const now = Date.now();
    if (now - disabledCache.at < 1000) return disabledCache.value;
    if (disabledCache.pending) return disabledCache.pending;
    disabledCache.pending = (async () => {
      const readJson = async file => {
        try { return JSON.parse((await fs.promises.readFile(file,'utf8')).replace(/^\uFEFF/,'')); }
        catch { return null; }
      };
      const [settings, config] = await Promise.all([readJson(settingsFile), readJson(configFile)]);
      const disabled = settings?.enabled === false || config?.plugins?.['antigravity-pulse']?.enabled === false;
      disabledCache = { value: disabled, at: Date.now(), pending: null };
      return disabled;
    })().finally(() => { if (disabledCache.pending) disabledCache.pending = null; });
    return disabledCache.pending;
  };

  const readLogTail = async (file, maxBytes = 262144) => {
    const stat = await fs.promises.stat(file);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (!length) return '';
    const handle = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buf, offset, length - offset, start + offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
      }
      return buf.toString('utf8', 0, offset);
    } finally {
      await handle.close();
    }
  };

  const getFallbackEndpoint = async () => {
    const now = Date.now();
    if (fallbackCache.endpoint && now - fallbackCache.at < 1500) return fallbackCache.endpoint;
    if (fallbackCache.pending) return fallbackCache.pending;
    fallbackCache.pending = (async () => {
      let endpoint = null;
      try {
        const log = await readLogTail(sidecarLogFile);
        const port = [...log.matchAll(/\[sidecar\] listening on 127\.0\.0\.1:(\d+)/g)].at(-1)?.[1];
        if (port) endpoint = `http://127.0.0.1:${port}/`;
      } catch {}
      fallbackCache = { endpoint, at: Date.now(), pending: null };
      return endpoint;
    })().finally(() => { if (fallbackCache.pending) fallbackCache.pending = null; });
    return fallbackCache.pending;
  };

  let preferenceStore;
  electron.ipcMain.handle('ag-pulse:preferences',async(event,input={})=>{
    try {
      const origin=new URL(event.senderFrame?.url||event.sender.getURL());
      if(!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||!['http:','https:'].includes(origin.protocol))throw new Error('Invalid preference origin');
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='language'))throw new Error('Invalid preference input');
      if(!preferenceStore){
        const file=path.join(os.homedir(),'.gemini','config','plugins','antigravity-pulse','compat','preferences.mjs');
        preferenceStore=import(require('node:url').pathToFileURL(file).href).then(({PreferencesStore})=>new PreferencesStore());
      }
      const store=await preferenceStore;
      return Object.hasOwn(input,'language')?await store.set(input):await store.get();
    }catch{preferenceStore=null;return {error:'Language preference could not be saved or read'};}
  });
  electron.ipcMain.on('ag-pulse:diagnostic',(event,state={})=>{
    try {
      const origin=new URL(event.senderFrame?.url||event.sender.getURL());
      if(!['127.0.0.1','localhost','[::1]'].includes(origin.hostname))return;
      if(!['boot','mounted','mount-error'].includes(state.stage))return;
      const safe={stage:state.stage,hostFound:state.hostFound===true,editorFound:state.editorFound===true,composerFound:state.composerFound===true};
      const line=`${new Date().toISOString()} ${JSON.stringify(safe)}\n`;
      Promise.resolve().then(async()=>{
        if(!diagDirReady){await fs.promises.mkdir(diagLogDir,{recursive:true});diagDirReady=true;}
        await fs.promises.appendFile(diagLogFile,line);
      }).catch(()=>{diagDirReady=false;});
    }catch{}
  });
  electron.ipcMain.handle('ag-pulse:metrics', async (event, input={}) => {
    let origin;
    try { origin = new URL(event.senderFrame?.url || event.sender.getURL()); } catch { return offline('来源不可用'); }
    if (!['127.0.0.1','localhost','[::1]'].includes(origin.hostname) || !['http:','https:'].includes(origin.protocol)) return offline('仅允许 Antigravity 本地界面');
    if (await isDisabled()) return {...offline('Antigrative Dashboard 已停用'),enabled:false};
    if (input.conversationId && !GUID.test(input.conversationId)) return offline('会话标识无效');
    let endpoint = [...authorities].find(([key])=>key.startsWith('antigravity-pulse--panel-'))?.[1];
    let usedFallback = false;
    if (!endpoint) {
      // The native UI feature may be hidden, but the installed plugin process
      // still runs. Its own SDK log announces the loopback port.
      endpoint = await getFallbackEndpoint();
      usedFallback = Boolean(endpoint);
    }
    if (!endpoint) return offline('等待 Antigrative Dashboard 后台启动');
    const url=new URL(endpoint);
    if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.protocol!=='http:') return offline('控件接口地址无效');
    url.hostname='127.0.0.1'; url.pathname='/api/metrics';url.search='';
    if(input.conversationId)url.searchParams.set('conversationId',input.conversationId);
    if(input.force===true)url.searchParams.set('force','1');
    return await new Promise(resolve=>{
      let settled = false;
      const finish = (value, failed = false) => {
        if (settled) return;
        settled = true;
        if (failed && usedFallback) fallbackCache = { endpoint: null, at: 0, pending: null };
        resolve(value);
      };
      const req=http.get({
        hostname: '127.0.0.1',
        port: url.port || 80,
        path: url.pathname + url.search,
        agent: keepAliveAgent,
      },res=>{
        let body='';res.setEncoding('utf8');
        res.on('data',chunk=>{body+=chunk;if(body.length>1048576)req.destroy(new Error('Metrics too large'));});
        res.on('error',()=>finish(offline('控件暂时不可用'),true));
        res.on('end',()=>{try{if(res.statusCode!==200)throw new Error();const metrics=JSON.parse(body);if(!['live','stale','offline'].includes(metrics.connection))throw new Error();finish(metrics);}catch{finish(offline('控件暂时不可用'),true);}});
      });
      req.on('error',()=>finish(offline('等待 Antigrative Dashboard 重新连接'),true));
      req.setTimeout(15000,()=>req.destroy(new Error('Metrics timeout')));
    });
  });

  let usageLedgerPromise;
  const getLedger = () => {
    if (!usageLedgerPromise) {
      const candidates = [
        path.join(__dirname, '..', 'sidecars', 'panel', 'usage.mjs'),
        path.join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity-pulse', 'sidecars', 'panel', 'usage.mjs')
      ];
      const target = candidates.find(p => fs.existsSync(p)) || candidates[0];
      usageLedgerPromise = import(require('node:url').pathToFileURL(target).href)
        .then(({ UsageLedger }) => new UsageLedger())
        .catch(err => { usageLedgerPromise = null; throw err; });
    }
    return usageLedgerPromise;
  };

  const validateOrigin = event => {
    const origin = new URL(event.senderFrame?.url || event.sender.getURL());
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || !['http:', 'https:'].includes(origin.protocol)) {
      throw new Error('Invalid origin');
    }
  };

  const handleAddManualUsage = async (event, input = {}) => {
    try {
      validateOrigin(event);
      const ledger = await getLedger();
      const scope = input.scope || input.account || input.accountKey;
      const data = input.data || input;
      return await ledger.addManualUsage(scope, data);
    } catch (e) {
      return { error: e.message || 'Failed to add manual usage' };
    }
  };

  const handleDeleteManualUsage = async (event, input = {}) => {
    try {
      validateOrigin(event);
      const ledger = await getLedger();
      const scope = input.scope || input.account || input.accountKey;
      const id = input.id || (typeof input === 'string' ? input : null);
      return await ledger.deleteManualUsage(scope, id);
    } catch (e) {
      return { error: e.message || 'Failed to delete manual usage' };
    }
  };

  const handleGetAccounts = async (event, input = {}) => {
    try {
      validateOrigin(event);
      const ledger = await getLedger();
      return await ledger.getAccounts(input.active || input.scope || null);
    } catch (e) {
      return { error: e.message || 'Failed to get accounts', accounts: [] };
    }
  };

  const handleSwitchAccount = async (event, input = {}) => {
    try {
      validateOrigin(event);
      const account = typeof input === 'string' ? input : (input.account || input.id);
      return { success: true, active: account, activeAccount: account };
    } catch (e) {
      return { error: e.message || 'Failed to switch account' };
    }
  };

  electron.ipcMain.handle('ag-pulse:add-manual-usage', handleAddManualUsage);
  electron.ipcMain.handle('ag-pulse:addManualUsage', handleAddManualUsage);
  electron.ipcMain.handle('ag-pulse:delete-manual-usage', handleDeleteManualUsage);
  electron.ipcMain.handle('ag-pulse:deleteManualUsage', handleDeleteManualUsage);
  electron.ipcMain.handle('ag-pulse:get-accounts', handleGetAccounts);
  electron.ipcMain.handle('ag-pulse:getAccounts', handleGetAccounts);
  electron.ipcMain.handle('ag-pulse:switch-account', handleSwitchAccount);
  electron.ipcMain.handle('ag-pulse:switchAccount', handleSwitchAccount);
};
