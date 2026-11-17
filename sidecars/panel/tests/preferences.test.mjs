import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {PreferencesStore} from '../../../compat/preferences.mjs';
const create=createRequire(import.meta.url)('../../../compat/i18n.cjs');
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'pulse-preferences-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=join(directory,'preferences.json');return {directory,file,store:new PreferencesStore({file})};
}
const connect=(language,store,extra={})=>language.connectPreferences({read:()=>store.get(),write:input=>store.set(input),...extra});

test('guide dismissal survives a fresh backend without selecting a language; older preference files migrate',async t=>{
  const {file,store}=await fixture(t);
  await store.set({languageGuideDismissed:true});
  assert.deepEqual((await new PreferencesStore({file}).get()).language,null);
  assert.equal((await store.get()).languageGuideDismissed,true);
  await writeFile(file,JSON.stringify({schema:1,language:'zh-CN',revision:1}));
  assert.equal((await store.get()).languageGuideDismissed,false);
  await Promise.all([store.set({languageGuideDismissed:true}),store.set({language:'en'})]);
  assert.equal((await store.get()).language,'en');assert.equal((await store.get()).languageGuideDismissed,true);
  await assert.rejects(store.set({languageGuideDismissed:false}));
});

test('Chinese and English survive a new backend and a renderer with empty origin storage',async t=>{
  const {file,store}=await fixture(t);assert.deepEqual(await store.get(),{language:null,languageGuideDismissed:false,usageGuideDismissed:false,modelTimelineEnabled:false,usageFontScale:1,sidebarFontScale:1,inlineFontScale:1,revision:0});
  const first=create(null),controller=connect(first,store);await controller.ready;await controller.toggle();
  assert.equal(first.language,'zh-CN');controller.dispose();
  const afterRestart=create(null),restored=connect(afterRestart,new PreferencesStore({file}));await restored.ready;
  assert.equal(afterRestart.language,'zh-CN');await restored.toggle();restored.dispose();
  const again=create(null);await connect(again,new PreferencesStore({file})).ready;assert.equal(again.language,'en');
  const json=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(Object.keys(json).sort(),['inlineFontScale','language','languageGuideDismissed','modelTimelineEnabled','revision','schema','sidebarFontScale','usageFontScale','usageGuideDismissed']);
});

test('usage onboarding completion persists independently of language and language onboarding',async t=>{
  const {file,store}=await fixture(t);
  await writeFile(file,JSON.stringify({schema:1,language:'zh-CN',languageGuideDismissed:true,revision:1}));
  assert.equal((await store.get()).usageGuideDismissed,false,'Existing users also receive the new usage explanation');
  await store.set({usageGuideDismissed:true});await store.set({language:'en'});
  const saved=await new PreferencesStore({file}).get();assert.equal(saved.usageGuideDismissed,true);assert.equal(saved.languageGuideDismissed,true);assert.equal(saved.language,'en');
  await assert.rejects(store.set({usageGuideDismissed:false}));await assert.rejects(store.set({usageGuideDismissed:'true'}));
  const fresh=await fixture(t);await fresh.store.set({usageGuideDismissed:true});const first=await fresh.store.get();assert.equal(first.language,null);assert.equal(first.languageGuideDismissed,false);
});

test('existing browser choice migrates once; durable preference overrides stale browser storage',async t=>{
  const {store}=await fixture(t);const old=create('zh-CN');await connect(old,store).ready;
  assert.equal((await store.get()).language,'zh-CN');await store.set({language:'en'});
  const stale=create('zh-CN');await connect(stale,store).ready;assert.equal(stale.language,'en');
});

test('atomic rapid writes persist the final choice and reject unrecognized values/keys',async t=>{
  const {store,directory}=await fixture(t);
  const values=await Promise.all(['zh-CN','en','zh-CN'].map(language=>store.set({language})));
  assert.ok(values[0].revision<values[1].revision&&values[1].revision<values[2].revision);
  for(const input of [{language:'zh'},{language:'../../other'},{language:'en',file:'other'},null,[]])await assert.rejects(store.set(input));
  assert.equal((await store.get()).language,'zh-CN');assert.deepEqual(await readdir(directory),['preferences.json']);
});

test('invalid files surface errors; failed replacement leaves the existing target intact',async t=>{
  const {store,file,directory}=await fixture(t);await writeFile(file,'not JSON');await assert.rejects(store.get());
  assert.ok((await store.snapshot()).error);assert.equal(await readFile(file,'utf8'),'not JSON');
  await store.set({language:'zh-CN'});assert.equal((await store.get()).language,'zh-CN');
  const blocked=join(directory,'blocked.json');await mkdir(blocked);const failed=new PreferencesStore({file:blocked});
  await assert.rejects(failed.set({language:'en'}));assert.deepEqual(await readdir(blocked),[]);
  assert.equal((await readdir(directory)).some(name=>name.endsWith('.tmp')),false);
});

