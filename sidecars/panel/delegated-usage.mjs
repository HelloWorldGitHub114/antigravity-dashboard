// Background task accounting. Every source remains an independent conversation;
// only numeric request projections are combined, never timing or context windows.
import {setImmediate as yieldLoop} from 'node:timers/promises';
import {delegatedIds,delegatedHints,normalizeConversationId} from './delegation.mjs';
import {taskRecords,mergeTaskRecords,taskModelRecords,mergeTaskModelRecords,aggregateTaskUsage,safeTaskUsage} from './task-usage.mjs';
import {trajectoryMetrics} from './metrics.mjs';

function extractChildTimeRange(raw){
  const steps=Array.isArray(raw?.trajectory?.steps)?raw.trajectory.steps:[];
  let minMs=null,maxMs=null;
  for(const s of steps){
    const m=s?.metadata;if(!m)continue;
    for(const rawTs of [m.createdAt,m.startedAt,m.completedAt]){
      const t=typeof rawTs==='string'?Date.parse(rawTs):NaN;
      if(Number.isFinite(t)){
        if(minMs===null||t<minMs)minMs=t;
        if(maxMs===null||t>maxMs)maxMs=t;
      }
    }
  }
  const generators=Array.isArray(raw?.trajectory?.generatorMetadata)?raw.trajectory.generatorMetadata:[];
  for(const g of generators){
    const rawTs=g?.chatModel?.chatStartMetadata?.createdAt;
    const t=typeof rawTs==='string'?Date.parse(rawTs):NaN;
    if(Number.isFinite(t)){
      if(minMs===null||t<minMs)minMs=t;
      if(maxMs===null||t>maxMs)maxMs=t;
    }
  }
  return {
    startedAt:minMs!==null?new Date(minMs).toISOString():null,
    endedAt:maxMs!==null?new Date(maxMs).toISOString():null,
    durationMs:minMs!==null&&maxMs!==null?Math.max(0,Math.round(maxMs-minMs)):0,
  };
}

