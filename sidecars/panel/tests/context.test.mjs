import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextMetrics, safeContext, formatModelName, normalizeModelId, isOrchestratorModel, modelContextReference, modelContextCapacity, modelCompressionLimit } from '../context.mjs';
import { trajectoryMetrics } from '../metrics.mjs';
import { SessionHistory, safeMetrics } from '../history.mjs';
import { MetricsStore } from '../store.mjs';

const id='11111111-1111-1111-1111-111111111111',scope='a'.repeat(64);
const raw=(used,max=256000,n=1)=>({trajectory:{cascadeId:id,generatorMetadata:Array.from({length:n},(_,i)=>({chatModel:{modelDisplayName:'Model A',usage:{messageId:String(i),inputTokens:'100',responseOutputTokens:'100',apiProvider:'API_PROVIDER_GOOGLE_GEMINI'},streamingDuration:'2s',chatStartMetadata:{contextWindowMetadata:{estimatedTokensUsed:used,maxContextTokens:max,tokenBreakdown:{prompt:'DO NOT SAVE'}}}}}))}});

test('context is latest request estimate, never accumulated tokens; 0 and over-capacity remain honest',()=>{
  const result=trajectoryMetrics(raw(112000,256000,3));
  assert.equal(result.context.usedTokens,112000);assert.equal(result.context.usedFraction,.4375);
  assert.equal(result.context.remainingTokens,144000);
  assert.equal(contextMetrics({estimatedTokensUsed:0,maxContextTokens:100}).usedFraction,0);
  const over=contextMetrics({estimatedTokensUsed:120,maxContextTokens:100});
  assert.equal(over.usedFraction,1.2);assert.equal(over.remainingTokens,0);
});
test('missing, invalid and unsafe counters cannot produce invented capacities or percentages',()=>{
  for(const estimatedTokensUsed of [-1,Infinity,'wrong',true,{},Number.MAX_SAFE_INTEGER+1])assert.equal(contextMetrics({estimatedTokensUsed,maxContextTokens:100}),null);
  assert.equal(contextMetrics({maxContextTokens:100}),null);
  for(const maxContextTokens of [undefined,0,-1,Infinity,'',true]){
    const value=contextMetrics({estimatedTokensUsed:20,maxContextTokens});
    assert.equal(value.usedTokens,20);assert.equal(value.maxTokens,null);assert.equal(value.usedFraction,null);
  }
});
test('latest model with absent context cannot inherit prior-model capacity',()=>{
  const first=raw(40,100).trajectory.generatorMetadata[0];
  const data=trajectoryMetrics({trajectory:{generatorMetadata:[first,{chatModel:{modelDisplayName:'Model B'}}]}});
  assert.equal(data.context,null);
});
test('only numeric context and sampled model/time enter history; lower usage survives compaction and restart',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ag-context-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const history=new SessionHistory(directory);
  await history.save(scope,id,trajectoryMetrics(raw(80000,100000,3)));
  await history.save(scope,id,trajectoryMetrics(raw(20000,100000,1)));
  const restored=await new SessionHistory(directory).load(scope,id);
  assert.equal(restored.metrics.context.usedTokens,20000);assert.equal(restored.metrics.requests,3);
  const text=await readFile(history.file(scope,id),'utf8');assert.ok(!text.includes('DO NOT SAVE'));assert.ok(!text.includes('tokenBreakdown'));
  const clean=safeMetrics({...trajectoryMetrics(raw(20,100)),context:{usedTokens:20,maxTokens:100,usedFraction:999,credential:'secret'}},id);
  assert.equal(clean.context.usedFraction,.2);assert.ok(!JSON.stringify(clean).includes('secret'));
});
test('context-only records can persist while old v0.4 records without context still load',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ag-context-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const history=new SessionHistory(directory);
  const data=trajectoryMetrics({trajectory:{generatorMetadata:[{chatModel:{chatStartMetadata:{contextWindowMetadata:{estimatedTokensUsed:0,maxContextTokens:100}}}}]}});
  await history.save(scope,id,data);assert.equal((await history.load(scope,id)).metrics.context.usedFraction,0);
  const old=trajectoryMetrics(raw(20));delete old.context;await history.save(scope,id,old);
  assert.equal((await history.load(scope,id)).metrics.tps,50);
});
test('live lower context updates even when cumulative TPS history is protected',async()=>{
  let n=3,used=80;
  const history={load:async()=>null,save:async()=>({savedAt:'2026-10-09T00:00:00Z'})};
  const store=new MetricsStore({trajectory:async()=>raw(used,100,n)},{history});store.identity=scope;
  await store.session(id,true);n=1;used=20;
  const current=await store.session(id,true);
  assert.equal(current.requests,3);assert.equal(current.context.usedFraction,.2);assert.equal(current.contextRestored,false);
});

