import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {AntigravityClient} from '../client.mjs';

async function fixture(t){
 const state={scans:0,now:100000,status:404,body:'{}',requests:0};
 const server=createServer((req,res)=>{state.requests++;req.resume();res.writeHead(state.status,{'Content-Type':'application/json'});res.end(state.body);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 state.port=server.address().port;state.pid=42;
 const client=new AntigravityClient({now:()=>state.now,paths:()=>({log:'fixture'}),readLog:async()=>`listening on random port at ${state.port} for HTTP\n`,
  processes:async()=>{state.scans++;return [{ProcessId:state.pid,CommandLine:'language_server --standalone --csrf_token=fixture',Ports:[state.port]}];}});
 return {client,state,server};
}

test('unavailable history and malformed RPC replies never invalidate a healthy endpoint',async t=>{
 const {client,state}=await fixture(t);
 for(const status of [400,404,409,429,500,503]){
  state.status=status;
  for(let i=0;i<3;i++)await assert.rejects(client.call('GetCascadeTrajectory',{cascadeId:'missing'}));
 }
 state.status=200;state.body='{broken';await assert.rejects(client.call('GetCascadeTrajectory'));
 state.body='{}';assert.deepEqual(await client.call('GetUserStatus'),{});
 assert.equal(state.scans,1,'Conversation/protocol failures must not spawn another process scan');
 assert.equal(state.requests,20,'Application failures are not blindly retried');
 assert.ok(client.server);
});

test('ordinary RPC JSON errors never expose a private response fragment',async t=>{
 const {client,state}=await fixture(t);state.status=200;state.body='{"private":"DO_NOT_DISCLOSE" invalid}';
 await assert.rejects(client.call('GetUserStatus'),error=>error.message==='Antigravity 接口返回了无法解析的数据');
 state.body='{}';assert.deepEqual(await client.call('GetUserStatus'),{});assert.equal(state.scans,1);
});

test('cold-start discovery failures coalesce and back off while the backend starts',async()=>{
 let now=0,scans=0,ready=false;
 const client=new AntigravityClient({now:()=>now,paths:()=>({log:'fixture'}),readLog:async()=> 'listening on random port at 1234 for HTTP\n',
  processes:async()=>{scans++;return ready?[{ProcessId:42,CommandLine:'language_server --standalone --csrf_token=fixture',Ports:[1234]}]:[];}});
 await Promise.allSettled(Array.from({length:20},()=>client.discover()));assert.equal(scans,1);
 for(let i=0;i<20;i++)await assert.rejects(client.discover());assert.equal(scans,1);
 now=3000;await assert.rejects(client.discover());assert.equal(scans,2);
 now=4000;ready=true;await assert.rejects(client.discover());assert.equal(scans,2);
 now=9000;assert.equal((await client.discover()).pid,42);assert.equal(scans,3);
});

test('authorization failures have a cooldown, then rediscover without disabling the plugin',async t=>{
 const {client,state}=await fixture(t);state.status=401;
 for(let i=0;i<10;i++)await assert.rejects(client.call('GetUserStatus'));
 assert.equal(state.scans,1);assert.equal(state.requests,1);
 state.now+=3000;state.status=200;
 assert.deepEqual(await client.call('GetUserStatus'),{});assert.equal(state.scans,2);
});

test('a refused old port rediscovers a restarted backend once, without toggling the plugin',async t=>{
 const {client,state,server}=await fixture(t);state.status=200;
 await client.call('GetUserStatus');assert.equal(state.scans,1);
 await new Promise(r=>server.close(r));
 const replacement=createServer((req,res)=>{req.resume();res.end('{}');});
 await new Promise(r=>replacement.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>replacement.close(r)));
 state.port=replacement.address().port;state.pid=43;state.now+=3000;
 assert.deepEqual(await client.call('GetUserStatus'),{});
 assert.equal(client.server.pid,43);assert.equal(state.scans,2);
});

test('malformed projected streams reject immediately even when response ends in the same read',async t=>{
 const {client,state}=await fixture(t);
 state.status=200;state.body='{broken';
 await assert.rejects(client.call('GetCascadeTrajectorySteps'),error=>error.message==='Antigravity 接口返回了无法解析的数据');
 state.body='{"steps":[]}';
 assert.deepEqual(await client.call('GetCascadeTrajectorySteps'),{steps:[]});
});

function connectFrame(flag,payload){
 const buf=Buffer.isBuffer(payload)?payload:Buffer.from(payload,'utf8');
 const header=Buffer.allocUnsafe(5);
 header.writeUInt8(flag,0);
 header.writeUInt32BE(buf.length,1);
 return Buffer.concat([header,buf]);
}

async function snapshotFixture(t,handler){
 const state={scans:0,now:100000,requests:0};
 const server=createServer((req,res)=>{state.requests++;req.resume();handler(req,res,state);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 state.port=server.address().port;state.pid=42;
 const client=new AntigravityClient({now:()=>state.now,paths:()=>({log:'fixture'}),readLog:async()=>`listening on random port at ${state.port} for HTTP\n`,
  processes:async()=>{state.scans++;return [{ProcessId:state.pid,CommandLine:'language_server --standalone --csrf_token=fixture',Ports:[state.port]}];}});
 return {client,state,server};
}

test('readAgentStateSnapshot streams and projects large multi-chunk frames with split headers and UTF-8',async t=>{
 const hugeText='PRIVATE_BLOB_'.repeat(160*1024);
 const payloadObj={update:{
  conversationId:'v1/default/jetski_remote_agents_3p/stream-1',
  status:'CASCADE_RUN_STATUS_IDLE',
  contextWindowUsage:{estimatedTokensUsed:1234,maxContextTokens:1048576},
  mainTrajectoryUpdate:{
   stepsUpdate:{steps:[
    {i:0,type:'CORTEX_STEP_TYPE_USER_INPUT',metadata:{createdAt:'2026-11-16T01:00:00Z'},
     userInput:{text:hugeText+'中文🧩结尾',userConfig:{plannerConfig:{planModel:'MODEL_PLACEHOLDER_M668'}}}},
    {i:1,type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',status:'CORTEX_STEP_STATUS_DONE',
     metadata:{createdAt:'2026-11-16T01:00:01Z',generatorModel:'MODEL_GOOGLE_GEMINI_INTERNAL_BYOM',
      modelUsage:{inputTokens:'500',outputTokens:'100',cacheReadTokens:'2000'},
      modelInfo:{modelName:'gemini-3.8-flash-high',maxTokens:1000000,modelFeatures:{supportedMimeTypes:{'image/png':true}}}},
     plannerResponse:{response:'🧩中'+hugeText,thinking:'SECRET_THOUGHT_'+hugeText,toolCalls:[{name:'read_file',status:'DONE',argumentsJson:hugeText}]}},
    {i:2,type:'CORTEX_STEP_TYPE_RUN_COMMAND',metadata:{startedAt:'2026-11-16T01:00:02Z',completedAt:'2026-11-16T01:00:03Z',toolCall:{name:'run_command'}},
     runCommand:{output:hugeText}},
   ]},
   generatorMetadatasUpdate:{generatorMetadatas:[{i:0,stepIndices:[1],plannerConfig:{modelName:'gemini-3.8-flash-high'}}]},
  },
 }};
 const wire=Buffer.concat([
  connectFrame(1,'ignored-compressed-frame'),
  connectFrame(0,'{"heartbeat":true}'),
  connectFrame(0,'{"update":null}'),
  connectFrame(0,JSON.stringify(payloadObj)),
 ]);
 assert.ok(wire.length>8*1024*1024);

 const {client}=await snapshotFixture(t,(req,res)=>{
  if(req.url?.endsWith('GetConversationMetadata')){
   res.writeHead(200,{'Content-Type':'application/json'});
   res.end(JSON.stringify({numSteps:3}));
   return;
  }
  res.writeHead(200,{'Content-Type':'application/connect+json'});
  let offset=0;
  const cuts=[2,5,19,24,40];
  const pump=()=>{
   if(offset>=wire.length){res.end();return;}
   const nextCut=cuts.find(c=>c>offset);
   const end=nextCut!==undefined?Math.min(wire.length,nextCut):Math.min(wire.length,offset+256*1024-3);
   const ok=res.write(wire.subarray(offset,end));
   offset=end;
   if(ok)setImmediate(pump);
   else res.once('drain',pump);
  };
  pump();
 });

 const update=await client.readAgentStateSnapshot('v1/default/jetski_remote_agents_3p/stream-1');
 const serialized=JSON.stringify(update);
 assert.equal(serialized.includes('PRIVATE_BLOB'),false);
 assert.equal(serialized.includes('SECRET_THOUGHT'),false);
 assert.equal(serialized.includes('supportedMimeTypes'),false);
 assert.ok(serialized.length<4096);
 assert.equal(update.conversationId,'v1/default/jetski_remote_agents_3p/stream-1');
 assert.equal(update.planModel,'MODEL_PLACEHOLDER_M668');
 assert.equal(update.mainTrajectoryUpdate.stepsUpdate.steps[1].plannerResponse.response,'1');
 assert.equal(update.mainTrajectoryUpdate.stepsUpdate.steps[1].metadata.modelUsage.inputTokens,'500');
 assert.equal(update.mainTrajectoryUpdate.stepsUpdate.steps[1].status,undefined);

 const remoteTraj=await client.trajectory('v1/default/jetski_remote_agents_3p/stream-1');
 assert.equal(remoteTraj.isRemote,true);
 assert.equal(remoteTraj.numTotalSteps,3);
 assert.equal(remoteTraj.trajectory.planModel,'MODEL_PLACEHOLDER_M668');
});

test('readAgentStateSnapshot forwards modelTimelineEnabled via client state and per-call option',async t=>{
 const payload=JSON.stringify({update:{
  conversationId:'remote-tl',
  status:'CASCADE_RUN_STATUS_IDLE',
  mainTrajectoryUpdate:{stepsUpdate:{steps:[
   {type:'CORTEX_STEP_TYPE_USER_INPUT',userInput:{text:'SECRET',userConfig:{plannerConfig:{planModel:'MODEL_PLACEHOLDER_M668'}}}},
   {type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',status:'CORTEX_STEP_STATUS_DONE',
    metadata:{toolCall:{name:'read_file'}},
    plannerResponse:{response:'SECRET',toolCalls:[{name:'read_file',status:'DONE',argumentsJson:'SECRET'}]}},
   {type:'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',systemMessage:{eventType:'plan_mode_handoff',message:'SECRET'}},
  ]}},
 }});
 const {client}=await snapshotFixture(t,(_req,res)=>{
  res.writeHead(200,{'Content-Type':'application/connect+json'});
  res.end(connectFrame(0,payload));
 });

 const off=await client.readAgentStateSnapshot('remote-tl');
 assert.equal(off.mainTrajectoryUpdate.stepsUpdate.steps[0].userInput,undefined);
 assert.equal(off.mainTrajectoryUpdate.stepsUpdate.steps[1].status,undefined);
 assert.deepEqual(off.mainTrajectoryUpdate.stepsUpdate.steps[1].plannerResponse.toolCalls,[{}]);
 assert.equal(off.mainTrajectoryUpdate.stepsUpdate.steps[2].systemMessage,undefined);

 const onOption=await client.readAgentStateSnapshot('remote-tl',{modelTimelineEnabled:true});
 assert.equal(JSON.stringify(onOption).includes('SECRET'),false);
 assert.equal(onOption.mainTrajectoryUpdate.stepsUpdate.steps[0].userInput.userConfig.plannerConfig.planModel,'MODEL_PLACEHOLDER_M668');
 assert.equal(onOption.mainTrajectoryUpdate.stepsUpdate.steps[1].status,'CORTEX_STEP_STATUS_DONE');
 assert.deepEqual(onOption.mainTrajectoryUpdate.stepsUpdate.steps[1].plannerResponse.toolCalls,[{name:'read_file',status:'DONE'}]);
 assert.deepEqual(onOption.mainTrajectoryUpdate.stepsUpdate.steps[2].systemMessage,{eventType:'plan_mode_handoff'});

 client.setModelTimelineEnabled(true);
 const onClient=await client.readAgentStateSnapshot('remote-tl');
 assert.equal(onClient.mainTrajectoryUpdate.stepsUpdate.steps[1].status,'CORTEX_STEP_STATUS_DONE');
});

test('readAgentStateSnapshot handles Connect error trailers, invalid JSON, missing update, and MAX_SNAPSHOT_BYTES',async t=>{
 let mode='trailer-error';
 const {client,state}=await snapshotFixture(t,(_req,res)=>{
  res.writeHead(200,{'Content-Type':'application/connect+json'});
  if(mode==='trailer-error'){
   const trailer=connectFrame(2,JSON.stringify({error:{code:'permission_denied',message:'cloud access denied'}}));
   res.write(trailer.subarray(0,3));
   setTimeout(()=>res.end(trailer.subarray(3)),5);
  }else if(mode==='invalid-json'){
   res.end(connectFrame(0,'{"update":{"bad":01}}'));
  }else if(mode==='empty-frame'){
   res.end(connectFrame(0,''));
  }else if(mode==='missing-update'){
   res.write(connectFrame(0,'{}'));
   res.end(connectFrame(2,'{}'));
  }else if(mode==='oversized'){
   const header=Buffer.allocUnsafe(5);
   header.writeUInt8(0,0);
   header.writeUInt32BE(64*1024*1024+1,1);
   res.end(header);
  }
 });

 await assert.rejects(client.readAgentStateSnapshot('c1',{},false),err=>err.message==='cloud access denied'&&err.status===403);
 assert.equal(state.scans,1);

 await client.discover(true);
 mode='invalid-json';
 await assert.rejects(client.readAgentStateSnapshot('c1'),err=>err.message==='Antigravity 接口返回了无法解析的数据');
 assert.ok(client.server,'invalid snapshot JSON must not invalidate healthy endpoint');

 mode='empty-frame';
 await assert.rejects(client.readAgentStateSnapshot('c1'),err=>err.message==='Antigravity 接口返回了无法解析的数据');

 mode='missing-update';
 await assert.rejects(client.readAgentStateSnapshot('c1'),err=>err.message==='会话暂时没有可用统计');

 mode='oversized';
 await assert.rejects(client.readAgentStateSnapshot('c1'),err=>err.message==='接口响应超过采集上限');
});
