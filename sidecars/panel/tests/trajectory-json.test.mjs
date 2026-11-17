import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {TrajectoryJson} from '../trajectory-json.mjs';
import {AntigravityClient} from '../client.mjs';
import {trajectoryMetrics} from '../metrics.mjs';
import {usageRecords} from '../usage.mjs';
const id='11111111-1111-1111-1111-111111111111';
const record={trajectory:{cascadeId:id,steps:[{type:'USER_INPUT',userInput:{text:'PRIVATE PROMPT'}},
 {type:'PLANNER_RESPONSE',metadata:{createdAt:'2026-10-13T01:00:00Z'},plannerResponse:{response:'A short reply',toolCalls:[{arguments:'PRIVATE TOOL INPUT'}]}},
 {type:'RUN_COMMAND',metadata:{startedAt:'2026-10-13T01:00:00Z',completedAt:'2026-10-13T01:00:05Z',toolCall:{}},result:'PRIVATE OUTPUT'}],
 generatorMetadata:[{stepIndices:[1],chatModel:{messages:[{content:'PRIVATE CONTEXT'}],usage:{inputTokens:100,outputTokens:200,responseOutputTokens:200,cacheReadTokens:300,cacheWriteTokens:0,apiProvider:'API_PROVIDER_GOOGLE_GEMINI',responseId:'request-1'},
 modelDisplayName:'Gemini',streamingDuration:'2s',timeToFirstToken:{seconds:1,nanos:0},retryInfos:[{usage:{outputTokens:200}}],
 chatStartMetadata:{createdAt:'2026-10-13T01:00:00Z',contextWindowMetadata:{estimatedTokensUsed:400,maxContextTokens:10000}}}}]},numTotalSteps:3,numTotalGeneratorMetadata:1,status:'CASCADE_RUN_STATUS_IDLE'};
