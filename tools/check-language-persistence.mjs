// Real frontend, separate origins/browser contexts, and recreated disk-backed services.
import {createServer} from 'node:http';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {PreferencesStore} from '../compat/preferences.mjs';
import {bindWindowFactory,invokeCjsFactory,makeEsmExportFromCjs} from '../compat/runtime-ui.mjs';
import {panelAppSource} from '../sidecars/panel/panel-source.mjs';
import {isDirectEntry,launchTestBrowser} from './ui-runner.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>readFile(join(root,path),'utf8');
const [i18n,widget,theme]=await Promise.all(['compat/i18n.cjs','compat/inline-widget.cjs','compat/theme.cjs'].map(read));
const themeCss=createRequire(import.meta.url)('../compat/theme.cjs')().css(':root');
export async function runCheck() {
const directory=await mkdtemp(join(tmpdir(),'pulse-language-ui-')),file=join(directory,'preferences.json');
const id='11111111-1111-1111-1111-111111111111';
async function serve() {
  const store=new PreferencesStore({file});
  let completedWrites=0;
  const server=createServer(async(req,res)=>{
    try {
      const path=new URL(req.url,'http://127.0.0.1').pathname;let text,type='text/javascript';
      if(path==='/api/preferences'){
        if(req.method==='POST'){let input='';for await(const chunk of req)input+=chunk;text=JSON.stringify(await store.set(JSON.parse(input)));completedWrites++;}
        else text=JSON.stringify(await store.get());type='application/json';
      }else if(path==='/api/metrics'){
        text=JSON.stringify({connection:'live',serverTime:new Date().toISOString(),preferences:await store.snapshot(),groups:[],speed:{conversationId:id,counts:{},cache:null,context:null}});type='application/json';
      }else if(path==='/app.js')text=panelAppSource();
      else if(path==='/i18n.js')text=makeEsmExportFromCjs('createI18n',i18n,'i18n');
      else if(path==='/theme.js')text=makeEsmExportFromCjs('createTheme',theme,'theme');
      else if(path==='/theme.css'){text=themeCss;type='text/css';}
      else if(path==='/inline-widget.js')text=bindWindowFactory('__agPulseI18nFactory',i18n,'i18n')+bindWindowFactory('__agPulseThemeFactory',theme,'theme')+invokeCjsFactory(widget,'inline-widget');
      else if(path==='/preload.js')text='';
      else if(path.startsWith('/toolbar-preview')){text=await read('sidecars/panel/toolbar-preview.html');type='text/html';}
      else if(['/','/app.js','/styles.css','/format.mjs'].includes(path)){text=await read('sidecars/panel/'+(path==='/'?'index.html':path.slice(1)));type=path==='/'?'text/html':path.endsWith('.css')?'text/css':'text/javascript';}
      else {res.writeHead(404);res.end();return;}
      res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'});res.end(text);
    }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
  });
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  return {url:'http://127.0.0.1:'+server.address().port,store,get completedWrites(){return completedWrites;},close:()=>new Promise(resolve=>server.close(resolve))};
}
const browser=await launchTestBrowser();
const errors=[];let server;
try {
  server=await serve();const firstOrigin=server.url;
  let context=await browser.newContext();let page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.url+'/toolbar-preview');let host=page.locator('#ag-pulse-status-bar');
  await host.locator('[data-card=context]').click();await host.locator('#card-language-zh').click();
  await page.waitForFunction(async()=>{const p=await(await fetch('/api/preferences')).json();return p.language==='zh-CN';});
  assert.equal((await server.store.get()).language,'zh-CN');
  await context.close();await server.close();server=await serve();assert.notEqual(server.url,firstOrigin);
  context=await browser.newContext();page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.url+'/toolbar-preview');host=page.locator('#ag-pulse-status-bar');
  await page.waitForFunction(()=>document.getElementById('ag-pulse-status-bar')?.lang==='zh-CN');
  await host.locator('[data-card=context]').click();assert.equal(await host.locator('#card-language-zh').getAttribute('aria-pressed'),'true');
  const panel=await context.newPage();panel.on('pageerror',error=>errors.push(error.message));await panel.goto(server.url+'/');
  await panel.waitForFunction(()=>document.documentElement.lang==='zh-CN');
  await panel.locator('#settings-button').click();
  await panel.locator('#settings-popover').waitFor({state:'visible'});
  await panel.locator('#lang-opt-en').click();
  await page.waitForFunction(()=>document.getElementById('ag-pulse-status-bar')?.lang==='en');
  assert.equal((await server.store.get()).language,'en');
  await context.close();await server.close();server=await serve();context=await browser.newContext();page=await context.newPage();
  await page.goto(server.url+'/toolbar-preview');host=page.locator('#ag-pulse-status-bar');await host.locator('[data-card=context]').click();
  assert.equal(await host.locator('#card-language-en').getAttribute('aria-pressed'),'true');
  await host.locator('#card-language-zh').click();await host.locator('#card-language-en').click();await host.locator('#card-language-zh').click();
  // The first click also saves zh-CN. Seeing that transient disk value does not
  // mean the remaining two serialized writes finished; closing the browser at
  // that point can abort the final write and produce a false restart failure.
  const deadline=Date.now()+30000;
  while(server.completedWrites<3){
    if(Date.now()>deadline)throw new Error('The three rapid language writes did not finish');
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal((await server.store.get()).language,'zh-CN');
  assert.equal(await host.locator('#card-language-zh').getAttribute('aria-pressed'),'true');
  await context.close();await server.close();server=await serve();context=await browser.newContext();page=await context.newPage();await page.goto(server.url+'/');
  await page.waitForFunction(()=>document.documentElement.lang==='zh-CN');
  await page.locator('#settings-button').click();
  await page.locator('#settings-popover').waitFor({state:'visible'});
  assert.equal(await page.locator('#lang-opt-zh').getAttribute('aria-pressed'),'true');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({changedOrigins:true,freshBrowserStorage:true,recreatedBackend:true,chineseRestored:true,englishRestored:true,panelToInlineSync:true,rapidToggle:true,pageErrors:errors},null,2));
}finally{await browser.close();await server?.close();await rm(directory,{recursive:true,force:true});}
}
if (isDirectEntry(import.meta.url)) await runCheck();
