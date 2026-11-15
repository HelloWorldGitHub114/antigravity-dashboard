// Statistics-only acquisition. Host schemas accept offsets, not page sizes.
// Cached immutable prefixes are local numeric/structural projections only.
import { formatModelName } from './context.mjs';
const settled=s=>/IDLE|DONE|COMPLETED|CANCELLED|CANCELED|STOPPED|FAILED|ERROR/.test(String(s||''));
const unavailable=()=>new Error('后台已重新连接，请等待刷新');
const TOOL_STEP=/SEARCH_WEB|BROWSE|RUN_COMMAND|COMMAND|READ|WRITE|EDIT|CODE_ACTION|TOOL|MCP|LIST|GREP|VIEW|FIND|TERMINAL/i;
const safeCount=v=>(typeof v==='number'||typeof v==='string'&&/^\d+$/.test(v))&&Number.isSafeInteger(Number(v))&&Number(v)>=0?Number(v):null;

function isoNanoParts(value){
 if(typeof value!=='string')return null;
 const m=value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/);
 if(!m){
  const ms=Date.parse(value);
  return Number.isFinite(ms)?{sec:Math.floor(ms/1000),ns:Math.round((ms%1000)*1e6)}:null;
 }
 const baseMs=Date.parse(m[1]+m[3]);
 if(!Number.isFinite(baseMs))return null;
 return {sec:Math.floor(baseMs/1000),ns:m[2]?Number(m[2].padEnd(9,'0')):0};
}

function isoDiffSeconds(startIso,endIso){
 const a=isoNanoParts(startIso),b=isoNanoParts(endIso);
 if(!a||!b)return null;
 const diff=(b.sec-a.sec)+(b.ns-a.ns)/1e9;
 return Number.isFinite(diff)&&diff>=0?diff:null;
}

function followedByToolStep(rawSteps,fromIndex){
 for(let j=fromIndex+1;j<rawSteps.length;j++){
  const next=rawSteps[j],type=String(next?.type||'');
  if(/USER_INPUT|PLANNER_RESPONSE/.test(type))return false;
  if(TOOL_STEP.test(type)||next?.metadata?.toolCall||safeCount(next?.metadata?.toolCallOutputTokens)>0)return true;
 }
 return false;
}

function inferApiProvider(usage,meta,rawModelName){
 if(usage?.apiProvider)return usage.apiProvider;
 const hint=[meta?.generatorModel,meta?.requestedModel?.model,meta?.modelInfo?.modelName,meta?.modelInfo?.displayName,rawModelName].filter(Boolean).join(' ');
 if(/GEMINI|GOOGLE/i.test(hint))return 'API_PROVIDER_GOOGLE_GEMINI';
 if(/ANTHROPIC|CLAUDE/i.test(hint))return 'API_PROVIDER_ANTHROPIC';
 if(/OPENAI|GPT/i.test(hint))return 'API_PROVIDER_OPENAI';
 return undefined;
}

function mergeGeneratorMetadata(older=[],newer=[]){
 const genMap=new Map();
 const keyOf=(g,tag)=>{
  if(Array.isArray(g?.stepIndices)&&g.stepIndices.length)return `s:${g.stepIndices.join(',')}`;
  const rid=g?.chatModel?.usage?.responseId;
  return rid?`r:${rid}`:Symbol(tag);
 };
 for(const g of older)genMap.set(keyOf(g,'o'),g);
 for(const g of newer)genMap.set(keyOf(g,'n'),g);
 const merged=[...genMap.values()];
 if(merged.length>1&&merged.every(g=>Number.isInteger(g?.stepIndices?.[0]))){
  merged.sort((a,b)=>a.stepIndices[0]-b.stepIndices[0]);
 }
 return merged;
}

function extractPlanModelFromSteps(rawSteps){
 let planModel=null;
 for(const s of Array.isArray(rawSteps)?rawSteps:[]){
  const pm=s?.userInput?.userConfig?.plannerConfig?.planModel;
  if(typeof pm==='string'&&pm.trim())planModel=pm.trim().slice(0,256);
 }
 return planModel;
}

