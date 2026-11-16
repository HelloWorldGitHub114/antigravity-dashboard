import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {UsageLedger,DesktopUsage,usageRecords,dateKey} from '../usage.mjs';
import {MetricsStore} from '../store.mjs';
const scope=s=>createHash('sha256').update(s).digest('hex'),account=scope('account A');
const id='11111111-1111-1111-1111-111111111111',other='22222222-2222-2222-2222-222222222222';
const raw=(options={})=>({trajectory:{steps:[{type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',metadata:{createdAt:'2026-10-10T16:05:00Z',...options.metadata}}],generatorMetadata:[{stepIndices:[0],chatModel:{modelDisplayName:options.model||'Gemini 3.8',...(options.start?{chatStartMetadata:{createdAt:options.start}}:{}),usage:{apiProvider:'API_PROVIDER_GOOGLE_GEMINI',responseId:'private-request-id',inputTokens:'100',cacheReadTokens:'900',cacheWriteTokens:'20',outputTokens:'80',thinkingOutputTokens:'30',...options.usage}}}]}});
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'ag-usage-'));t.after(()=>rm(dir,{recursive:true,force:true}));return new UsageLedger(dir);}
test('usage survives restart, upserts, and deduplicates across conversations',async t=>{
 const ledger=await fixture(t);await Promise.all([ledger.ingest(account,id,raw()),ledger.ingest(account,id,raw())]);
 await ledger.ingest(account,other,raw());let summary=await new UsageLedger(ledger.directory).summary(account,Date.parse('2026-10-11T02:00:00Z'));
 assert.equal(summary.totalTokens,1100);assert.equal(summary.requests,1);assert.equal(summary.todayTokens,1100);
 await ledger.ingest(account,id,raw({usage:{outputTokens:100}}));summary=await ledger.summary(account);assert.equal(summary.totalTokens,1120);
 await ledger.ingest(account,id,{trajectory:{generatorMetadata:[]}});assert.equal((await ledger.summary(account)).totalTokens,1120);
 const content=await readFile(ledger.file(account,id),'utf8');assert.equal(content.includes('private-request-id'),false);assert.equal(content.includes(id),false);
 assert.equal((await ledger.summary(scope('other'))).totalTokens,0);assert.throws(()=>ledger.file(account,'../escape'));
});
test('request time wins, planner-created is fallback, and unknown dates stay out of today',async t=>{
 assert.equal(dateKey(Date.parse('2026-10-10T16:05:00Z')),'2026-10-11');
 assert.equal(usageRecords(raw(),id)[0].timeBasis,'planner-created');
 const start=usageRecords(raw({start:'2026-10-10T15:59:59Z'}),id)[0];assert.equal(dateKey(start.at),'2026-10-10');assert.equal(start.timeBasis,'request-start');
 const ledger=await fixture(t);await ledger.ingest(account,id,raw({metadata:{createdAt:undefined}}));
 const summary=await ledger.summary(account,Date.parse('2026-10-11T02:00:00Z'));assert.equal(summary.unknownTokens,1100);assert.equal(summary.unknownRequests,1);assert.equal(summary.todayTokens,0);assert.equal(summary.totalTokens,1100);
 await ledger.ingest(account,id,raw());assert.equal((await ledger.summary(account)).unknownRequests,0);
});
test('thinking is included once, anomalous TPS is irrelevant, partial fields do not destroy known counts',async t=>{
 const r=usageRecords(raw(),id)[0];assert.equal(r.output,80);assert.equal(r.uncached+r.cacheRead+r.cacheWrite+r.output,1100);
 const ledger=await fixture(t);await ledger.ingest(account,id,raw());await ledger.ingest(account,id,raw({usage:{outputTokens:'invalid'}}));
 const summary=await ledger.summary(account);assert.equal(summary.totalTokens,1100);assert.equal(summary.partialRequests,1);
 const invalid=raw({usage:{inputTokens:'bad',cacheReadTokens:'bad',outputTokens:'50'}});assert.equal(usageRecords(invalid,id)[0].partial,true);
});
test('weekly/monthly buckets use the configured calendar, unreadable records are reported',async t=>{
 const ledger=await fixture(t);await ledger.ingest(account,id,raw({start:'2026-09-30T16:00:00Z'}));
 await ledger.ingest(account,other,raw({usage:{responseId:'request-two'},start:'2026-10-11T00:00:00Z'}));
 let summary=await ledger.summary(account,Date.parse('2026-10-11T08:00:00Z'));assert.equal(summary.monthTokens,2200);assert.equal(summary.weekTokens,1100);
 await writeFile(ledger.file(account,other),'{broken');summary=await new UsageLedger(ledger.directory).summary(account);assert.equal(summary.unreadableFiles,1);
});
test('backfill refreshes changed trajectories and isolates an account change in flight',async t=>{
 const ledger=await fixture(t);let calls=0,release;const store={identity:account,epoch:1,listConversations:async()=>[{id,modifiedAt:'one',status:'DONE'}],client:{trajectory:async()=>{calls++;return raw();}}};
 const tracker=new DesktopUsage(store,ledger);await tracker.sync();await tracker.sync();assert.equal(calls,1);assert.equal((await tracker.snapshot()).totalTokens,1100);
 store.listConversations=async()=>[{id:other,modifiedAt:'two',status:'DONE'}];let started;const waitStart=new Promise(r=>{started=r;});store.client.trajectory=()=>{started();return new Promise(r=>{release=r;});};
 const pending=tracker.sync();await waitStart;store.identity=scope('B');store.epoch++;release(raw());await pending;
 assert.equal((await ledger.summary(store.identity)).totalTokens,0);
});
test('MetricsStore forwards authenticated raw records and preserves live speed on ledger failure',async()=>{
 const history={load:async()=>null,save:async()=>null};let scopeSeen=null;
 const client={discover:async()=>({pid:1}),call:async name=>name==='GetUserStatus'?{userStatus:{email:'fixture@example.test'}}:{},trajectory:async()=>raw()};
 const store=new MetricsStore(client,{history,onTrajectory:async s=>{scopeSeen=s;throw Error('disk unavailable');}});const result=await store.snapshot({conversationId:id});
 assert.equal(scopeSeen,scope('fixture@example.test'));assert.equal(store.usagePersistenceError,true);assert.equal(result.speed.counts.input,100);
 store.onTrajectory=async()=>{};await store.snapshot({conversationId:id,force:true});assert.equal(store.usagePersistenceError,false);
});
test('IDE usage keeps a separate ledger and source across collector restarts',async t=>{
 const desktop=await fixture(t),ide=new UsageLedger(join(desktop.directory,'ide'),{source:'ide-local'});
 const store={identity:account,epoch:1,listConversations:async()=>[{id,modifiedAt:'one',status:'DONE'}],client:{trajectory:async()=>raw()}};
 const tracker=new DesktopUsage(store,ide);await tracker.sync();assert.equal((await tracker.snapshot()).source,'ide-local');assert.equal((await tracker.snapshot()).totalTokens,1100);
 assert.equal((await desktop.summary(account)).totalTokens,0);
 const restarted=new DesktopUsage(store,new UsageLedger(ide.directory,{source:'ide-local'}));await restarted.sync();assert.equal((await restarted.snapshot()).totalTokens,1100);assert.equal((await restarted.snapshot()).requests,1);
});
test('MetricsStore retains WeakRefs in entry.rawWeak and ancestorRaws without entry.rawRef and hits sameRaw fast path',async()=>{
 const history={load:async()=>null,save:async()=>null};
 const currentRaw=raw();
 const ancestorRaw=raw({usage:{responseId:'ancestor-req',outputTokens:'120'}});
 const entries=new Map([[id,{data:currentRaw,rev:1}],[other,{data:ancestorRaw,rev:1}]]);
 let onTrajectoryCalls=0,trajectoryCalls=0;
 const client={
  discover:async()=>({pid:1}),
  call:async name=>name==='GetUserStatus'?{userStatus:{email:'weakref@example.test'}}:{},
  reader:{entries},
  trajectory:async tid=>{trajectoryCalls++;return tid===other?ancestorRaw:currentRaw;}
 };
 const store=new MetricsStore(client,{history,timelineStore:null,onTrajectory:async()=>{onTrajectoryCalls++;}});
 await store.snapshot({conversationId:id});
 const entry=store.sessions.get(id);
 assert.equal('rawRef' in entry,false);
 assert.equal(entry.rawWeak instanceof WeakRef,true);
 assert.equal(entry.rawWeak.deref(),currentRaw);
 assert.equal(onTrajectoryCalls,1);
 assert.equal(trajectoryCalls,1);

 entry.updatedAt=0;
 const fast=await store.session(id);
 assert.equal(trajectoryCalls,2);
 assert.equal(onTrajectoryCalls,1);
 assert.equal(fast.counts.input,100);

 await store.snapshot({conversationId:other});
 const ancestorEntry=store.sessions.get(other);
 assert.equal('rawRef' in ancestorEntry,false);
 assert.equal(ancestorEntry.rawWeak instanceof WeakRef,true);
 ancestorEntry.rawWeak=null;
 store.refreshAncestorUsage(store.identity,store.epoch,other,null,false);
 const pending=store.ancestorPending.get(`${store.identity}:${other}`);
 assert.ok(pending);
 await pending;
 const weakAncestor=store.ancestorRaws.get(`${store.identity}:${other}`);
 assert.equal(weakAncestor instanceof WeakRef,true);
 assert.equal(weakAncestor.deref(),ancestorRaw);
 assert.equal('rawRef' in ancestorEntry,false);
 assert.equal(ancestorEntry.rawWeak instanceof WeakRef,true);
 assert.equal(ancestorEntry.rawWeak.deref(),ancestorRaw);
});

test('incremental summary avoids re-reading unchanged files while detecting updates, deletions, corruptions, timezone/rollover, and ownership changes',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ag-usage-inc-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const reads=[];
 const ledger=new UsageLedger(dir,{
  knownAccounts:{},
  fs:{
   readFile:async(p,...args)=>{reads.push(p);return await readFile(p,...args);}
  }
 });
 const accountB=scope('account B');
 const conv3='33333333-3333-3333-3333-333333333333';
 const day1=Date.parse('2026-10-11T02:00:00Z');
 const day2=Date.parse('2026-10-12T02:00:00Z');
 await ledger.ingest(account,id,raw({usage:{responseId:'r-1',inputTokens:'100',cacheReadTokens:'0',cacheWriteTokens:'0',outputTokens:'50'}}));
 await ledger.ingest(account,other,raw({usage:{responseId:'r-2',inputTokens:'200',cacheReadTokens:'0',cacheWriteTokens:'0',outputTokens:'50'}}));
 await ledger.ingest(accountB,conv3,raw({usage:{responseId:'r-3',inputTokens:'300',cacheReadTokens:'0',cacheWriteTokens:'0',outputTokens:'50'}}));

 reads.length=0;
 let sumA=await ledger.summary(account,day1);
 assert.equal(sumA.totalTokens,400);
 const ledgerReads=()=>reads.filter(p=>/[a-f0-9]{64}\.json$/.test(p));
 assert.equal(ledgerReads().length,0);

 // Cold ledger instance reads all 3 files once, then 0 on subsequent calls.
 const coldReads=[];
 const cold=new UsageLedger(dir,{
  knownAccounts:{},
  fs:{readFile:async(p,...args)=>{coldReads.push(p);return await readFile(p,...args);}}
 });
 const coldLedgerReads=()=>coldReads.filter(p=>/[a-f0-9]{64}\.json$/.test(p));
 assert.equal((await cold.summary(account,day1)).totalTokens,400);
 assert.equal(coldLedgerReads().length,3);

 coldReads.length=0;
 assert.equal((await cold.summary(account,day1)).totalTokens,400);
 assert.equal(coldLedgerReads().length,0);

 // Same-tick, same-size rewrite via ingestRows updates index directly without re-reading or re-parsing on summary().
 await ledger.ingest(account,id,raw({usage:{responseId:'r-1',inputTokens:'123',cacheReadTokens:'0',cacheWriteTokens:'0',outputTokens:'50'}}));
 reads.length=0;
 const origParse=JSON.parse;
 let parseCalls=0;
 JSON.parse=(...args)=>{parseCalls++;return origParse(...args);};
 t.after(()=>{JSON.parse=origParse;});
 try{
  sumA=await ledger.summary(account,day1);
  assert.equal(sumA.totalTokens,423);
  assert.equal(ledgerReads().length,0);
  assert.equal(parseCalls,0);
 }finally{
  JSON.parse=origParse;
 }

 // External file modification is detected and ONLY the changed file is re-read.
 const externalDoc=JSON.parse(await readFile(ledger.file(account,other),'utf8'));
 externalDoc.records[0].output=150;
 await new Promise(r=>setTimeout(r,20));
 await writeFile(ledger.file(account,other),JSON.stringify(externalDoc));
 reads.length=0;
 parseCalls=0;
 JSON.parse=(...args)=>{parseCalls++;return origParse(...args);};
 try{
  sumA=await ledger.summary(account,day1);
  assert.equal(sumA.totalTokens,523);
  assert.deepEqual(ledgerReads(),[ledger.file(account,other)]);
  assert.equal(parseCalls,1);
 }finally{
  JSON.parse=origParse;
 }

 // Corrupt file on disk is reported once and cached until repaired.
 await new Promise(r=>setTimeout(r,20));
 await writeFile(ledger.file(account,other),'{broken');
 reads.length=0;
 sumA=await ledger.summary(account,day1);
 assert.equal(sumA.unreadableFiles,1);
 assert.equal(sumA.totalTokens,173);
 assert.deepEqual(ledgerReads(),[ledger.file(account,other)]);
 reads.length=0;
 assert.equal((await ledger.summary(account,day1)).unreadableFiles,1);
 assert.equal(ledgerReads().length,0);

 // Repairing the file is detected without re-reading unchanged files.
 await new Promise(r=>setTimeout(r,20));
 await writeFile(ledger.file(account,other),JSON.stringify(externalDoc));
 reads.length=0;
 sumA=await ledger.summary(account,day1);
 assert.equal(sumA.unreadableFiles,0);
 assert.equal(sumA.totalTokens,523);
 assert.deepEqual(ledgerReads(),[ledger.file(account,other)]);

 // External deletion is detected without re-reading remaining files.
 await unlink(ledger.file(account,other));
 reads.length=0;
 sumA=await ledger.summary(account,day1);
 assert.equal(sumA.totalTokens,173);
 assert.equal(ledgerReads().length,0);

 // Manual usage add & delete invalidate/update incremental state cleanly.
 reads.length=0;
 const manual=await ledger.addManualUsage(account,{id:'manual-inc-1',timestamp:day1,prompt:80,output:20,model:'Manual'});
 assert.equal((await ledger.summary(account,day1)).totalTokens,273);
 assert.equal(ledgerReads().length,0);
 assert.equal(await ledger.deleteManualUsage(account,manual.id),true);
 assert.equal((await ledger.summary(account,day1)).totalTokens,173);
 assert.equal(ledgerReads().length,0);

 // Timezone & day rollover recompute buckets without re-reading <sha256>.json files.
 reads.length=0;
 const nextDay=await ledger.summary(account,day2);
 assert.equal(nextDay.today,'2026-10-12');
 assert.equal(nextDay.todayTokens,0);
 assert.equal(nextDay.totalTokens,173);
 ledger.timeZone='UTC';
 const utcDay=await ledger.summary(account,Date.parse('2026-10-10T23:30:00Z'));
 assert.equal(utcDay.today,'2026-10-10');
 assert.equal(utcDay.todayTokens,173);
 assert.equal(ledgerReads().length,0);

 // Cross-account duplicate + registerOwnership + registerAccount update without re-reading ledger files.
 await ledger.ingest(accountB,id,raw({usage:{responseId:'r-1',inputTokens:'123',cacheReadTokens:'0',cacheWriteTokens:'0',outputTokens:'50'}}));
 await ledger.registerOwnership(id,accountB,{overwrite:true});
 reads.length=0;
 assert.equal((await ledger.summary(account,day1)).totalTokens,0);
 assert.equal((await ledger.summary(accountB,day1)).totalTokens,523);
 await ledger.registerAccount(accountB,{email:'b@example.test',primary:true});
 const allAfter=await ledger.summary('all',day1);
 assert.equal(allAfter.userMeta[accountB].email,'b@example.test');
 assert.equal(ledgerReads().length,0);
});

test('read operations (summary/getAccounts) are not head-of-line blocked by in-flight writes while writes stay serialized',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ag-usage-sched-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 let releaseWrite,enteredFirstWrite;
 const firstWriteEntered=new Promise(r=>{enteredFirstWrite=r;});
 const writeOrder=[];
 const ledger=new UsageLedger(dir,{
  knownAccounts:{},
  fs:{
   writeFile:async(p,data,...args)=>{
    writeOrder.push(p);
    if(writeOrder.length===1){
     enteredFirstWrite();
     await new Promise(r=>{releaseWrite=r;});
    }
    return await writeFile(p,data,...args);
   }
  }
 });

 const seed=new UsageLedger(dir,{knownAccounts:{}});
 await seed.ingest(account,id,raw());
 assert.equal((await ledger.summary(account)).totalTokens,1100);

 // Launch slow write (saveBackfillState) and second queued write (ingestRows).
 const firstWrite=ledger.saveBackfillState(account,'app',{});
 await firstWriteEntered;
 const secondWrite=ledger.ingest(account,other,raw({usage:{responseId:'queued-req',inputTokens:'50',cacheReadTokens:'0',cacheWriteTokens:'0',outputTokens:'50'}}));

 // summary() and getAccounts() must complete while firstWrite is still blocked.
 const readSummary=await Promise.race([
  ledger.summary(account),
  new Promise((_,rej)=>setTimeout(()=>rej(Error('summary head-of-line blocked')),500))
 ]);
 const readAccounts=await Promise.race([
  ledger.getAccounts(account),
  new Promise((_,rej)=>setTimeout(()=>rej(Error('getAccounts head-of-line blocked')),500))
 ]);
 assert.equal(readSummary.totalTokens,1100);
 assert.ok(readAccounts.some(a=>a.id===account));
 // Verify secondWrite did NOT run before firstWrite released.
 assert.equal(writeOrder.length,1);

 releaseWrite();
 await Promise.all([firstWrite,secondWrite]);
 assert.equal(writeOrder.length,2);
 assert.equal((await ledger.summary(account)).totalTokens,1200);
});
