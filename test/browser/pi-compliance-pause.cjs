const { selectBrowserTargets } = require('./targets.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {once}=require('node:events'),{randomUUID}=require('node:crypto'),express=require('express');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../..'),temporary=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'pivane-compliance-pause-'))),agent=path.join(temporary,'agent'),cwd=path.join(temporary,'project');
fs.mkdirSync(agent);fs.mkdirSync(cwd);process.env.PI_CODING_AGENT_DIR=agent;process.env.PI_PROJECT_ROOTS=temporary;process.env.PI_OFFLINE='1';
const {PiSessionStore}=require('../../server/pi-session-store'),{PiProfileRegistry}=require('../../server/pi-profile-registry'),{ComplianceService,mountCompliance}=require('../../server/pi-compliance'),{WorkspaceAccessService}=require('../../server/workspace-access-service');
const store=new PiSessionStore(),profiles=new PiProfileRegistry(store);store.profiles=profiles;
const documents=new(require('../../server/pi-document-uploads').DocumentUploads)({store,supervisor:{getActiveWorker:()=>null,removing:new Set(),moving:new Set()}});
const models=[{provider:'fixture',id:'text',name:'文本样例',input:['text'],available:true},{provider:'fixture',id:'vision',name:'图像样例',input:['text','image'],available:true}];
let recognitionGate;
const service=new ComplianceService({store,profiles,documents,createModelRuntime:async()=>({getAvailable:async()=>models,completeSimple:async()=>{await recognitionGate;return {stopReason:'stop',content:[{type:'text',text:JSON.stringify({fields:[{key:'date',raw:'2026-08-01',status:'known',excerpt:'日期：2026-08-01',rect:[0,0,90,20]}]})}],usage:{input:10,output:3,cost:{total:0}}};}})});
const token='synthetic-pause-owner',access=new WorkspaceAccessService({filePath:path.join(agent,'access.json'),envToken:()=>token});
async function run(browser,origin,width){
 const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};let revision=0,releaseRecognition,pending,releaseRead,heldId,readReached;
 const call=async(method,route,body)=>{const response=await fetch(origin+'/api/pi/compliance'+route,{method,headers,body:body&&JSON.stringify(body)});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));if(Number.isSafeInteger(data.revision))revision=data.revision;return data;};
 const write=(route,body={},method='POST')=>call(method,route,{requestId:randomUUID(),expectedRevision:revision,...body});
 await call('GET','');await write('/settings',{enabled:true,mainModel:{provider:'fixture',modelId:'text'},extractionModel:{provider:'fixture',modelId:'vision'}},'PUT');
 const project=(await write('/projects',{project:{name:'暂停归属 '+width,number:'PAUSE-'+width}})).project,session=await write('/sessions',{cwd});
 const canvas=require('@napi-rs/canvas').createCanvas(100,80);canvas.getContext('2d').fillRect(5,5,30,20);
 const document=(await write('/projects/'+project.id+'/documents',{sources:[{kind:'upload',name:'合同.png',base64:canvas.toBuffer('image/png').toString('base64')}]})).documents[0];
 await write('/documents/'+document.id+'/assignment',{role:'contract',selected:true,identityConfirmed:true},'PUT');
 const historical=(await write('/projects/'+project.id+'/batches')).batch;assert.equal(historical.execution.status,'completed');
 recognitionGate=new Promise(resolve=>{releaseRecognition=resolve;});const requestId=randomUUID();pending=write('/projects/'+project.id+'/batches',{requestId});pending.catch(()=>{});
 let running;for(let n=0;n<300;n++){const response=await fetch(origin+'/api/pi/compliance/operations/'+requestId,{headers});if(response.ok){const value=await response.json();if(value.status==='pending'){running=value.batchId;break;}}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(running,'the real checks job is durably running before UI interaction');
 const context=await browser.newContext({locale:'zh-CN',viewport:{width,height:width<900?852:1000},isMobile:width<900,hasTouch:width<900}),page=await context.newPage(),errors=[];
 page.setDefaultTimeout(60000);page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(({cwd,token,id})=>{localStorage.setItem('pi.web.cwd',cwd);localStorage.setItem('pi.web.session:'+cwd,id);sessionStorage.setItem('pi.web.token',token);},{cwd,token,id:session.id});
 await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//,route=>route.abort());
 await page.route('**/api/**',async route=>{
  const request=route.request(),endpoint=new URL(request.url()).pathname,json=data=>route.fulfill({json:data});
  if(heldId&&endpoint==='/api/pi/compliance/batches/'+heldId&&request.method()==='GET'){heldId=null;const response=await route.fetch();readReached();return new Promise(resolve=>{releaseRead=()=>route.fulfill({response}).then(resolve);});}
  if(endpoint.startsWith('/api/pi/compliance')||endpoint==='/api/pi/profiles')return route.continue();
  if(endpoint==='/api/pi/status')return json({ok:true,sessionWorkflows:true,projectRoots:[temporary]});
  if(endpoint==='/api/pi/projects')return json({projects:[{cwd,name:'Synthetic pause',sessionCount:1}],roots:[temporary]});
  if(endpoint==='/api/pi/sessions')return json({sessions:[session]});
  if(endpoint==='/api/pi/activity')return json({runtimes:[],pinnedProjects:[],hiddenProjects:[],replyNotices:[]});
  if(endpoint==='/api/pi/settings/models')return json({models,providers:[{id:'fixture',name:'合成服务'}],preferences:{}});
  if(endpoint.endsWith('/deferred'))return json({jobs:[]});if(endpoint.endsWith('/workflow'))return json({leafId:'leaf',prompts:[],versions:[]});
  if(request.method()!=='GET')throw new Error('Unexpected browser write '+endpoint);return json(endpoint.includes('history')?[]:{});
 });
 await page.routeWebSocket('**/api/pi/ws',ws=>ws.onMessage(raw=>{const cmd=JSON.parse(raw),state={model:models[0],thinkingLevel:'off',isStreaming:false,isCompacting:false},send=data=>ws.send(JSON.stringify({type:'response',id:cmd.id,command:cmd.type,success:true,data}));if(cmd.type==='open_session')return send({session,state,messages:{messages:[]},stats:{},models:{models},thinkingLevels:{levels:['off']},commands:{commands:[]}});if(cmd.type==='get_state')return send(state);if(cmd.type==='get_messages')return send({messages:[]});if(cmd.type==='get_session_stats')return send({});throw new Error('Unexpected RPC '+cmd.type);}));
 try{
  await page.goto(origin+'/#/chat?'+new URLSearchParams({cwd,sessionId:session.id}),{waitUntil:'domcontentloaded',timeout:120000});
  await page.locator('#pi-compliance-open').click();await page.getByRole('button',{name:project.name+' · '+project.number,exact:true}).click();
  await page.waitForFunction(id=>document.querySelector('#compliance-results')?.textContent.includes(id)&&document.querySelector('#compliance-execution > strong')?.textContent.startsWith('正在执行'),running);
  await page.evaluate(()=>{window.syntheticBatchReads=[];window.syntheticFetchCalls=[];const original=window.fetch;window.fetch=async(...args)=>{const url=new URL(typeof args[0]==='string'?args[0]:args[0].url,location.href),method=args[1]?.method||'GET';window.syntheticFetchCalls.push({path:url.pathname,method});const response=await original(...args);if(method==='GET'&&/^\/api\/pi\/compliance\/batches\/[^/]+$/.test(url.pathname)){const json=response.json.bind(response);response.json=async()=>{const data=await json();window.syntheticBatchReads.push(url.pathname);return data;};}return response;};});
  heldId=running;const reached=new Promise(resolve=>{readReached=resolve;});await page.getByRole('button',{name:'当前步骤结束后暂停',exact:true}).click();await reached;
  const history=page.locator('.compliance-materials label').filter({hasText:'历史批次'}).locator('select');await history.selectOption(historical.id);await page.waitForFunction(id=>document.querySelector('#compliance-results')?.textContent.includes(id),historical.id);
  await releaseRead();releaseRead=null;await page.waitForFunction(id=>window.syntheticBatchReads.includes('/api/pi/compliance/batches/'+id),running);await page.waitForTimeout(250);
  assert.deepEqual(await page.evaluate(()=>window.syntheticFetchCalls.filter(call=>call.method==='POST'&&call.path.endsWith('/pause'))),[],'a late pause GET cannot send a POST to the newly selected batch');
  assert.ok((await page.locator('#compliance-results').textContent()).includes(historical.id));assert.deepEqual(errors,[]);
  await history.selectOption(running);await page.waitForFunction(id=>document.querySelector('#compliance-results')?.textContent.includes(id),running);
  await page.getByRole('button',{name:'当前步骤结束后暂停',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#compliance-material-status')?.textContent.includes('暂停请求已保存'));
  assert.deepEqual(await page.evaluate(()=>window.syntheticFetchCalls.filter(call=>call.method==='POST'&&call.path.endsWith('/pause'))),[{path:'/api/pi/compliance/batches/'+running+'/pause',method:'POST'}],'an unchanged owner still sends exactly one pause to its actual running batch');
  assert.equal((await call('GET','/batches/'+running)).batch.execution.pauseRequested,true);assert.deepEqual(errors,[]);
  assert.equal(await page.evaluate(()=>document.body.scrollWidth>document.body.clientWidth),false);await page.screenshot({path:path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR||os.tmpdir(),'compliance-pause-'+width+'.png')});
  releaseRecognition();recognitionGate=null;await pending;console.log('compliance pause '+width+': real running job, held response and changed selection retain exact operation owner');
 }finally{releaseRecognition?.();recognitionGate=null;await releaseRead?.();await pending?.catch(()=>{});await context.close();}
}
(async()=>{const app=express();for(const[name,directory]of[['marked','marked/lib'],['dompurify','dompurify/dist'],['highlight','@highlightjs/cdn-assets']])app.use('/vendor/'+name,express.static(path.join(root,'node_modules',directory)));app.use(express.static(path.join(root,'public')));access.mount(app);app.use(express.json({limit:'32mb'}));const router=express.Router();router.use(access.middleware());mountCompliance(router,service);router.get('/profiles',async(_req,res)=>res.json(await profiles.list()));app.use('/api/pi',router);const server=http.createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR||os.tmpdir(),{recursive:true});const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});try{for(const width of selectBrowserTargets([1440,393]))await run(browser,'http://127.0.0.1:'+server.address().port,width);}finally{await browser.close();await service.dispose();await documents.dispose();access.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
