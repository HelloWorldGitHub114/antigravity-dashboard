// Local usage ledger. Never stores prompts, credentials or raw request IDs.
import {readFile,writeFile,mkdir,rename,readdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {tokenCount,requestCacheMetrics} from './metrics.mjs';
import {platformPaths} from '../../compat/platform.mjs';
import {discoverLocalConversations,conversationId} from './local-conversations.mjs';
import {setImmediate as yieldToLiveRequests} from 'node:timers/promises';
const HASH=/^[a-f0-9]{64}$/,GUID=/^(?:[a-zA-Z0-9_.-]+\/)*[a-f0-9-]{36}$/i;
const hash=value=>createHash('sha256').update(value).digest('hex');
const keys=['uncached','cacheRead','cacheWrite','output'];
const KNOWN_ACCOUNTS={};
const cleanModel=value=>String(value||'Unknown').replace(/[\x00-\x1f\x7f]/g,'').slice(0,120);
const stamp=value=>typeof value==='string'&&/^20\d\d-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const sum=r=>keys.reduce((n,k)=>n+(r[k]??0),0);
export function dateTimeParts(time,zone='Asia/Shanghai'){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',hourCycle:'h23'}).formatToParts(time);
  const get=key=>parts.find(p=>p.type===key)?.value;
  const num=Number.parseInt(get('hour'),10);
  return {date:`${get('year')}-${get('month')}-${get('day')}`,hour:Number.isInteger(num)&&num>=0&&num<=23?num:0};
}
export function dateKey(time,zone='Asia/Shanghai'){
  return dateTimeParts(time,zone).date;
}
export function hourKey(time,zone='Asia/Shanghai'){
  return dateTimeParts(time,zone).hour;
}
export function usageRecords(raw,conversationId){
  const trajectory=raw?.trajectory||{},rows=new Map(),steps=trajectory.steps||[];
  for(const [index,g] of (trajectory.generatorMetadata||[]).entries()){
    const chat=g.chatModel,u=chat?.usage;if(!u)continue;
    const output=tokenCount(u.outputTokens),cache=requestCacheMetrics(u);
    const uncached=cache?.uncachedTokens??tokenCount(u.inputTokens);
    const read=tokenCount(u.cacheReadTokens)??(u.cacheReadTokens===undefined?0:null);
    const write=tokenCount(u.cacheWriteTokens)??(u.cacheWriteTokens===undefined?0:null);
    // Empty failed-attempt records have no reported consumption.
    if([uncached,read,write,output].every(n=>n===null||n===0))continue;
    const planners=(g.stepIndices||[]).map(i=>Number.isInteger(i)&&i>=0?steps[i]:null).filter(s=>/PLANNER_RESPONSE/.test(String(s?.type||'')));
    const times=planners.map(s=>stamp(s.metadata?.createdAt)).filter(t=>t!==null);
    const at=stamp(chat.chatStartMetadata?.createdAt)??(times.length?Math.min(...times):null);
    const identity=u.responseId?`response:${u.apiProvider||''}:${u.responseId}`:u.messageId?`message:${u.apiProvider||''}:${u.messageId}`:
      `fallback:${conversationId}:${JSON.stringify(g.stepIndices||[index])}:${at??'undated'}`;
    const row={id:hash(identity),at,model:cleanModel(chat.modelDisplayName||chat.responseModel||u.model||chat.model),
      uncached,cacheRead:read,cacheWrite:write,output,partial:uncached===null||read===null||write===null||output===null||!cache&&uncached>0,
      timeBasis:stamp(chat.chatStartMetadata?.createdAt)!==null?'request-start':at!==null?'planner-created':'unknown'};
    const old=rows.get(row.id);
    if(!old||sum(row)>sum(old))rows.set(row.id,row);
  }
  return [...rows.values()];
}
const validRow=r=>r&&HASH.test(r.id)&&typeof r.model==='string'&&r.model.length<=120&&
  (r.at===null||Number.isSafeInteger(r.at)&&r.at>=0)&&keys.every(k=>r[k]===null||Number.isSafeInteger(r[k])&&r[k]>=0);
export class UsageLedger{
  constructor(directory=join(platformPaths().data,'usage-v1'),{timeZone='Asia/Shanghai',source='desktop-local'}={}){this.directory=directory;this.timeZone=timeZone;this.source=source;}
  queue=Promise.resolve();revision=0;cache=null;
  async backfillState(scope,host){
    if(!HASH.test(scope)||!['app','ide'].includes(host))throw Error('Invalid backfill scope');
    await this.queue.catch(()=>{});
    try{
      const content=await readFile(join(this.directory,scope,'backfill-v1.json'),'utf8');
      if(content.length>8*1024*1024)return {};
      const value=JSON.parse(content);
      if(value.schema!==1||value.account!==scope||value.host!==host||!value.entries||typeof value.entries!=='object'||Array.isArray(value.entries))return {};
      return Object.fromEntries(Object.entries(value.entries).filter(([id,e])=>HASH.test(id)&&e&&HASH.test(e.signature)&&['complete','retry'].includes(e.state)&&Number.isSafeInteger(e.failures)&&e.failures>=0&&Number.isSafeInteger(e.retryAt)&&e.retryAt>=0));
    }catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return {};throw e;}
  }
  saveBackfillState(scope,host,entries){
    if(!HASH.test(scope)||!['app','ide'].includes(host))throw Error('Invalid backfill scope');
    const file=join(this.directory,scope,'backfill-v1.json');
    const pending=this.queue.catch(()=>{}).then(async()=>{
      await mkdir(join(this.directory,scope),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';
      try{await writeFile(temp,JSON.stringify({schema:1,account:scope,host,entries}),{mode:0o600});await rename(temp,file);}
      catch(e){await unlink(temp).catch(()=>{});throw e;}
    });this.queue=pending;return pending;
  }
  file(scope,id){if(!HASH.test(scope)||!GUID.test(id))throw Error('Invalid usage scope');return join(this.directory,scope,hash(id.toLowerCase())+'.json');}
  ownershipFile(){return join(this.directory,'ownership-v1.json');}
  accountsFile(){return join(this.directory,'accounts-v1.json');}
  async accountsMeta(){
    await this.queue.catch(()=>{});
    try{
      const content=await readFile(this.accountsFile(),'utf8');
      if(content.length>8*1024*1024)return {};
      const val=JSON.parse(content);
      if(val&&typeof val==='object'&&!Array.isArray(val)){
        const raw=val.accounts&&typeof val.accounts==='object'&&!Array.isArray(val.accounts)?val.accounts:val;
        return Object.fromEntries(Object.entries(raw).filter(([k,v])=>HASH.test(k)&&v&&typeof v==='object'));
      }
      return {};
    }catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return {};throw e;}
  }
  async saveAccountsMeta(entries){
    const file=this.accountsFile();
    const pending=this.queue.catch(()=>{}).then(async()=>{
      await mkdir(this.directory,{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';
      try{await writeFile(temp,JSON.stringify({schema:1,accounts:entries},null,2),{mode:0o600});await rename(temp,file);}
      catch(e){await unlink(temp).catch(()=>{});throw e;}
    });this.queue=pending;return pending;
  }
  async registerAccount(scope,meta={}){
    if(!scope||!HASH.test(scope))return;
    const current=await this.accountsMeta();
    const existing=current[scope]||KNOWN_ACCOUNTS[scope]||{};
    const email=meta.email||existing.email||null;
    const name=meta.name||existing.name||email||`Account (${scope.slice(0,8)})`;
    const primary=meta.primary!==undefined?meta.primary:(existing.primary!==undefined?existing.primary:false);
    current[scope]={...existing,...meta,email,name,primary};
    await this.saveAccountsMeta(current);
  }
  async ownership(){
    await this.queue.catch(()=>{});
    try{
      const content=await readFile(this.ownershipFile(),'utf8');
      if(content.length>8*1024*1024)return {};
      const value=JSON.parse(content);
      if(value&&typeof value==='object'&&!Array.isArray(value)){
        const raw=value.owners&&typeof value.owners==='object'&&!Array.isArray(value.owners)?value.owners:value;
        const valid={};
        for(const [k,v] of Object.entries(raw)){
          if(typeof k==='string'&&typeof v==='string'&&HASH.test(v))valid[k.toLowerCase()]=v;
        }
        return valid;
      }
      return {};
    }catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return {};throw e;}
  }
  saveOwnership(entries){
    const file=this.ownershipFile();
    const pending=this.queue.catch(()=>{}).then(async()=>{
      await mkdir(this.directory,{recursive:true});
      const temp=file+'.'+randomUUID()+'.tmp';
      try{await writeFile(temp,JSON.stringify(entries),{mode:0o600});await rename(temp,file);}
      catch(e){await unlink(temp).catch(()=>{});throw e;}
    });this.queue=pending;return pending;
  }
  registerOwnership(id,scope,{overwrite=false}={}){
    if(!scope||!HASH.test(scope)||!id)return Promise.resolve(false);
    const norm=String(id).toLowerCase();
    const file=this.ownershipFile();
    const pending=this.queue.catch(()=>{}).then(async()=>{
      let current={};
      try{
        const content=await readFile(file,'utf8');
        if(content.length<=8*1024*1024){
          const value=JSON.parse(content);
          if(value&&typeof value==='object'&&!Array.isArray(value)){
            const raw=value.owners&&typeof value.owners==='object'&&!Array.isArray(value.owners)?value.owners:value;
            for(const [k,v] of Object.entries(raw)){
              if(typeof k==='string'&&typeof v==='string'&&HASH.test(v))current[k.toLowerCase()]=v;
            }
          }
        }
      }catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
      if(current[norm]&&(!overwrite||current[norm]===scope))return false;
      current[norm]=scope;
      await mkdir(this.directory,{recursive:true});
      const temp=file+'.'+randomUUID()+'.tmp';
      try{await writeFile(temp,JSON.stringify(current),{mode:0o600});await rename(temp,file);}
      catch(e){await unlink(temp).catch(()=>{});throw e;}
      this.revision++;this.cache=null;
      return true;
    });
    this.queue=pending;return pending;
  }
  async scopeDirectories(){
    const scopes=[];
    try{
      const entries=await readdir(this.directory,{withFileTypes:true});
      for(const entry of entries)if(entry.isDirectory()&&HASH.test(entry.name))scopes.push(entry.name);
    }catch(e){if(e.code!=='ENOENT')throw e;}
    return scopes;
  }
  async otherScopeFiles(scope){
    const ownFiles=new Set(),otherFiles=new Map();
    const scopes=await this.scopeDirectories();
    for(const s of scopes){
      try{
        const fls=await readdir(join(this.directory,s));
        for(const f of fls){
          if(!/^[a-f0-9]{64}\.json$/.test(f))continue;
          if(s===scope)ownFiles.add(f);
          else{
            let arr=otherFiles.get(f);
            if(!arr){arr=[];otherFiles.set(f,arr);}
            arr.push(s);
          }
        }
      }catch{}
    }
    return {ownFiles,otherFiles};
  }
  async inspectOtherAccounts(scope,id){
    const fileName=hash(String(id).toLowerCase())+'.json';
    const scopes=await this.scopeDirectories();
    const owners=[],recordIds=new Set();
    let maxAt=0,inOwn=false;
    for(const s of scopes){
      try{
        const text=await readFile(join(this.directory,s,fileName),'utf8');
        if(text.length>16*1024*1024)continue;
        const doc=JSON.parse(text);
        if(doc.schema!==1||doc.account!==s||!Array.isArray(doc.records))continue;
        if(s===scope){inOwn=true;continue;}
        owners.push(s);
        for(const r of doc.records){
          if(r?.id)recordIds.add(r.id);
          if(Number.isSafeInteger(r?.at)&&r.at>maxAt)maxAt=r.at;
        }
      }catch{}
    }
    return {fileName,inOwn,owners,recordIds,maxAt};
  }
  async addManualUsage(scope,data={}){
    if(!scope||!HASH.test(scope))throw Error('Invalid usage scope');
    await this.queue.catch(()=>{});
    const id=data.id||randomUUID();
    const fileHash=hash(id);
    const timestamp=typeof data.timestamp==='number'&&Number.isSafeInteger(data.timestamp)&&data.timestamp>=0?data.timestamp
      :typeof data.timestamp==='string'&&Number.isFinite(Date.parse(data.timestamp))?Date.parse(data.timestamp)
      :Date.now();
    const model=cleanModel(data.model||'manual-model');
    const prompt=Number.isSafeInteger(data.tokens?.prompt)?data.tokens.prompt:(Number.isSafeInteger(data.prompt)?data.prompt:0);
    const candidates=Number.isSafeInteger(data.tokens?.candidates)?data.tokens.candidates:(Number.isSafeInteger(data.candidates)?data.candidates:(Number.isSafeInteger(data.output)?data.output:0));
    const total=Number.isSafeInteger(data.tokens?.total)?data.tokens.total:(Number.isSafeInteger(data.total)?data.total:(prompt+candidates));
    const tokens={prompt,candidates,total};
    const projectName=String(data.projectName||'');
    const note=String(data.note||'');
    const metadata={timestamp,source:'remote-manual',model,tokens,projectName,note};
    let uncached=prompt,output=candidates;
    if(uncached===0&&output===0&&total>0)uncached=total;
    const records=[{id:fileHash,at:timestamp,model,uncached,cacheRead:Number.isSafeInteger(data.cacheRead)?data.cacheRead:0,cacheWrite:Number.isSafeInteger(data.cacheWrite)?data.cacheWrite:0,output,partial:false,timeBasis:'request-start'}];
    const content={schema:1,account:scope,id,hash:fileHash,metadata,records};
    const dir=join(this.directory,scope);
    await mkdir(dir,{recursive:true});
    const file=join(dir,`${fileHash}.json`);
    const temp=file+'.'+randomUUID()+'.tmp';
    try{await writeFile(temp,JSON.stringify(content),{mode:0o600});await rename(temp,file);}
    catch(e){await unlink(temp).catch(()=>{});throw e;}
    this.revision++;this.cache=null;
    return {id,hash:fileHash,file:`${fileHash}.json`,...metadata};
  }
  async deleteManualUsage(scope,id){
    if(!scope||!HASH.test(scope))throw Error('Invalid usage scope');
    await this.queue.catch(()=>{});
    let deleted=false;
    const clean=typeof id==='string'?id.trim().replace(/\.json$/,''):'';
    const targets=new Set();
    if(clean){if(HASH.test(clean))targets.add(clean);targets.add(hash(clean));}
    const dir=join(this.directory,scope);
    for(const h of targets){
      try{await unlink(join(dir,`${h}.json`));deleted=true;}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    if(!deleted){
      try{
        const files=await readdir(dir);
        for(const name of files.filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){
          const file=join(dir,name);
          try{
            const text=await readFile(file,'utf8');
            const data=JSON.parse(text);
            if(data.id===id||data.metadata?.id===id||data.hash===id||data.metadata?.projectName===id){
              await unlink(file);deleted=true;break;
            }
          }catch{}
        }
      }catch(e){if(e.code!=='ENOENT')throw e;}
    }
    this.revision++;this.cache=null;
    return deleted;
  }
  async listManualUsage(scope){
    if(!scope||!HASH.test(scope))return [];
    await this.queue.catch(()=>{});
    const list=[];
    const dir=join(this.directory,scope);
    try{
      const files=await readdir(dir);
      for(const name of files.filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){
        try{
          const text=await readFile(join(dir,name),'utf8');
          const doc=JSON.parse(text);
          if(doc.metadata?.source==='remote-manual'){
            list.push({id:doc.id,hash:name.replace(/\.json$/,''),...doc.metadata});
          }
        }catch{}
      }
    }catch(e){if(e.code!=='ENOENT')throw e;}
    return list.sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));
  }
  async getAccounts(activeScope=null){
    await this.queue.catch(()=>{});
    const meta=await this.accountsMeta();
    const accounts=[];
    accounts.push({id:'all',name:'All Accounts (Aggregated)',email:'All Accounts (Aggregated)',active:activeScope==='all'});
    const scopes=new Set();
    try{
      const entries=await readdir(this.directory,{withFileTypes:true});
      for(const entry of entries){
        if(entry.isDirectory()&&HASH.test(entry.name))scopes.add(entry.name);
      }
    }catch(e){if(e.code!=='ENOENT')throw e;}
    if(activeScope&&HASH.test(activeScope))scopes.add(activeScope);
    for(const k of Object.keys(meta))if(HASH.test(k))scopes.add(k);
    for(const k of Object.keys(KNOWN_ACCOUNTS))scopes.add(k);
    for(const scope of scopes){
      const m=meta[scope]||KNOWN_ACCOUNTS[scope]||{};
      const email=m.email||null;
      const name=m.name||email||`Account (${scope.slice(0,8)})`;
      accounts.push({id:scope,name,email:email||name,primary:!!m.primary,active:activeScope?scope===activeScope:false});
    }
    accounts.accounts=accounts;
    accounts.active=activeScope||(accounts.find(a=>a.id!=='all')?.id)||'all';
    accounts.activeAccount=accounts.active;
    return accounts;
  }
  ingest(scope,id,raw){
    if(!scope)return Promise.resolve();
    return this.ingestRows(scope,id,usageRecords(raw,id));
  }
  ingestRows(scope,id,rows){
    if(!scope)return Promise.resolve();
    const file=this.file(scope,id);
    const pending=this.queue.catch(()=>{}).then(async()=>{
      let previous;try{previous=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('Usage ledger cannot be read');}
      if(previous&&(previous.schema!==1||previous.account!==scope||!Array.isArray(previous.records)||!previous.records.every(validRow)))throw Error('Invalid usage ledger');
      const merged=new Map((previous?.records||[]).map(r=>[r.id,r]));
      for(const row of rows){const old=merged.get(row.id),record={...row,at:row.at??old?.at??null,timeBasis:row.at===null&&old?.at!==null&&old?.at!==undefined?old.timeBasis:row.timeBasis};for(const key of keys)record[key]=row[key]??old?.[key]??null;merged.set(row.id,record);}
      const records=[...merged.values()].sort((a,b)=>a.id.localeCompare(b.id));
      if(previous&&JSON.stringify(previous.records)===JSON.stringify(records))return;
      await mkdir(join(this.directory,scope),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';
      try{await writeFile(temp,JSON.stringify({schema:1,account:scope,records}),{mode:0o600});await rename(temp,file);}
      catch(e){await unlink(temp).catch(()=>{});throw e;}
      this.revision++;this.cache=null;
    });this.queue=pending;return pending;
  }
  async summary(scope,now=Date.now()){
    await this.queue.catch(()=>{});
    if(!scope||(!HASH.test(scope)&&scope!=='all'))return null;
    const today=dateKey(now,this.timeZone),cacheKey=scope+':'+today;
    if(this.cache?.key===cacheKey&&this.cache.revision===this.revision)return this.cache.value;
    const meta=await this.accountsMeta();
    const getAccountName=s=>{
      const m=meta[s]||KNOWN_ACCOUNTS[s];
      return m?.email||m?.name||`Account (${s.slice(0,8)})`;
    };
    const knownKeys=Object.keys(KNOWN_ACCOUNTS);
    const primaryRank=s=>{
      const m=meta[s],k=KNOWN_ACCOUNTS[s];
      if(m?.primary===true||k?.primary===true)return 0;
      if(m?.primary===false||k?.primary===false||m?.secondary===true||k?.secondary===true)return 2;
      if(k&&knownKeys.indexOf(s)>0)return 2;
      return 1;
    };
    const pickPrimary=scopesList=>{
      if(!scopesList?.length)return null;
      return [...scopesList].sort((a,b)=>{
        const ra=primaryRank(a),rb=primaryRank(b);
        if(ra!==rb)return ra-rb;
        const ta=meta[a]?.addedAt??meta[a]?.createdAt??Number.MAX_SAFE_INTEGER;
        const tb=meta[b]?.addedAt??meta[b]?.createdAt??Number.MAX_SAFE_INTEGER;
        if(ta!==tb)return ta-tb;
        const ia=knownKeys.indexOf(a),ib=knownKeys.indexOf(b);
        if(ia!==-1&&ib!==-1&&ia!==ib)return ia-ib;
        return a.localeCompare(b);
      })[0];
    };
    const ownership=await this.ownership();
    const ownerByName=new Map();
    for(const [convId,ownerScope]of Object.entries(ownership||{})){
      if(HASH.test(ownerScope))ownerByName.set(this.file(ownerScope,convId).split(/[\\/]/).pop(),ownerScope);
    }
    const daily=new Map(),models=new Set(),userKeys=new Set(),seen=new Map(),manualEntries=[];
    let unreadable=0,unknownTokens=0,unknownRequests=0,partialRequests=0,legacyTokens=0;
    const allScopes=await this.scopeDirectories();
    const targetScopes=scope==='all'?(allScopes.length?allScopes:(this.scope?[this.scope]:[])):[scope];
    const targetSet=new Set(targetScopes);
    const scanScopes=allScopes.length>1?[...new Set([...allScopes,...targetScopes])]:targetScopes;

    // Pass 1: index every request record r.id across account scopes while parsing target files once.
    const recordScopes=new Map();
    const parsedFiles=[];
    for(const s of scanScopes){
      let files=[];try{files=await readdir(join(this.directory,s));}catch(e){if(e.code!=='ENOENT')throw e;}
      for(const name of files.filter(name=>/^[a-f0-9]{64}\.json$/.test(name))){
        try{
          const text=await readFile(join(this.directory,s,name),'utf8');if(text.length>16*1024*1024)throw Error('Ledger too large');
          const record=JSON.parse(text);if(record.schema!==1||record.account!==s||!Array.isArray(record.records)||!record.records.every(validRow))throw Error('Invalid ledger');
          for(const r of record.records){
            let list=recordScopes.get(r.id);
            if(!list){list=[];recordScopes.set(r.id,list);}
            if(!list.includes(s))list.push(s);
          }
          if(targetSet.has(s))parsedFiles.push({scope:s,name,record});
        }catch{if(targetSet.has(s))unreadable++;}
      }
    }

    // Pass 2: resolve per-record ownership without cross-account leakage or filename collision inflation.
    for(const {scope:s,name,record} of parsedFiles){
      if(record.metadata?.source==='remote-manual'){
        manualEntries.push({id:record.id,hash:name.replace(/\.json$/,''),account:s,...record.metadata});
      }
      const explicitOwner=ownerByName.get(name);
      const fileMarkedLegacy=record.metadata?.isLegacy===true||record.isLegacy===true;
      for(const r of record.records){
        const scopesForRecord=recordScopes.get(r.id)||[s];
        const isDuplicate=scopesForRecord.length>1;
        const resolvedOwner=explicitOwner&&scopesForRecord.includes(explicitOwner)?explicitOwner:null;
        if(scope!=='all'){
          if(resolvedOwner){
            if(resolvedOwner!==s)continue;
          }else if(isDuplicate&&pickPrimary(scopesForRecord)!==s){
            continue;
          }
        }
        const effectiveOwner=resolvedOwner||(isDuplicate?null:s);
        const isLegacy=(!effectiveOwner&&isDuplicate)||(!resolvedOwner&&fileMarkedLegacy);
        const userKey=scope==='all'&&isLegacy?'legacy':(effectiveOwner||s);
        const userName=userKey==='legacy'?'早期历史未区分用量':getAccountName(userKey);
        const previous=seen.get(r.id);
        if(!previous||sum(r)>sum(previous)){
          seen.set(r.id,{...r,isLegacy:isLegacy||r.isLegacy===true,userKey,userName,account:userKey==='legacy'?s:userKey});
        }else if(previous&&sum(r)===sum(previous)&&effectiveOwner===s&&previous.isLegacy){
          seen.set(r.id,{...r,isLegacy:false,userKey:s,userName:getAccountName(s),account:s});
        }
      }
    }

    for(const r of seen.values()){
      models.add(r.model);
      userKeys.add(r.userKey);
      const tokenSum=sum(r);
      if(r.isLegacy)legacyTokens+=tokenSum;
      if(r.partial)partialRequests++;
      if(r.at===null){unknownTokens+=tokenSum;unknownRequests++;continue;}
      const {date,hour}=dateTimeParts(r.at,this.timeZone);
      if(!daily.has(date))daily.set(date,{date,models:{},users:{},hours:Array(24).fill(0),legacyTokens:0});
      const day=daily.get(date);
      if(hour>=0&&hour<24)day.hours[hour]+=tokenSum;
      if(r.isLegacy)day.legacyTokens+=tokenSum;

      day.models[r.model]||={uncached:0,cacheRead:0,cacheWrite:0,output:0,total:0,requests:0};
      const bucket=day.models[r.model];for(const key of keys)bucket[key]+=r[key]??0;bucket.total+=tokenSum;bucket.requests++;

      day.users[r.userKey]||={name:r.userName,userKey:r.userKey,isLegacy:!!r.isLegacy,uncached:0,cacheRead:0,cacheWrite:0,output:0,total:0,requests:0};
      const uBucket=day.users[r.userKey];for(const key of keys)uBucket[key]+=r[key]??0;uBucket.total+=tokenSum;uBucket.requests++;
    }

    const days=[...daily.values()].sort((a,b)=>a.date.localeCompare(b.date));
    const total=day=>Object.values(day.models).reduce((n,r)=>n+r.total,0);
    const todayDay=daily.get(today);
    const todayHours=todayDay?[...todayDay.hours]:Array(24).fill(0);
    const usersSummary={};
    for(const day of days){
      for(const [uKey,uData] of Object.entries(day.users)){
        usersSummary[uKey]||={name:uData.name,userKey:uKey,isLegacy:uData.isLegacy,uncached:0,cacheRead:0,cacheWrite:0,output:0,total:0,requests:0};
        for(const key of keys)usersSummary[uKey][key]+=uData[key]??0;
        usersSummary[uKey].total+=uData.total;
        usersSummary[uKey].requests+=uData.requests;
      }
    }
    const userMeta=Object.fromEntries([...userKeys].map(k=>[k,{
      name:k==='legacy'?'早期历史未区分用量':getAccountName(k),
      email:k==='legacy'?'早期历史未区分用量':(meta[k]?.email||KNOWN_ACCOUNTS[k]?.email||getAccountName(k)),
      isLegacy:k==='legacy'
    }]));
    const value={
      accountKey:scope,
      viewScope:scope,
      timeZone:this.timeZone,
      today,
      todayHours,
      days,
      models:[...models].sort(),
      users:[...userKeys],
      userMeta,
      usersSummary,
      legacyTokens,
      todayTokens:days.filter(d=>d.date===today).reduce((n,d)=>n+total(d),0),
      weekTokens:days.filter(d=>d.date>=weekStart(today)&&d.date<=today).reduce((n,d)=>n+total(d),0),
      monthTokens:days.filter(d=>d.date.slice(0,7)===today.slice(0,7)&&d.date<=today).reduce((n,d)=>n+total(d),0),
      totalTokens:days.reduce((n,d)=>n+total(d),0)+unknownTokens,
      unknownTokens,unknownRequests,partialRequests,unreadableFiles:unreadable,
      manualEntries:manualEntries.sort((a,b)=>(b.timestamp||0)-(a.timestamp||0)),
      requests:seen.size,firstDate:days[0]?.date||null,updatedAt:new Date(now).toISOString(),source:this.source
    };
    this.cache={key:cacheKey,revision:this.revision,value};return value;
  }
}
export function weekStart(date){const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);}

