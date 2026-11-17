import test from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityClient } from '../client.mjs';
import { trajectoryMetrics } from '../metrics.mjs';
import { usageRecords } from '../usage.mjs';
const id='test-id',summary=(n,status='CASCADE_RUN_STATUS_IDLE',modified='v1')=>({stepCount:n,status,lastModifiedTime:modified});
function fixture(){
 let now=0;const client=new AntigravityClient({now:()=>now});
 const state={steps:[{type:'USER_INPUT',i:0},{type:'PLANNER_RESPONSE',i:1},{type:'USER_INPUT',i:2},{type:'PLANNER_RESPONSE',i:3}],generators:[{i:0,stepIndices:[1]},{i:1,stepIndices:[3]}],summary:summary(4),calls:[],endpoint:{pid:42,port:1234,csrf:'fixture'}};
 client.discover=async()=>state.endpoint;
 client.call=async(method,body={})=>{
  state.calls.push([method,body]);
  if(method==='GetAllCascadeTrajectories')return {trajectorySummaries:{[id]:state.summary}};
  if(method==='GetCascadeTrajectorySteps'){assert.equal(body.trajectoryVerbosity,3);return {steps:state.steps.slice(body.stepOffset,body.stepOffset+1)};}
  assert.equal(method,'GetCascadeTrajectoryGeneratorMetadata','Never request a whole trajectory');
  assert.equal(body.includeMessages,false);assert.equal(Object.hasOwn(body,'trajectoryVerbosity'),false);
  return {generatorMetadata:state.generators.slice(body.generatorMetadataOffset,body.generatorMetadataOffset+1)};
 };
 return {client,state,tick:()=>now+=2000};
}
test('cold acquisition uses summary/step/metadata RPCs and the empty terminal metadata page',async()=>{
 const {client,state}=fixture();const r=await client.trajectory(id);
 assert.deepEqual(r.trajectory.steps.map(s=>s.i),[0,1,2,3]);assert.deepEqual(r.trajectory.generatorMetadata.map(g=>g.i),[0,1]);assert.equal(r.numTotalGeneratorMetadata,2);
 assert.deepEqual(state.calls.filter(([m])=>m==='GetCascadeTrajectoryGeneratorMetadata').map(([,b])=>b.generatorMetadataOffset),[0,1,2]);
});
test('unchanged settled conversations skip downloads; new turns revalidate the preceding mutable tail',async()=>{
 const {client,state,tick}=fixture();await client.trajectory(id);state.calls=[];await client.trajectory(id);assert.equal(state.calls.length,0);
 tick();await client.trajectory(id);assert.deepEqual(state.calls.map(([m])=>m),['GetAllCascadeTrajectories']);
 state.steps.push({type:'USER_INPUT',i:4},{type:'PLANNER_RESPONSE',i:5});state.generators.push({i:2,stepIndices:[5]});state.summary=summary(6,'CASCADE_RUN_STATUS_IDLE','v2');tick();state.calls=[];
 const r=await client.trajectory(id);assert.deepEqual(r.trajectory.generatorMetadata.map(g=>g.i),[0,1,2]);
 assert.equal(state.calls.find(([m])=>m==='GetCascadeTrajectorySteps')[1].stepOffset,3);
 assert.equal(state.calls.find(([m])=>m==='GetCascadeTrajectoryGeneratorMetadata')[1].generatorMetadataOffset,1);
});
test('busy same-length updates replace mutable metadata without duplicating requests',async()=>{
 const {client,state}=fixture();state.summary=summary(4,'CASCADE_RUN_STATUS_RUNNING');await client.trajectory(id);
 state.generators[1]={i:1,stepIndices:[3],chatModel:{usage:{outputTokens:200},chatStartMetadata:{contextWindowMetadata:{estimatedTokensUsed:500}}}};state.calls=[];
 const r=await client.trajectory(id);assert.equal(r.trajectory.generatorMetadata.length,2);assert.equal(r.trajectory.generatorMetadata[1].chatModel.usage.outputTokens,200);
 assert.equal(state.calls.find(([m])=>m==='GetCascadeTrajectoryGeneratorMetadata')[1].generatorMetadataOffset,1);
});
test('rewinds and settled edits invalidate prefixes; explicit refresh reloads metadata',async()=>{
 const {client,state,tick}=fixture();await client.trajectory(id);state.steps=state.steps.slice(0,2);state.generators=state.generators.slice(0,1);state.summary=summary(2,'CASCADE_RUN_STATUS_IDLE','v2');tick();state.calls=[];
 let r=await client.trajectory(id);assert.equal(r.trajectory.steps.length,2);assert.equal(state.calls.find(([m])=>m==='GetCascadeTrajectorySteps')[1].stepOffset,0);
 state.summary=summary(2,'CASCADE_RUN_STATUS_IDLE','v3');tick();state.calls=[];r=await client.trajectory(id);assert.equal(state.calls.find(([m])=>m==='GetCascadeTrajectoryGeneratorMetadata')[1].generatorMetadataOffset,0);
 state.calls=[];await client.trajectory(id,{force:true});assert.ok(state.calls.some(([m])=>m==='GetCascadeTrajectorySteps'));
});
test('incomplete pages never replace the last complete cached revision',async()=>{
 const {client,state,tick}=fixture();const saved=await client.trajectory(id);state.summary=summary(10,'CASCADE_RUN_STATUS_IDLE','v2');tick();
 await assert.rejects(client.trajectory(id),/分页/);assert.equal(client.reader.entries.get(id).data,saved);
});
test('provided historical summaries skip enumeration; missing counts use an empty terminal step page',async()=>{
 const {client,state}=fixture();delete state.summary.stepCount;const r=await client.trajectory(id,{summary:state.summary});
 assert.equal(r.trajectory.steps.length,4);assert.ok(!state.calls.some(([m])=>m==='GetAllCascadeTrajectories'));
 assert.equal(state.calls.filter(([m])=>m==='GetCascadeTrajectorySteps').at(-1)[1].stepOffset,4);
});
test('concurrent reads coalesce; account reset and endpoint replacement invalidate prefixes',async()=>{
 const {client,state}=fixture();const [a,b]=await Promise.all([client.trajectory(id),client.trajectory(id)]);assert.equal(a,b);
 assert.equal(state.calls.filter(([m])=>m==='GetAllCascadeTrajectories').length,1);
 state.calls=[];client.resetTrajectories();await client.trajectory(id);assert.ok(state.calls.some(([m])=>m==='GetCascadeTrajectorySteps'));
 state.calls=[];state.endpoint={...state.endpoint,pid:43};await client.trajectory(id);assert.ok(state.calls.some(([m])=>m==='GetCascadeTrajectorySteps'));
});
test('unknown metadata associations are re-read rather than skipping unseen records',async()=>{
 const {client,state}=fixture();state.summary=summary(4,'CASCADE_RUN_STATUS_RUNNING');state.generators[0]={i:0};await client.trajectory(id);state.calls=[];
 await client.trajectory(id);assert.equal(state.calls.find(([m])=>m==='GetCascadeTrajectoryGeneratorMetadata')[1].generatorMetadataOffset,0);
});
test('long running turns re-read only the latest model and any earlier unfinished tools',async()=>{
 const {client,state}=fixture();state.steps=[{type:'USER_INPUT'},{type:'PLANNER_RESPONSE'},{type:'RUN_COMMAND',metadata:{startedAt:'2026-10-13T01:00:00Z'}},{type:'PLANNER_RESPONSE'},{type:'PLANNER_RESPONSE'}];
 state.generators=[{stepIndices:[1]},{stepIndices:[3]},{stepIndices:[4]}];state.summary=summary(5,'CASCADE_RUN_STATUS_RUNNING');await client.trajectory(id);state.calls=[];
 await client.trajectory(id);assert.equal(state.calls.find(([m])=>m==='GetCascadeTrajectorySteps')[1].stepOffset,2);assert.equal(state.calls.find(([m])=>m==='GetCascadeTrajectoryGeneratorMetadata')[1].generatorMetadataOffset,2);
 state.steps[2].metadata.completedAt='2026-10-13T01:00:05Z';await client.trajectory(id);state.calls=[];await client.trajectory(id);
 assert.equal(state.calls.find(([m])=>m==='GetCascadeTrajectorySteps')[1].stepOffset,4);
});
test('host growth during acquisition fails instead of caching mismatched steps',async()=>{
 const {client,state}=fixture();state.generators.push({stepIndices:[5]});await assert.rejects(client.trajectory(id),/仍在更新/);assert.equal(client.reader.entries.size,0);
});
test('idle caches periodically revalidate the tail even if summary timestamps did not change',async()=>{
 const {client,state,tick}=fixture();await client.trajectory(id);for(let i=0;i<5;i++)tick();state.generators[1]={i:1,stepIndices:[3],chatModel:{usage:{outputTokens:345}}};state.calls=[];
 const r=await client.trajectory(id);assert.equal(r.trajectory.generatorMetadata[1].chatModel.usage.outputTokens,345);assert.equal(state.calls.find(([m])=>m==='GetCascadeTrajectorySteps')[1].stepOffset,3);
});
test('a planner created before its first metadata entry is revalidated when the request finishes',async()=>{
 const {client,state}=fixture();state.steps=[{type:'USER_INPUT'},{type:'PLANNER_RESPONSE'}];state.generators=[];state.summary=summary(2,'CASCADE_RUN_STATUS_RUNNING');await client.trajectory(id);
 state.steps[1]={type:'PLANNER_RESPONSE',plannerResponse:{toolCalls:[{}]}};state.generators=[{stepIndices:[1]}];state.calls=[];
 const r=await client.trajectory(id);assert.equal(r.trajectory.steps[1].plannerResponse.toolCalls.length,1);assert.equal(state.calls.find(([m])=>m==='GetCascadeTrajectorySteps')[1].stepOffset,1);
});
test('retained-statistics budget fails closed independently of discarded corpus size',async()=>{
 const {client}=fixture();client.reader.budgetBytes=20;await assert.rejects(client.trajectory(id),/内存预算/);assert.equal(client.reader.entries.size,0);assert.equal(client.reader.cachedBytes,0);
});
test('the shared LRU statistics budget evicts inactive prefixes without leaking old scope',async()=>{
 const {client,state}=fixture();await client.trajectory(id);const bytes=client.reader.cachedBytes;client.reader.budgetBytes=bytes+1;
 await client.trajectory('other-id',{summary:state.summary});assert.equal(client.reader.entries.size,1);assert.ok(client.reader.entries.has('other-id'));assert.ok(client.reader.cachedBytes<=client.reader.budgetBytes);
});
test('reset during an in-flight read rejects late old records and permits a fresh scope',async()=>{
 const {client,state}=fixture();const original=client.call.bind(client);let release,entered;
 const begun=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let first=true;
 client.call=async(m,b)=>{if(m==='GetCascadeTrajectorySteps'&&first){first=false;entered();await gate;}return original(m,b);};
 const pending=client.trajectory(id);await begun;client.resetTrajectories();release();await assert.rejects(pending,/重新连接/);assert.equal(client.reader.entries.size,0);
 assert.equal((await client.trajectory(id)).trajectory.steps.length,state.steps.length);
});
test('unlisted remote conversations seamlessly fall back to StreamAgentStateUpdates snapshot',async()=>{
 const {client,state,tick}=fixture();
 const remoteId='remote-agent-uuid-1';
 let snapshotCalls=0;
 client.readAgentStateSnapshot=async(cid)=>{
  assert.equal(cid,remoteId);
  snapshotCalls++;
  return {
   conversationId:remoteId,
   status:'CASCADE_RUN_STATUS_IDLE',
   contextWindowUsage:{estimatedTokensUsed:4200,maxContextTokens:1048576},
   mainTrajectoryUpdate:{
    stepsUpdate:{steps:[{type:'USER_INPUT',i:0},{type:'PLANNER_RESPONSE',i:1}]},
    generatorMetadatasUpdate:{generatorMetadatas:[{i:0,stepIndices:[1],chatModel:{usage:{outputTokens:150}}}]}
   }
  };
 };
 const r=await client.trajectory(remoteId);
 assert.equal(snapshotCalls,1);
 assert.equal(r.trajectory.cascadeId,remoteId);
 assert.equal(r.trajectory.steps.length,2);
 assert.equal(r.trajectory.generatorMetadata.length,1);
 assert.equal(r.contextWindowUsage.estimatedTokensUsed,4200);
 assert.equal(r.isRemote,true);
 // Cached within idleRecheckMs
 await client.trajectory(remoteId);
 assert.equal(snapshotCalls,1);
 for(let i=0;i<6;i++)tick();
 await client.trajectory(remoteId);
 assert.equal(snapshotCalls,2);
});
test('cloudproxy unimplemented error on legacy steps RPC falls back to snapshot',async()=>{
 const {client,state}=fixture();
 const remoteId='remote-agent-uuid-2';
 state.summary=summary(2);
 client.call=async(method,body={})=>{
  if(method==='GetAllCascadeTrajectories')return {trajectorySummaries:{[remoteId]:state.summary}};
  if(method==='GetCascadeTrajectorySteps'){
   const err=new Error('unimplemented: cloudproxy: GetConversation: unimplemented');
   err.status=501;
   throw err;
  }
  throw new Error('unexpected method '+method);
 };
 let snapshotCalls=0;
 client.readAgentStateSnapshot=async(cid)=>{
  snapshotCalls++;
  return {
   conversationId:cid,
   status:'CASCADE_RUN_STATUS_IDLE',
   contextWindowUsage:{estimatedTokensUsed:1000,maxContextTokens:200000},
   mainTrajectoryUpdate:{
    stepsUpdate:{steps:[{type:'USER_INPUT'}]},
    generatorMetadatasUpdate:{generatorMetadatas:[]}
   }
  };
 };
 const r=await client.trajectory(remoteId);
 assert.equal(snapshotCalls,1);
 assert.equal(r.isRemote,true);
 assert.equal(r.trajectory.steps.length,1);
});
test('cloud remote agent step-level modelUsage normalizes TPS, cache hit, context occupancy and usage ledger',async()=>{
 const {client}=fixture();
 const remoteId='v1/default/jetski_remote_agents_3p/72bd7cfa-7ddf-41fa-9056-bf2777fafc90';
 client.readAgentStateSnapshot=async(cid)=>{
  assert.equal(cid,remoteId);
  return {
   conversationId:remoteId,
   status:'CASCADE_RUN_STATUS_IDLE',
   mainTrajectoryUpdate:{
    stepsUpdate:{
     steps:[
      {type:'CORTEX_STEP_TYPE_USER_INPUT',metadata:{createdAt:'2026-11-08T08:49:59.000000000Z'}},
      {
       type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
       plannerResponse:{thinking:'Secret thinking'},
       metadata:{
        createdAt:'2026-11-08T08:50:00.000000000Z',
        viewableAt:'2026-11-08T08:50:25.559000000Z',
        finishedGeneratingAt:'2026-11-08T08:50:25.654000000Z',
        generatorModel:'MODEL_GOOGLE_GEMINI_INTERNAL_BYOM',
        modelApiContentId:'content-id-tool-1',
        modelUsage:{inputTokens:'1200',cacheReadTokens:'30000',outputTokens:'180',responseOutputTokens:'110',thinkingOutputTokens:'70'},
        modelInfo:{modelName:'gemini-3.8-flash-high',maxTokens:1000000,modelFeatures:{supportedMimeTypes:{'image/png':true}}},
       },
      },
      {
       type:'CORTEX_STEP_TYPE_RUN_COMMAND',
       metadata:{
        createdAt:'2026-11-08T08:50:25.700000000Z',
        startedAt:'2026-11-08T08:50:25.700000000Z',
        completedAt:'2026-11-08T08:50:27.700000000Z',
        toolCallOutputTokens:120,
       },
      },
      {
       type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
       plannerResponse:{response:'Sensitive assistant reply that must be stripped',thinking:'Secret thinking 2'},
       metadata:{
        createdAt:'2026-11-08T08:51:00.000000000Z',
        viewableAt:'2026-11-08T08:51:03.829000000Z',
        finishedGeneratingAt:'2026-11-08T08:51:05.618000000Z',
        generatorModel:'MODEL_GOOGLE_GEMINI_INTERNAL_BYOM',
        modelApiContentId:'content-id-reply-2',
        modelUsage:{inputTokens:'2332',cacheReadTokens:'44345',outputTokens:'417',responseOutputTokens:'282',thinkingOutputTokens:'135'},
        modelInfo:{modelName:'gemini-3.8-flash-high',maxTokens:1000000,modelFeatures:{supportedMimeTypes:{'image/png':true}}},
       },
      },
     ],
    },
    generatorMetadatasUpdate:{
     generatorMetadatas:[
      {stepIndices:[1],plannerConfig:{modelName:'gemini-3.8-flash-high'}},
      {stepIndices:[3],plannerConfig:{modelName:'gemini-3.8-flash-high'}},
     ],
    },
   },
  };
 };
 const raw=await client.trajectory(remoteId);
 const serialized=JSON.stringify(raw);
 assert.ok(!serialized.includes('Sensitive assistant reply'));
 assert.ok(!serialized.includes('Secret thinking'));
 assert.ok(!serialized.includes('supportedMimeTypes'));

 const metrics=trajectoryMetrics(raw);
 assert.equal(metrics.requests,2);
 assert.equal(metrics.measuredRequests,1);
 assert.equal(metrics.excludedTiming,1);
 assert.equal(metrics.timingReasons['short-tool-window'],1);
 assert.ok(Math.abs(metrics.tps-(282/1.789))<0.01);
 assert.ok(Math.abs(metrics.latestTps-(282/1.789))<0.01);
 assert.equal(metrics.cache.measuredRequests,2);
 assert.equal(metrics.cache.complete,true);
 assert.ok(Math.abs(metrics.cache.hitRate-(74345/(74345+3532)))<1e-6);
 assert.equal(metrics.tokens.complete,true);
 assert.equal(metrics.tokens.outputTokens,597);
 assert.equal(metrics.context.usedTokens,47094);
 assert.equal(metrics.context.maxTokens,1000000);
 assert.equal(metrics.context.model,'Gemini 3.8 Flash (High)');
 assert.equal(metrics.context.providerMaxTokens,1048576);
 assert.equal(metrics.toolSeconds,2);

 const rows=usageRecords(raw,remoteId);
 assert.equal(rows.length,2);
 assert.ok(rows.every(r=>r.partial===false&&r.model==='Gemini 3.8 Flash (High)'&&r.timeBasis==='request-start'));
});
test('compound remote IDs revalidate settled state via GetConversationMetadata before streaming',async()=>{
 const {client,tick}=fixture();
 const remoteId='v1/default/jetski_remote_agents_3p/841d8c06-1111-2222-3333-444444444444';
 let snapshotCalls=0,metaCalls=0,remoteSteps=2;
 client.call=async(method,body={})=>{
  assert.equal(method,'GetConversationMetadata');
  assert.equal(body.conversationId,remoteId);
  metaCalls++;
  return {numSteps:remoteSteps};
 };
 client.readAgentStateSnapshot=async()=>{
  snapshotCalls++;
  return {
   conversationId:remoteId,
   status:'CASCADE_RUN_STATUS_IDLE',
   mainTrajectoryUpdate:{
    stepsUpdate:{steps:Array.from({length:remoteSteps},(_,i)=>({type:i===0?'USER_INPUT':'PLANNER_RESPONSE'}))},
    generatorMetadatasUpdate:{generatorMetadatas:[]},
   },
  };
 };
 await client.trajectory(remoteId);
 assert.equal(snapshotCalls,1);
 assert.equal(metaCalls,1);
 for(let i=0;i<6;i++)tick();
 await client.trajectory(remoteId);
 assert.equal(metaCalls,2);
 assert.equal(snapshotCalls,1);
 remoteSteps=4;
 for(let i=0;i<6;i++)tick();
 const updated=await client.trajectory(remoteId);
 assert.equal(metaCalls,3);
 assert.equal(snapshotCalls,2);
 assert.equal(updated.numTotalSteps,4);

 client.readAgentStateSnapshot=async()=>{throw new Error('Antigravity 本地接口超时');};
 await assert.rejects(client.trajectory(remoteId,{force:true}),/远程环境休眠或同步较慢/);
});
test('incremental remote steps use initialStepsPageBounds slice and merge without duplicates',async()=>{
 const {client,tick}=fixture();
 const remoteId='v1/default/jetski_remote_agents_3p/4cc28cee-0000-0000-0000-000000000000';
 let remoteSteps=2;
 const requestedBounds=[];
 client.call=async(method,body={})=>{
  if(method==='GetConversationMetadata')return {numSteps:remoteSteps};
  throw new Error('Unexpected call '+method);
 };
 client.readAgentStateSnapshot=async(cid,options={})=>{
  if(options?.initialStepsPageBounds)requestedBounds.push(options.initialStepsPageBounds);
  const start=options?.initialStepsPageBounds?.startIndex??0;
  const end=options?.initialStepsPageBounds?.endIndexExclusive??remoteSteps;
  const sliceSteps=[];
  for(let i=start;i<end;i++){
   sliceSteps.push({
    i,
    type:i%2===0?'CORTEX_STEP_TYPE_USER_INPUT':'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    metadata:{
     createdAt:'2026-11-08T08:00:00.000Z',
     ...(i%2===1?{
      modelUsage:{inputTokens:'100',outputTokens:'50'},
      modelInfo:{maxTokens:1000000,displayName:'Gemini 3.8 Flash'},
     }:{}),
    },
   });
  }
  return {
   conversationId:remoteId,
   status:'CASCADE_RUN_STATUS_IDLE',
   mainTrajectoryUpdate:{
    stepsUpdate:{steps:sliceSteps},
    generatorMetadatasUpdate:{generatorMetadatas:[]},
   },
  };
 };
 const r1=await client.trajectory(remoteId);
 assert.equal(r1.trajectory.steps.length,2);
 assert.equal(requestedBounds.length,0);

 // Conversation grows to 4 steps
 remoteSteps=4;
 for(let i=0;i<6;i++)tick();
 const r2=await client.trajectory(remoteId);
 assert.equal(requestedBounds.length,1);
 assert.deepEqual(requestedBounds[0],{startIndex:2,endIndexExclusive:4});
 assert.equal(r2.trajectory.steps.length,4);
 assert.deepEqual(r2.trajectory.steps.map(s=>s.i),[0,1,2,3]);
 assert.equal(r2.contextWindowUsage.estimatedTokensUsed,150);
});
test('cold remote read for long conversation (>50 steps) uses tail window bounds and schedules backfill',async()=>{
 const {client}=fixture();
 const remoteId='v1/default/jetski_remote_agents_3p/cold-long-0000-1111-2222-333333333333';
 const remoteSteps=120;
 const requestedBounds=[];
 client.call=async(method)=>{
  if(method==='GetConversationMetadata')return {numSteps:remoteSteps};
  throw new Error('Unexpected call '+method);
 };
 client.readAgentStateSnapshot=async(cid,options={})=>{
  if(options?.initialStepsPageBounds)requestedBounds.push(options.initialStepsPageBounds);
  const start=options?.initialStepsPageBounds?.startIndex??0;
  const end=options?.initialStepsPageBounds?.endIndexExclusive??remoteSteps;
  const sliceSteps=[];
  for(let i=start;i<end;i++){
   sliceSteps.push({
    i,
    type:i%2===0?'CORTEX_STEP_TYPE_USER_INPUT':'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    metadata:{
     createdAt:'2026-11-08T08:00:00.000Z',
     ...(i%2===1?{
      modelUsage:{inputTokens:'100',outputTokens:'50'},
      modelInfo:{maxTokens:1000000,displayName:'Gemini 3.8 Flash'},
     }:{}),
    },
   });
  }
  return {
   conversationId:remoteId,
   status:'CASCADE_RUN_STATUS_IDLE',
   mainTrajectoryUpdate:{
    stepsUpdate:{steps:sliceSteps},
    generatorMetadatasUpdate:{generatorMetadatas:[]},
   },
  };
 };
 const r=await client.trajectory(remoteId);
 assert.equal(r.numTotalSteps,120);
 assert.equal(requestedBounds[0]?.startIndex,70);
 assert.equal(requestedBounds[0]?.endIndexExclusive,120);
 assert.equal(r.trajectory.steps.length,120);
 assert.equal(r.trajectory.steps[119]?.type,'CORTEX_STEP_TYPE_PLANNER_RESPONSE');
 assert.ok(requestedBounds.length>=2);
 assert.deepEqual(requestedBounds[1],{startIndex:20,endIndexExclusive:70});
 assert.equal(r.trajectory.steps[0]?.type,'CORTEX_STEP_TYPE_USER_INPUT');
});
test('stuck RUNNING remote conversation revalidates settled state when step count is unchanged',async()=>{
 const {client,tick}=fixture();
 const remoteId='v1/default/jetski_remote_agents_3p/stuck-running-0000-1111-2222-333333333333';
 let snapshotCalls=0,metaCalls=0;
 client.call=async(method)=>{
  if(method==='GetConversationMetadata'){metaCalls++;return {numSteps:40};}
  throw new Error('Unexpected call '+method);
 };
 client.readAgentStateSnapshot=async()=>{
  snapshotCalls++;
  return {
   conversationId:remoteId,
   status:'CASCADE_RUN_STATUS_RUNNING',
   mainTrajectoryUpdate:{
    stepsUpdate:{steps:[{type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',metadata:{completedAt:'2026-11-08T08:00:00Z'}}]},
    generatorMetadatasUpdate:{generatorMetadatas:[]},
   },
  };
 };
 await client.trajectory(remoteId);
 assert.equal(snapshotCalls,1);
 assert.equal(metaCalls,1);
 // Next recheck within idle window should use cached entry because remoteSteps is unchanged at 40
 for(let i=0;i<6;i++)tick();
 const cached=await client.trajectory(remoteId);
 assert.equal(snapshotCalls,1);
 assert.equal(metaCalls,2);
 assert.equal(cached.numTotalSteps,40);
});
