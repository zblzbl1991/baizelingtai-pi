const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {once}=require('node:events');const {WebSocket}=require('ws');
const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'pi-model-onboarding-')));
process.env.PI_CODING_AGENT_DIR=path.join(root,'agent');process.env.PI_PROJECT_ROOTS=root;process.env.PI_WEB_DEFERRED_FILE=path.join(root,'deferred.json');process.env.PI_OFFLINE='1';delete process.env.PI_WEB_APPROVE_PROJECTS;
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const wait=async f=>{const end=Date.now()+15000;while(!f()){if(Date.now()>end)throw Error('fixture timeout');await new Promise(r=>setTimeout(r,20))}};
// Temporary phase evidence. Never record payloads, credentials or extension text.
function runtimePhases(t, label) {
 const { PiRpcClient } = require('../server/pi-rpc-client');
 const begun = performance.now(), events = [], clients = new Map(), restores = []; let omitted = 0, serial = 0;
 const mark = (phase, fields = {}) => { if (events.length === 200) { events.shift(); omitted++; } events.push({ ms: Math.round(performance.now() - begun), phase, ...fields }); };
 const errorCode = error => ['RPC_TIMEOUT','RPC_STARTUP_FAILED','RPC_REJECTED','STARTUP_UI_UNSUPPORTED','SESSION_BUSY'].includes(error?.code) ? error.code : 'OTHER';
 const clientState = client => { if (!clients.has(client)) clients.set(client, { id: clients.size + 1, pending: new Map() }); return clients.get(client); };
 const observe = (target, name, identify) => {
  const original = target[name];
  target[name] = function (...args) {
   const state = identify ? identify(this, args) : null, call = ++serial;
   const phase = name === 'request' ? 'rpc:' + args[0] : name;
   state?.pending.set(call, phase); mark(phase + ':begin', state ? { client: state.id } : {});
   let result;
   const done = error => { state?.pending.delete(call); mark(phase + (error ? ':error' : ':end'), { ...(state ? { client: state.id } : {}), ...(error ? { code: errorCode(error) } : {}) }); };
   try { result = original.apply(this, args); } catch (error) { done(error); throw error; }
   if (name === 'start' && this.child && !state.observedChild) {
    state.observedChild = this.child; mark('child:spawned', { client: state.id });
    this.child.once('exit', (code, signal) => mark('child:exit', { client: state.id, code, signal }));
    this.child.once('close', (code, signal) => mark('child:close', { client: state.id, code, signal }));
   }
   Promise.resolve(result).then(() => done(), error => done(error)); return result;
  };
  restores.push(() => { target[name] = original; });
 };
 for (const name of ['start','request','dispose']) observe(PiRpcClient.prototype, name, clientState);
 t.after(() => { for (const restore of restores.reverse()) restore(); });
 let supervisor;
 return {
  mark,
  attach(gateway) {
   supervisor = gateway.supervisor;
   observe(gateway.store, 'getSession');
   for (const name of ['getWorker','restartWorker']) observe(supervisor, name);
   if (supervisor.workerEnvironment) observe(supervisor, 'workerEnvironment');
   supervisor.on('worker', () => mark('worker:published'));
  },
  dump(phase) {
   mark(phase);
   t.diagnostic('[DEBUG-runtime-phase] ' + JSON.stringify({ label, omitted, events, supervisor: supervisor ? {
    workers: supervisor.workers.size, starting: supervisor.starting.size,
    active: [...supervisor.workers.values()].map(worker => ({ disposed: worker.disposed, restarting: Boolean(worker.restarting), busy: worker.activity.snapshot().busy }))
   } : null, clients: [...clients].map(([client, state]) => ({ id: state.id, disposed: client.disposed, child: Boolean(client.child), pending: [...state.pending.values()] })) }));
  }
 };
}
test('an already-open empty runtime discovers later credentials in place without sending or selecting a model', {timeout:60000}, async t=>{
 const phases = runtimePhases(t, 'empty-runtime'); let socketOrdinal = 0;
 const {createPiAgentGateway}=require('../server/pi-agent-routes');const {PiSettingsService}=require('../server/pi-settings-service');let calls=0;
 const provider=http.createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer private-fixture-key');for await(const _ of req){}calls++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content:'CATALOG_OK'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}})+'\n\ndata: [DONE]\n\n')});provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const gateway=createPiAgentGateway();phases.attach(gateway);const app=require('express')();app.use(require('express').json());gateway.mount(app);const server=http.createServer(app);gateway.attachWebSocket(server);server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port,sockets=[];
 t.after(async()=>{try{for(const s of sockets)s.terminate();await gateway.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));provider.closeAllConnections();await new Promise(r=>provider.close(r))}finally{phases.dump('cleanup:finished')}});
 const session=await gateway.store.createSession(root,'Empty first runtime');
 // Catalog checks start with an open native runtime. Cold WebSocket opening is
 // covered by pi-native-completion: "native worker restores live output...".
 // Keep real cold startup inside this test's unchanged 60-second total budget.
 const preparedWorker=await gateway.supervisor.getWorker({cwd:root,sessionPath:session.path,sessionId:session.id});
 async function connect(){
  const ordinal=++socketOrdinal,ws=new WebSocket(base.replace('http:','ws:')+'/api/pi/ws',{origin:base});sockets.push(ws);
  const pending=new Map(),events=[];let seq=0;
  ws.on('close',code=>phases.mark('ws:close',{socket:ordinal,code}));ws.on('error',()=>phases.mark('ws:error',{socket:ordinal}));
  ws.on('message',raw=>{const e=JSON.parse(raw);if(e.type==='response'&&pending.has(e.id)){const p=pending.get(e.id);pending.delete(e.id);clearTimeout(p.timer);phases.mark('ws:response',{socket:ordinal,id:e.id,success:e.success});e.success?p.resolve(e.data):p.reject(Object.assign(Error(e.error),{code:e.errorCode}))}else events.push(e)});
  await once(ws,'open');phases.mark('ws:open',{socket:ordinal});
  const call=(type,data={})=>new Promise((resolve,reject)=>{const id=String(++seq),timer=setTimeout(()=>{phases.dump('ws:timeout:'+ordinal+':'+type);reject(Error('timeout '+type))},15000);pending.set(id,{resolve,reject,timer});phases.mark('ws:send',{socket:ordinal,id,type});ws.send(JSON.stringify({id,type,...data}))});
  return {call,events,snapshot:await call('open_session',{cwd:root,sessionId:session.id})}
 }
 const main=await connect(),other=await connect();assert.strictEqual(gateway.supervisor.getActiveWorker(session.path),preparedWorker);assert.equal(gateway.supervisor.workers.size,1);assert.equal(main.snapshot.models.models.length,0);const before=fs.readFileSync(session.path);const initial=(await main.call('get_state')).model;
 await assert.rejects(main.call('prompt',{message:'MUST_NOT_BE_ACCEPTED'}),e=>e.code==='MODEL_AUTH_REQUIRED'&&!e.message.includes('node_modules')&&e.message.includes('供应商与模型'));assert.deepEqual(fs.readFileSync(session.path),before);
 const settings=new PiSettingsService({cwd:root});await settings.upsertCustomProvider({id:'catalog-fixture',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,api:'openai-completions',authHeader:true});await settings.upsertCustomModel('catalog-fixture',{id:'fixture',name:'Fixture',contextWindow:32000,maxTokens:1000,imageInput:false});await settings.saveApiKey('catalog-fixture','private-fixture-key');
 assert.equal((await main.call('get_available_models')).models.length,0,'old native snapshot reproduces the bug');
 const [fresh,shared]=await Promise.all([main.call('refresh_models'),other.call('refresh_models')]);assert.ok(fresh.models.some(m=>m.provider==='catalog-fixture'));assert.deepEqual(shared,fresh);assert.equal(calls,0);assert.equal(gateway.supervisor.workers.size,1);assert.deepEqual((await main.call('get_state')).model,initial,'refresh does not select or replace the model');assert.deepEqual(fs.readFileSync(session.path),before,'private command is not conversation history');assert.ok(main.events.some(e=>e.type==='gateway_models'));assert.doesNotMatch(JSON.stringify([...main.events,...other.events,fresh]),/private-fixture-key|pi5Models|pi5-web-navigate/);
 await main.call('set_model',{provider:'catalog-fixture',modelId:'fixture'});await main.call('prompt',{message:'Only a synthetic endpoint receives this'});await wait(()=>main.events.some(e=>e.type==='agent_settled'));assert.equal(calls,1);
 const worker=gateway.supervisor.getActiveWorker(session.path);worker.client.emit('event',{type:'agent_start'});await assert.rejects(main.call('refresh_models'),{code:'SESSION_BUSY'});worker.client.emit('event',{type:'agent_settled'});
 await settings.logout('catalog-fixture');assert.equal((await main.call('refresh_models')).models.length,0,'logout removes availability from the same worker');assert.equal(calls,1);
});
test('an extension-backed session reloads edited context limits without changing model identity', {timeout:60000}, async t => {
 const phases = runtimePhases(t, 'extension-runtime');
 const {createPiAgentGateway}=require('../server/pi-agent-routes');const {PiSettingsService}=require('../server/pi-settings-service');
 const providerId='overlap-catalog-fixture',modelId='model/context:v1';
 const extensionDir=path.join(process.env.PI_CODING_AGENT_DIR,'extensions');fs.mkdirSync(extensionDir,{recursive:true});
 const extensionPath=path.join(extensionDir,'overlap-fixture.ts');
 const definition={baseUrl:'http://127.0.0.1:65530/v1',api:'openai-completions',apiKey:'private-overlap-fixture-key',models:[{id:modelId,name:'Extension model',reasoning:false,input:['text'],contextWindow:1050000,maxTokens:128000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]};
 fs.writeFileSync(extensionPath,`export default function(pi) { pi.registerProvider(${JSON.stringify(providerId)}, ${JSON.stringify(definition)}); }`);
 const settings=new PiSettingsService({cwd:root});await settings.upsertCustomProvider({id:providerId,baseUrl:definition.baseUrl,api:definition.api,authHeader:true});
 const {modelsPath}=await settings.paths();const initial=settings.readModelsFile(modelsPath);initial.providers[providerId].models=definition.models;await settings.writeModelsFile(initial);
 const gateway=createPiAgentGateway(),app=require('express')();phases.attach(gateway);app.use(require('express').json());gateway.mount(app);const server=http.createServer(app);gateway.attachWebSocket(server);server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 const pending=new Map();let seq=0,ws;
 t.after(async()=>{try{ws?.terminate();await gateway.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(extensionPath);await settings.deleteCustomProvider(providerId)}finally{phases.dump('cleanup:finished')}});
 // As above, prepare this same native runtime before testing catalog commands.
 const session=await gateway.store.createSession(root,'Extension context limits');
 const preparedWorker=await gateway.supervisor.getWorker({cwd:root,sessionPath:session.path,sessionId:session.id});
 ws=new WebSocket(base.replace('http:','ws:')+'/api/pi/ws',{origin:base});
 ws.on('close',code=>phases.mark('ws:close',{code}));ws.on('error',()=>phases.mark('ws:error'));
 ws.on('message',raw=>{const e=JSON.parse(raw),p=pending.get(e.id);if(e.type==='response'&&p){pending.delete(e.id);clearTimeout(p.timer);phases.mark('ws:response',{id:e.id,success:e.success});e.success?p.resolve(e.data):p.reject(Object.assign(Error(e.error),{code:e.errorCode}))}});
 await once(ws,'open');phases.mark('ws:open');const call=(type,data={})=>new Promise((resolve,reject)=>{const id=String(++seq),timer=setTimeout(()=>{phases.dump('ws:timeout:'+type);reject(Error('timeout '+type))},20000);pending.set(id,{resolve,reject,timer});phases.mark('ws:send',{id,type});ws.send(JSON.stringify({id,type,...data}))});
 await call('open_session',{cwd:root,sessionId:session.id});assert.strictEqual(gateway.supervisor.getActiveWorker(session.path),preparedWorker);assert.equal(gateway.supervisor.workers.size,1);await call('set_model',{provider:providerId,modelId});
 assert.equal((await call('get_state')).model.contextWindow,1050000);
 await settings.upsertCustomModel(providerId,{id:modelId,name:'Edited model',contextWindow:272000,maxTokens:32000});
 const fresh=await call('refresh_models');assert.equal(fresh.models.find(m=>m.provider===providerId&&m.id===modelId).contextWindow,272000);
 await call('reload_resources');
 const state=await call('get_state');assert.equal(state.model.provider,providerId);assert.equal(state.model.id,modelId);assert.equal(state.model.contextWindow,272000);assert.equal(state.model.maxTokens,32000);
 assert.equal(gateway.supervisor.workers.size,1);assert.doesNotMatch(JSON.stringify(state),/private-overlap-fixture-key/);
});

test('catalog responses remain private and an uncertain refresh closes the reserved idle worker',async()=>{
 const {PiModelCatalog}=require('../server/pi-model-catalog');let disposed=false,reserved=false;const events=[];const worker={navigationToken:'fixture',_broadcast:e=>events.push(e),async dispose(){assert.equal(reserved,true);disposed=true},async exclusive(fn){reserved=true;try{return await fn()}finally{reserved=false}},client:{async request(type){if(type==='get_commands')return {commands:[{name:'pi5-web-navigate',description:'model-catalog-v1'}]};throw Object.assign(Error('Pi RPC command timed out: prompt'),{code:'RPC_TIMEOUT'})}}};const catalog=new PiModelCatalog(worker);assert.equal(catalog.handle({pi5Models:'late',data:{models:[]}}),true);await assert.rejects(catalog.refresh(),{code:'RPC_TIMEOUT'});assert.equal(disposed,true);assert.equal(catalog.pending.size,0);assert.ok(events.some(e=>e.type==='gateway_reconnect'));
});