export function normalizeRemoteSnapshot(update,fallbackId,stepOffset=0,{modelTimelineEnabled=false}={}){
 const main=update?.mainTrajectoryUpdate||{};
 const rawSteps=Array.isArray(main.stepsUpdate?.steps)?main.stepsUpdate.steps:[];
 const rawGenerators=Array.isArray(main.generatorMetadatasUpdate?.generatorMetadatas)?main.generatorMetadatasUpdate.generatorMetadatas:[];
 const hasNativeChatModel=rawGenerators.some(g=>g?.chatModel?.usage||g?.chatModel?.chatStartMetadata);
 const withTimeline=modelTimelineEnabled===true;
 const planModel=(typeof update?.planModel==='string'&&update.planModel.trim()?update.planModel.trim().slice(0,256):null)||extractPlanModelFromSteps(rawSteps);

 const steps=rawSteps.map((s,idx)=>{
  const m=s?.metadata||{},type=String(s?.type||'');
  const projectedMeta={
   ...(m.createdAt?{createdAt:m.createdAt}:{}),
   ...(m.startedAt?{startedAt:m.startedAt}:{}),
   ...(m.completedAt?{completedAt:m.completedAt}:{}),
   ...(withTimeline&&m.generatorModel?{generatorModel:String(m.generatorModel).slice(0,256)}:{}),
   ...(withTimeline&&m.toolCall?.name?{toolCall:{name:String(m.toolCall.name).slice(0,64)}}:m.toolCall?{toolCall:true}:{}),
  };
  const out={
   ...(s?.i!==undefined?{i:s.i}:{}),
   ...(s?.type!==undefined?{type:s.type}:{}),
   ...(withTimeline&&s?.status!==undefined?{status:String(s.status).slice(0,64)}:{}),
   metadata:projectedMeta,
   ...(s?.invokeSubagent?{invokeSubagent:s.invokeSubagent}:{}),
  };
  if(withTimeline){
   const stepPlanModel=s?.userInput?.userConfig?.plannerConfig?.planModel;
   if(typeof stepPlanModel==='string'&&stepPlanModel.trim()){
    out.userInput={userConfig:{plannerConfig:{planModel:stepPlanModel.trim().slice(0,256)}}};
   }
   const eventType=s?.systemMessage?.eventType;
   if(typeof eventType==='string'&&eventType.trim())out.systemMessage={eventType:eventType.trim().slice(0,64)};
   const tbMode=s?.taskBoundary?.mode||s?.taskBoundary?.Mode;
   if(typeof tbMode==='string'&&tbMode.trim())out.taskBoundary=s.taskBoundary?.mode?{mode:tbMode.trim().slice(0,64)}:{Mode:tbMode.trim().slice(0,64)};
   if(s?.exitPlanMode)out.exitPlanMode=true;
   if(s?.enterPlanMode)out.enterPlanMode=true;
  }
  if(/PLANNER_RESPONSE/.test(type)){
   const hasResp=Boolean(String(s?.plannerResponse?.response||'').trim());
   const rawCalls=Array.isArray(s?.plannerResponse?.toolCalls)?s.plannerResponse.toolCalls:[];
   const hasToolCalls=Boolean(rawCalls.length>0||followedByToolStep(rawSteps,idx));
   let toolCalls;
   if(withTimeline&&rawCalls.length){
    toolCalls=rawCalls.map(tc=>({
     ...(typeof tc?.name==='string'&&tc.name.trim()?{name:tc.name.trim().slice(0,64)}:{}),
     ...(typeof tc?.status==='string'&&tc.status.trim()?{status:tc.status.trim().slice(0,64)}:{}),
    }));
   }else if(hasToolCalls){
    toolCalls=[{}];
   }
   out.plannerResponse={
    response:hasResp?'1':'',
    ...(toolCalls?{toolCalls}:{}),
   };
  }
  return out;
 });

 if(hasNativeChatModel){
  return {
   cascadeId:update?.conversationId||fallbackId,
   ...(planModel?{planModel}:{}),
   steps,
   generatorMetadata:rawGenerators,
   contextWindowUsage:update?.contextWindowUsage,
  };
 }

 const genByStep=new Map();
 for(const g of rawGenerators){
  for(const idx of g?.stepIndices||[]){
   if(Number.isInteger(idx)&&idx>=0&&!genByStep.has(idx))genByStep.set(idx,g);
  }
 }

 const usageSteps=[];
 for(let idx=0;idx<rawSteps.length;idx++){
  if(rawSteps[idx]?.metadata?.modelUsage){
   const globalIdx=rawSteps[idx]?.metadata?.sourceTrajectoryStepInfo?.stepIndex??(stepOffset+idx);
   usageSteps.push({localIdx:idx,globalIdx});
  }
 }
 const lastUsage=usageSteps.at(-1);
 let synthesizedContext=null;
 if(lastUsage){
  const lm=rawSteps[lastUsage.localIdx].metadata||{},lu=lm.modelUsage||{};
  const inTok=safeCount(lu.inputTokens);
  if(inTok!==null){
   const used=inTok+(safeCount(lu.cacheReadTokens)??0)+(safeCount(lu.cacheWriteTokens)??0)+(safeCount(lu.outputTokens)??0);
   const rawMax=safeCount(lm.modelInfo?.maxTokens??lm.modelInfo?.contextWindow??lm.modelInfo?.maxInputTokens);
   if(Number.isSafeInteger(used)){
    synthesizedContext={estimatedTokensUsed:used,...(rawMax>0?{maxContextTokens:rawMax}:{})};
   }
  }
 }
 const effectiveContext=safeCount(update?.contextWindowUsage?.estimatedTokensUsed)!==null?update.contextWindowUsage:synthesizedContext;

 const generatorMetadata=usageSteps.map(({localIdx,globalIdx})=>{
  const s=rawSteps[localIdx],m=s.metadata||{},u=m.modelUsage||{},g=genByStep.get(globalIdx)||genByStep.get(localIdx);
  const rawModelName=m.modelInfo?.displayName||m.modelInfo?.modelName||g?.plannerConfig?.modelName||u.model||m.requestedModel?.model||m.generatorModel||'';
  const apiProvider=inferApiProvider(u,m,rawModelName);
  const responseId=u.responseId||m.modelApiContentId||undefined;
  const ttft=isoDiffSeconds(m.createdAt,m.viewableAt);
  const stream=isoDiffSeconds(m.viewableAt,m.finishedGeneratingAt);
  const displayName=formatModelName(rawModelName)||m.modelInfo?.displayName||rawModelName||undefined;
  const isLast=localIdx===lastUsage?.localIdx;
  return {
   stepIndices:[globalIdx],
   chatModel:{
    usage:{
     ...u,
     ...(apiProvider?{apiProvider}:{}),
     ...(responseId?{responseId}:{}),
     ...(u.model||rawModelName?{model:u.model||rawModelName}:{}),
    },
    ...(displayName?{modelDisplayName:displayName}:{}),
    ...(rawModelName?{responseModel:rawModelName}:{}),
    ...(ttft!==null?{timeToFirstToken:ttft}:{}),
    ...(stream!==null&&stream>0?{streamingDuration:stream}:{}),
    chatStartMetadata:{
     ...(m.createdAt?{createdAt:m.createdAt}:{}),
     ...(isLast&&effectiveContext?{contextWindowMetadata:effectiveContext}:{}),
    },
   },
  };
 });

 return {
  cascadeId:update?.conversationId||fallbackId,
  ...(planModel?{planModel}:{}),
  steps,
  generatorMetadata,
  contextWindowUsage:effectiveContext||undefined,
 };
}
export class TrajectoryReader {
 // Serialized statistics budget, not transcript/response size. Local resource
 // experiments cover 1K/8K/32K records; 8 MiB bounds retained objects well below
 // the 32K-record case (~100 MiB extra heap). See docs/LONG_CONVERSATIONS.md.
 constructor(client,{budgetBytes=8*1024*1024,idleRecheckMs=10000,modelTimelineEnabled=client?.modelTimelineEnabled===true}={}){
  this.client=client;this.budgetBytes=budgetBytes;this.idleRecheckMs=idleRecheckMs;this.modelTimelineEnabled=modelTimelineEnabled===true;
 }
 setModelTimelineEnabled(enabled){this.modelTimelineEnabled=enabled===true;return this.modelTimelineEnabled;}
 isTimelineEnabled(options){return (options?.modelTimelineEnabled??this.modelTimelineEnabled??this.client?.modelTimelineEnabled)===true;}
 callStepRpc(method,body,wantTimeline){
  const clientTimeline=this.client?.modelTimelineEnabled===true;
  if(wantTimeline!==clientTimeline)return this.client.call(method,body,true,{modelTimelineEnabled:wantTimeline});
  return this.client.call(method,body);
 }
 entries=new Map();epoch=0;endpoint=null;summaries=null;summaryAt=-Infinity;summaryPending=null;cachedBytes=0;
 reset(){this.epoch++;this.entries.clear();this.summaries=null;this.summaryAt=-Infinity;this.summaryPending=null;this.cachedBytes=0;}
 seedSummaries(summaries,at=this.client.now(),endpoint=this.client.server){
  if(!summaries||typeof summaries!=='object')return;
  if(endpoint){
   if(this.endpoint&&['pid','port','csrf'].some(k=>this.endpoint[k]!==endpoint[k]))return;
   if(!this.endpoint)this.endpoint=endpoint;
  }
  this.summaries=summaries;
  this.summaryAt=at;
 }
 trim(keep){for(const [key,e]of this.entries){if(this.cachedBytes<=this.budgetBytes)break;if(key===keep||e.pending)continue;this.cachedBytes-=e.bytes;this.entries.delete(key);}}
 async summary(id,provided,force){
  if(provided)return provided;
  if(force||!this.summaries||this.client.now()-this.summaryAt>=1800){
   if(!this.summaryPending){const epoch=this.epoch;
    const pending=this.client.call('GetAllCascadeTrajectories').then(r=>{
     if(epoch!==this.epoch)throw unavailable();this.summaries=r.trajectorySummaries||{};this.summaryAt=this.client.now();
    }).finally(()=>{if(this.summaryPending===pending)this.summaryPending=null;});this.summaryPending=pending;
   }
   await this.summaryPending;
  }
  const s=this.summaries[id];if(!s)throw new Error('会话暂时没有可用统计');return s;
 }
 async read(id,{summary:provided,force=false,isCurrent=()=>true,modelTimelineEnabled}={}){
  if(!isCurrent())throw unavailable();
  const wantTimeline=this.isTimelineEnabled({modelTimelineEnabled});
  const endpoint=await this.client.discover();
  if(!this.endpoint){this.endpoint=endpoint;}
  else if(['pid','port','csrf'].some(k=>this.endpoint[k]!==endpoint[k])){this.reset();this.endpoint=endpoint;}
  let entry=this.entries.get(id);if(entry?.pending)return entry.pending;
  entry||={data:null,bytes:0,withTimeline:false};this.entries.set(id,entry);
  const epoch=this.epoch,current=()=>epoch===this.epoch&&this.entries.get(id)===entry&&isCurrent();
  const assertCurrent=()=>{if(!current())throw unavailable();};
  entry.pending=(async()=>{
   let summary=null,isRemote=false;
   if(id.includes('/')&&typeof this.client.readAgentStateSnapshot==='function'){
    isRemote=true;
   }else{
    try{
     summary=await this.summary(id,provided,force);assertCurrent();
    }catch(err){
     if(err.message==='会话暂时没有可用统计'&&typeof this.client.readAgentStateSnapshot==='function'){
      isRemote=true;
     }else{
      throw err;
     }
    }
   }
   if(isRemote || (summary?.trajectoryMetadata?.remoteControlDetails && typeof this.client.readAgentStateSnapshot==='function')){
    try{
     return await this.readRemote(id,entry,force,assertCurrent,wantTimeline);
    }catch(remoteErr){
     if(isRemote)throw remoteErr;
    }
   }
   const count=summary.stepCount===undefined?null:Number(summary.stepCount);if(count!==null&&(!Number.isSafeInteger(count)||count<0))throw new Error('会话统计分页数量无效');
   const mark=JSON.stringify([count,summary.lastModifiedTime,summary.status,summary.lastUserInputStepIndex]);
   const old=entry.data;
   const timelineModeMismatch=Boolean(old)&&entry.withTimeline!==wantTimeline;
   const same=old&&!timelineModeMismatch&&entry.mark===mark;
   if(!force&&same&&settled(summary.status)&&summary.lastModifiedTime&&this.client.now()-entry.verifiedAt<this.idleRecheckMs){this.entries.delete(id);this.entries.set(id,entry);return old;}
   // A changed settled history with no append may have been edited/compacted.
   const incremental=old&&!force&&!timelineModeMismatch&&count!==null&&count>=old.trajectory.steps.length&&(count>old.trajectory.steps.length||!settled(entry.summary?.status)||same);
   let stepOffset=0,metadataOffset=0;
   if(incremental){
    const lastInput=old.trajectory.steps.findLastIndex(s=>/USER_INPUT/.test(String(s?.type||'')));
    // The submitted input is immutable within a running turn. Start after it
    // so a large corpus is not downloaded on each generation-state refresh.
    stepOffset=lastInput<0?0:lastInput+1;
    const gs=old.trajectory.generatorMetadata;
    if(gs.length&&gs.every(g=>Array.isArray(g.stepIndices)&&g.stepIndices.length&&g.stepIndices.every(i=>Number.isInteger(i)&&i>=0))){
     metadataOffset=Math.max(0,gs.length-1);
     const associated=(gs.at(-1)?.stepIndices||[]).filter(i=>Number.isInteger(i)&&i>=0&&i<old.trajectory.steps.length&&!/USER_INPUT/.test(String(old.trajectory.steps[i]?.type||'')));
     stepOffset=associated.length?Math.min(...associated):old.trajectory.steps.length;
    }
    // Background tools can finish after newer model requests have started.
    // Refresh from the earliest unresolved timed tool as well as the last model.
    const pendingTool=old.trajectory.steps.findIndex(s=>s?.metadata&&(s.metadata.startedAt||s.metadata.createdAt)&&!s.metadata.completedAt&&
     (/SEARCH_WEB|BROWSE|RUN_COMMAND|COMMAND|READ|WRITE|EDIT|CODE_ACTION|TOOL|MCP|LIST|GREP|VIEW|FIND|TERMINAL/i.test(String(s.type||''))||s.metadata.toolCall));
    if(pendingTool>=0)stepOffset=Math.min(stepOffset,pendingTool);
    if(gs.some(g=>!Array.isArray(g.stepIndices)||!g.stepIndices.length))metadataOffset=0;
   }
   const steps=incremental?old.trajectory.steps.slice(0,stepOffset):[];
   const generators=incremental?old.trajectory.generatorMetadata.slice(0,metadataOffset):[];
   let planModel=incremental?(old.trajectory.planModel||null):null;
   let bytes=(steps.length||generators.length)?Buffer.byteLength(JSON.stringify({steps,generatorMetadata:generators})):34;const deadline=this.client.now()+30000;
   const append=(target,items)=>{
    for(const item of items){bytes+=Buffer.byteLength(JSON.stringify(item))+1;if(bytes>this.budgetBytes)throw new Error('会话统计数据超过内存预算');target.push(item);}
   };
   const check=()=>{assertCurrent();if(this.client.now()>deadline)throw new Error('会话统计分页读取超时');};
   try{
    while(count===null||steps.length<count){
     check();const page=await this.callStepRpc('GetCascadeTrajectorySteps',{cascadeId:id,stepOffset:steps.length,trajectoryVerbosity:3},wantTimeline);check();
     const items=page.steps||[];if(!Array.isArray(items))throw new Error('会话统计分页格式无效');
     if(!items.length){if(count===null)break;throw new Error('完整会话统计分页暂不可用');}
     const pagePlan=(typeof page.planModel==='string'&&page.planModel.trim()?page.planModel.trim().slice(0,256):null)||extractPlanModelFromSteps(items);
     if(pagePlan)planModel=pagePlan;
     append(steps,items);
    }
    // Full step semantics retain the tool-only timing markers. Their text and
    // large tool payloads are discarded by the streaming projector.
    for(;;){
     check();const page=await this.client.call('GetCascadeTrajectoryGeneratorMetadata',{cascadeId:id,generatorMetadataOffset:generators.length,includeMessages:false});check();
     const items=page.generatorMetadata||page.generatorMetadatas||[];if(!Array.isArray(items))throw new Error('会话统计分页格式无效');
     if(!items.length)break;append(generators,items);
    }
   }catch(err){
    if(err.message==='后台已重新连接，请等待刷新')throw err;
    if(typeof this.client.readAgentStateSnapshot==='function'&&([404,501].includes(err.status)||/not found|unimplemented|cloudproxy|完整会话统计分页暂不可用/i.test(err.message))){
     try{
      return await this.readRemote(id,entry,force,assertCurrent,wantTimeline);
     }catch{}
    }
    throw err;
   }
   // A growing host may return newer metadata than the step-count snapshot.
   // Do not cache or persist a mixed/incomplete revision when settled.
   if(generators.some(g=>(g.stepIndices||[]).some(i=>Number.isInteger(i)&&i>=steps.length))){
    if(settled(summary.status))throw new Error('会话仍在更新，请等待下一次刷新');
   }
   const value={trajectory:{cascadeId:id,...(planModel?{planModel}:{}),steps,generatorMetadata:generators},numTotalSteps:steps.length,numTotalGeneratorMetadata:generators.length,status:summary.status};
   assertCurrent();this.cachedBytes-=entry.bytes;entry.bytes=bytes;this.cachedBytes+=bytes;
   entry.data=value;entry.summary=summary;entry.mark=mark;entry.withTimeline=wantTimeline;entry.rev=(entry.rev||0)+1;entry.verifiedAt=this.client.now();this.entries.delete(id);this.entries.set(id,entry);
   this.trim(id);
   return value;
  })().finally(()=>{entry.pending=null;if(!entry.data&&current())this.entries.delete(id);if(current())this.trim(id);});
  return entry.pending;
 }
 async readRemote(id,entry,force,assertCurrent,wantTimeline=this.isTimelineEnabled()){
  const old=entry.data;
  const timelineMismatch=Boolean(old)&&entry.withTimeline!==wantTimeline;
  let remoteMeta=null,remoteSteps=null;
  if(!force&&!timelineMismatch&&old?.isRemote){
   if(settled(old.status)&&this.client.now()-entry.verifiedAt<this.idleRecheckMs){
    this.entries.delete(id);this.entries.set(id,entry);return old;
   }
   if(id.includes('/')){
    try{
     remoteMeta=await this.client.call('GetConversationMetadata',{conversationId:id});
     assertCurrent();
     remoteSteps=remoteMeta?.numSteps===undefined?null:Number(remoteMeta.numSteps);
     const unchanged=Number.isSafeInteger(remoteSteps)&&remoteSteps===old.numTotalSteps;
     const isSettledOrUnchanged=settled(old.status)||unchanged;
     if(isSettledOrUnchanged&&unchanged){
      entry.verifiedAt=this.client.now();
      this.entries.delete(id);this.entries.set(id,entry);return old;
     }
    }catch(err){
     if(err.message==='后台已重新连接，请等待刷新')throw err;
    }
   }
  }
  if(id.includes('/')&&remoteSteps===null){
   try{
    remoteMeta=await this.client.call('GetConversationMetadata',{conversationId:id});
    assertCurrent();
    remoteSteps=remoteMeta?.numSteps===undefined?null:Number(remoteMeta.numSteps);
   }catch(err){
    if(err.message==='后台已重新连接，请等待刷新')throw err;
   }
  }
  const canIncremental=!force&&!timelineMismatch&&old?.isRemote&&Number.isSafeInteger(remoteSteps)&&remoteSteps>old.numTotalSteps&&
   Array.isArray(old.trajectory?.steps);
  const isColdTail=!canIncremental&&Number.isSafeInteger(remoteSteps)&&remoteSteps>50;
  let update,isIncrementalSlice=false,sliceStart=0;
  try{
   if(canIncremental){
    sliceStart=old.numTotalSteps;
    update=await this.client.readAgentStateSnapshot(id,{initialStepsPageBounds:{startIndex:sliceStart,endIndexExclusive:remoteSteps}});
    isIncrementalSlice=true;
   }else if(isColdTail){
    sliceStart=remoteSteps-50;
    update=await this.client.readAgentStateSnapshot(id,{initialStepsPageBounds:{startIndex:sliceStart,endIndexExclusive:remoteSteps}});
    isIncrementalSlice=true;
   }else{
    update=await this.client.readAgentStateSnapshot(id);
   }
  }catch(err){
   if(/cloud conversations are not enabled/i.test(err.message)){
    throw new Error('当前登录账号未开启远程 Agent (Cloud Conversations) 权限');
   }
   if(id.includes('/')&&/超时|timeout/i.test(err.message)){
    throw new Error('远程环境休眠或同步较慢，请稍候刷新');
   }
   if([404,403].includes(err.status)||/not found|无权访问|权限/i.test(err.message))throw new Error('会话暂时没有可用统计');
   throw err;
  }
  assertCurrent();
  const stepOffset=isIncrementalSlice?sliceStart:0;
  const normalized=normalizeRemoteSnapshot(update,id,stepOffset,{modelTimelineEnabled:wantTimeline});
  let steps,generatorMetadata,contextWindowUsage;
  if(isIncrementalSlice){
   if(canIncremental&&old){
    if(normalized.steps.length>=remoteSteps){
     steps=normalized.steps;
     generatorMetadata=normalized.generatorMetadata;
     entry.pendingBackfillOffset=0;
     entry.backfillGen=(entry.backfillGen||0)+1;
    }else{
     steps=[...old.trajectory.steps.slice(0,old.numTotalSteps),...normalized.steps];
     generatorMetadata=mergeGeneratorMetadata(old.trajectory.generatorMetadata||[],normalized.generatorMetadata);
    }
    contextWindowUsage=normalized.contextWindowUsage||old.contextWindowUsage;
   }else{
    if(normalized.steps.length>=remoteSteps){
     steps=normalized.steps;
     entry.pendingBackfillOffset=0;
     entry.backfillGen=(entry.backfillGen||0)+1;
    }else{
     steps=[];
     steps.length=remoteSteps;
     for(let i=0;i<normalized.steps.length;i++)steps[sliceStart+i]=normalized.steps[i];
     entry.pendingBackfillOffset=sliceStart;
     entry.backfillGen=(entry.backfillGen||0)+1;
    }
    generatorMetadata=normalized.generatorMetadata;
    contextWindowUsage=normalized.contextWindowUsage;
   }
  }else{
   steps=normalized.steps;
   generatorMetadata=normalized.generatorMetadata;
   contextWindowUsage=normalized.contextWindowUsage;
   entry.pendingBackfillOffset=0;
   entry.backfillGen=(entry.backfillGen||0)+1;
  }
  const cascadeId=normalized.cascadeId||old?.trajectory?.cascadeId||id;
  const planModel=normalized.planModel||(canIncremental?old?.trajectory?.planModel:null)||null;
  const bytes=Buffer.byteLength(JSON.stringify({steps,generatorMetadata}));
  if(bytes>this.budgetBytes)throw new Error('会话统计数据超过内存预算');
  const status=update.status||'CASCADE_RUN_STATUS_IDLE';
  const totalSteps=Number.isSafeInteger(remoteSteps)?remoteSteps:steps.length;
  const value={
   trajectory:{cascadeId,...(planModel?{planModel}:{}),steps,generatorMetadata},
   contextWindowUsage,
   status,
   numTotalSteps:totalSteps,
   numTotalGeneratorMetadata:generatorMetadata.length,
   isRemote:true,
  };
  const mark=JSON.stringify([totalSteps,status,contextWindowUsage?.estimatedTokensUsed]);
  assertCurrent();this.cachedBytes-=entry.bytes;entry.bytes=bytes;this.cachedBytes+=bytes;
  entry.data=value;entry.summary={stepCount:totalSteps,status:value.status,lastModifiedTime:new Date().toISOString()};
  entry.mark=mark;entry.withTimeline=wantTimeline;entry.rev=(entry.rev||0)+1;entry.verifiedAt=this.client.now();this.entries.delete(id);this.entries.set(id,entry);
  this.trim(id);
  if(entry.pendingBackfillOffset&&entry.pendingBackfillOffset>0&&!entry.backfilling){
   this.scheduleRemoteBackfill(id,entry);
  }
  return value;
 }
 scheduleRemoteBackfill(id,entry){
  if(entry.backfilling||!entry.pendingBackfillOffset||entry.pendingBackfillOffset<=0)return;
  entry.backfilling=true;
  const epoch=this.epoch,gen=entry.backfillGen||0,wantTimeline=entry.withTimeline===true;
  (async()=>{
   while(entry.pendingBackfillOffset>0&&this.epoch===epoch&&this.entries.get(id)===entry&&(entry.backfillGen||0)===gen){
    const end=entry.pendingBackfillOffset;
    const start=Math.max(0,end-50);
    try{
     const chunk=await this.client.readAgentStateSnapshot(id,{
      initialStepsPageBounds:{startIndex:start,endIndexExclusive:end}
     });
     if(this.epoch!==epoch||this.entries.get(id)!==entry||(entry.backfillGen||0)!==gen)break;
     const normalized=normalizeRemoteSnapshot(chunk,id,start,{modelTimelineEnabled:wantTimeline});
     const currentSteps=entry.data?.trajectory?.steps;
     if(Array.isArray(currentSteps)){
      for(let i=0;i<normalized.steps.length;i++)currentSteps[start+i]=normalized.steps[i];
      if(normalized.planModel&&entry.data?.trajectory&&!entry.data.trajectory.planModel)entry.data.trajectory.planModel=normalized.planModel;
      entry.data.trajectory.generatorMetadata=mergeGeneratorMetadata(
       normalized.generatorMetadata,
       entry.data.trajectory.generatorMetadata||[]
      );
      entry.data.numTotalGeneratorMetadata=entry.data.trajectory.generatorMetadata.length;
      const delta=Math.max(0,Buffer.byteLength(JSON.stringify(normalized.steps))-normalized.steps.length*5)
       +Buffer.byteLength(JSON.stringify(normalized.generatorMetadata));
      entry.bytes=(entry.bytes||0)+delta;
      this.cachedBytes+=delta;
      entry.rev=(entry.rev||0)+1;
      this.trim(id);
     }
     entry.pendingBackfillOffset=start;
     if(typeof this.onTrajectory==='function'&&entry.data){
      try{this.onTrajectory(id,entry.data);}catch{}
     }
    }catch{
     if((entry.backfillGen||0)===gen)entry.pendingBackfillOffset=0;
     break;
    }
   }
  })().finally(()=>{
   entry.backfilling=false;
   if(entry.pendingBackfillOffset>0&&this.epoch===epoch&&this.entries.get(id)===entry){
    this.scheduleRemoteBackfill(id,entry);
   }
  });
 }
}
