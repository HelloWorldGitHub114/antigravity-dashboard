import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { trajectoryMetrics, seconds } from '../metrics.mjs';

const make = (id,tokens,duration,options={}) => ({stepIndices:options.tool?[0]:[],chatModel:{modelDisplayName:options.model||'Model A',
  usage:{messageId:id,responseOutputTokens:tokens,outputTokens:tokens,inputTokens:1000,cacheReadTokens:500,apiProvider:'API_PROVIDER_GOOGLE_GEMINI',...options.usage},
  streamingDuration:duration,timeToFirstToken:options.ttft??2,...options.chat}});
const result = generators => trajectoryMetrics({trajectory:{generatorMetadata:generators,steps:[{type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',plannerResponse:{toolCalls:[{}]}}]}});

test('real buffered-tool reproduction is quarantined; usage, cache and TTFT survive',()=>{
  const normal=make('normal',909,9.6352291),bad=make('buffered',17776,.349271,{tool:true,ttft:106.005289});
  const data=result([normal,bad]);
  assert.ok(Math.abs(data.tps-94.34129594282298)<1e-8);
  assert.equal(data.latestTps,null);assert.equal(data.latestRateStatus,'unreliable');
  assert.equal(data.measuredRequests,1);assert.equal(data.excludedTiming,1);
  assert.equal(data.timingReasons['short-tool-window'],1);
  assert.equal(data.counts.responseOutput,18685);assert.equal(data.cache.outputTokens,18685);
  assert.equal(data.cache.measuredRequests,2);assert.equal(data.ttftSeconds,54.0026445);
});
test('ordinary short text and genuinely sustained high throughput remain measurable',()=>{
  for(const sample of [make('text',27,.0797699,{ttft:4.0878562}),make('fast',30000,2),make('tool',68,.06,{tool:true,ttft:.1})]){
    const data=result([sample]);assert.equal(data.measuredRequests,1);assert.equal(data.excludedTiming,0);assert.ok(data.tps>0);
  }
});
test('five same-model normal samples identify a short outlier; different models cannot supply the baseline',()=>{
  const baseline=Array.from({length:5},(_,i)=>make('normal'+i,200,2));
  const data=result([...baseline,make('spike',1000,.01)]);
  assert.equal(data.tps,100);assert.equal(data.latestTps,null);assert.equal(data.timingReasons['short-outlier'],1);
  const other=result([...baseline,make('new-model',1000,.01,{model:'Model B'})]);
  assert.equal(other.excludedTiming,0);assert.equal(other.rateWarnings,1);
  const sustained=result([...baseline,make('fast',10000,2)]);
  assert.equal(sustained.excludedTiming,0);assert.equal(sustained.rateWarnings,1);assert.ok(sustained.latestTps>1000);
});
test('one attempt record is valid; differing multiple-attempt usage is not paired to a single duration',()=>{
  const single=make('single',100,2,{chat:{retryInfos:[{usage:{outputTokens:100,responseOutputTokens:100}}]}});
  assert.equal(result([single]).tps,50);
  const multi=make('retry',100,2,{chat:{retryInfos:[{usage:{outputTokens:80,responseOutputTokens:80}},{usage:{outputTokens:100,responseOutputTokens:100}}]}});
  const data=result([multi]);assert.equal(data.tps,null);assert.equal(data.counts.output,100);assert.equal(data.timingReasons['retry-scope'],1);
});
test('conflicting duplicate timing and inconsistent token scopes cannot poison TPS',()=>{
  const a=make('same',100,2),b=make('same',100,.001);
  const duplicate=result([a,b]);assert.equal(duplicate.requests,1);assert.equal(duplicate.tps,null);assert.equal(duplicate.counts.output,100);
  assert.equal(duplicate.timingReasons['duplicate-scope'],1);
  for(const usage of [{thinkingOutputTokens:200},{responseOutputTokens:'bad'},{responseOutputTokens:80,thinkingOutputTokens:40}]){
    const data=result([make('bad',100,2,{usage})]);assert.equal(data.tps,null);assert.equal(data.excludedTiming,1);
    assert.equal(data.timingReasons['token-scope'],1);
  }
});
test('latest missing timing never borrows the previous rate; malformed durations stay unknown',()=>{
  const data=result([make('normal',100,2),make('missing',100,undefined)]);
  assert.equal(data.latestTps,null);assert.equal(data.latestRateStatus,'missing');assert.equal(data.tps,50);
  for(const duration of [{},{seconds:2,nanos:-1},{seconds:2,nanos:1e9},'9'.repeat(400)+'s'])assert.equal(seconds(duration),null);
});
test('all rejected samples have no fabricated TPS; the UI keeps only the calculation basis',()=>{
  const data=result([make('tool',17776,.349271,{tool:true,ttft:106})]);assert.equal(data.tps,null);assert.equal(data.latestTps,null);
  assert.equal(data.rateBasis,'response');
  const i18n=createRequire(import.meta.url)('../../../compat/i18n.cjs');
  for(const locale of ['en','zh-CN']) assert.equal(i18n(locale).rateNote(data),i18n(locale).t('responseBasis'));
  assert.equal(i18n('zh-CN').rateNote({...data,latestRateStatus:'legacy'}),'等待重算');
});
test('sustained streamed thinking pairs full output with stream while partial thought splits quarantine',()=>{
  const streamed=trajectoryMetrics({trajectory:{generatorMetadata:[
    make('argon-long',2320,144.8640773,{ttft:10.5050548,usage:{outputTokens:13351,responseOutputTokens:2320,thinkingOutputTokens:11031}}),
  ],steps:[]}});
  assert.ok(Math.abs(streamed.tps-13351/144.8640773)<1e-6);
  assert.equal(streamed.rateBasis,'all-output');
  assert.equal(streamed.counts.responseOutput,2320);
  assert.equal(streamed.counts.thinkingOutput,11031);

  const zeroVis=trajectoryMetrics({trajectory:{generatorMetadata:[
    make('think-only',0,466.25,{ttft:10.53,usage:{outputTokens:26469,responseOutputTokens:0,thinkingOutputTokens:26469}}),
  ],steps:[]}});
  assert.ok(Math.abs(zeroVis.tps-26469/466.25)<1e-6);
  assert.equal(zeroVis.measuredRequests,1);

  const emptyZero=trajectoryMetrics({trajectory:{generatorMetadata:[
    make('empty',0,2,{usage:{outputTokens:0,responseOutputTokens:0,thinkingOutputTokens:0}}),
  ],steps:[]}});
  assert.equal(emptyZero.tps,null);
  assert.equal(emptyZero.measuredRequests,0);

  const split=trajectoryMetrics({trajectory:{generatorMetadata:[
    make('split',55,9.3611173,{tool:true,ttft:5.3568856,usage:{outputTokens:1647,responseOutputTokens:55,thinkingOutputTokens:1592}}),
  ],steps:[{type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',plannerResponse:{toolCalls:[{}]}}]}});
  assert.equal(split.tps,null);
  assert.equal(split.excludedTiming,1);
  assert.equal(split.timingReasons['token-scope'],1);
});
test('multi-second buffered tool flushes, preamble+tool bursts, two-sample spikes and trailing empty placeholders are handled cleanly',()=>{
  const steps=[
    {type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',plannerResponse:{toolCalls:[{}]}},
    {type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',plannerResponse:{response:'Reading file...',toolCalls:[{}]}},
  ];
  const bufferedMultiSec=make('big-tool',12789,1.57,{ttft:113.67,usage:{outputTokens:12872,responseOutputTokens:12789,thinkingOutputTokens:83}});
  bufferedMultiSec.stepIndices=[0];
  const preambleTool=make('preamble-tool',69,0.097,{ttft:4.9,usage:{outputTokens:76,responseOutputTokens:69,thinkingOutputTokens:7}});
  preambleTool.stepIndices=[1];
  const s1=make('s1',3524,28.39,{ttft:12.11,usage:{outputTokens:3524,responseOutputTokens:733,thinkingOutputTokens:2791}});
  const s2=make('s2',200,2,{ttft:2,usage:{outputTokens:240,responseOutputTokens:200,thinkingOutputTokens:40}});
  const shortBurst=make('burst',77,0.1,{ttft:7.01,usage:{outputTokens:210,responseOutputTokens:77,thinkingOutputTokens:133}});
  const trailingPlaceholder={chatModel:{usage:{}}};
  const data=trajectoryMetrics({trajectory:{generatorMetadata:[bufferedMultiSec,preambleTool,s1,s2,shortBurst,trailingPlaceholder],steps}});
  assert.equal(data.timingReasons['short-tool-window'],2);
  assert.equal(data.timingReasons['short-outlier'],1);
  assert.equal(data.measuredRequests,2);
  assert.equal(data.latestRateStatus,'unreliable');
  assert.equal(data.latestTps,null);

  const cleanEnd=trajectoryMetrics({trajectory:{generatorMetadata:[s1,s2,trailingPlaceholder],steps}});
  assert.equal(cleanEnd.latestRateStatus,'ok');
  assert.equal(cleanEnd.latestTps,100);
});

test('active generating requests retain latest completed request metrics while running, and settle upon completion',()=>{
  const steps=[
    {type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',plannerResponse:{toolCalls:[{}]}},
    {type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',metadata:{startedAt:'2026-11-11T05:30:00.000Z'}},
  ];
  const toolStep=make('tool-call',69,0.097,{ttft:4.9,tool:true,usage:{outputTokens:76,responseOutputTokens:69,thinkingOutputTokens:7}});
  toolStep.stepIndices=[0];
  const goodStep=make('prior-good',200,2,{ttft:2,usage:{outputTokens:240,responseOutputTokens:200,thinkingOutputTokens:40}});
  goodStep.stepIndices=[0];
  const inFlightStep={stepIndices:[1],chatModel:{
    chatStartMetadata:{createdAt:'2026-11-11T05:30:00.000Z'},
    timeToFirstToken:2.0,
    usage:{outputTokens:150,responseOutputTokens:150},
  }};

  const runningWithPriorGood=trajectoryMetrics({
    status:'CASCADE_RUN_STATUS_RUNNING',
    now:Date.parse('2026-11-11T05:30:05.000Z'),
    trajectory:{generatorMetadata:[goodStep,inFlightStep],steps},
  });
  assert.equal(runningWithPriorGood.latestRateStatus,'ok');
  assert.equal(runningWithPriorGood.latestTps,100);

  const runningWithPriorTool=trajectoryMetrics({
    status:'CASCADE_RUN_STATUS_RUNNING',
    now:Date.parse('2026-11-11T05:30:05.000Z'),
    trajectory:{generatorMetadata:[toolStep,inFlightStep],steps},
  });
  assert.equal(runningWithPriorTool.latestRateStatus,'unreliable');
  assert.equal(runningWithPriorTool.latestTps,null);

  const runningFresh=trajectoryMetrics({
    status:'CASCADE_RUN_STATUS_RUNNING',
    trajectory:{generatorMetadata:[inFlightStep],steps},
  });
  assert.equal(runningFresh.latestRateStatus,'missing');
  assert.equal(runningFresh.latestTps,null);

  const settled=trajectoryMetrics({
    status:'CASCADE_RUN_STATUS_IDLE',
    trajectory:{generatorMetadata:[toolStep],steps},
  });
  assert.equal(settled.latestRateStatus,'unreliable');
  assert.equal(settled.timingReasons['short-tool-window'],1);

  const i18n=createRequire(import.meta.url)('../../../compat/i18n.cjs');
  assert.ok(i18n('zh-CN').rateNote(runningFresh).includes('生成中'));
  assert.ok(i18n('en').rateNote(runningFresh).includes('Generating'));
  assert.ok(!i18n('zh-CN').rateNote(settled).includes('生成中'));
});

test('multi-round runs update latest TPS correctly and suppress false tool-window anomalies while running',()=>{
  const steps=[
    {type:'USER_INPUT'},
    {type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE'},
    {type:'USER_INPUT'},
    {type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',plannerResponse:{toolCalls:[{}]}},
    {type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE'},
    {type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',metadata:{startedAt:'2026-11-11T05:31:00.000Z'}},
  ];

  const round1Good=make('r1-good',200,2,{ttft:2,usage:{outputTokens:200,responseOutputTokens:200}});
  round1Good.stepIndices=[1];

  const round2Tool=make('r2-tool',69,0.097,{ttft:4.9,tool:true,usage:{outputTokens:76,responseOutputTokens:69,thinkingOutputTokens:7}});
  round2Tool.stepIndices=[3];

  const round2Good=make('r2-good',300,2,{ttft:2,usage:{outputTokens:300,responseOutputTokens:300}});
  round2Good.stepIndices=[4];

  const inFlightStep={
    stepIndices:[5],
    chatModel:{
      chatStartMetadata:{createdAt:'2026-11-11T05:31:00.000Z'},
      timeToFirstToken:2.0,
      usage:{outputTokens:150,responseOutputTokens:150},
    },
  };

  // 1. Turn 1 running with in-flight generator: USER_INPUT at step 0 must not exclude round1Good
  const turn1Running=trajectoryMetrics({
    status:'CASCADE_RUN_STATUS_RUNNING',
    trajectory:{generatorMetadata:[round1Good,inFlightStep],steps:steps.slice(0,2)},
  });
  assert.equal(turn1Running.latestRateStatus,'ok');
  assert.equal(turn1Running.latestTps,100);

  // 2. Turn 2 running: intermediate tool call is quarantined, does not cause false anomaly flickering while next step is generating
  const turn2RunningAfterTool=trajectoryMetrics({
    status:'CASCADE_RUN_STATUS_RUNNING',
    trajectory:{generatorMetadata:[round1Good,round2Tool,inFlightStep],steps},
  });
  assert.equal(turn2RunningAfterTool.latestRateStatus,'ok');
  assert.equal(turn2RunningAfterTool.latestTps,100);

  // 3. Turn 2 running: once a valid step completes in Turn 2, latest updates to Turn 2's rate rather than remaining locked to Turn 1
  const turn2RunningAfterGood=trajectoryMetrics({
    status:'CASCADE_RUN_STATUS_RUNNING',
    trajectory:{generatorMetadata:[round1Good,round2Tool,round2Good,inFlightStep],steps},
  });
  assert.equal(turn2RunningAfterGood.latestRateStatus,'ok');
  assert.equal(turn2RunningAfterGood.latestTps,150);

  // 4. Turn 2 settled: settles with Turn 2's rate
  const turn2Settled=trajectoryMetrics({
    status:'CASCADE_RUN_STATUS_IDLE',
    trajectory:{generatorMetadata:[round1Good,round2Tool,round2Good],steps},
  });
  assert.equal(turn2Settled.latestRateStatus,'ok');
  assert.equal(turn2Settled.latestTps,150);

  // 5. Settled on tool call: when settled, the final request status (unreliable) is preserved honestly
  const settledOnTool=trajectoryMetrics({
    status:'CASCADE_RUN_STATUS_IDLE',
    trajectory:{generatorMetadata:[round1Good,round2Tool],steps},
  });
  assert.equal(settledOnTool.latestRateStatus,'unreliable');
  assert.equal(settledOnTool.latestTps,null);

  // 6. In-flight generator before usage stats arrive: retains latest settled rate instead of slicing completed samples
  const inFlightNoUsage={
    stepIndices:[5],
    chatModel:{
      chatStartMetadata:{createdAt:'2026-11-11T05:31:00.000Z'},
    },
  };
  const turn1RunningNoUsage=trajectoryMetrics({
    status:'CASCADE_RUN_STATUS_RUNNING',
    trajectory:{generatorMetadata:[round1Good,inFlightNoUsage],steps:steps.slice(0,2)},
  });
  assert.equal(turn1RunningNoUsage.latestRateStatus,'ok');
  assert.equal(turn1RunningNoUsage.latestTps,100);

  const turn2RunningNoUsage=trajectoryMetrics({
    status:'CASCADE_RUN_STATUS_RUNNING',
    trajectory:{generatorMetadata:[round1Good,round2Tool,round2Good,inFlightNoUsage],steps},
  });
  assert.equal(turn2RunningNoUsage.latestRateStatus,'ok');
  assert.equal(turn2RunningNoUsage.latestTps,150);

  const freshRunningNoUsage=trajectoryMetrics({
    status:'CASCADE_RUN_STATUS_RUNNING',
    trajectory:{generatorMetadata:[inFlightNoUsage],steps:steps.slice(0,2)},
  });
  assert.equal(freshRunningNoUsage.latestRateStatus,'missing');
  assert.equal(freshRunningNoUsage.latestTps,null);
});
