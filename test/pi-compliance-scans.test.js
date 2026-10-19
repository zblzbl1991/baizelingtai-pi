const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-scans-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
let gateway, server, provider, origin, revision = 0, gatewayClosed=false, composed; const calls = [];
let holdNext = false, held, release, responseFields, responseText, responseUsage, nativeArguments;
async function call(method, route, input) {
    const res = await fetch(origin + '/api/pi/compliance' + route, { method, headers: { Authorization: 'Bearer synthetic-scans', 'Content-Type': 'application/json' }, body: input && JSON.stringify(input) });
    const data = await res.json(); if (res.ok && Number.isSafeInteger(data.revision)) revision = data.revision; return { status: res.status, data };
}
async function write(route, input = {}, method = 'POST') { return call(method, route, { requestId: require('node:crypto').randomUUID(), expectedRevision: revision, ...input }); }
async function archive(bytes, name = '扫描.png') {
    const project = (await write('/projects', { project: { name: '扫描工程', identityConfirmed: true, applicability: { 'documents-identity': true, 'contract-deadline': true, 'feasibility-numbers': false, 'feasibility-order': false } } })).data.project;
    const docs = (await write(`/projects/${project.id}/documents`, { sources: [{ kind: 'upload', name, base64: bytes.toString('base64') }] })).data.documents;
    assert.ok(docs, 'synthetic original imported');
    assert.equal((await write(`/documents/${docs[0].id}/assignment`, { role: 'contract', identityConfirmed: true, selected: true }, 'PUT')).status, 200);
    return project;
}
test.before(async () => {
    provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk; const body=JSON.parse(raw);calls.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (holdNext) { holdNext=false; held(); await new Promise(resolve=>{release=resolve;}); }
        const content = responseText ?? JSON.stringify({ fields: responseFields || [{ key: 'date', raw: '2026-08-31', status: 'known', excerpt: '签订日期：2026-08-31', rect: [0, 0, 90, 20] }] });
        const native = body.messages.at(-1)?.role==='user' && JSON.stringify(body.messages.at(-1)).includes('fixture native_scan');
        const delta=native?{role:'assistant',tool_calls:[{index:0,id:'native-scan',type:'function',function:{name:'compliance_check',arguments:JSON.stringify(nativeArguments)}}]}:{role:'assistant',content};
        res.write(`data: ${JSON.stringify({ id: 'scan', object: 'chat.completion.chunk', model: 'vision', choices: [{ index: 0, delta, finish_reason: native?'tool_calls':'stop' }] })}\n\n`);
        if(responseUsage)res.write(`data: ${JSON.stringify({id:'scan',object:'chat.completion.chunk',model:'vision',choices:[],usage:responseUsage})}\n\n`);
        res.end('data: [DONE]\n\n');
    }); provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'vision', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'vision', input: ['text', 'image'], contextWindow: 32000, maxTokens: 2000 }] } } }));
    const { createPiAgentGateway } = require('../server/pi-agent-routes'), { WorkspaceAccessService } = require('../server/workspace-access-service');
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => 'synthetic-scans' });
    gateway = createPiAgentGateway({ accessService: access, deferredFilePath: path.join(agent, 'deferred.json'), cronFilePath: path.join(agent, 'cron.sqlite') }); gateway.testAccess = access;
    const app = require('express')(); access.mount(app); app.use(require('express').json({ limit: '32mb' })); gateway.mount(app);
    server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`; process.env.PI_WORKSPACE_INTERNAL_ORIGIN = origin;
    assert.equal((await write('/settings', { enabled: true, mainModel: { provider: 'fixture', modelId: 'vision' }, extractionModel: { provider: 'fixture', modelId: 'vision' } }, 'PUT')).status, 200);
});
test.after(async () => { if(!gatewayClosed)await gateway?.dispose(); gateway?.testAccess.dispose(); server?.closeAllConnections(); provider?.closeAllConnections(); await Promise.all([server, provider].filter(Boolean).map(s => new Promise(r => s.close(r)))); fs.rmSync(root, { recursive: true, force: true }); });
test('configured recognition sends only a bounded authorized raster and returns schema-checked date evidence with unknown bill', async () => {
    const canvas = require('@napi-rs/canvas').createCanvas(100, 80); canvas.getContext('2d').fillRect(2, 2, 20, 20);
    const project = await archive(canvas.toBuffer('image/png'));
    const result = await write(`/projects/${project.id}/batches`); assert.equal(result.status, 200, JSON.stringify(result.data)); const batch = result.data.batch;
    assert.equal(batch.fields.find(f => f.key === 'date')?.raw, '2026-08-31');
    assert.equal(batch.fields.find(f => f.key === 'date').location.page, 1);
    assert.equal(batch.execution.usage.modelCalls, 1); assert.equal(batch.execution.usage.cost.actual, null);
    assert.equal(batch.execution.status, 'completed'); assert.equal(calls.length, 1);
    const payload = calls[0]; assert.equal(payload.tools?.length || 0, 0);
    assert.ok(payload.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image_url' && c.image_url.url.startsWith('data:image/png;base64,'))));
    assert.deepEqual((await call('GET', `/batches/${batch.id}`)).data.batch, batch);
});
test('model-call budget pauses before the next request and an explicit allowance continues only the unstarted page', async () => {
    const canvas = require('@napi-rs/canvas').createCanvas(100, 80); canvas.getContext('2d').fillRect(4, 2, 20, 20);
    const project = await archive(canvas.toBuffer('image/png'));
    canvas.getContext('2d').fillRect(30, 2, 20, 20);
    const doc = (await write(`/projects/${project.id}/documents`, { sources: [{ kind:'upload', name:'通知书.png', base64:canvas.toBuffer('image/png').toString('base64') }] })).data.documents[0];
    await write(`/documents/${doc.id}/assignment`, { role:'award-notice', identityConfirmed:true, selected:true }, 'PUT');
    const before = calls.length, input = { requestId:'budget-run', expectedRevision:revision, budget:{pages:20,modelCalls:1,runMs:600000} };
    const result = await call('POST', `/projects/${project.id}/batches`, input); assert.equal(result.status,200,JSON.stringify(result.data));
    const batch = result.data.batch; assert.equal(batch.execution.status,'paused'); assert.equal(batch.execution.reason,'budget-modelCalls'); assert.equal(calls.length,before+1);
    assert.equal(batch.execution.usage.modelCalls,1); assert.equal(batch.results.find(r=>r.id==='contract-deadline').conclusion,'insufficient');
    const repeat = await call('POST', `/projects/${project.id}/batches`, input); assert.deepEqual(repeat.data,result.data); assert.equal(calls.length,before+1);
    await call('GET','');
    const continued = await write(`/batches/${batch.id}/continue`, { budget:{pages:1,modelCalls:1,runMs:60000} }); assert.equal(continued.status,200,JSON.stringify(continued.data));
    assert.equal(continued.data.batch.execution.status,'completed'); assert.equal(continued.data.batch.execution.usage.modelCalls,2); assert.equal(calls.length,before+2);
    assert.equal(continued.data.batch.results.find(r=>r.id==='contract-deadline').conclusion,'passed');
});

test('a schema-rejected recognition keeps provider-reported tokens instead of losing the completed request usage',async()=>{
    const canvas=require('@napi-rs/canvas').createCanvas(100,80);canvas.getContext('2d').fillRect(12,12,22,22);
    const project=await archive(canvas.toBuffer('image/png'));
    responseText='not valid JSON';responseUsage={prompt_tokens:17,completion_tokens:9,total_tokens:26};
    try {
        const result=await write(`/projects/${project.id}/batches`); assert.equal(result.status,200,JSON.stringify(result.data));
        const batch=result.data.batch;assert.equal(batch.execution.status,'failed');assert.equal(batch.execution.steps[0].code,'COMPLIANCE_MODEL_SCHEMA');
        assert.equal(batch.execution.usage.modelCalls,1);assert.equal(batch.execution.usage.inputTokens,17);assert.equal(batch.execution.usage.outputTokens,9);
        assert.equal((await call('GET',`/batches/${batch.id}`)).data.batch.execution.usage.inputTokens,17);assert.equal(batch.execution.usage.cost.actual,null);
    } finally {responseText=undefined;responseUsage=undefined;}
});
test('a paused scan retains human input and conclusion history while later recognition fills original evidence for the composed report', {timeout:180000}, async () => {
    await call('GET',''); const session=(await write('/sessions',{cwd})).data;
    const canvas=require('@napi-rs/canvas').createCanvas(100,80);canvas.getContext('2d').fillRect(5,20,20,20);const project=await archive(canvas.toBuffer('image/png'));
    canvas.getContext('2d').fillRect(35,20,20,20);
    const doc=(await write(`/projects/${project.id}/documents`,{sources:[{kind:'upload',name:'待执行通知书.png',base64:canvas.toBuffer('image/png').toString('base64')}]})).data.documents[0];
    await write(`/documents/${doc.id}/assignment`,{role:'award-notice',identityConfirmed:true,selected:true},'PUT');
    let batch=(await write(`/projects/${project.id}/batches`,{budget:{pages:5,modelCalls:1,runMs:600000}})).data.batch;
    assert.equal(batch.execution.status,'paused');
    const prepare=async change=>{await call('GET','');const prepared=await write(`/batches/${batch.id}/review-proposals`,{cwd,sessionId:session.id,batchRevision:batch.revision,change});assert.equal(prepared.status,200,JSON.stringify(prepared.data));return prepared.data.proposal;};
    const confirm=async card=>{await call('GET','');const result=await write(`/review-proposals/${card.id}/confirm`,{cwd,sessionId:session.id,contentHash:card.contentHash});assert.equal(result.status,200,JSON.stringify(result.data));batch=result.data.batch;};
    await confirm(await prepare({kind:'field',documentId:doc.id,key:'date',raw:'2026-08-01',location:{page:1,region:'body',excerpt:'人工查看通知书日期'},reason:'先核对未执行原件的日期'}));
    const manualId=batch.fields.find(f=>f.documentId===doc.id&&f.key==='date').id;
    await confirm(await prepare({kind:'conclusion',resultId:'contract-deadline',conclusion:'insufficient',reason:'继续识别前保留人工决定'}));
    const decidedRevision=batch.revision;await call('GET','');const result=await write(`/batches/${batch.id}/continue`,{budget:{pages:1,modelCalls:1,runMs:60000}});assert.equal(result.status,200,JSON.stringify(result.data));batch=result.data.batch;
    const field=batch.fields.find(f=>f.documentId===doc.id&&f.key==='date');
    assert.equal(field.id,manualId); assert.equal(field.humanValue.raw,'2026-08-01'); assert.equal(field.raw,'2026-08-31','the actual later OCR candidate fills original evidence without replacing the human value');
    assert.equal(field.status,'known'); assert.equal(field.location.page,1);assert.equal(batch.execution.status,'completed');
    assert.ok(batch.history.some(h=>h.revision===decidedRevision&&h.results.some(r=>r.humanDecision?.reason==='继续识别前保留人工决定')));
    assert.equal(batch.results.find(r=>r.id==='contract-deadline').conclusion,'passed');
    await confirm(await prepare({kind:'conclusion',resultId:'contract-deadline',conclusion:'passed',reason:'最终核对三十自然日'}));
    await call('GET',''); const generated=await write(`/batches/${batch.id}/reports`,{batchRevision:batch.revision});assert.equal(generated.status,200,JSON.stringify(generated.data));
    const html=(await call('GET',`/reports/${generated.data.report.id}/files/0`)).data.content;
    for(const text of ['2026-08-31','2026-08-01','最终核对三十自然日','继续识别前保留人工决定'])assert.ok(html.includes(text),text);
    const api=async(method,route,input)=>{const response=await fetch(origin+'/api/pi'+route,{method,headers:{Authorization:'Bearer synthetic-scans','Content-Type':'application/json'},body:input&&JSON.stringify(input)});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;};
    const worker=await gateway.supervisor.getWorker({cwd,sessionId:session.id,sessionPath:session.path});
    await call('GET','');const deliveryInput={cwd,sessionId:session.id,requestId:'composed-delivery',expectedRevision:revision};
    const delivered=await write(`/reports/${generated.data.report.id}/delivery`,deliveryInput);assert.equal(delivered.status,200,JSON.stringify(delivered.data));assert.equal(delivered.data.report.status,'delivered');
    assert.equal((await write(`/reports/${generated.data.report.id}/delivery`,deliveryInput)).status,200);
    const reference=delivered.data.report.delivery.reference;
    assert.equal((await worker.request('get_entries')).entries.filter(e=>e.customType==='pivane-deliverable'&&e.data.id===reference.id).length,1);
    const artifacts=await api('GET','/artifacts?'+new URLSearchParams({cwd,sessionId:session.id})),group=artifacts.items.find(i=>i.files.some(f=>f.name===generated.data.report.files[0].name));assert.ok(group);
    const saved=await api('POST','/artifacts/batch',{requestId:'composed-save',action:'save',files:group.files.map(f=>({key:f.key}))});assert.ok(saved.results.every(r=>r.ok));
    await call('GET','');assert.equal((await write('/settings',{enabled:false},'PUT')).status,200);assert.equal((await api('GET','/artifacts/'+saved.results[0].item.key+'/preview')).content,html);
    composed={batchId:batch.id,reportId:generated.data.report.id,libraryId:saved.results[0].item.key,html};
    await call('GET','');assert.equal((await write('/settings',{enabled:true},'PUT')).status,200);
});
test('image-only PDF is rendered in the shared isolated pool and its actual page reaches the configured provider', async () => {
    const { scannedPdf } = require('./compliance-fixtures.cjs');
    const project = await archive(scannedPdf(), '扫描合同.pdf'), before = calls.length;
    const checked = await write(`/projects/${project.id}/batches`); assert.equal(checked.status,200,JSON.stringify(checked.data));
    assert.equal(checked.data.batch.fields.find(f=>f.key==='date')?.raw,'2026-08-31',JSON.stringify(checked.data.batch.documents));
    assert.equal(calls.length,before+1); assert.equal(checked.data.batch.execution.usage.pages,2);
});
test('disable is accepted during an actual model request, drains it and never launches the following document', async () => {
    const canvas=require('@napi-rs/canvas').createCanvas(100,80);canvas.getContext('2d').fillRect(10,10,10,10);
    const project=await archive(canvas.toBuffer('image/png'));canvas.getContext('2d').fillRect(40,10,10,10);
    const doc=(await write(`/projects/${project.id}/documents`,{sources:[{kind:'upload',name:'第二页.png',base64:canvas.toBuffer('image/png').toString('base64')}]})).data.documents[0];
    await write(`/documents/${doc.id}/assignment`,{role:'award-notice',identityConfirmed:true,selected:true},'PUT');
    holdNext=true;const observed=new Promise(resolve=>{held=resolve;});const before=calls.length;
    const pending=write(`/projects/${project.id}/batches`,{requestId:'held-check'});await observed;
    await call('GET','');const disabled=await write('/settings',{enabled:false},'PUT');assert.equal(disabled.status,200,JSON.stringify(disabled.data));assert.equal(disabled.data.status,'disabling');
    const activity=await (await fetch(origin+'/api/pi/activity',{headers:{Authorization:'Bearer synthetic-scans'}})).json();assert.equal(activity.complianceBusy,true);
    assert.equal((await write(`/projects/${project.id}/batches`)).status,409);
    await call('GET','');assert.equal((await write('/settings',{enabled:true},'PUT')).status,200,'re-enabling must not silently resume a batch already asked to pause');
    release();const result=await pending;assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.batch.execution.status,'paused');assert.equal(result.data.batch.execution.reason,'disabled');assert.equal(calls.length,before+1);
    assert.equal((await call('GET','')).data.status,'enabled');assert.equal(result.data.batch.execution.steps.filter(s=>s.status==='completed').length,1);
});
test('a hard service restart preserves the running request as uncertain and never resends it on reads or continue', async () => {
    const recoveryAgent=path.join(root,'recovery-agent');fs.mkdirSync(recoveryAgent);
    for(const name of ['settings.json','models.json'])fs.copyFileSync(path.join(agent,name),path.join(recoveryAgent,name));
    const originalOrigin=origin,originalRevision=revision;let child;
    const start=async()=>{child=require('node:child_process').fork(path.join(__dirname,'compliance-service-fixture.cjs'),[],{env:{...process.env,PI_CODING_AGENT_DIR:recoveryAgent},execArgv:[],stdio:['ignore','ignore','pipe','ipc']});let error='';child.stderr.on('data',c=>{error+=c;}); const message=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error(error||'fixture exited');})]);origin=message[0].origin;};
    try {
        await start();revision=0;assert.equal((await write('/settings',{enabled:true,mainModel:{provider:'fixture',modelId:'vision'},extractionModel:{provider:'fixture',modelId:'vision'}},'PUT')).status,200);
        const canvas=require('@napi-rs/canvas').createCanvas(100,80);canvas.getContext('2d').fillRect(15,15,30,30);const project=await archive(canvas.toBuffer('image/png'));
        holdNext=true;const observed=new Promise(resolve=>{held=resolve;});const input={requestId:'restart-request',expectedRevision:revision};const before=calls.length;
        const pending=call('POST',`/projects/${project.id}/batches`,input).catch(()=>null);await observed;
        const batchId=(await call('GET','/operations/restart-request')).data.batchId;
        child.kill();await once(child,'exit');await pending;release();
        await start();const batch=(await call('GET',`/batches/${batchId}`)).data.batch;
        assert.equal(batch.execution.status,'needs-review');assert.equal(batch.execution.reason,'restart');assert.equal(batch.execution.steps[0].status,'uncertain');assert.equal(batch.execution.usage.modelCalls,1);
        const recovered=await call('POST',`/projects/${project.id}/batches`,input);assert.equal(recovered.status,200,JSON.stringify(recovered.data));assert.equal(recovered.data.status,'pending');
        await call('GET','');const continued=await write(`/batches/${batchId}/continue`,{budget:{pages:1,modelCalls:1,runMs:60000}});assert.equal(continued.status,200,JSON.stringify(continued.data));
        assert.equal(continued.data.batch.execution.status,'needs-review');assert.equal(calls.length,before+1);assert.equal(continued.data.batch.results.find(r=>r.id==='contract-deadline').conclusion,'insufficient');
    } finally { if(child?.connected){child.send('close');await once(child,'exit');}else if(child?.exitCode===null){child.kill();await once(child,'exit');} origin=originalOrigin;revision=originalRevision; }
});
test('a real managed dedicated worker can request a budgeted scan and the provider captures a separate tool-free image request', {timeout:180000}, async () => {
    await call('GET','');const session=(await write('/sessions',{cwd})).data;
    const canvas=require('@napi-rs/canvas').createCanvas(100,80);canvas.getContext('2d').fillRect(20,20,20,20);const project=await archive(canvas.toBuffer('image/png'));
    nativeArguments={action:'run',projectId:project.id,requestId:'native-scan-check',expectedRevision:revision,budget:{pages:3,modelCalls:1,runMs:60000}};
    const worker=await gateway.supervisor.getWorker({cwd,sessionId:session.id,sessionPath:session.path});
    let off,timer;const done=new Promise((resolve,reject)=>{off=worker.subscribe(event=>{if(event.type==='agent_settled')resolve();});timer=setTimeout(()=>reject(new Error('native scan did not settle')),60000);});
    try{await worker.request('prompt',{message:'fixture native_scan'});await done;}finally{off();clearTimeout(timer);}
    const entry=(await worker.request('get_entries')).entries.findLast(e=>e.message?.toolName==='compliance_check')?.message;
    assert.ok(entry&&!entry.isError,JSON.stringify(entry));const result=entry.details.pivaneCompliance;assert.equal(result.execution.usage.modelCalls,1);assert.equal(result.execution.budget.modelCalls,1);
    assert.equal((await call('GET',`/batches/${result.batchId}`)).data.batch.fields.find(f=>f.key==='date').raw,'2026-08-31');
    assert.ok(calls.some(p=>p.tools?.some(t=>t.function?.name==='compliance_check')));
    assert.ok(calls.some(p=>!(p.tools?.length)&&p.messages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='image_url'))));
});
test('unconfigured scans retain text checks but still reject a damaged original instead of hiding the read failure',async()=>{
    await call('GET','');await write('/settings',{enabled:true,extractionModel:null},'PUT');
    const canvas=require('@napi-rs/canvas').createCanvas(100,80);canvas.getContext('2d').fillRect(50,20,20,20);const project=await archive(canvas.toBuffer('image/png'));
    const document=(await call('GET',`/projects/${project.id}/documents`)).data.documents[0];fs.writeFileSync(path.join(agent,'pivane-compliance',document.hash+'.bin'),'damaged');
    const before=calls.length,result=await write(`/projects/${project.id}/batches`);assert.equal(result.status,200);assert.equal(result.data.batch.execution.status,'failed');assert.equal(calls.length,before);
    await write('/settings',{enabled:true,extractionModel:{provider:'fixture',modelId:'vision'}},'PUT');
});
test('unified shutdown waits for the actual recognition request and preserves its final checkpoint before releasing the identity',async()=>{
    const canvas=require('@napi-rs/canvas').createCanvas(100,80);canvas.getContext('2d').fillRect(70,40,20,20);const project=await archive(canvas.toBuffer('image/png'));
    holdNext=true;const observed=new Promise(resolve=>{held=resolve;});const pending=write(`/projects/${project.id}/batches`,{requestId:'shutdown-request'});await observed;
    let finished=false;const closing=gateway.dispose().then(()=>{finished=true;gatewayClosed=true;});
    try{await new Promise(resolve=>setTimeout(resolve,80));assert.equal(finished,false,'shutdown cannot report completion while the provider request is still held');}
    finally{release();}
    const result=await pending;await closing;assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.batch.execution.steps[0].status,'completed');
    assert.equal((await call('GET',`/batches/${result.data.batch.id}`)).data.batch.execution.status,'completed');
    assert.ok(composed,'the complete human-to-independent-report chain ran before restart');
    let child;const originalOrigin=origin;
    try{
        child=require('node:child_process').fork(path.join(__dirname,'compliance-service-fixture.cjs'),[],{env:{...process.env},execArgv:[],stdio:['ignore','inherit','inherit','ipc']});origin=(await once(child,'message'))[0].origin;
        const restored=(await call('GET',`/batches/${composed.batchId}`)).data.batch;assert.equal(restored.results.find(r=>r.id==='contract-deadline').humanDecision.reason,'最终核对三十自然日');
        await call('GET','');assert.equal((await write('/settings',{enabled:false},'PUT')).status,200);
        const preview=await fetch(origin+'/api/pi/artifacts/'+composed.libraryId+'/preview',{headers:{Authorization:'Bearer synthetic-scans'}});assert.equal(preview.status,200);assert.equal((await preview.json()).content,composed.html);
        assert.ok((await call('GET',`/reports/${composed.reportId}`)).data.report.savedFiles.every(Boolean));
    }finally{if(child?.connected){child.send('close');await once(child,'exit');}origin=originalOrigin;}
});