export class DesktopUsage{
  constructor(store,ledger=new UsageLedger(),{host=null,discoverLocal=null,owns=()=>true,now=Date.now,sliceMs=3000,continueDelay=250}={}){
    this.store=store;this.ledger=ledger;this.fingerprints=new Map();this.host=host;this.owns=owns;this.now=now;
    this.discoverLocal=discoverLocal||(()=>host?discoverLocalConversations({host}):Promise.resolve({conversations:[],errors:0}));
    this.sliceMs=sliceMs;this.continueDelay=continueDelay;this.fullRemaining=new Set();this.passSeen=new Set();this.passFailures=new Set();this.readFailures=new Map();
  }
  syncing=false;lastSync=0;status='waiting';missingConversations=0;confirmedMissingConversations=0;retryingConversations=0;scope=null;scopeEpoch=null;viewScope='all';forceQueued=false;disposed=false;continuation=null;
  async ingest(scope,id,raw){
    if(!scope||!id)return;
    const rows=usageRecords(raw,id);
    if(!rows.length)return;
    const norm=id.toLowerCase();
    const ownership=await this.ledger.ownership();
    const owner=ownership[norm];
    const other=await this.ledger.inspectOtherAccounts(scope,norm);
    const isForeign=(owner&&owner!==scope)||(!owner&&!other.inOwn&&other.owners.length>0);
    if(isForeign){
      const status=String(raw?.trajectory?.status||raw?.status||'');
      const isRunning=status.includes('RUNNING');
      const nowMs=typeof this.now==='function'?this.now():Date.now();
      const filtered=rows.filter(r=>{
        if(other.recordIds.has(r.id))return false;
        if(isRunning)return r.at===null||other.maxAt===0||r.at>=other.maxAt;
        return Number.isFinite(r.at)&&r.at>other.maxAt&&(nowMs-r.at)<=15*60*1000;
      });
      if(!filtered.length)return;
      await this.ledger.ingestRows(scope,id,filtered);
      return;
    }
    const filtered=other.recordIds.size?rows.filter(r=>!other.recordIds.has(r.id)):rows;
    if(!filtered.length)return;
    await this.ledger.ingestRows(scope,id,filtered);
    if(!owner&&other.owners.length===0)await this.ledger.registerOwnership(norm,scope);
  }
  sync(forceFull=false){
    if(this.disposed||!this.owns())return Promise.resolve();
    if(forceFull)this.forceQueued=true;
    if(this.pending)return this.pending;
    if(!this.continuation){this.passSeen.clear();this.passFailures.clear();}
    clearTimeout(this.continuation);this.continuation=null;
    this.syncing=true;this.status='syncing';
    this.pending=(async()=>{
      let result;
      do{
        const force=this.forceQueued;this.forceQueued=false;
        result=await this.runSync(force);
      }while(this.forceQueued&&!this.disposed&&this.owns());
      if(!result?.current())return;
      this.lastSync=this.now();this.missingConversations=result.missing;
      this.confirmedMissingConversations=result.confirmed;this.retryingConversations=result.retrying;
      this.status=result.more?'syncing':result.missing?'partial':'ready';
      if(result.more){this.continuation=setTimeout(()=>void this.sync(),this.continueDelay);this.continuation.unref?.();}
    })().catch(()=>{this.status='offline';this.lastSync=this.now();}).finally(()=>{this.syncing=false;this.pending=null;});return this.pending;
  }
  async runSync(forceFull){
    const scope=this.store.identity,epoch=this.store.epoch;
    const current=()=>!this.disposed&&this.owns()&&scope===this.store.identity&&epoch===this.store.epoch;
    if(!scope)return null;
    if(this.scope!==scope||this.scopeEpoch!==epoch){this.scope=scope;this.scopeEpoch=epoch;this.fingerprints.clear();this.fullRemaining.clear();this.passSeen.clear();this.passFailures.clear();this.readFailures.clear();}
    let missing=0,listed=[];
    try{listed=await this.store.listConversations(true);}catch{missing++;}
    if(!current())return {current};
    const local=await this.discoverLocal();if(!current())return {current};missing+=local.errors||0;
    const [journal,ownership,{ownFiles,otherFiles}]=await Promise.all([
      this.host?this.ledger.backfillState(scope,this.host):Promise.resolve({}),
      this.ledger.ownership(),
      this.ledger.otherScopeFiles(scope)
    ]);
    const isForeign=id=>{
      if(ownership[id])return ownership[id]!==scope;
      const fileName=this.ledger.file(scope,id).split(/[\\/]/).pop();
      if(ownFiles.has(fileName))return false;
      return Boolean(otherFiles.get(fileName)?.length);
    };
    const candidates=new Map();
    // Current conversations get priority over unloaded archives.
    for(const c of listed)if(conversationId.test(c.id)){
      const id=c.id.toLowerCase();
      if(isForeign(id))continue;
      candidates.set(id,{id,listed:c});
    }
    if(local.conversations?.length){
      for(const c of local.conversations)if(conversationId.test(c.id)){
        const id=c.id.toLowerCase();
        if(isForeign(id))continue;
        candidates.set(id,{...candidates.get(id),...c,id});
      }
    }
    if(forceFull){this.fullRemaining=new Set(candidates.keys());this.passSeen.clear();this.passFailures.clear();}
    const started=this.now();let processed=0,more=false,dirty=false;
    for(const c of candidates.values()){
      if(!current())return {current};
      const key=hash(c.id),s=c.listed,mark=JSON.stringify([s?.stepCount,s?.modifiedAt,s?.status,s?.lastUserInputStepIndex]);
      const signature=c.signature?hash(c.signature+mark):hash(mark),old=journal[key];
      const unchanged=old?.signature===signature;
      const forced=this.fullRemaining.has(c.id);
      if(!forced&&this.passSeen.has(c.id))continue;
      if(!forced&&unchanged&&old.state==='retry'&&old.retryAt>this.now()){this.passFailures.add(c.id);continue;}
      const cached=s&&this.fingerprints.get(c.id)===mark&&!/RUNNING/.test(s.status||'');
      // A persisted checkpoint already verified both disk and host revision.
      // Restarting the collector alone must not force all settled chats to load.
      const settled=s?.modifiedAt&&/IDLE|DONE|COMPLETED|CANCELLED|CANCELED|STOPPED|FAILED|ERROR/.test(String(s.status||''));
      if(!forced&&(c.signature?unchanged&&old.state==='complete'&&(!s||cached||settled):cached))continue;
      if(processed&&this.now()-started>=this.sliceMs){more=true;break;}
      processed++;
      this.passSeen.add(c.id);
      this.fullRemaining.delete(c.id);
      try{
        // An independently discovered ID has no summary. An empty summary
        // intentionally reads steps until EOF; the shared reader still enforces
        // pagination, revision checks, memory budgets and a wall-time deadline.
        const summary=s?{stepCount:s.stepCount,lastModifiedTime:s.modifiedAt,status:s.status,lastUserInputStepIndex:s.lastUserInputStepIndex}:{};
        const raw=await this.store.client.trajectory(c.id,{summary,force:forced||!!c.signature,isCurrent:current});
        if(!current())return {current};
        if(!raw?.trajectory||!Array.isArray(raw.trajectory.steps)||!Array.isArray(raw.trajectory.generatorMetadata))throw Error('Incomplete historical statistics');
        if(!s&&!raw.trajectory.steps.length&&!raw.trajectory.generatorMetadata.length)throw Error('History not yet readable');
        const rows=usageRecords(raw,c.id);
        const other=await this.ledger.inspectOtherAccounts(scope,c.id);
        const filteredRows=other.recordIds.size?rows.filter(r=>!other.recordIds.has(r.id)):rows;
        if(filteredRows.length||!other.recordIds.size){
          await this.ledger.ingestRows(scope,c.id,filteredRows);if(!current())return {current};
          if(other.owners.length===0)await this.ledger.registerOwnership(c.id,scope);
        }
        const stable=!c.readSignature||await c.readSignature()===c.signature;
        if(!current())return {current};
        if(!stable)throw Error('History changed during import');
        this.fingerprints.set(c.id,mark);
        this.passFailures.delete(c.id);
        this.readFailures.delete(c.id);
        if(this.host&&c.signature){journal[key]={signature,state:'complete',failures:0,retryAt:0};dirty=true;}
      }catch{
        if(!current())return {current};this.passFailures.add(c.id);
        const failures=c.signature?(unchanged?(old?.failures||0)+1:1):(this.readFailures.get(c.id)||0)+1;
        this.readFailures.set(c.id,failures);
        if(this.host&&c.signature){
          journal[key]={signature,state:'retry',failures,retryAt:this.now()+Math.min(30*60000,30000*2**Math.min(failures-1,6))};dirty=true;}
      }
      // Save progress after every archive, so a restart doesn't lose the batch.
      if(dirty){await this.ledger.saveBackfillState(scope,this.host,journal);dirty=false;}
      await yieldToLiveRequests();
    }
    const confirmed=[...this.passFailures].filter(id=>(journal[hash(id)]?.failures||this.readFailures.get(id)||0)>=2).length;
    return {current,missing:missing+this.passFailures.size,confirmed,retrying:missing+this.passFailures.size-confirmed,more};
  }
  async snapshot(){
    const targetScope=this.viewScope||'all';
    if(!targetScope&&!this.store?.identity)return null;
    if(this.store?.identity&&(this.scope!==this.store.identity||this.scopeEpoch!==this.store.epoch)){this.lastSync=0;this.status='waiting';this.missingConversations=0;this.confirmedMissingConversations=0;this.retryingConversations=0;if(this.pending)this.forceQueued=true;}
    if(this.store?.identity&&this.now()-this.lastSync>60000&&!this.continuation)void this.sync();
    const scope=targetScope;
    const value=await this.ledger.summary(scope);
    const accounts=await this.ledger.getAccounts(scope);
    return value?{...value,viewScope:scope,activeAccount:this.store?.identity||scope,accounts,syncing:this.syncing||!!this.continuation,status:this.status,missingConversations:this.missingConversations,confirmedMissingConversations:this.confirmedMissingConversations,retryingConversations:this.retryingConversations,persistenceError:this.store?.usagePersistenceError===true}:null;
  }
  async addManualUsage(scope,data){return await this.ledger.addManualUsage(scope,data);}
  async deleteManualUsage(scope,id){return await this.ledger.deleteManualUsage(scope,id);}
  async getAccounts(){return await this.ledger.getAccounts(this.viewScope||'all');}
  async switchAccount(target){
    const scope=typeof target==='string'?target:(target?.account||target?.id||target?.accountKey);
    if(!scope||(scope!=='all'&&!HASH.test(scope)))throw new Error('Invalid account scope');
    this.viewScope=scope;
    return {success:true,active:scope,activeAccount:this.store?.identity||scope};
  }
  dispose(){this.disposed=true;this.forceQueued=false;clearTimeout(this.continuation);this.continuation=null;}
}
export async function addManualUsage(scope,data,ledger=new UsageLedger()){return await ledger.addManualUsage(scope,data);}
export async function deleteManualUsage(scope,id,ledger=new UsageLedger()){return await ledger.deleteManualUsage(scope,id);}
