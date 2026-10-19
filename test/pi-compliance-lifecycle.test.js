const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fork } = require('node:child_process'), { once } = require('node:events');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-compliance-lifecycle-')));
let child, origin, revision, messages = [];
function event(type) {
    const prior = messages.findIndex(m => m.type === type); if (prior >= 0) return Promise.resolve(messages.splice(prior, 1)[0]);
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { child.off('message', receive); reject(new Error('fixture IPC ' + type)); }, 15000); const receive = message => { if (message.type === type) { child.off('message', receive); clearTimeout(timer); messages.splice(messages.indexOf(message),1); resolve(message); } }; child.on('message', receive); });
}
async function call(method, route, input, full = false) {
    const res = await fetch(origin + '/api/pi' + (full ? '' : '/compliance') + route, { method, headers: { Authorization: 'Bearer synthetic-lifecycle', 'Content-Type': 'application/json' }, body: input && JSON.stringify(input) });
    const data = await res.json(); if (res.ok && Number.isSafeInteger(data.revision)) revision = data.revision; return { status: res.status, data };
}
const write = (route, input, method = 'POST') => call(method, route, { requestId: require('node:crypto').randomUUID(), expectedRevision: revision, ...input });
async function open() {
    const agent = path.join(root, 'agent'); fs.mkdirSync(agent, { recursive: true }); fs.mkdirSync(path.join(root,'project'), { recursive:true });
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: 'http://127.0.0.1:1/v1', api:'openai-completions', apiKey:'synthetic', models:[{id:'text',input:['text'],contextWindow:32000,maxTokens:1000}] } } }));
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({defaultProvider:'fixture',defaultModel:'text',defaultProjectTrust:'never',enableInstallTelemetry:false}));
    child = fork(path.join(__dirname, 'compliance-lifecycle-fixture.cjs'), [], { env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_PROJECT_ROOTS: root, PI_OFFLINE:'1' }, stdio:['ignore','inherit','inherit','ipc'] });
    child.on('message', m => messages.push(m)); origin = (await event('ready')).origin; revision = (await call('GET','')).data.revision;
    assert.equal((await write('/settings',{enabled:true,mainModel:{provider:'fixture',modelId:'text'}},'PUT')).status,200);
}
test.after(async () => { if (child?.connected) { child.send({type:'release'}); child.send({type:'close'}); await once(child,'exit'); } fs.rmSync(root,{recursive:true,force:true}); });
test('disable accepts a held real import step, drains it and never publishes a partial selected set or restarts on re-enable', async () => {
    await open(); const project = (await write('/projects',{project:{name:'生命周期工程'}})).data.project;
    const original = (await write(`/projects/${project.id}/documents`,{sources:[{kind:'upload',name:'已有.csv',base64:Buffer.from('项目名称,日期\n已有,2026-08-01\n').toString('base64')}]})).data.documents[0];
    child.send({type:'arm-parser',marker:'HELD_IMPORT'}); await event('armed');
    const pending = write(`/projects/${project.id}/documents`,{requestId:'held-import',sources:[{kind:'upload',name:'当前.csv',base64:Buffer.from('项目名称,日期\nHELD_IMPORT,2026-08-01\n').toString('base64')},{kind:'upload',name:'下一.csv',base64:Buffer.from('项目名称,日期\nNEXT_IMPORT,2026-08-02\n').toString('base64')}]});
    await event('held');
    try {
        const refused=await write(`/projects/${project.id}/documents`,{requestId:'not-admitted-import',sources:[{kind:'upload',name:'拒绝.csv',base64:Buffer.from('项目名称\n拒绝\n').toString('base64')}]});
        assert.equal(refused.status,409);assert.equal(refused.data.operationAccepted,false,'a distinct import rejected before admission has no durable intent');
        assert.equal((await call('GET','/operations/not-admitted-import')).status,404);
        const state=(await call('GET','')).data;
        const disabled=await write('/settings',{enabled:false,expectedSettingsRevision:state.settingsRevision},'PUT');
        assert.equal(disabled.status,200,JSON.stringify(disabled.data)); assert.equal(disabled.data.status,'disabling');
        assert.equal((await call('GET','/activity',undefined,true)).data.complianceBusy,true);
        assert.equal((await write('/settings',{enabled:true,expectedSettingsRevision:disabled.data.settingsRevision},'PUT')).status,200);
    } finally { child.send({type:'release'}); }
    const result=await pending; assert.equal(result.status,409); assert.match(result.data.error,/停用|暂停|停止/);
    assert.equal(messages.some(message=>message.type==='unexpected-next-parser'),false,'the second source never reaches the real parser');
    const documents=(await call('GET',`/projects/${project.id}/documents`)).data.documents; assert.deepEqual(documents.map(d=>d.id),[original.id]);
    assert.equal((await call('GET','/operations/held-import')).status,404); assert.equal((await call('GET','/activity',undefined,true)).data.complianceBusy,false);
});
test('readiness distinguishes enabled text-only service from available scanning and a missing actual configured model', async () => {
    const textOnly=(await call('GET','')).data;
    assert.equal(textOnly.enabled,true); assert.equal(textOnly.availability.status,'partial'); assert.equal(textOnly.availability.text,true); assert.equal(textOnly.availability.scan,false);
    const file=path.join(root,'agent','models.json'), configured=fs.readFileSync(file,'utf8'), models=JSON.parse(configured); models.providers.fixture.models[0].input=['text','image']; fs.writeFileSync(file,JSON.stringify(models));
    assert.equal((await write('/settings',{enabled:true,extractionModel:{provider:'fixture',modelId:'text'}},'PUT')).status,200);
    assert.equal((await call('GET','')).data.availability.status,'available');
    models.providers.fixture.models=[]; fs.writeFileSync(file,JSON.stringify(models));
    const missing=(await call('GET','')).data; assert.equal(missing.enabled,true); assert.equal(missing.availability.status,'configuration-insufficient'); assert.equal(missing.availability.text,false); assert.equal(missing.availability.scan,false);
    fs.writeFileSync(file,configured);
    assert.equal((await write('/settings',{enabled:true,extractionModel:null},'PUT')).status,200);
});
test('accepted original reads remain busy until the real file read settles and unified shutdown waits for its descriptor', async () => {
    const project=(await write('/projects',{project:{name:'原件读取工程'}})).data.project;
    const bytes=Buffer.from('项目名称,日期\n原件读取,2026-08-01\n');
    const document=(await write(`/projects/${project.id}/documents`,{sources:[{kind:'upload',name:'原件.csv',base64:bytes.toString('base64')}]})).data.documents[0];
    await write('/settings',{enabled:false},'PUT');
    child.send({type:'arm-read',hash:document.hash}); await event('armed');
    const pending=call('GET',`/documents/${document.id}/content`); await event('held');
    try {
        assert.equal((await call('GET','/activity',undefined,true)).data.complianceBusy,true,'actual original read holds maintenance/activity occupancy even while disabled');
        assert.equal((await call('POST','/settings/updates/review',{action:'restart'},true)).status,409,'maintenance confirmation cannot bypass a real original read');
        child.send({type:'dispose'});
        var draining = event('disposed');
        const observation=await Promise.race([draining.then(()=> 'disposed'),new Promise(resolve=>setTimeout(()=>resolve('waiting'),80))]);
        assert.equal(observation,'waiting','shutdown must wait for the actual accepted fd read');
        assert.equal((await call('GET',`/documents/${document.id}/content`)).status,409,'no new read after close');
    } finally { child.send({type:'release'}); }
    const result=await pending; assert.equal(result.status,200); assert.deepEqual(Buffer.from(result.data.base64,'base64'),bytes);
    await draining;
    assert.equal((await call('GET',`/projects/${project.id}/batches`)).status,409,'a first lazy recovery cannot start after unified shutdown has finished');
});