test('provider references never override a valid host capacity or infer compaction', () => {
  assert.equal(modelContextCapacity('gemini-3.8-flash-n'), 1048576);
  assert.equal(modelContextCapacity('Gemini 3.8 Flash (High)'), 1048576);
  assert.equal(modelContextReference('Claude Sonnet 5.5 (Thinking)').label, '1M');
  assert.equal(modelContextReference('Claude Sonnet 4.6 (Thinking)').label, '1M');
  assert.equal(modelContextCapacity('Claude Sonnet 5.5 (Thinking)'), null,'Do not invent an exact number from the inspected 1M label');
  assert.equal(modelContextCapacity('GPT-OSS 120B (Medium)'), 131072);
  assert.equal(modelContextCapacity('unknown-model'), null);

  for(const model of ['gemini-3.8-flash-n','MODEL_PLACEHOLDER_M318','claude-sonnet-5.5','claude-sonnet-4-6','gpt-oss-120b'])assert.equal(modelCompressionLimit(model),null);

  assert.equal(formatModelName('gemini-3.8-flash-n'), 'Gemini 3.8 Flash');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M318'), 'Gemini 3.8 Flash (High)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M319'), 'Gemini 3.8 Flash (Medium)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M320'), 'Gemini 3.8 Flash (Low)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M317'), 'MODEL_PLACEHOLDER_M317');

  const result = contextMetrics(
    { estimatedTokensUsed: 128000, maxContextTokens: 256000 },
    { model: 'gemini-3.8-flash-n' }
  );
  assert.equal(result.usedTokens, 128000);
  assert.equal(result.maxTokens, 256000);
  assert.equal(result.providerMaxTokens,1048576);
  assert.equal(result.capacitySource,'host-reported');
  assert.equal(result.compressionLimit,null);
  assert.equal(result.usedFraction,.5);
  assert.equal(result.compressionFraction,null);
  assert.equal(result.model, 'Gemini 3.8 Flash');
});
test('80% host occupancy stays 80% while the larger provider input reference is displayed separately',()=>{
 const result=contextMetrics({estimatedTokensUsed:80000,maxContextTokens:100000},{model:'Gemini 3.8 Flash (High)'});
 assert.equal(result.usedFraction,.8);assert.equal(result.remainingTokens,20000);assert.equal(result.providerMaxTokens,1048576);
});
test('equivalent model IDs normalize identically without changing versions or inventing effort',()=>{
 for(const family of ['sonnet','opus'])for(const version of ['4.6','5.5']){
  const dot=`claude-${family}-${version}`,dash=dot.replace('.', '-');
  assert.equal(formatModelName(dot),formatModelName(dash));assert.deepEqual(modelContextReference(dot),modelContextReference(dash));
  assert.equal(modelContextReference(dot).label,'1M');assert.ok(!formatModelName(dot).includes('Thinking'));
  assert.match(formatModelName(`Claude ${family} ${version} (Thinking)`),/\(Thinking\)$/);
 }
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M35'),'Claude Sonnet 4.6 (Thinking)');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M26'),'Claude Opus 4.6 (Thinking)');
 assert.equal(formatModelName('MODEL_OPENAI_GPT_OSS_120B_MEDIUM'),'GPT-OSS 120B (Medium)');
});
test('unknown/family/specialized model names never inherit another model reference',()=>{
 for(const model of ['Gemini','gemini-3.8-flash-tts','gemini-3.8-flash-lite','Claude','claude-sonnet-4-5','claude-sonnet-4','claude-sonnet-5-5-custom','gpt-oss','gpt-oss-20b','MODEL_PLACEHOLDER_M317','MODEL_PLACEHOLDER_M421','user-gemini-3.8-flash-custom']){
  assert.equal(modelContextReference(model),null,model);assert.equal(formatModelName(model),model);
 }
 for(const model of [undefined,null,123,'',' \n\t'])assert.equal(modelContextReference(model),null);
});
test('known provider capacity cannot fabricate a missing, zero or invalid host denominator',()=>{
 for(const maxContextTokens of [undefined,0,-1,Infinity,'',true,{},Number.MAX_SAFE_INTEGER+1]){
  const value=contextMetrics({estimatedTokensUsed:20,maxContextTokens},{model:'Gemini 3.8 Flash (High)'});
  assert.equal(value.maxTokens,null);assert.equal(value.usedFraction,null);assert.equal(value.providerMaxTokens,1048576);
 }
});
test('saved derived fields and arbitrary reference/threshold data are never trusted',()=>{
 const value=safeContext({usedTokens:80000,maxTokens:100000,model:'Gemini 3.8 Flash (High)',usedFraction:.01,remainingTokens:999999,
  providerMaxTokens:999999999,providerCapacityLabel:'PRIVATE',providerCapacitySource:'https://example.com/private',compressionLimit:200000,compressionFraction:4,credential:'secret',breakdown:{private:'PRIVATE'}});
 assert.equal(value.usedFraction,.8);assert.equal(value.remainingTokens,20000);assert.equal(value.providerMaxTokens,1048576);
 assert.equal(value.compressionLimit,null);assert.equal(value.compressionFraction,null);assert.ok(!JSON.stringify(value).includes('PRIVATE'));assert.ok(!JSON.stringify(value).includes('secret'));
 assert.equal(safeContext({usedTokens:Infinity,maxTokens:100}),null);
});
test('provider reference and unknown threshold survive numeric history round trips',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'ag-context-reference-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const history=new SessionHistory(directory),response=raw(128000,256000);
 response.trajectory.generatorMetadata[0].chatModel.modelDisplayName='Gemini 3.8 Flash (High)';
 await history.save(scope,id,trajectoryMetrics(response));const restored=(await history.load(scope,id)).metrics.context;
 assert.equal(restored.usedFraction,.5);assert.equal(restored.maxTokens,256000);assert.equal(restored.providerMaxTokens,1048576);assert.equal(restored.compressionLimit,null);
 const saved=JSON.parse(await readFile(history.file(scope,id),'utf8'));assert.equal(saved.metrics.context.providerCapacitySource,'https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash');
});
test('orchestrator, flash worker, and gemini 4/claude 5.5 host placeholders format cleanly',()=>{
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M668'),'Orchestrator (Argon)');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M669'),'Gemini Flash');
 assert.equal(formatModelName('gemini-pro-orchestrator-g1-pro'),'Orchestrator (Argon)');
 assert.equal(formatModelName('gemini-flash-worker-agy'),'Gemini Flash');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M417'),'Gemini 4 Argon (High)');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M525'),'Gemini 4 Hydrogen (High)');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M528'),'Gemini 4 Hydrogen (XHigh)');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M402'),'Claude Opus 5.5 (High)');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M405'),'Claude Sonnet 5.5 (High)');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M670'),'Gemini 4 Carbon');
 assert.equal(normalizeModelId('MODEL_PLACEHOLDER_M668'),'orchestrator-argon');
 assert.equal(normalizeModelId('Orchestrator (Argon)'),'orchestrator-argon');
 assert.equal(normalizeModelId('MODEL_PLACEHOLDER_M669'),'gemini-flash');
 assert.equal(isOrchestratorModel('MODEL_PLACEHOLDER_M668'),true);
 assert.equal(isOrchestratorModel('MODEL_PLACEHOLDER_M669'),false);
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M535'),'Gemini 4 Neon (XHigh)');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M533'),'Gemini 4 Neon (Medium)');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M537'),'Orchestrator (Neon)');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M198'),'Gemini 3.5 Flash Lite');
});

