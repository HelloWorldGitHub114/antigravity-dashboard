// Exercise both production renderers against partial and regressing metadata.
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {trajectoryMetrics} from '../sidecars/panel/metrics.mjs';
import {reconcileMetrics,safeMetrics} from '../sidecars/panel/history.mjs';
import {bindWindowFactory,invokeCjsFactory,makeEsmExportFromCjs} from '../compat/runtime-ui.mjs';
import {panelAppSource,panelPageSource} from '../sidecars/panel/panel-source.mjs';
import {isDirectEntry,launchTestBrowser} from './ui-runner.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const sources=await Promise.all(['i18n.cjs','theme.cjs','inline-widget.cjs'].map(name=>readFile(join(root,'compat',name),'utf8')));
const install=bindWindowFactory('__agPulseI18nFactory',sources[0],'i18n')+bindWindowFactory('__agPulseThemeFactory',sources[1],'theme')+invokeCjsFactory(sources[2],'inline-widget');
const read=file=>readFile(join(root,file),'utf8');
const id='11111111-1111-1111-1111-111111111111';
const request=(key,usage)=>({chatModel:{usage:{responseId:key,...usage},streamingDuration:'2s'}});
const known=request('known',{apiProvider:'API_PROVIDER_GOOGLE_GEMINI',inputTokens:'15578',cacheReadTokens:'11063',outputTokens:'880'});
const missing=Array.from({length:253},(_,i)=>request(`old-${i}`,{outputTokens:i===0?'89749':'0'}));
const sampleWithSteps=(items,steps=[])=>trajectoryMetrics({trajectory:{cascadeId:id,generatorMetadata:items,steps}});
const sample=items=>sampleWithSteps(items,[]);
const partial=sample([known,...missing]);
const orchestratorHybrid=sampleWithSteps([
  {stepIndices:[1],chatModel:{model:'MODEL_PLACEHOLDER_M668',modelDisplayName:'Orchestrator (Argon)',streamingDuration:'2s',usage:{responseId:'orch-1',apiProvider:'API_PROVIDER_GOOGLE_GEMINI',inputTokens:'100',cacheReadTokens:'400',outputTokens:'50',thinkingOutputTokens:'20'}}},
  {stepIndices:[2],chatModel:{model:'MODEL_PLACEHOLDER_M669',modelDisplayName:'Gemini Flash',streamingDuration:'1s',usage:{responseId:'orch-2',apiProvider:'API_PROVIDER_GOOGLE_GEMINI',inputTokens:'200',cacheReadTokens:'800',outputTokens:'80',thinkingOutputTokens:'10'},chatStartMetadata:{contextWindowMetadata:{estimatedTokensUsed:1200,maxContextTokens:1000000}}}},
],[
  {type:'CORTEX_STEP_TYPE_USER_INPUT',userInput:{userConfig:{plannerConfig:{planModel:'MODEL_PLACEHOLDER_M668'}}}},
  {type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',plannerResponse:{response:'1'}},
  {type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',plannerResponse:{response:'1'}},
]);
const fourModelMix=sampleWithSteps([
  {stepIndices:[1],chatModel:{model:'MODEL_PLACEHOLDER_M669',modelDisplayName:'Gemini Flash',streamingDuration:'1s',usage:{responseId:'m4-1',apiProvider:'API_PROVIDER_GOOGLE_GEMINI',inputTokens:'1000',outputTokens:'100'}}},
  {stepIndices:[2],chatModel:{model:'MODEL_PLACEHOLDER_M668',modelDisplayName:'Orchestrator (Argon)',streamingDuration:'1s',usage:{responseId:'m4-2',apiProvider:'API_PROVIDER_GOOGLE_GEMINI',inputTokens:'500',outputTokens:'100'}}},
  {stepIndices:[3],chatModel:{model:'claude-sonnet-4-6',modelDisplayName:'Claude Sonnet',streamingDuration:'1s',usage:{responseId:'m4-3',apiProvider:'API_PROVIDER_ANTHROPIC',inputTokens:'300',outputTokens:'50'}}},
  {stepIndices:[4],chatModel:{model:'gemini-2.5-pro',modelDisplayName:'Gemini Pro',streamingDuration:'1s',usage:{responseId:'m4-4',apiProvider:'API_PROVIDER_GOOGLE_GEMINI',inputTokens:'100',outputTokens:'50'}}},
],[
  {type:'CORTEX_STEP_TYPE_USER_INPUT',userInput:{userConfig:{plannerConfig:{planModel:'MODEL_PLACEHOLDER_M668'}}}},
]);
const singleFlash=sampleWithSteps([
  {stepIndices:[1],chatModel:{model:'MODEL_PLACEHOLDER_M669',modelDisplayName:'Gemini Flash',streamingDuration:'1s',usage:{responseId:'sf-1',apiProvider:'API_PROVIDER_GOOGLE_GEMINI',inputTokens:'300',cacheReadTokens:'100',outputTokens:'50'}}},
],[
  {type:'CORTEX_STEP_TYPE_USER_INPUT',userInput:{userConfig:{plannerConfig:{planModel:'MODEL_PLACEHOLDER_M669'}}}},
  {type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',plannerResponse:{response:'1'}},
]);
assert.equal(orchestratorHybrid.modelUsage.models.length,2,'Orchestrator hybrid fixture has 2 distinct models');
assert.equal(fourModelMix.modelUsage.models.length,4,'Four-model fixture has 4 distinct models');
assert.equal(singleFlash.modelUsage.models.length,1,'Single-model Flash fixture has 1 model');
export async function runCheck() {
let language='en',speed=partial;
const preferences=()=>({language,languageGuideDismissed:true,revision:1});
const metrics=()=>({connection:'live',groups:[],speed});
const staticFiles={'/':'index.html','/app.js':'app.js','/styles.css':'styles.css','/format.mjs':'format.mjs'};
const server=createServer(async(req,res)=>{
  try {
    const path=new URL(req.url,'http://localhost').pathname;
    let content,type='text/javascript';
    if(path==='/api/preferences'){content=JSON.stringify(preferences());type='application/json';}
    else if(path==='/api/metrics'){content=JSON.stringify(metrics());type='application/json';}
    else if(path==='/app.js')content=panelAppSource();
    else if(path==='/'){content=panelPageSource();type='text/html';}
    else if(path==='/i18n.js')content=makeEsmExportFromCjs('createI18n',sources[0],'i18n');
    else if(path==='/theme.js')content=makeEsmExportFromCjs('createTheme',sources[1],'theme');
    else if(path==='/theme.css'){content=require(join(root,'compat/theme.cjs'))().css(':root');type='text/css';}
    else if(path==='/preload.js')content='';
    else if(path==='/inline-widget.js')content=install;
    else if(path==='/fixture'){content=await read('sidecars/panel/toolbar-preview.html');type='text/html';}
    else if(staticFiles[path]){content=await read('sidecars/panel/'+staticFiles[path]);type=path==='/'?'text/html':path.endsWith('.css')?'text/css':'text/javascript';}
    else {res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});res.end(content);
  }catch(error){res.writeHead(500);res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const output=join(root,'.data','token-usage-ui');await mkdir(output,{recursive:true});
let browser;
const errors=[],results=[];
try {
  browser=await launchTestBrowser();
  const origin='http://127.0.0.1:'+server.address().port;
  for(const inline of [true,false])for(const lang of ['en','zh-CN']) {
    language=lang;speed=partial;
    const page=await browser.newPage({viewport:{width:1100,height:900}});
    page.on('pageerror',e=>errors.push(e.message));
    try {
      await page.goto(origin+(inline?'/fixture':'/'));
      const scope=inline?page.locator('#ag-pulse-status-bar'):page.locator('body');
      await scope.locator('#cache-output').waitFor({state:'attached'});
      const expectText=async(id,text)=>{
        await page.waitForFunction(({inline,id,text})=>{
          const root=inline?document.getElementById('ag-pulse-status-bar')?.shadowRoot:document;
          return root?.getElementById(id)?.textContent===text;
        },{inline,id,text});
      };
      try{await expectText('cache-output','90,629 tok');}catch(error){
        console.log(JSON.stringify({inline,lang,errors,output:await scope.locator('#cache-output').textContent(),
          rate:await scope.locator(inline?'#rate-note':'#health-note').textContent(),
          note:await scope.locator('#cache-note').textContent()}));throw error;
      }
      await expectText('cache-coverage','117,270 tok');
      if(inline)await scope.locator('[data-card=cache]').hover();
      else await scope.locator('[data-card=cache]').click();
      await scope.locator('#cache-card').waitFor({state:'visible'});
      assert.equal(await scope.locator('#cache-note').isVisible(),false,'Compact cards do not display calculation/coverage explanations');
      assert.equal((await scope.locator('#cache-card').textContent()).includes('≥'),false,'Readable token counters have no repeated inequality prefixes');
      if(inline)assert.equal(await scope.locator('#model-mix-compact').isVisible(),false,'Single-model cache card hides #model-mix-compact');
      assert.equal(speed.tokens.missingInputRequests,253,'Removing UI notes must not erase coverage from statistics');
      const card=await scope.locator('#cache-card').boundingBox();
      assert.ok(card&&card.y>=0&&card.y+card.height<=900,'Partial-data explanation stays inside viewport');
      await page.screenshot({path:join(output,`${inline?'inline':'panel'}-${lang}.png`)});
      speed=sample([known,...missing,request('new',{outputTokens:'500'})]);
      await expectText('cache-output','91,129 tok');
      await expectText('cache-coverage','117,770 tok');
      speed=sample([request('output-only',{outputTokens:'200'})]);
      await expectText('cache-output','200 tok');
      await expectText('cache-miss','—');
      await expectText(inline?'cache-detail-rate':'cache-rate','—');
      speed=sample([request('zero',{outputTokens:'0'})]);
      await expectText('cache-output','0 tok');
      await expectText('cache-coverage','0 tok');
      const saved=sample([known]);
      const fresh=sample([request('known',{outputTokens:'880'}),request('new',{outputTokens:'500'})]);
      speed=reconcileMetrics(saved,{...fresh,measuredRequests:0},'2026-10-13T00:00:00Z');
      await expectText('cache-output','1,380 tok');
      await expectText('cache-coverage','1,380 tok');
      const legacy=structuredClone(partial);delete legacy.tokens;
      speed=safeMetrics(legacy,id);
      await expectText('cache-output','90,629 tok');
      await expectText('cache-coverage','117,270 tok');
      assert.equal(speed.tokens.coverageUnknown,true,'Legacy/corrupt records keep conservative coverage internally');
      const corrupt=sample([known]);corrupt.tokens.outputTokens=1.5;
      speed=safeMetrics(corrupt,id);
      await expectText('cache-output','—');
      await expectText('cache-coverage','26,641 tok');
      assert.equal(speed.tokens.coverageUnknown,true,'Legacy/corrupt records keep conservative coverage internally');
      speed=sample([request('zero-input',{apiProvider:'API_PROVIDER_GOOGLE_GEMINI',inputTokens:'0',outputTokens:'200'})]);
      await expectText('cache-coverage','200 tok');await expectText('cache-output','200 tok');
      await expectText('cache-miss','0 tok');await expectText('cache-read','0 tok');
      await expectText(inline?'cache-detail-rate':'cache-rate','—');
      assert.equal(speed.cache.hitRate,null,'A zero denominator stays unavailable, not a fabricated cache percentage');
      assert.equal(await scope.locator('#cache-note').isVisible(),false);
      speed=sample([request('partial-input',{apiProvider:'API_PROVIDER_GOOGLE_GEMINI',inputTokens:'100',cacheReadTokens:'invalid',outputTokens:'200'})]);
      await expectText('cache-coverage','300 tok');await expectText('cache-output','200 tok');
      await expectText('cache-miss','100 tok');await expectText('cache-read','—');
      speed=sample([request('cache-only',{apiProvider:'API_PROVIDER_GOOGLE_GEMINI',cacheReadTokens:'40',cacheWriteTokens:'5',outputTokens:'50'})]);
      await expectText('cache-coverage','95 tok');await expectText('cache-miss','—');
      await expectText('cache-read','40 tok');await expectText('cache-write','5 tok');
      await expectText('cache-output','50 tok');
      if(inline){
        await scope.locator('[data-card=context]').hover();
        await scope.locator('#context-card').waitFor({state:'visible'});
        assert.equal(await scope.locator('#context-orchestrator-row').isVisible(),false,'Single-model context card hides #context-orchestrator-row');
        await page.setViewportSize({width:900,height:900});
        speed=orchestratorHybrid;
        await expectText('cache-coverage','1,630 tok');
        await expectText('context-model','Gemini Flash');
        await scope.locator('[data-card=cache]').hover();
        await scope.locator('#cache-card').waitFor({state:'visible'});
        assert.equal(await scope.locator('#cache-note').isVisible(),false,'Multi-model cache card keeps #cache-note hidden');
        assert.equal(await scope.locator('#model-mix-compact').isVisible(),true,'Multi-model cache card shows #model-mix-compact');
        await expectText('model-mix-count',lang==='zh-CN'?'2 个模型':'2 models');
        const cacheLayout=await page.evaluate(()=>{
          const root=document.getElementById('ag-pulse-status-bar')?.shadowRoot;
          const card=root?.getElementById('cache-card');
          const mix=root?.getElementById('model-mix-compact');
          const svg=root?.getElementById('model-mix-svg');
          const legend=root?.getElementById('model-mix-legend');
          if(!card||!mix||!svg||!legend)return {missing:true};
          const cr=card.getBoundingClientRect(),sr=svg.getBoundingClientRect(),lr=legend.getBoundingClientRect();
          const segs=[...svg.querySelectorAll('circle.model-mix-seg')].map(el=>({
            id:el.getAttribute('data-model-id'),
            r:el.getAttribute('r'),
            dasharray:el.getAttribute('stroke-dasharray'),
            dashoffset:el.getAttribute('stroke-dashoffset'),
          }));
          const items=[...legend.querySelectorAll('.model-mix-item')].map(el=>({
            name:el.querySelector('.model-mix-name')?.textContent||'',
            val:el.querySelector('.model-mix-val')?.textContent||'',
          }));
          const badAttrs=[...mix.querySelectorAll('*')].some(el=>[...el.attributes].some(a=>a.name.toLowerCase().startsWith('on')));
          return {
            missing:false,
            text:card.textContent||'',
            canvases:card.querySelectorAll('canvas').length,
            badAttrs,
            cardRect:{x:cr.x,y:cr.y,width:cr.width,height:cr.height,right:cr.right,bottom:cr.bottom},
            overflow:{sw:card.scrollWidth,cw:card.clientWidth,sh:card.scrollHeight,ch:card.clientHeight},
            svgRect:{width:sr.width,height:sr.height,left:sr.left,right:sr.right,top:sr.top,bottom:sr.bottom},
            legendRect:{left:lr.left,right:lr.right,top:lr.top,bottom:lr.bottom},
            segs,
            items,
          };
        });
        assert.equal(cacheLayout.missing,false,'Inline multi-model cache DOM nodes exist');
        assert.equal(cacheLayout.text.includes('≥'),false,'Multi-model cache card never renders inequality symbol');
        assert.equal(cacheLayout.canvases,0,'TrustedHTML guard: zero <canvas> elements');
        assert.equal(cacheLayout.badAttrs,false,'TrustedHTML guard: zero inline on* attributes');
        assert.ok(cacheLayout.svgRect.width>=34&&cacheLayout.svgRect.width<=36.5&&cacheLayout.svgRect.height>=34&&cacheLayout.svgRect.height<=36.5,'Compact donut SVG is 34-36px');
        assert.equal(cacheLayout.segs.length,2,'2-model donut renders 2 SVG <circle> segments');
        for(const seg of cacheLayout.segs){
          assert.equal(seg.r,'13');
          assert.match(seg.dasharray||'',/^\d+(\.\d+)?\s+\d+(\.\d+)?$/);
          assert.ok(Number.isFinite(Number(seg.dashoffset)));
        }
        assert.deepEqual(cacheLayout.items.map(i=>i.name),['Gemini Flash','Orchestrator (Argon)']);
        assert.match(cacheLayout.items[0].val,/^66%\s*\([^)]+\)$/);
        assert.match(cacheLayout.items[1].val,/^34%\s*\([^)]+\)$/);
        assert.ok(cacheLayout.cardRect.x>=0&&cacheLayout.cardRect.y>=0&&cacheLayout.cardRect.right<=900&&cacheLayout.cardRect.bottom<=900,'Multi-model cache card stays inside 900x900 viewport');
        assert.ok(cacheLayout.overflow.sw<=cacheLayout.overflow.cw+1&&cacheLayout.overflow.sh<=cacheLayout.overflow.ch+1,'Multi-model cache card has no internal clipping/overflow');
        assert.ok(cacheLayout.svgRect.right<=cacheLayout.legendRect.left+1,'Donut SVG does not overlap legend');
        assert.ok(cacheLayout.svgRect.bottom<=cacheLayout.cardRect.bottom+1&&cacheLayout.legendRect.bottom<=cacheLayout.cardRect.bottom+1,'Donut and legend stay within #cache-card');
        await page.screenshot({path:join(output,`inline-${lang}-orchestrator-cache.png`)});

        await scope.locator('[data-card=context]').hover();
        await scope.locator('#context-card').waitFor({state:'visible'});
        assert.equal(await scope.locator('#context-orchestrator-row').isVisible(),true,'Orchestrator hybrid session shows #context-orchestrator-row');
        await expectText('context-orchestrator-label',lang==='zh-CN'?'主控入口':'Planner entrypoint');
        await expectText('context-planner','Orchestrator (Argon)');
        await expectText('context-orchestrator-note',lang==='zh-CN'?'规划用 Argon 周额度 · 执行用 Flash 5h 额度':'Plan uses Argon weekly quota · Worker uses Flash 5h quota');
        const ctxLayout=await page.evaluate(()=>{
          const root=document.getElementById('ag-pulse-status-bar')?.shadowRoot;
          const card=root?.getElementById('context-card');
          if(!card)return {missing:true};
          const cr=card.getBoundingClientRect();
          return {
            missing:false,
            text:card.textContent||'',
            rect:{x:cr.x,y:cr.y,right:cr.right,bottom:cr.bottom},
            overflow:{sw:card.scrollWidth,cw:card.clientWidth,sh:card.scrollHeight,ch:card.clientHeight},
          };
        });
        assert.equal(ctxLayout.missing,false);
        assert.equal(ctxLayout.text.includes('≥'),false);
        assert.ok(ctxLayout.rect.x>=0&&ctxLayout.rect.y>=0&&ctxLayout.rect.right<=900&&ctxLayout.rect.bottom<=900,'Orchestrator context card fits inside 900x900 viewport');
        assert.ok(ctxLayout.overflow.sw<=ctxLayout.overflow.cw+1&&ctxLayout.overflow.sh<=ctxLayout.overflow.ch+1,'Orchestrator context card has no clipping/overflow');
        await page.screenshot({path:join(output,`inline-${lang}-orchestrator-context.png`)});

        speed=fourModelMix;
        await expectText('model-mix-count',lang==='zh-CN'?'4 个模型':'4 models');
        await scope.locator('[data-card=cache]').hover();
        await scope.locator('#cache-card').waitFor({state:'visible'});
        const fourMix=await page.evaluate(()=>{
          const root=document.getElementById('ag-pulse-status-bar')?.shadowRoot;
          const card=root?.getElementById('cache-card');
          const cr=card.getBoundingClientRect();
          return {
            segs:root.querySelectorAll('#model-mix-svg circle.model-mix-seg').length,
            names:[...root.querySelectorAll('#model-mix-legend .model-mix-name')].map(el=>el.textContent),
            rect:{x:cr.x,y:cr.y,right:cr.right,bottom:cr.bottom},
            overflow:{sw:card.scrollWidth,cw:card.clientWidth,sh:card.scrollHeight,ch:card.clientHeight},
          };
        });
        assert.equal(fourMix.segs,4,'Four-model mix renders top-3 + Other segments');
        assert.equal(fourMix.names.length,4,'Four-model legend renders top-3 + Other rows');
        assert.equal(fourMix.names[3],lang==='zh-CN'?'其他':'Other','4th+ models aggregate into localized Other row');
        assert.ok(fourMix.rect.right<=900&&fourMix.rect.bottom<=900&&fourMix.overflow.sw<=fourMix.overflow.cw+1&&fourMix.overflow.sh<=fourMix.overflow.ch+1,'4-model cache card stays inside 900x900 with zero overflow');

        speed=singleFlash;
        await expectText('cache-coverage','450 tok');
        assert.equal(await scope.locator('#model-mix-compact').isVisible(),false,'Switching back to single model hides #model-mix-compact');
        assert.equal(await page.evaluate(()=>document.getElementById('ag-pulse-status-bar')?.shadowRoot?.querySelectorAll('#model-mix-svg circle.model-mix-seg').length??-1),0,'Single model clears donut segments');
        await scope.locator('[data-card=context]').hover();
        await scope.locator('#context-card').waitFor({state:'visible'});
        assert.equal(await scope.locator('#context-orchestrator-row').isVisible(),false,'Switching back to single model hides #context-orchestrator-row');
      }
      results.push({renderer:inline?'inline':'panel',language:lang,partial:true,continuedOutput:true,outputOnly:true,zero:true,independentHistory:true,legacyCoverage:true,corruptCounters:true,zeroInput:true,independentInput:true,cacheOnlyInput:true,...(inline?{orchestratorHybrid:true,fourModelOther:true,orchestratorResetToSingle:true}:{})});
    }finally{await page.close();}
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({results,pageErrors:errors,screenshots:output},null,2));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
}
if (isDirectEntry(import.meta.url)) await runCheck();