test('unified shutdown rejects new ordinary documents while the accepted PDF step finishes its subsequent shared-pool read', async () => {
    child.send({type:'close'}); await once(child,'exit'); messages=[]; await open();
    const project=(await write('/projects',{project:{name:'PDF 停机工程'}})).data.project;
    const bytes=require('./compliance-fixtures.cjs').labeledPdf([{text:'日期：2026-08-31',y:650}]);
    const imported=await write(`/projects/${project.id}/documents`,{sources:[{kind:'upload',name:'合同.pdf',base64:bytes.toString('base64')}]});
    assert.equal(imported.status,200,JSON.stringify(imported.data)); const document=imported.data.documents[0];
    assert.equal((await write(`/documents/${document.id}/assignment`,{role:'contract',identityConfirmed:true,selected:true},'PUT')).status,200);
    child.send({type:'arm-parser-action',action:'inspect',matches:2}); await event('armed');
    const pending=write(`/projects/${project.id}/batches`,{requestId:'shutdown-multiple-pdf-reads'}); await event('held');
    child.send({type:'dispose'}); const draining=event('disposed');
    try {
        assert.equal(await Promise.race([draining.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),80))]),false);
        assert.equal((await call('GET','/uploads',undefined,true)).status,503,'ordinary document admission stops immediately');
    } finally { child.send({type:'release'}); }
    const result=await pending; await draining; assert.equal(result.status,200,JSON.stringify(result.data));
    assert.equal(result.data.batch.execution.steps[0].status,'completed','the same accepted PDF step can make its later pool read during draining');
    assert.equal(result.data.batch.fields.find(field=>field.key==='date')?.raw,'2026-08-31');
    assert.equal((await call('GET','/uploads',undefined,true)).status,503);
});
