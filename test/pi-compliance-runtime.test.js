const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-compliance-rpc-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1'; process.env.PI_WEB_DEFERRED_FILE = path.join(agent, 'deferred.json');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test('managed compliance tools and four skills reach only verified dedicated sessions, including actual provider payloads', { timeout: 300000 }, async () => {
    const calls = []; let createArguments, operation;
    const provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); calls.push(body);
        const triggerIndex = body.messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message).includes('fixture '));
        const trigger = triggerIndex >= 0 && !body.messages.slice(triggerIndex + 1).some(message => message.role === 'tool') ? body.messages[triggerIndex] : {};
        const wantsCreate = JSON.stringify(trigger).includes('fixture create project');
        const wantsList = JSON.stringify(trigger).includes('fixture list projects');
        const wantsOperation = JSON.stringify(trigger).includes('fixture operate');
        const delta = wantsCreate ? { role: 'assistant', tool_calls: [{ index: 0, id: 'create-project', type: 'function', function: { name: 'compliance_project', arguments: JSON.stringify(createArguments) } }] }
            : wantsList ? { role: 'assistant', tool_calls: [{ index: 0, id: 'list-projects', type: 'function', function: { name: 'compliance_project', arguments: JSON.stringify({ action: 'list' }) } }] }
            : wantsOperation ? { role: 'assistant', tool_calls: [{ index: 0, id: 'operation-' + calls.length, type: 'function', function: { name: operation.name, arguments: JSON.stringify(operation.input) } }] } : { role: 'assistant', content: 'Fixture complete.' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: wantsCreate || wantsList || wantsOperation ? 'tool_calls' : 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'text', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: ['text','selected'].map(id=>({id,input:['text'],contextWindow:32000,maxTokens:1000})) } } }));
    const { createPiAgentGateway } = require('../server/pi-agent-routes'), { WorkspaceAccessService } = require('../server/workspace-access-service');
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => 'fixture-compliance-token' });
    const gateway = createPiAgentGateway({ accessService: access, deferredFilePath: path.join(agent, 'deferred.json'), cronFilePath: path.join(agent, 'cron.sqlite') });
    const app = require('express')(); access.mount(app); app.use(require('express').json()); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`; process.env.PI_WORKSPACE_INTERNAL_ORIGIN = origin;
    const api = async (method, route, body) => {
        const res = await fetch(origin + '/api/pi' + route, { method, headers: { Authorization: 'Bearer fixture-compliance-token', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        assert.equal(res.status, 200, route); return res.json();
    };
    const workerFor = async session => gateway.supervisor.getWorker({ cwd, sessionId: session.id, sessionPath: session.path });
    const prompt = async (worker, message) => {
        let off, timer; const done = new Promise((resolve, reject) => { off = worker.subscribe(event => { if (event.type === 'agent_settled') resolve(); }); timer = setTimeout(() => reject(new Error('Fixture did not settle')), 20000); });
        try { await worker.request('prompt', { message }); await done; } finally { off(); clearTimeout(timer); }
        return calls.at(-1);
    };
    const resources = async worker => worker.getNativeResources();
    const noCompliance = payload => {
        assert.ok(!(payload.tools || []).some(tool => tool.function?.name?.startsWith('compliance_')));
        const system = payload.messages.filter(message => message.role === 'system').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
        const unexpected = /<name>compliance-(?:materials|checks|review|reports)<\/name>|pi-packages[\\/]compliance[\\/]skills|Read and maintain the engineering project/.exec(system);
        assert.equal(Boolean(unexpected), false, unexpected && system.slice(Math.max(0, unexpected.index - 180), unexpected.index + 250));
    };
    try {
        const initial = await api('GET', '/compliance'); assert.equal(initial.enabled, false);
        const ordinary = await gateway.store.createSession(cwd, 'Ordinary', { agentProfileId: null });
        const normalWorker = await workerFor(ordinary); noCompliance(await prompt(normalWorker, 'fixture ordinary before enable'));
        const enabled = await api('PUT', '/compliance/settings', { requestId: 'enable', expectedRevision: initial.revision, enabled: true, mainModel: { provider: 'fixture', modelId: 'text' } });
        await normalWorker.reloadResources(); noCompliance(await prompt(normalWorker, 'fixture ordinary after enable'));
        assert.equal((await resources(normalWorker)).skills.filter(skill => skill.name.startsWith('compliance-')).length, 0);
        const dedicated = await api('POST', '/compliance/sessions', { cwd, requestId: 'dedicated', expectedRevision: enabled.revision });
        assert.equal((await api('POST', '/compliance/sessions', { cwd, requestId: 'dedicated', expectedRevision: enabled.revision })).id, dedicated.id);
        assert.equal((await api('GET', '/sessions?cwd=' + encodeURIComponent(cwd))).sessions.filter(session => session.agentProfile?.id === enabled.profileId).length, 1);
        const worker = await workerFor(dedicated), inventory = await resources(worker);
        assert.ok(inventory.tools.some(tool => tool.name === 'compliance_project'));
        assert.ok(inventory.tools.some(tool => tool.name === 'compliance_review'), 'dedicated worker exposes prepare/query review tool');
        assert.deepEqual(inventory.skills.filter(skill => skill.name.startsWith('compliance-')).map(skill => skill.name).sort(), ['compliance-checks', 'compliance-materials', 'compliance-reports', 'compliance-review']);
        createArguments = { action: 'create', requestId: 'rpc-create', expectedRevision: (await api('GET', '/compliance')).revision, project: { name: 'RPC 工程', identityConfirmed: false } };
        await prompt(worker, 'fixture create project');
        const entries = (await worker.request('get_entries')).entries;
        const result = entries.find(entry => entry.message?.role === 'toolResult' && entry.message.toolName === 'compliance_project')?.message;
        assert.ok(result && !result.isError, JSON.stringify(result));
        const project = result.details.pivaneCompliance.project; assert.equal(project.name, 'RPC 工程'); assert.equal(project.number, null);
        await prompt(worker, 'fixture list projects');
        const listing = (await worker.request('get_entries')).entries.findLast(entry => entry.message?.role === 'toolResult' && entry.message.toolName === 'compliance_project')?.message.details.pivaneCompliance;
        assert.equal(listing.total, 1); assert.equal(listing.nextOffset, null);
        assert.deepEqual(Object.keys(listing.projects[0]).sort(), ['id', 'name', 'number', 'revision']);
        assert.ok(calls.some(payload => JSON.stringify(payload.tools).includes('compliance_project') && JSON.stringify(payload.messages).includes('compliance-materials')));
        fs.writeFileSync(path.join(cwd, '资料.csv'), '项目名称,日期\nRPC 工程,2026-08-01\n');
        operation = { name: 'compliance_materials', input: { action: 'import', projectId: project.id, requestId: 'rpc-import', expectedRevision: (await api('GET', '/compliance')).revision, sources: [{ kind: 'file', path: '资料.csv' }] } };
        await prompt(worker, 'fixture operate import');
        let materialResult = (await worker.request('get_entries')).entries.findLast(entry => entry.message?.toolName === 'compliance_materials')?.message;
        assert.ok(materialResult && !materialResult.isError, JSON.stringify(materialResult));
        const importedId = materialResult.details.pivaneCompliance.documents[0].id; assert.ok(importedId);
        const docs = await api('GET', '/compliance/projects/' + project.id + '/documents'); assert.equal(docs.documents[0].id, importedId);
        await api('PUT', '/compliance/documents/' + importedId + '/assignment', { requestId: 'rpc-assign', expectedRevision: docs.revision, role: 'contract', identityConfirmed: true, selected: true });
        await worker.request('set_model',{provider:'fixture',modelId:'selected'});
        operation = { name: 'compliance_check', input: { action: 'run', projectId: project.id, requestId: 'rpc-check', expectedRevision: (await api('GET', '/compliance')).revision } };
        await prompt(worker, 'fixture operate check');
        const checkResult = (await worker.request('get_entries')).entries.findLast(entry => entry.message?.toolName === 'compliance_check')?.message;
        assert.ok(checkResult && !checkResult.isError, JSON.stringify(checkResult)); assert.ok(checkResult.details.pivaneCompliance.batchId);
        const reviewBatch = (await api('GET', '/compliance/batches/' + checkResult.details.pivaneCompliance.batchId)).batch;
        assert.deepEqual(reviewBatch.configurationSnapshot.mainModel,{provider:'fixture',modelId:'selected'});
        assert.equal(reviewBatch.configurationSnapshot.mainModelSource,'native-session');
        const httpBatch=(await api('POST','/compliance/projects/'+project.id+'/batches',{requestId:'http-selected-model',expectedRevision:(await api('GET','/compliance')).revision,cwd,sessionId:dedicated.id})).batch;
        assert.deepEqual(httpBatch.configurationSnapshot.mainModel,{provider:'fixture',modelId:'selected'});
        const unknownBatch=(await api('POST','/compliance/projects/'+project.id+'/batches',{requestId:'http-unknown-model',expectedRevision:(await api('GET','/compliance')).revision})).batch;
        assert.equal(unknownBatch.configurationSnapshot.mainModel,null);assert.equal(unknownBatch.configurationSnapshot.mainModelSource,'unknown');
        operation = { name: 'compliance_review', input: { action: 'prepare', batchId: reviewBatch.id, batchRevision: reviewBatch.revision, requestId: 'rpc-review', expectedRevision: (await api('GET', '/compliance')).revision,
            change: { kind: 'field', documentId: importedId, key: 'date', raw: '2026-08', location: { sheet: 'CSV', row: 2, column: 2, excerpt: '日期列，原件只写到月' }, reason: '建议保留原件月份精度，等待用户确认' } } };
        await prompt(worker, 'fixture operate prepare review');
        const preparedReview = (await worker.request('get_entries')).entries.findLast(entry => entry.message?.toolName === 'compliance_review')?.message;
        assert.ok(preparedReview && !preparedReview.isError, JSON.stringify(preparedReview)); const reviewCard = preparedReview.details.pivaneCompliance.proposal;
        assert.equal(reviewCard.origin.sessionId, dedicated.id); assert.equal(reviewCard.change.precision, 'month');
        assert.equal((await api('GET', '/compliance/batches/' + reviewBatch.id)).batch.fields.some(field => field.humanValue), false, 'model preparation is not human confirmation');
        operation = { name: 'compliance_review', input: { action: 'confirm', proposalId: reviewCard.id, requestId: 'model-confirms', expectedRevision: (await api('GET', '/compliance')).revision } };
        await prompt(worker, 'fixture operate forbidden confirm');
        const modelConfirmation = (await worker.request('get_entries')).entries.findLast(entry => entry.message?.toolName === 'compliance_review')?.message; assert.equal(modelConfirmation.isError, true);
        const forged = await fetch(origin + '/api/pi/compliance/review-proposals/' + reviewCard.id + '/confirm', { method: 'POST', headers: { Authorization: 'Bearer ' + worker.navigationToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'forged-http-confirm', expectedRevision: (await api('GET', '/compliance')).revision, contentHash: reviewCard.contentHash, cwd, sessionId: dedicated.id }) }); assert.equal(forged.status, 401);
        await api('POST', '/compliance/review-proposals/' + reviewCard.id + '/confirm', { requestId: 'actual-human-confirm', expectedRevision: (await api('GET', '/compliance')).revision, contentHash: reviewCard.contentHash, cwd, sessionId: dedicated.id });
        operation = { name: 'compliance_review', input: { action: 'operation', requestId: 'actual-human-confirm' } }; await prompt(worker, 'fixture operate query human receipt');
        const humanReceipt = (await worker.request('get_entries')).entries.findLast(entry => entry.message?.toolName === 'compliance_review')?.message;
        assert.ok(humanReceipt && !humanReceipt.isError, JSON.stringify(humanReceipt)); assert.equal(humanReceipt.details.pivaneCompliance.proposalId, reviewCard.id);
        assert.match(reviewCard.origin.nativeKey,/^[a-f0-9]{64}$/);
        const image=require('@napi-rs/canvas').createCanvas(60,40);image.getContext('2d').fillRect(5,5,20,20);fs.writeFileSync(path.join(cwd,'批复首页.png'),image.toBuffer('image/png'));
        const absenceDoc=(await api('POST','/compliance/projects/'+project.id+'/documents',{requestId:'absence-original',expectedRevision:(await api('GET','/compliance')).revision,cwd,sources:[{kind:'file',path:'批复首页.png'}]})).documents[0];
        await api('PUT','/compliance/documents/'+absenceDoc.id+'/assignment',{requestId:'absence-assignment',expectedRevision:(await api('GET','/compliance')).revision,role:'feasibility-approval',identityConfirmed:true,selected:true});
        const absenceBatch=(await api('POST','/compliance/projects/'+project.id+'/batches',{requestId:'absence-batch',expectedRevision:(await api('GET','/compliance')).revision})).batch;
        operation={name:'compliance_review',input:{action:'prepare',batchId:absenceBatch.id,batchRevision:absenceBatch.revision,requestId:'native-absence-card',expectedRevision:(await api('GET','/compliance')).revision,change:{kind:'field',documentId:absenceDoc.id,key:'documentNumber',raw:null,absent:true,location:{page:1,region:'upper',excerpt:'人工待核对的发文首页上方'},reason:'只准备明确缺失候选，模型不作人工确认'}}};
        await prompt(worker,'fixture operate explicit absence');const absentResult=(await worker.request('get_entries')).entries.findLast(e=>e.message?.toolName==='compliance_review')?.message;assert.ok(absentResult&&!absentResult.isError,JSON.stringify(absentResult));
        const absentCard=absentResult.details.pivaneCompliance.proposal;assert.equal(absentCard.change.raw,null);assert.equal(absentCard.change.absent,true);assert.equal(absentCard.origin.nativeKey,reviewCard.origin.nativeKey);
        const absenceConfirmed=await api('POST','/compliance/review-proposals/'+absentCard.id+'/confirm',{requestId:'human-absence-confirm',expectedRevision:(await api('GET','/compliance')).revision,contentHash:absentCard.contentHash,cwd,sessionId:dedicated.id});assert.equal(absenceConfirmed.batch.fields.find(f=>f.documentId===absenceDoc.id&&f.key==='documentNumber').humanValue.status,'absent');
        assert.ok(calls.some(payload => JSON.stringify(payload.tools).includes('compliance_materials') && JSON.stringify(payload.tools).includes('compliance_check')));
        operation = { name:'compliance_project',input:{action:'update',projectId:project.id,requestId:'spoof-confirmation',expectedRevision:(await api('GET','/compliance')).revision,project:{name:project.name,identityConfirmed:true,applicability:{'contract-deadline':true}}} };
        await prompt(worker,'fixture operate spoof confirmation');
        const spoof=(await worker.request('get_entries')).entries.findLast(entry=>entry.message?.toolName==='compliance_project')?.message; assert.equal(spoof.isError,true);
        assert.equal((await api('GET','/compliance/projects/'+project.id)).project.identityConfirmed,false);
        const { labeledPdf }=require('./compliance-fixtures.cjs');
        const dense=labeledPdf(Array.from({length:4000},(_,i)=>({text:'Office fixture line '+i,x:20,y:760-(i%60)*10})));
        const uploaded=await fetch(origin+'/api/pi/uploads?'+new URLSearchParams({cwd,sessionId:dedicated.id,requestId:'rpc-pdf',name:'密集文本.pdf'}),{method:'POST',headers:{Authorization:'Bearer fixture-compliance-token','Content-Type':'application/octet-stream'},body:dense}); const attachment=await uploaded.json(); assert.equal(uploaded.status,200,JSON.stringify({bytes:dense.length,...attachment}));
        operation={name:'read_document',input:{id:attachment.reference.id,action:'read',start:1,count:10}};
        await prompt(worker,'fixture operate read ordinary PDF\n'+attachment.marker);
        const readEntries=(await worker.request('get_entries')).entries, read=readEntries.findLast(entry=>entry.message?.toolName==='read_document')?.message; assert.ok(read&&!read.isError,JSON.stringify({read,tools:readEntries.map(e=>e.message?.toolName).filter(Boolean),last:calls.at(-1)?.messages?.at(-1)}));
        assert.match(read.details.pivaneDocument.items[0].text,/Office fixture/); assert.equal(read.details.pivaneDocument.items[0].runs,undefined,'ordinary public read keeps its old bounded text shape');
        operation={name:'compliance_materials',input:{action:'import',projectId:project.id,requestId:'rpc-import-attachment',expectedRevision:(await api('GET','/compliance')).revision,sources:[{kind:'attachment',id:attachment.reference.id}]}};
        await prompt(worker,'fixture operate current branch attachment');
        const attached=(await worker.request('get_entries')).entries.findLast(entry=>entry.message?.toolName==='compliance_materials')?.message; assert.ok(attached&&!attached.isError,JSON.stringify(attached));
        assert.equal(attached.details.pivaneCompliance.documents.length,1);
        const forbidden = await fetch(origin + '/api/pi/compliance/tool', { method: 'POST', headers: { Authorization: 'Bearer ' + normalWorker.navigationToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'list' }) }); assert.equal(forbidden.status, 403);
        const saved = await api('GET', '/compliance');
        await api('PUT', '/compliance/settings', { requestId: 'disable', expectedRevision: saved.revision, enabled: false });
        const disabledCall = await prompt(worker, 'fixture after disable');
        assert.ok(!(disabledCall.tools || []).some(tool => tool.function?.name === 'compliance_project'));
        await worker.reloadResources(); assert.equal((await resources(worker)).skills.filter(skill => skill.name.startsWith('compliance-')).length, 0);
        noCompliance(await prompt(normalWorker,'fixture ordinary after disable'));
        assert.ok((await normalWorker.request('get_entries')).entries.some(entry=>entry.message?.role==='user'&&JSON.stringify(entry.message).includes('fixture ordinary before enable')),'existing native user history remains');
        assert.equal((await api('GET', '/compliance/projects')).projects[0].id, project.id);
    } finally {
        await gateway.dispose(); access.dispose(); server.closeAllConnections(); provider.closeAllConnections();
        await Promise.all([new Promise(r => server.close(r)), new Promise(r => provider.close(r))]);
    }
});

// Preserve native LF bytes and all unrelated frames. Delay only the real model
// acknowledgement; no worker, provider result or state is substituted.
function holdModelResponse(worker,command='set_model') {
    const stream=worker.client.child.stdout, emit=stream.emit;let buffer=Buffer.alloc(0),held,resolve,reject;
    const reached=new Promise((yes,no)=>{resolve=yes;reject=no;}), timer=setTimeout(()=>reject(new Error('actual set_model response not observed')),15000);
    stream.emit=function(event,...args){
        if(event!=='data')return emit.call(this,event,...args);
        buffer=Buffer.concat([buffer,Buffer.from(args[0])]);let end;
        while((end=buffer.indexOf(10))>=0){const line=buffer.subarray(0,end+1);buffer=buffer.subarray(end+1);let value;try{value=JSON.parse(line.toString('utf8'));}catch{}
            if(!held&&value?.type==='response'&&value.command===command){held=Buffer.from(line);clearTimeout(timer);resolve();}
            else emit.call(this,'data',line);
        }return true;
    };
    return {reached,release(){clearTimeout(timer);stream.emit=emit;if(held)emit.call(stream,'data',held);if(buffer.length)emit.call(stream,'data',buffer);}};
}

test('HTTP batch creation rejects a real model switch while its native acknowledgement is pending or uncertain', {timeout:180000},async()=>{
    const {createPiAgentGateway}=require('../server/pi-agent-routes'),{WorkspaceAccessService}=require('../server/workspace-access-service');
    const access=new WorkspaceAccessService({filePath:path.join(agent,'access.json'),envToken:()=> 'synthetic-model-boundary'});
    const gateway=createPiAgentGateway({accessService:access,deferredFilePath:path.join(agent,'deferred.json'),cronFilePath:path.join(agent,'cron.sqlite')});
    const app=require('express')();access.mount(app);app.use(require('express').json());gateway.mount(app);
    const server=http.createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;process.env.PI_WORKSPACE_INTERNAL_ORIGIN=origin;let revision=0,gate;
    const call=async(method,route,body)=>{const response=await fetch(origin+'/api/pi/compliance'+route,{method,headers:{Authorization:'Bearer synthetic-model-boundary','Content-Type':'application/json'},body:body&&JSON.stringify(body)});const data=await response.json();if(response.ok&&Number.isSafeInteger(data.revision))revision=data.revision;return {status:response.status,data};};
    const write=(route,body={},method='POST')=>call(method,route,{requestId:require('node:crypto').randomUUID(),expectedRevision:revision,...body});
    try {
        await call('GET','');assert.equal((await write('/settings',{enabled:true},'PUT')).status,200);
        const project=(await write('/projects',{project:{name:'模型选择边界'}})).data.project,session=(await write('/sessions',{cwd})).data;
        const worker=await gateway.supervisor.getWorker({cwd,sessionId:session.id,sessionPath:session.path});
        gate=holdModelResponse(worker);const changing=worker.request('set_model',{provider:'fixture',modelId:'selected'});changing.catch(()=>{});await gate.reached;
        try{const denied=await write('/projects/'+project.id+'/batches',{cwd,sessionId:session.id});assert.equal(denied.status,409,JSON.stringify(denied.data));assert.equal(denied.data.code,'COMPLIANCE_BUSY');}
        finally{gate.release();gate=null;}await changing;
        gate=holdModelResponse(worker,'get_state');const creating=write('/projects/'+project.id+'/batches',{cwd,sessionId:session.id});creating.catch(()=>{});await gate.reached;
        await assert.rejects(worker.request('set_model',{provider:'fixture',modelId:'text'}),/会话操作进行中/);gate.release();gate=null;
        const crossed=await creating;assert.equal(crossed.status,200,JSON.stringify(crossed.data));assert.deepEqual(crossed.data.batch.configurationSnapshot.mainModel,{provider:'fixture',modelId:'selected'},'the existing operation slot excludes a model switch across snapshot admission');
        gate=holdModelResponse(worker);const uncertain=worker.request('set_model',{provider:'fixture',modelId:'selected'},100);uncertain.catch(()=>{});await gate.reached;await assert.rejects(uncertain,{code:'RPC_TIMEOUT'});
        assert.equal((await write('/projects/'+project.id+'/batches',{cwd,sessionId:session.id})).status,409);
        gate.release();gate=null;
        assert.equal((await write('/projects/'+project.id+'/batches',{cwd,sessionId:session.id})).status,409,'a late acknowledgement does not clear the existing uncertain-model latch');
        assert.equal((await call('GET','/projects/'+project.id+'/batches')).data.batches.length,1,'only the admitted locked snapshot creates a batch; pending and uncertain attempts create none');
        await gateway.supervisor.stopSession(session.path);const reopened=await gateway.supervisor.getWorker({cwd,sessionId:session.id,sessionPath:session.path});
        const actual=await reopened.request('get_state');assert.equal(actual.model.provider,'fixture');assert.equal(actual.model.id,'text','a model switch without a native message does not persist across a fresh worker');
        const confirmed=await write('/projects/'+project.id+'/batches',{cwd,sessionId:session.id});assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));assert.deepEqual(confirmed.data.batch.configurationSnapshot.mainModel,{provider:actual.model.provider,modelId:actual.model.id});assert.equal(confirmed.data.batch.configurationSnapshot.mainModelSource,'native-session');assert.equal(confirmed.data.batch.configurationSnapshot.mainModelSessionId,session.id);
    } finally {gate?.release();await gateway.dispose();access.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('batch model admission excludes a real cron start across the snapshot and rejects its native temporary model until restore', {timeout:180000},async()=>{
    const provider=http.createServer(async(req,res)=>{for await(const part of req){}res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'cron-boundary',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'Fixture settled.'},finish_reason:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');});
    provider.listen(0,'127.0.0.1');await once(provider,'listening');
    fs.writeFileSync(path.join(agent,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:'http://127.0.0.1:'+provider.address().port+'/v1',api:'openai-completions',apiKey:'synthetic',models:['text','selected'].map(id=>({id,input:['text'],contextWindow:32000,maxTokens:1000}))}}}));
    const {createPiAgentGateway}=require('../server/pi-agent-routes'),{WorkspaceAccessService}=require('../server/workspace-access-service');
    const access=new WorkspaceAccessService({filePath:path.join(agent,'cron-boundary-access.json'),envToken:()=> 'synthetic-cron-boundary'}),gateway=createPiAgentGateway({accessService:access,deferredFilePath:path.join(agent,'cron-boundary-deferred.json'),cronFilePath:path.join(agent,'cron-boundary.sqlite')});
    const app=require('express')();access.mount(app);app.use(require('express').json());gateway.mount(app);const server=http.createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
    const origin='http://127.0.0.1:'+server.address().port;process.env.PI_WORKSPACE_INTERNAL_ORIGIN=origin;let revision=0,gate,creating;
    const call=async(method,route,body)=>{const response=await fetch(origin+'/api/pi/compliance'+route,{method,headers:{Authorization:'Bearer synthetic-cron-boundary','Content-Type':'application/json'},body:body&&JSON.stringify(body)});const data=await response.json();if(response.ok&&Number.isSafeInteger(data.revision))revision=data.revision;return {status:response.status,data};};
    const write=(route,body={},method='POST')=>call(method,route,{requestId:require('node:crypto').randomUUID(),expectedRevision:revision,...body});
    const finish=async(worker,runId)=>{for(let n=0;n<400;n++){if(!worker.activity.snapshot().busy){const state=await worker.cron({action:'status',runId});if(state?.status==='settled')return worker.cron({action:'finish',runId});}await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('real native cron did not settle');};
    try{
        await call('GET','');await write('/settings',{enabled:true},'PUT');const project=(await write('/projects',{project:{name:'定时模型互斥工程'}})).data.project,session=(await write('/sessions',{cwd})).data,worker=await gateway.supervisor.getWorker({cwd,sessionId:session.id,sessionPath:session.path});
        const start=()=>({action:'start',runId:require('node:crypto').randomBytes(32).toString('hex'),jobId:require('node:crypto').randomUUID(),sessionId:session.id,name:'模型快照边界',prompt:'Synthetic cron boundary.',mode:'text',timeZone:'Asia/Shanghai',scheduledAt:Date.now(),maxCalls:1,maxTokens:32000,maxDurationSeconds:30,model:{provider:'fixture',modelId:'selected',thinkingLevel:'off'}});
        gate=holdModelResponse(worker,'get_state');creating=write('/projects/'+project.id+'/batches',{cwd,sessionId:session.id});creating.catch(()=>{});await gate.reached;
        const crossing=start();let rejected;try{await worker.cron(crossing);}catch(error){rejected=error;}finally{gate.release();gate=null;await creating;creating=null;}
        if(!rejected)await finish(worker,crossing.runId);
        assert.equal(rejected?.code,'SESSION_BUSY','a complete native cron start cannot enter between the actual model snapshot and durable batch admission');
        const active=start();await worker.cron(active);assert.equal((await worker.request('get_state')).model.id,'selected','native cron actually selected its temporary model');
        const denied=await write('/projects/'+project.id+'/batches',{cwd,sessionId:session.id});assert.equal(denied.status,409,JSON.stringify(denied.data));
        await finish(worker,active.runId);assert.equal((await worker.request('get_state')).model.id,'text','native cron restores the actual original model');
        const confirmed=await write('/projects/'+project.id+'/batches',{cwd,sessionId:session.id});assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));assert.deepEqual(confirmed.data.batch.configurationSnapshot.mainModel,{provider:'fixture',modelId:'text'});
    }finally{gate?.release();await creating?.catch(()=>{});await gateway.dispose();access.dispose();server.closeAllConnections();provider.closeAllConnections();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>provider.close(resolve))]);}
});