const project=(text,size=1)=>{const p=new TrajectoryJson();for(let i=0;i<text.length;i+=size)p.write(text.slice(i,i+size));return p.end();};
test('all statistical values and usage identities survive projection across single-character chunks',()=>{
 const raw=JSON.stringify(record),small=project(raw);
 assert.deepEqual(trajectoryMetrics(small),trajectoryMetrics(record));assert.deepEqual(usageRecords(small,id),usageRecords(record,id));
 assert.ok(!JSON.stringify(small).includes('PRIVATE'));assert.equal(small.trajectory.steps.length,3);
 assert.deepEqual(small,project(raw,65));
});
test('escaped response text retains only its trimmed presence; tool calls retain presence, not arguments',()=>{
 for(const response of ['', ' \u2000\n', ' \u2000正文🧩']){
  const raw={trajectory:{steps:[{plannerResponse:{response,toolCalls:response?['private']:[]}}]}};
  const reduced=project(JSON.stringify(raw));const planner=reduced.trajectory.steps[0].plannerResponse;
  assert.equal(Boolean(planner.response.trim()),Boolean(response.trim()));assert.equal(planner.toolCalls.length,raw.trajectory.steps[0].plannerResponse.toolCalls.length);
 }
});
test('malformed JSON is rejected even in discarded fields',()=>{
 for(const text of ['{"ignored":"bad\\x"}','{"ignored":"bad\\uABQ1"}','{"ignored":[1,]}','{"ignored":{"x":1,}}','{"ignored":01}','{"trajectory":{}}garbage','{"ignored":"unterminated','{"ignored":"\n"}'])assert.throws(()=>project(text));
 const p=new TrajectoryJson({maxRetainedBytes:1});assert.throws(()=>p.write('{"trajectory":{}}'),/上限/);
 assert.deepEqual(project('{"__proto__":{"usage":"private"},"constructor":"private"}'),{});
});
test('step and generator page schemas preserve array offsets and distinct metadata spelling',()=>{
 assert.deepEqual(project(JSON.stringify({steps:record.trajectory.steps})).steps.length,3);
 assert.equal(project(JSON.stringify({generatorMetadatas:record.trajectory.generatorMetadata})).generatorMetadatas.length,1);
});
test('a real HTTP step page above the old 32 MiB cap restores all metrics without whole-trajectory RPCs',async t=>{
 const head=JSON.stringify({steps:record.trajectory.steps}).slice(0,-1)+',"largeToolOutput":"',tail='"}',chunk='x'.repeat(64*1024);let wireBytes=0,scans=0;const methods=[];
 const server=createServer(async(req,res)=>{
  let text='';for await(const c of req)text+=c;const body=JSON.parse(text),method=req.url.split('/').at(-1);methods.push(method);res.writeHead(200,{'Content-Type':'application/json'});
  if(method==='GetAllCascadeTrajectories'){res.end(JSON.stringify({trajectorySummaries:{[id]:{stepCount:3,lastModifiedTime:'2026-10-13T01:00:00Z',status:record.status}}}));return;}
  if(method==='GetCascadeTrajectoryGeneratorMetadata'){assert.equal(body.includeMessages,false);res.end(JSON.stringify({generatorMetadata:body.generatorMetadataOffset===0?record.trajectory.generatorMetadata:[]}));return;}
  assert.equal(method,'GetCascadeTrajectorySteps');assert.equal(body.stepOffset,0);
  res.write(head);wireBytes+=Buffer.byteLength(head);
  for(let i=0;i<640;i++){wireBytes+=chunk.length;if(!res.write(chunk))await once(res,'drain');}
  res.end(tail);wireBytes+=Buffer.byteLength(tail);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const port=server.address().port,client=new AntigravityClient({paths:()=>({log:'fixture'}),readLog:async()=>`listening on random port at ${port} for HTTP\n`,
 processes:async()=>{scans++;return [{ProcessId:42,CommandLine:'language_server --standalone --csrf_token=fixture',Ports:[port]}];}});
 const raw=await client.trajectory(id);assert.ok(wireBytes>32*1024*1024);assert.ok(Buffer.byteLength(JSON.stringify(raw))<4096);assert.ok(!methods.includes('GetCascadeTrajectory'));
 assert.deepEqual(trajectoryMetrics(raw),trajectoryMetrics(record));assert.deepEqual(usageRecords(raw,id),usageRecords(record,id));assert.equal(scans,1);
 assert.equal(trajectoryMetrics(raw).tps,100);assert.equal(trajectoryMetrics(raw).cache.hitRate,.75);
 console.log(JSON.stringify({longConversationRegression:true,wireBytes,retainedBytes:Buffer.byteLength(JSON.stringify(raw)),context:trajectoryMetrics(raw).context.usedTokens,cache:trajectoryMetrics(raw).cache.hitRate}));
});
test('modelTimelineEnabled gate keeps zero extra step fields when false and strips sensitive fields when true',()=>{
 const hybridInput={trajectory:{cascadeId:id,steps:[
  {type:'CORTEX_STEP_TYPE_USER_INPUT',status:'CORTEX_STEP_STATUS_DONE',metadata:{createdAt:'2026-11-14T06:38:52Z'},userInput:{text:'SECRET USER PROMPT',items:[{text:'SECRET'}],userConfig:{plannerConfig:{planModel:'MODEL_PLACEHOLDER_M668'},declarativeMixinConfig:{secret:true}}}},
  {type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',status:'CORTEX_STEP_STATUS_DONE',metadata:{createdAt:'2026-11-14T06:39:00Z',generatorModel:'MODEL_PLACEHOLDER_M668'},plannerResponse:{response:'SECRET REPLY',thought:'SECRET THINKING',toolCalls:[{name:'read_file',status:'DONE',argumentsJson:'{"path":"C:/secret/key.txt"}',thinkingSignature:'sig'}]}},
  {type:'CORTEX_STEP_TYPE_RUN_COMMAND',status:'CORTEX_STEP_STATUS_ERROR',metadata:{startedAt:'2026-11-14T06:39:01Z',completedAt:'2026-11-14T06:39:02Z',toolCall:{name:'run_command',argumentsJson:'rm -rf /secret'}},runCommand:{commandLine:'SECRET CMD'}},
  {type:'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',status:'CORTEX_STEP_STATUS_DONE',metadata:{createdAt:'2026-11-14T06:39:03Z'},systemMessage:{eventType:'plan_mode_handoff',message:'SECRET HANDOFF TEXT'}},
  {type:'CORTEX_STEP_TYPE_TASK_BOUNDARY',status:'CORTEX_STEP_STATUS_DONE',metadata:{createdAt:'2026-11-14T06:39:04Z'},taskBoundary:{Mode:'EXECUTION',TaskSummary:'SECRET TASK SUMMARY'}}
 ],generatorMetadata:[]}};
 const off=new TrajectoryJson();
 off.write(JSON.stringify(hybridInput));
 const offOut=off.end();
 assert.equal(offOut.trajectory.planModel,'MODEL_PLACEHOLDER_M668');
 assert.equal(offOut.trajectory.steps[0].userInput,undefined);
 assert.equal(offOut.trajectory.steps[1].status,undefined);
 assert.equal(offOut.trajectory.steps[1].metadata.generatorModel,undefined);
 assert.deepEqual(offOut.trajectory.steps[1].plannerResponse.toolCalls,[{}]);
 assert.equal(offOut.trajectory.steps[3].systemMessage,undefined);
 assert.equal(offOut.trajectory.steps[4].taskBoundary,undefined);
 assert.equal(JSON.stringify(offOut).includes('SECRET'),false);

 const on=new TrajectoryJson({modelTimelineEnabled:true});
 on.write(JSON.stringify(hybridInput));
 const onOut=on.end();
 const serialized=JSON.stringify(onOut);
 assert.equal(serialized.includes('SECRET'),false);
 assert.equal(serialized.includes('key.txt'),false);
 assert.equal(serialized.includes('thinkingSignature'),false);
 assert.equal(onOut.trajectory.steps[0].userInput.userConfig.plannerConfig.planModel,'MODEL_PLACEHOLDER_M668');
 assert.equal(onOut.trajectory.steps[1].metadata.generatorModel,'MODEL_PLACEHOLDER_M668');
 assert.deepEqual(onOut.trajectory.steps[1].plannerResponse.toolCalls,[{name:'read_file',status:'DONE'}]);
 assert.deepEqual(onOut.trajectory.steps[2].metadata.toolCall,{name:'run_command'});
 assert.equal(onOut.trajectory.steps[2].status,'CORTEX_STEP_STATUS_ERROR');
 assert.deepEqual(onOut.trajectory.steps[3].systemMessage,{eventType:'plan_mode_handoff'});
 assert.deepEqual(onOut.trajectory.steps[4].taskBoundary,{Mode:'EXECUTION'});
});

test('StreamAgentStateUpdates update schema projects remote stats, captures planModel, and gates timeline fields',()=>{
 const remoteId='v1/default/jetski_remote_agents_3p/72bd7cfa-7ddf-41fa-9056-bf2777fafc90';
 const rawUpdate={update:{
  conversationId:remoteId,
  status:'CASCADE_RUN_STATUS_IDLE',
  contextWindowUsage:{estimatedTokensUsed:4200,maxContextTokens:1048576,extraSecret:'SECRET_CTX'},
  mainTrajectoryUpdate:{
   stepsUpdate:{steps:[
    {i:0,type:'CORTEX_STEP_TYPE_USER_INPUT',status:'CORTEX_STEP_STATUS_DONE',metadata:{createdAt:'2026-11-14T06:38:52Z'},
     userInput:{text:'SECRET REMOTE PROMPT',userConfig:{plannerConfig:{planModel:'MODEL_PLACEHOLDER_M668'}}}},
    {i:1,type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',status:'CORTEX_STEP_STATUS_DONE',
     metadata:{createdAt:'2026-11-14T06:39:00Z',viewableAt:'2026-11-14T06:39:01Z',finishedGeneratingAt:'2026-11-14T06:39:03Z',
      generatorModel:'MODEL_GOOGLE_GEMINI_INTERNAL_BYOM',modelApiContentId:'cid-1',
      modelUsage:{inputTokens:'1200',cacheReadTokens:'30000',outputTokens:'180',responseOutputTokens:'110',thinkingOutputTokens:'70'},
      modelInfo:{modelName:'gemini-3.8-flash-high',maxTokens:1000000,modelFeatures:{supportedMimeTypes:{'image/png':true}}},
      requestedModel:{model:'gemini-3.8-flash-high',secret:'SECRET'},
      sourceTrajectoryStepInfo:{stepIndex:1,extra:'SECRET'}},
     plannerResponse:{response:'SECRET REMOTE REPLY',thinking:'SECRET THINKING',
      toolCalls:[{name:'read_file',status:'DONE',argumentsJson:'{"path":"C:/secret.env"}'}]}},
    {i:2,type:'CORTEX_STEP_TYPE_RUN_COMMAND',status:'CORTEX_STEP_STATUS_DONE',
     metadata:{startedAt:'2026-11-14T06:39:04Z',completedAt:'2026-11-14T06:39:05Z',toolCallOutputTokens:64,
      toolCall:{name:'run_command',argumentsJson:'SECRET'},modelInfo:{modelFeatures:{secret:true}}},
     runCommand:{output:'SECRET COMMAND OUTPUT'}},
    {i:3,type:'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',status:'CORTEX_STEP_STATUS_DONE',
     systemMessage:{eventType:'plan_mode_handoff',message:'SECRET HANDOFF'}},
   ]},
   generatorMetadatasUpdate:{generatorMetadatas:[
    {i:0,stepIndices:[1],plannerConfig:{modelName:'gemini-3.8-flash-high',secret:'SECRET'}},
   ]},
  },
 }};
 const offOut=project(JSON.stringify(rawUpdate),128);
 const offStr=JSON.stringify(offOut);
 assert.equal(offStr.includes('SECRET'),false);
 assert.equal(offStr.includes('supportedMimeTypes'),false);
 assert.equal(offOut.update.conversationId,remoteId);
 assert.equal(offOut.update.planModel,'MODEL_PLACEHOLDER_M668');
 assert.deepEqual(offOut.update.contextWindowUsage,{estimatedTokensUsed:4200,maxContextTokens:1048576});
 const offSteps=offOut.update.mainTrajectoryUpdate.stepsUpdate.steps;
 assert.equal(offSteps.length,4);
 assert.equal(offSteps[0].userInput,undefined);
 assert.equal(offSteps[1].status,undefined);
 assert.equal(offSteps[1].metadata.modelUsage.inputTokens,'1200');
 assert.equal(offSteps[1].metadata.modelInfo.maxTokens,1000000);
 assert.equal(offSteps[1].metadata.sourceTrajectoryStepInfo.stepIndex,1);
 assert.deepEqual(offSteps[1].plannerResponse,{response:'1',toolCalls:[{}]});
 assert.equal(offSteps[2].metadata.toolCall,true);
 assert.equal(offSteps[2].metadata.toolCallOutputTokens,64);
 assert.equal(offSteps[2].metadata.modelInfo,undefined);
 assert.equal(offSteps[3].systemMessage,undefined);
 assert.deepEqual(offOut.update.mainTrajectoryUpdate.generatorMetadatasUpdate.generatorMetadatas[0].plannerConfig,{modelName:'gemini-3.8-flash-high'});

 const on=new TrajectoryJson({modelTimelineEnabled:true});
 on.write(JSON.stringify(rawUpdate));
 const onOut=on.end();
 const onStr=JSON.stringify(onOut);
 assert.equal(onStr.includes('SECRET'),false);
 const onSteps=onOut.update.mainTrajectoryUpdate.stepsUpdate.steps;
 assert.equal(onSteps[0].userInput.userConfig.plannerConfig.planModel,'MODEL_PLACEHOLDER_M668');
 assert.equal(onSteps[1].status,'CORTEX_STEP_STATUS_DONE');
 assert.deepEqual(onSteps[1].plannerResponse.toolCalls,[{name:'read_file',status:'DONE'}]);
 assert.deepEqual(onSteps[2].metadata.toolCall,{name:'run_command'});
 assert.deepEqual(onSteps[3].systemMessage,{eventType:'plan_mode_handoff'});
});