export class DelegatedUsage {
  constructor(client,{onSource=async()=>{},onUpdate=async()=>{},owns=()=>true,now=Date.now,
    budgetBytes=8*1024*1024,maxAgents=128,maxEntries=4,refreshMs=5000,modelTimelineEnabled=false}={}) {
    Object.assign(this,{client,onSource,onUpdate,owns,now,budgetBytes,maxAgents,maxEntries,refreshMs});
    // A Promise is truthy but is never proof of ownership. Callers must supply
    // the synchronous cached predicate, not the asynchronous marker verifier.
    this.owns=()=>owns()===true;
    this.modelTimelineEnabled=modelTimelineEnabled===true;
  }
  tasks=new Map();epoch=0;scope=null;running=null;bytes=0;disposed=false;
  setModelTimelineEnabled(enabled){
    const next=enabled===true;
    const turnedOn=next&&!this.modelTimelineEnabled;
    this.modelTimelineEnabled=next;
    if(!next){
      for(const task of this.tasks.values())task.childTimelines?.clear?.();
    }else if(turnedOn){
      for(const task of this.tasks.values())task.lastAt=-Infinity;
    }
    return this.modelTimelineEnabled;
  }
  getTimelineChildren(id){
    const norm=normalizeConversationId(id);if(!norm)return [];
    const task=this.tasks.get(norm);if(!task)return [];
    const summaries=this.client.reader?.summaries||{};
    return [...task.children].map(cid=>{
      const tl=task.childTimelines?.get(cid);
      if(tl)return tl;
      const d=task.details?.get(cid);
      if(!d)return null;
      const s=this.findSummary(summaries,cid);
      const spec=s?.trajectoryMetadata?.subagentSpec;
      const hintRole=task.hints?.get(cid)?.role||null;
      const safeRole=spec?.role||spec?.typeName||s?.trajectoryMetadata?.subagentRole||hintRole||(spec?.modelTier?`worker (${spec.modelTier})`:'subagent');
      return {
        id:cid,role:safeRole,parentId:d.parentId,depth:d.depth,model:d.model,
        planModel:null,activeModel:d.model,requests:0,totalTokens:d.totalTokens??0,outputTokens:0,
        tokens:null,tps:d.tps,status:d.status,steps:d.steps,startedAt:null,endedAt:null,durationMs:0,modelUsage:null,
      };
    }).filter(Boolean);
  }
  findSummary(summaries,id){
    if(!summaries||typeof summaries!=='object')return {};
    if(summaries[id])return summaries[id];
    for(const [key,val]of Object.entries(summaries))if(key.toLowerCase()===id)return val;
    return {};
  }
  mergeHint(task,rawId,{role=null,parentId=null,depth=null}={}){
    const cid=normalizeConversationId(rawId);
    if(!cid||cid===task.id)return;
    const prev=task.hints.get(cid)||{role:null,parentId:null,depth:null};
    const nextRole=typeof role==='string'&&role.trim()?role.trim():null;
    const nextParent=normalizeConversationId(parentId);
    const nextDepth=Number.isInteger(depth)&&depth>=0?depth:null;
    task.hints.set(cid,{
      role:nextRole||prev.role||null,
      parentId:nextParent||prev.parentId||null,
      depth:nextDepth??prev.depth??null,
    });
  }
  mergeHints(task,hintsMap){
    if(!hintsMap)return;
    for(const [cid,h]of hintsMap)this.mergeHint(task,cid,h);
  }
  seedHints(task,saved){
    if(!Array.isArray(saved?.items))return;
    for(const item of saved.items){
      const cid=normalizeConversationId(item?.id);
      if(!cid||cid===task.id)continue;
      const parentId=normalizeConversationId(item.parentId);
      const rawDepth=Number.isInteger(item.depth)&&item.depth>=0?item.depth:null;
      this.mergeHint(task,cid,{
        role:typeof item.role==='string'&&item.role.trim()?item.role.trim():null,
        parentId,
        depth:(parentId||rawDepth>1)?rawDepth:null,
      });
    }
  }
  resolveHint(task,id,summaries,raw=null){
    const h=task.hints?.get(id);
    const summary=this.findSummary(summaries,id);
    const meta=summary?.trajectoryMetadata||raw?.trajectoryMetadata||null;
    const spec=meta?.subagentSpec;
    const specRole=(typeof spec?.role==='string'?spec.role:'')
      ||(typeof spec?.typeName==='string'?spec.typeName:'')
      ||(typeof meta?.subagentRole==='string'?meta.subagentRole:'');
    const role=specRole.trim()||h?.role||summary?.summary||null;
    const parentId=normalizeConversationId(meta?.parentConversationId)||h?.parentId||null;
    const metaDepth=Number.isInteger(meta?.nestingDepth)?meta.nestingDepth
      :(Number.isInteger(meta?.subagentDepth)?meta.subagentDepth:null);
    let depth=metaDepth;
    if(depth===null&&parentId){
      if(parentId===task.id){
        depth=1;
      }else{
        let cur=parentId,hops=1,fallbackAncestorDepth=null,fallbackHops=0;
        const seen=new Set([id,cur]);
        while(cur&&hops<64){
          const ps=this.findSummary(summaries,cur)?.trajectoryMetadata;
          const pd=task.details?.get(cur),ph=task.hints?.get(cur);
          const pNext=normalizeConversationId(ps?.parentConversationId)||ph?.parentId||pd?.parentId||null;
          const pMetaDepth=Number.isInteger(ps?.nestingDepth)?ps.nestingDepth
            :(Number.isInteger(ps?.subagentDepth)?ps.subagentDepth:(ph?.depth??null));
          if(pNext===task.id){depth=hops+1;break;}
          if(fallbackAncestorDepth===null&&Number.isInteger(pMetaDepth)){
            fallbackAncestorDepth=pMetaDepth;
            fallbackHops=hops;
          }
          if(!pNext||seen.has(pNext))break;
          seen.add(pNext);
          cur=pNext;
          hops++;
        }
        if(depth===null&&fallbackAncestorDepth!==null)depth=fallbackAncestorDepth+fallbackHops;
      }
    }
    if(depth===null)depth=h?.depth??1;
    return {role,parentId,depth,specRole:specRole.trim()||null,meta};
  }
  reset(){this.epoch++;this.tasks.clear();this.bytes=0;this.scope=null;}
  dispose(){this.disposed=true;this.reset();}
  links(id,raw){return delegatedIds(id,raw,this.client.reader?.summaries||{});}
  request(scope,id,raw,{saved=null,knownIds=[],force=false,isCurrent=()=>true}={}) {
    if(this.disposed||!scope||!this.owns())return safeTaskUsage(saved);
    id=normalizeConversationId(id);if(!id)return null;
    if(scope!==this.scope){this.reset();this.scope=scope;}
    const summaries=this.client.reader?.summaries||{};
    const ids=[...new Set([...this.links(id,raw),...knownIds.map(normalizeConversationId).filter(Boolean)])].filter(child=>child!==id);
    let task=this.tasks.get(id);
    if(!ids.length&&!task)return safeTaskUsage(saved);
    if(!task){
      while(this.tasks.size>=this.maxEntries){const oldest=this.tasks.keys().next().value;this.bytes-=this.tasks.get(oldest).bytes;this.tasks.delete(oldest);}
      task={id,scope,children:new Set(),hints:new Map(),sources:new Map(),modelSources:new Map(),details:new Map(),childTimelines:new Map(),failures:new Map(),staleSources:new Set(),attempted:new Map(),order:0,bytes:0,lastAt:-Infinity,requested:false,force:false,result:safeTaskUsage(saved),truncated:false,planModel:null,activeModel:null};
      this.tasks.set(id,task);
    }
    this.tasks.delete(id);this.tasks.set(id,task);
    task.isCurrent=isCurrent;
    this.seedHints(task,saved);
    const oldSize=task.children.size;
    this.addChildren(task,ids);
    this.mergeHints(task,delegatedHints(id,raw,summaries,0));
    if(task.raw?.deref()!==raw){
      task.raw=new WeakRef(raw);
      const rows=taskRecords(raw,id);
      if(!this.put(task,id,rows))task.truncated=true;
      this.putModels(task,id,taskModelRecords(raw,id));
      const m=trajectoryMetrics(raw);
      task.planModel=m.planModel||task.planModel;
      task.activeModel=m.activeModel||task.activeModel;
      task.result=this.result(task,task.lastAt===-Infinity?'loading':task.result?.state||'loading');
    }
    if(force||!task.collecting&&(oldSize!==task.children.size||this.now()-task.lastAt>=this.refreshMs)){task.requested=true;task.force||=force;this.schedule();}
    return task.result||this.result(task,'loading');
  }
  addChildren(task,ids){
    for(const id of ids){
      if(id===task.id||task.children.has(id))continue;
      if(task.children.size>=this.maxAgents){task.truncated=true;break;}
      task.children.add(id);
    }
  }
  put(task,id,rows){
    const merged=mergeTaskRecords(task.sources.get(id)?.rows||[],rows);rows=merged.rows;
    if(merged.restored)task.staleSources.add(id);else task.staleSources.delete(id);
    const size=Buffer.byteLength(JSON.stringify(rows)),old=task.sources.get(id)?.bytes||0;
    if(this.bytes-old+size>this.budgetBytes){
      for(const [key,other] of this.tasks){if(other===task)continue;this.bytes-=other.bytes;this.tasks.delete(key);if(this.bytes-old+size<=this.budgetBytes)break;}
    }
    if(this.bytes-old+size>this.budgetBytes)return false;
    this.bytes+=size-old;task.bytes+=size-old;task.sources.set(id,{rows,bytes:size});return true;
  }
  putModels(task,id,rows){
    if(!task.modelSources)task.modelSources=new Map();
    const merged=mergeTaskModelRecords(task.modelSources.get(id)?.rows||[],rows);
    const size=Buffer.byteLength(JSON.stringify(merged)),old=task.modelSources.get(id)?.bytes||0;
    if(this.bytes-old+size>this.budgetBytes){
      for(const [key,other]of this.tasks){if(other===task)continue;this.bytes-=other.bytes;this.tasks.delete(key);if(this.bytes-old+size<=this.budgetBytes)break;}
    }
    if(this.bytes-old+size>this.budgetBytes)return false;
    this.bytes+=size-old;task.bytes+=size-old;task.modelSources.set(id,{rows:merged,bytes:size});return true;
  }
  result(task,state){
    const childRows=[...task.children].filter(id=>task.sources.has(id)).map(id=>task.sources.get(id).rows);
    const rootModelRows=task.modelSources?.get(task.id)?.rows||[];
    const childModelRowSets=[...task.children].filter(id=>task.modelSources?.has(id)).map(id=>task.modelSources.get(id).rows);
    const summaries=this.client.reader?.summaries||{};
    const items=[...task.children].map(id=>{
      const d=task.details?.get(id);
      if(d)return d;
      const {role,parentId,depth}=this.resolveHint(task,id,summaries);
      return {id,role,parentId,depth,model:null,tps:null,latestTps:null,latestRateStatus:'missing',totalTokens:null,context:null,status:task.failures.has(id)?'CASCADE_RUN_STATUS_ERROR':'CASCADE_RUN_STATUS_RUNNING',steps:0};
    });
    const result=aggregateTaskUsage(task.sources.get(task.id)?.rows||[],childRows,{
      subagents:task.children.size,loadedSubagents:childRows.length,state:task.truncated||task.staleSources.size?'partial':state,items,
      rootModelRecords:rootModelRows,childModelRecordSets:childModelRowSets,
      planModel:task.planModel||null,activeModel:task.activeModel||null,
    });
    // On restart, numeric saved task totals remain visible until the first pass
    // can account for every known child. They are never treated as fresh/complete.
    const savedTotal=task.result?.tokens?.totalTokens;
    if(Number.isSafeInteger(savedTotal)&&(result.tokens?.totalTokens===null||savedTotal>result.tokens?.totalTokens)){
      const bestModelUsage=(result.modelUsage?.totalTokens||0)>=savedTotal&&result.modelUsage?.models?.length
        ?result.modelUsage:task.result?.modelUsage||result.modelUsage;
      return {...task.result,tokens:{...task.result.tokens,complete:false},cache:{...task.result.cache,complete:false},subagents:Math.max(task.children.size,task.result.subagents),state:state==='loading'?'loading':'partial',complete:false,items,...(bestModelUsage?{modelUsage:bestModelUsage}:{})};
    }
    return result;
  }
  schedule(){
    if(this.running||this.disposed)return;
    this.running=Promise.resolve().then(async()=>{
      for(;;){
        const task=[...this.tasks.values()].find(t=>t.requested);if(!task||this.disposed||!this.owns())break;
        task.requested=false;const force=task.force;task.force=false;
        const epoch=this.epoch,current=()=>!this.disposed&&this.owns()&&epoch===this.epoch&&task.scope===this.scope&&this.tasks.get(task.id)===task&&task.isCurrent();
        task.collecting=true;try{await this.collect(task,force,current);}finally{task.collecting=false;}
      }
    }).finally(()=>{this.running=null;});
  }
  async collect(task,force,current){
    const deadline=this.now()+30000;let failed=false;
    try{
      // Resume oldest/unread sources first after a bounded pass. Starting from
      // the same first child every time can starve late children in a large task.
      const queue=[...task.children].sort((a,b)=>(task.attempted.get(a)||0)-(task.attempted.get(b)||0)),queued=new Set(queue);
      for(const id of queue){
        if(!current())return;
        if(this.now()>deadline){failed=true;break;}
        const failure=task.failures.get(id);
        if(!force&&failure?.retryAt>this.now()){failed=true;continue;}
        task.attempted.set(id,++task.order);
        try{
          const summaries=this.client.reader?.summaries||{};
          const summary=this.findSummary(summaries,id);
          const raw=await this.client.trajectory(id,{summary,force,isCurrent:current});
          if(!current())return;
          if(!raw?.trajectory||!Array.isArray(raw.trajectory.generatorMetadata)||
            !raw.trajectory.generatorMetadata.length&&!raw.trajectory.steps?.length&&!Object.keys(summary).length)throw Error('Delegated statistics unavailable');
          const {role,parentId,depth,specRole,meta}=this.resolveHint(task,id,summaries,raw);
          this.mergeHint(task,id,{role:specRole||role,parentId,depth});
          this.addChildren(task,this.links(id,raw));
          this.mergeHints(task,delegatedHints(id,raw,summaries,depth));
          for(const child of task.children)if(!queued.has(child)){queued.add(child);queue.push(child);}
          if(!this.put(task,id,taskRecords(raw,id))){task.truncated=true;failed=true;break;}
          this.putModels(task,id,taskModelRecords(raw,id));
          const m=trajectoryMetrics(raw);
          const context=m.context?{usedTokens:m.context.usedTokens,maxTokens:m.context.maxTokens,usedFraction:m.context.usedFraction}:null;
          task.details.set(id,{id,role,parentId,depth,model:m.model||null,tps:m.tps??null,latestTps:m.latestTps??null,latestRateStatus:m.latestRateStatus||'missing',totalTokens:m.tokens?.totalTokens??null,context,status:m.status||raw?.status||'CASCADE_RUN_STATUS_IDLE',steps:m.steps??raw?.numTotalSteps??0});
          if(this.modelTimelineEnabled){
            const span=extractChildTimeRange(raw);
            task.childTimelines?.set(id,{
              id,role:specRole||task.hints?.get(id)?.role||(meta?.subagentSpec?.modelTier?`worker (${meta.subagentSpec.modelTier})`:'subagent'),
              parentId,depth,model:m.activeModel||m.model||null,planModel:m.planModel||null,activeModel:m.activeModel||null,
              requests:m.requests??0,totalTokens:m.tokens?.totalTokens??0,outputTokens:m.tokens?.outputTokens??0,
              tokens:m.tokens?{inputTokens:m.tokens.inputTokens??0,outputTokens:m.tokens.outputTokens??0,thinkingTokens:m.counts?.thinkingOutput??0,cachedTokens:m.tokens.cachedTokens??0,totalTokens:m.tokens.totalTokens??0}:null,
              tps:m.tps??null,status:m.status||raw?.status||'CASCADE_RUN_STATUS_IDLE',steps:m.steps??raw?.numTotalSteps??0,
              ...span,modelUsage:m.modelUsage||null,
            });
          }
          await this.onSource(task.scope,id,raw,{isCurrent:current,guardKey:task});
          if(!current())return;
          task.failures.delete(id);
        }catch{
          if(!current())return;failed=true;
          const failures=(failure?.failures||0)+1;
          task.failures.set(id,{failures,retryAt:this.now()+Math.min(300000,5000*2**Math.min(failures-1,6))});
        }
        await yieldLoop();
      }
      if(!current())return;
      task.lastAt=this.now();task.result=this.result(task,failed?'partial':'ready');
      await this.onUpdate(task.scope,task.id,task.result,[...task.children]);
    }catch{if(current()){task.lastAt=this.now();task.result=this.result(task,'partial');}}
  }
  async idle(){while(this.running)await this.running;}
}