test('post-compaction checkpoint updates context immediately from dynamic session baseline and calibrates on next reply', () => {
 const mkGen = (idx, used, max = 512000, ts = '2026-11-21T12:00:00Z') => ({
  stepIndices: [idx],
  chatModel: {
   modelDisplayName: 'Gemini 4 Neon (XHigh)',
   usage: { messageId: `m-${idx}`, inputTokens: '100', responseOutputTokens: '100', apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' },
   streamingDuration: '1s',
   chatStartMetadata: { createdAt: ts, contextWindowMetadata: { estimatedTokensUsed: used, maxContextTokens: max } },
  },
 });

 // 1. 第 1 次 /compact 刚结束：最新步骤为 CHECKPOINT (idx=3)，最新 generator 仍为压缩前 (idx=2, 473760)
 //    动态采用当前会话首轮实测基线 (idx=1, 42000 —— 模拟重度 MCP 配置用户，零硬编码常数)
 const afterFirstCompact = trajectoryMetrics({
  trajectory: {
   cascadeId: id,
   steps: [
    { i: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
    { i: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' },
    { i: 2, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' },
    { i: 3, type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { completedAt: '2026-11-21T12:45:00Z' } },
   ],
   generatorMetadata: [mkGen(1, 42000), mkGen(2, 473760)],
  },
 });
 assert.equal(afterFirstCompact.context?.compacted, true);
 assert.equal(afterFirstCompact.context?.usedTokens, 42000);
 assert.equal(afterFirstCompact.context?.maxTokens, 512000);
 assert.equal(afterFirstCompact.context?.preCompactionUsedTokens, 473760);
 assert.equal(afterFirstCompact.context?.compactionCount, 1);

 // 2. 下一条回复落盘后 (idx=4, 51000)：立刻切回宿主精确值，解除 compacted 估算态，保留 compactionCount=1
 const afterNextReply = trajectoryMetrics({
  trajectory: {
   cascadeId: id,
   steps: [
    { i: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
    { i: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' },
    { i: 2, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' },
    { i: 3, type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { completedAt: '2026-11-21T12:45:00Z' } },
    { i: 4, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' },
   ],
   generatorMetadata: [mkGen(1, 42000), mkGen(2, 473760), mkGen(4, 51000)],
  },
 });
 assert.equal(afterNextReply.context?.compacted, undefined);
 assert.equal(afterNextReply.context?.usedTokens, 51000);
 assert.equal(afterNextReply.context?.compactionCount, 1);

 // 3. 第 2 次 /compact 刚结束 (idx=6)：优先复用第 1 次压缩后的真实首轮实测 (51000) 作为更贴合当前会话的基线
 const afterSecondCompact = trajectoryMetrics({
  trajectory: {
   cascadeId: id,
   steps: [
    { i: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
    { i: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' },
    { i: 2, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' },
    { i: 3, type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { completedAt: '2026-11-21T12:45:00Z' } },
    { i: 4, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' },
    { i: 5, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' },
    { i: 6, type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { completedAt: '2026-11-21T13:30:00Z' } },
   ],
   generatorMetadata: [mkGen(1, 42000), mkGen(2, 473760), mkGen(4, 51000), mkGen(5, 460000)],
  },
 });
 assert.equal(afterSecondCompact.context?.compacted, true);
 assert.equal(afterSecondCompact.context?.usedTokens, 51000);
 assert.equal(afterSecondCompact.context?.preCompactionUsedTokens, 460000);
 assert.equal(afterSecondCompact.context?.compactionCount, 2);

 // 4. safeContext 往返保留 compacted / preCompactionUsedTokens / compactionCount 并过滤多余脏字段
 const sanitized = safeContext({ ...afterSecondCompact.context, injected: 'bad' });
 assert.equal(sanitized?.compacted, true);
 assert.equal(sanitized?.preCompactionUsedTokens, 460000);
 assert.equal(sanitized?.compactionCount, 2);
 assert.ok(!JSON.stringify(sanitized).includes('injected'));
});