test('a delayed startup read and stale polling response cannot undo a newer selection',async()=>{
  let resolve;const language=create(null);const pending=new Promise(done=>resolve=done);
  const controller=language.connectPreferences({read:()=>pending,write:async()=>({language:'zh-CN',revision:20})});
  await controller.choose('zh-CN');resolve({language:'en',revision:1});await controller.ready;
  controller.sync({language:'en',revision:1});assert.equal(language.language,'zh-CN');
  controller.sync({language:'en',revision:21});assert.equal(language.language,'en');controller.dispose();
});

test('rapid renderer toggles serialize writes; failed save is visible and can be retried',async()=>{
  let saved=null,revision=0,fail=false;const writes=[];const language=create(null);
  const controller=language.connectPreferences({read:async()=>({language:saved,revision}),cache:()=>{throw new Error('Storage blocked');},write:async input=>{
    await new Promise(resolve=>setTimeout(resolve,5));if(fail)throw new Error('Disk unavailable');
    saved=input.language;writes.push(saved);return {language:saved,revision:++revision};
  }});await controller.ready;
  const first=controller.toggle(),second=controller.toggle(),third=controller.toggle();
  controller.sync({language:'en',revision:100});await Promise.all([first,second,third]);
  assert.deepEqual(writes,['zh-CN','en','zh-CN']);assert.equal(saved,'zh-CN');assert.equal(language.language,'zh-CN');
  fail=true;await controller.choose('en');assert.equal(language.language,'en');assert.equal(controller.error,true);assert.equal(saved,'zh-CN');
  controller.sync({language:saved,revision});assert.equal(language.language,'en');assert.equal(controller.error,true);
  fail=false;await controller.choose('en');assert.equal(controller.error,false);assert.equal(saved,'en');
});

test('modelTimelineEnabled defaults false, toggles boolean cleanly, and rejects non-boolean values',async t=>{
  const {file,store}=await fixture(t);
  await writeFile(file,JSON.stringify({schema:1,language:'zh-CN',languageGuideDismissed:true,usageGuideDismissed:true,revision:1}));
  const migrated=await store.get();
  assert.equal(migrated.modelTimelineEnabled,false);
  const enabled=await store.set({modelTimelineEnabled:true});
  assert.deepEqual({language:enabled.language,languageGuideDismissed:enabled.languageGuideDismissed,usageGuideDismissed:enabled.usageGuideDismissed,modelTimelineEnabled:enabled.modelTimelineEnabled},
    {language:'zh-CN',languageGuideDismissed:true,usageGuideDismissed:true,modelTimelineEnabled:true});
  const langUpdate=await store.set({language:'en'});
  assert.equal(langUpdate.modelTimelineEnabled,true);
  const disabled=await store.set({modelTimelineEnabled:false});
  assert.equal(disabled.modelTimelineEnabled,false);
  assert.equal(disabled.language,'en');
  assert.equal(disabled.languageGuideDismissed,true);
  assert.equal(disabled.usageGuideDismissed,true);
  for(const bad of ['true',1,0,null,{}]) {
    await assert.rejects(store.set({modelTimelineEnabled:bad}),{message:'Invalid timeline preference'});
  }
  assert.equal((await store.get()).modelTimelineEnabled,false);
});

test('independent font scale preferences default to 1, round cleanly, persist across updates, and reject out-of-range inputs',async t=>{
  const {file,store}=await fixture(t);
  await writeFile(file,JSON.stringify({schema:1,language:'zh-CN',revision:2,usageFontScale:0.5,sidebarFontScale:'bad',inlineFontScale:2.4}));
  const migrated=await store.get();
  assert.equal(migrated.usageFontScale,0.8);
  assert.equal(migrated.sidebarFontScale,1);
  assert.equal(migrated.inlineFontScale,1.5);

  const updated=await store.set({usageFontScale:1.153,sidebarFontScale:1.2,inlineFontScale:0.9});
  assert.equal(updated.usageFontScale,1.15);
  assert.equal(updated.sidebarFontScale,1.2);
  assert.equal(updated.inlineFontScale,0.9);
  const reread=await new PreferencesStore({file}).get();
  assert.equal(reread.usageFontScale,1.15);
  assert.equal(reread.sidebarFontScale,1.2);
  assert.equal(reread.inlineFontScale,0.9);

  for(const bad of [0.79,1.51,'1.1',null,Number.NaN,Infinity]) {
    await assert.rejects(store.set({usageFontScale:bad}),{message:'Invalid font scale preference'});
    await assert.rejects(store.set({sidebarFontScale:bad}),{message:'Invalid font scale preference'});
    await assert.rejects(store.set({inlineFontScale:bad}),{message:'Invalid font scale preference'});
  }
  const unchanged=await store.get();
  assert.equal(unchanged.usageFontScale,1.15);
  assert.equal(unchanged.sidebarFontScale,1.2);
  assert.equal(unchanged.inlineFontScale,0.9);
});
