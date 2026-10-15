const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), express = require('express');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-materials-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(cwd); process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
const { PiSessionStore } = require('../server/pi-session-store'), { PiProfileRegistry } = require('../server/pi-profile-registry');
const { ComplianceService, mountCompliance } = require('../server/pi-compliance'), { DocumentUploads } = require('../server/pi-document-uploads');
const { WorkspaceAccessService } = require('../server/workspace-access-service');
const { labeledPdf } = require('./compliance-fixtures.cjs');
let service, documents, access, server, origin, project, revision;
const store = new PiSessionStore(), profiles = new PiProfileRegistry(store); store.profiles = profiles;
async function open() {
    documents = new DocumentUploads({ store, supervisor: { getActiveWorker: () => null, removing: new Set(), moving: new Set() } });
    service = new ComplianceService({ store, profiles, documents, createModelRuntime: async () => ({ getAvailable: async () => [{ provider: 'fixture', id: 'text', input: ['text'] }] }) });
    access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => 'synthetic-materials' });
    const app = express(); access.mount(app); app.use(express.json({ limit: '32mb' })); const router = express.Router(); router.use(access.middleware()); mountCompliance(router, service); require('../server/pi-document-uploads').mountDocumentUploads(router,documents); app.use('/api/pi', router);
    server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
}
async function close() { await service.dispose(); await documents.dispose(); access.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
async function call(method, url, input) { const r = await fetch(origin + '/api/pi/compliance' + url, { method, headers: { Authorization: 'Bearer synthetic-materials', 'Content-Type': 'application/json' }, body: input && JSON.stringify(input) }); const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; } if (r.ok && data.revision !== undefined) revision = data.revision; return { status: r.status, data }; }
async function largeRequest(url,input) {
    const bytes=Buffer.from(JSON.stringify(input));
    return new Promise((resolve,reject)=>{
        const req=http.request(origin+'/api/pi/compliance'+url,{method:'POST',headers:{Authorization:'Bearer synthetic-materials','Content-Type':'application/json','Content-Length':bytes.length}},res=>{
            let text=''; res.setEncoding('utf8'); res.on('data',chunk=>{text+=chunk;}); res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(text)});}catch(error){reject(error);}}); res.on('error',reject);
        }); req.on('error',reject);
        // Respect socket backpressure; one huge undici write can hit Windows ENOBUFS.
        (async()=>{for(let at=0;at<bytes.length;at+=65536) if(!req.write(bytes.subarray(at,at+65536))) await once(req,'drain'); req.end();})().catch(error=>{req.destroy();reject(error);});
    });
}
const write = (url, input) => call('POST', url, { requestId: require('node:crypto').randomUUID(), expectedRevision: revision, ...input });
test.after(async () => { if (server) await close(); fs.rmSync(root, { recursive: true, force: true }); });
test('reviewer imports selected UTF-8 ledger bytes once and can retrieve the same snapshot after reopening', async () => {
    await open(); revision = 0;
    const enabled = await call('PUT', '/settings', { requestId: 'enable', expectedRevision: 0, enabled: true, mainModel: { provider: 'fixture', modelId: 'text' } }); assert.equal(enabled.status, 200);
    project = (await write('/projects', { project: { name: '工程甲', number: 'P-1', identityConfirmed: true, applicability: { 'documents-identity': true, 'contract-deadline': true } } })).data.project;
    const csv = '项目名称,项目编号,日期\n工程甲,P-1,2026-08-01\n', input = { requestId: 'import', expectedRevision: revision, sources: [{ kind: 'upload', name: '台账.csv', base64: Buffer.from(csv).toString('base64') }] };
    const imported = await call('POST', `/projects/${project.id}/documents`, input); assert.equal(imported.status, 200, JSON.stringify(imported.data));
    assert.equal(imported.data.documents.length, 1); const document = imported.data.documents[0]; assert.equal(document.name, '台账.csv'); assert.equal(document.assignment, null);
    assert.deepEqual((await call('POST', `/projects/${project.id}/documents`, input)).data, imported.data);
    assert.equal((await call('POST', `/projects/${project.id}/documents`, { ...input, sources: [{ ...input.sources[0], name: 'other.csv' }] })).status, 409);
    await close(); await open();
    const reopened = await call('GET', `/projects/${project.id}/documents`); assert.equal(reopened.data.documents[0].hash, document.hash);
    const snapshot = await call('GET', `/documents/${document.id}/content`); assert.equal(Buffer.from(snapshot.data.base64, 'base64').toString(), csv);
});
test('reviewer confirms document roles before a frozen batch can pass the day-zero contract rule', async () => {
    const sources = ['中标通知书', '合同'].map(name => ({ kind: 'upload', name: name + '.csv', base64: Buffer.from('项目名称,项目编号,日期\n工程甲,P-1,2026-08-01\n').toString('base64') }));
    // Distinct source contents represent separate originals, even with the same date.
    sources[1].base64 = Buffer.from('项目名称,项目编号,日期\n工程甲,P-1,2026-08-01\n\n').toString('base64');
    const imported = await write(`/projects/${project.id}/documents`, { sources }); assert.equal(imported.status, 200);
    const documents = imported.data.documents;
    for (const [index, role] of ['award-notice', 'contract'].entries()) {
        const saved = await call('PUT', `/documents/${documents[index].id}/assignment`, { requestId: 'role-' + index, expectedRevision: revision, role, identityConfirmed: true, selected: true });
        assert.equal(saved.status, 200, JSON.stringify(saved.data));
    }
    const checked = await write(`/projects/${project.id}/batches`, {}); assert.equal(checked.status, 200, JSON.stringify(checked.data));
    const batch = checked.data.batch;
    assert.equal(batch.results.find(r => r.id === 'contract-deadline').conclusion, 'passed');
    assert.equal(batch.results.find(r => r.id === 'feasibility-order').conclusion, 'insufficient');
    assert.equal(batch.review.status, 'unreviewed'); assert.equal(batch.rulePackage.version, '1.0.0');
    assert.equal(batch.fields.find(f => f.key === 'date').location.row, 2);
    const evidence = await call('GET', `/batches/${batch.id}/evidence/${batch.fields.find(f => f.key === 'date').id}`); assert.equal(evidence.status, 200); assert.equal(evidence.data.field.raw, '2026-08-01');
    await close(); await open(); assert.deepEqual((await call('GET', `/batches/${batch.id}`)).data.batch, batch);
});
test('selected directory files remain snapshots and unsafe, unsupported or mismatched bytes never enter the archive', async () => {
    fs.writeFileSync(path.join(cwd, 'copy.csv'), '项目名称,日期\n工程甲,2026-08\n');
    const imported = await write(`/projects/${project.id}/documents`, { cwd, sources: [{ kind: 'file', path: 'copy.csv' }] }); assert.equal(imported.status, 200);
    const document = imported.data.documents[0]; fs.writeFileSync(path.join(cwd, 'copy.csv'), 'changed');
    assert.match(Buffer.from((await call('GET', `/documents/${document.id}/content`)).data.base64, 'base64').toString(), /2026-08/);
    assert.equal((await write(`/projects/${project.id}/documents`, { cwd, sources: [{ kind: 'file', path: '../outside.csv' }] })).status, 403);
    assert.equal((await write(`/projects/${project.id}/documents`, { sources: [{ kind: 'upload', name: '文件.zip', base64: Buffer.from('zip').toString('base64') }] })).status, 415);
    assert.equal((await write(`/projects/${project.id}/documents`, { sources: [{ kind: 'upload', name: '伪造.pdf', base64: Buffer.from('not a pdf').toString('base64') }] })).status, 415);
    assert.equal((await write(`/projects/${project.id}/documents`, { sources: [{ kind: 'upload', name: '坏编码.csv', base64: Buffer.from([0xff, 0xfe, 0]).toString('base64') }] })).status, 415);
});
test('unknown required-document scope cannot pass and known unit/year/phase conflicts block dependent checks', async () => {
    const archive = (await write('/projects', { project: { name: '工程乙', organization: '甲单位', year: '2026', phase: '一期', identityConfirmed: true, applicability: { 'documents-identity': true } } })).data.project;
    const unknown = await write(`/projects/${archive.id}/batches`, {}); assert.equal(unknown.data.batch.results[0].conclusion, 'insufficient');
    const saved = await call('PUT', `/projects/${archive.id}`, { requestId: 'known-applicability', expectedRevision: revision, project: { ...Object.fromEntries(['name','organization','year','phase','identityConfirmed'].map(k => [k, archive[k]])), applicability: { 'documents-identity': true, 'contract-deadline': true, 'feasibility-numbers': false, 'feasibility-order': false } } }); assert.equal(saved.status, 200);
    const docs = (await write(`/projects/${archive.id}/documents`, { sources: ['甲', '乙'].map((name, index) => ({ kind: 'upload', name: name + '.csv', base64: Buffer.from(`项目名称,单位,年度,期次,日期\n工程乙,${index ? '乙单位' : '甲单位'},2026,一期,2026-08-01\n`).toString('base64') })) })).data.documents;
    for (const [index, role] of ['award-notice', 'contract'].entries()) await call('PUT', `/documents/${docs[index].id}/assignment`, { requestId: 'conflict-role-' + index, expectedRevision: revision, role, identityConfirmed: true, selected: true });
    const conflict = await write(`/projects/${archive.id}/batches`, {}); assert.equal(conflict.data.batch.results.find(r => r.id === 'documents-identity').conclusion, 'issue'); assert.equal(conflict.data.batch.results.find(r => r.id === 'contract-deadline').conclusion, 'insufficient');
    assert.ok(conflict.data.batch.results.find(r => r.id === 'documents-identity').evidence.some(fieldId => conflict.data.batch.fields.find(f => f.id === fieldId)?.key === 'organization'));
});
test('frozen HTTP batches match independent natural-day and month-precision examples', async () => {
    const examples = [
        ['contract-deadline','2026-08-01','2026-08-01','passed',0,0],
        ['contract-deadline','2026-08-01','2026-08-31','passed',30,30],
        ['contract-deadline','2026-08-01','2026-09-01','issue',31,31],
        ['contract-deadline','2026-08-01','2026-07-31','issue',-1,-1],
        ['contract-deadline','2026-08-01','2026-08','passed',0,30],
        ['contract-deadline','2026-08-02','2026-08','insufficient',-1,29],
        ['contract-deadline','2026-08-01','2026-09','issue',31,60],
        ['feasibility-order','2026-08-01','2026-08-02','passed',1,1],
        ['feasibility-order','2026-08-01','2026-08-01','issue',0,0],
        ['feasibility-order','2026-08','2026-09','passed',1,60],
        ['feasibility-order','2026-08','2026-08','insufficient',-30,30],
        ['feasibility-order','08-01','2026-08-01','insufficient',null,null]
    ];
    for (const [index, [group, first, second, expected, minimum, maximum]] of examples.entries()) {
        const archive = (await write('/projects', { project: { name: '边界工程' + index, identityConfirmed: true, applicability: { 'documents-identity': true, 'contract-deadline': group === 'contract-deadline', 'feasibility-order': group === 'feasibility-order', 'feasibility-numbers': false } } })).data.project;
        const docs = (await write(`/projects/${archive.id}/documents`, { sources: [first,second].map((date,index) => ({ kind:'upload', name:index + '.csv', base64:Buffer.from(`项目名称,日期,说明\n${archive.name},${date},${index}\n`).toString('base64') })) })).data.documents;
        for (const [i,role] of (group === 'contract-deadline' ? ['award-notice','contract'] : ['feasibility-report','feasibility-review']).entries()) {
            const assigned = await call('PUT', `/documents/${docs[i].id}/assignment`, { requestId:'boundary-role-' + index + '-' + i, expectedRevision:revision, role, identityConfirmed:true, selected:true }); assert.equal(assigned.status,200);
        }
        const checked = await write(`/projects/${archive.id}/batches`, {}); assert.equal(checked.status,200,JSON.stringify(checked.data)); const result = checked.data.batch.results.find(r => r.id === group);
        assert.equal(result.conclusion,expected,`${group} ${first} -> ${second}`);
        if (minimum !== null) assert.deepEqual(result.range,{minimum,maximum,unit:'natural-day'});
        assert.equal(checked.data.batch.results.find(r => r.id === (group === 'contract-deadline' ? 'feasibility-order' : 'contract-deadline')).conclusion,'not-applicable');
        if (first.length === 7 || second.length === 7) assert.ok(checked.data.batch.fields.some(f => f.precision === 'month'));
    }
});
test('document numbers require actual first-page upper provenance; empty image text is insufficient until reviewer confirms absence', async () => {
    for (const [index, sample] of [
        {rotation:0, x:40, y:760, expected:'passed'},
        {rotation:90,x:40,y:600,expected:'passed'},
        {rotation:0,x:40,y:200,expected:'insufficient'},
        {rotation:180,x:40,y:760,expected:'insufficient'},
        {rotation:0,x:40,y:760,empty:true,expected:'insufficient'},
        {rotation:0,x:40,y:760,image:true,expected:'insufficient'}
    ].entries()) {
        const archive = (await write('/projects',{project:{name:'文号工程'+index,identityConfirmed:true,applicability:{'documents-identity':true,'feasibility-numbers':true,'contract-deadline':false,'feasibility-order':false}}})).data.project;
        const bytes = sample.image ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64') : labeledPdf(sample.empty ? [] : [{text:'文号：审〔2026〕1号',x:sample.x,y:sample.y}],sample.rotation);
        const docs=[];
        for (const [i,role] of ['feasibility-review','feasibility-approval'].entries()) {
            // Keep two originals distinct without changing extracted fields.
            const buffer = Buffer.concat([bytes,Buffer.from('\n% '+i)]);
            const imported = await write(`/projects/${archive.id}/documents`,{sources:[{kind:'upload',name:role+(sample.image?'.png':'.pdf'),base64:buffer.toString('base64')}]}); assert.equal(imported.status,200,JSON.stringify(imported.data)); docs.push(imported.data.documents[0]);
            assert.equal((await call('PUT',`/documents/${docs[i].id}/assignment`,{requestId:`number-role-${index}-${i}`,expectedRevision:revision,role,identityConfirmed:true,selected:true})).status,200);
        }
        const result = await write(`/projects/${archive.id}/batches`,{}); assert.equal(result.status,200); const checked = result.data.batch.results.find(r => r.id === 'feasibility-numbers');
        assert.equal(checked.conclusion,sample.expected,JSON.stringify({sample,checked,fields:result.data.batch.fields,processing:result.data.batch.documents.map(d => d.processing)}));
        if (sample.expected === 'passed') { const field=result.data.batch.fields.find(f => f.id === checked.evidence[0]); assert.equal(field.location.page,1); assert.equal(field.location.region,'upper'); assert.equal(field.location.viewport.rotation,sample.rotation); assert.ok(field.location.rects.length); }
        if (sample.empty || sample.image) {
            for (const [i,doc] of docs.entries()) await call('PUT',`/documents/${doc.id}/assignment`,{requestId:`absent-${index}-${i}`,expectedRevision:revision,role:i?'feasibility-approval':'feasibility-review',identityConfirmed:true,selected:true,numberAbsentConfirmed:true});
            assert.equal((await write(`/projects/${archive.id}/batches`,{})).data.batch.results.find(r => r.id === 'feasibility-numbers').conclusion,'issue');
        }
    }
});
test('XLSX template cells retain sheet/row provenance and formula caches cannot become authoritative dates', async () => {
    const { zip, xlsxFiles } = require('./document-fixtures.cjs');
    const archive = (await write('/projects',{project:{name:'表格工程',identityConfirmed:true,applicability:{'documents-identity':true,'contract-deadline':true,'feasibility-numbers':false,'feasibility-order':false}}})).data.project;
    const original = xlsxFiles(), make = formula => zip({...original,'xl/worksheets/sheet1.xml':`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>项目名称</t></is></c><c r="C1" t="inlineStr"><is><t>日期</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>表格工程</t></is></c><c r="C2" t="str">${formula?'<f>DATE(2026,8,1)</f><v>2026-08-01</v>':'<v>2026-08-01</v>'}</c></row></sheetData></worksheet>`});
    const docs=[];
    for (const [i,role] of ['award-notice','contract'].entries()) {
        const imported=await write(`/projects/${archive.id}/documents`,{sources:[{kind:'upload',name:role+'.xlsx',base64:make(Boolean(i)).toString('base64')}]}); assert.equal(imported.status,200); docs.push(imported.data.documents[0]);
        await call('PUT',`/documents/${docs[i].id}/assignment`,{requestId:'xlsx-role-'+i,expectedRevision:revision,role,identityConfirmed:true,selected:true});
    }
    const checked=await write(`/projects/${archive.id}/batches`,{}); assert.equal(checked.status,200);
    assert.equal(checked.data.batch.results.find(r=>r.id==='contract-deadline').conclusion,'insufficient');
    const field=checked.data.batch.fields.find(f=>f.key==='date'); assert.equal(field.location.sheet,'销售'); assert.equal(field.location.row,2); assert.equal(field.location.column,3);
    assert.equal(checked.data.batch.fields.some(f=>f.key==='date'&&f.documentId===docs[1].id),false);
});
test('explicit current-chat attachments can be imported, while another chat cannot claim the same draft upload', async () => {
    const session=(await write('/sessions',{cwd})).data;
    const other=(await write('/sessions',{cwd})).data;
    const { pdfBytes }=require('./document-fixtures.cjs'); const bytes=pdfBytes();
    const upload=await fetch(origin+'/api/pi/uploads?'+new URLSearchParams({cwd,sessionId:session.id,requestId:'attachment',name:'附件.pdf'}),{method:'POST',headers:{Authorization:'Bearer synthetic-materials','Content-Type':'application/octet-stream'},body:bytes}); assert.equal(upload.status,200); const reference=(await upload.json()).reference;
    const refused=await write(`/projects/${project.id}/documents`,{cwd,sessionId:other.id,sources:[{kind:'attachment',id:reference.id}]}); assert.equal(refused.status,403);
    const imported=await write(`/projects/${project.id}/documents`,{cwd,sessionId:session.id,sources:[{kind:'attachment',id:reference.id}]}); assert.equal(imported.status,200,JSON.stringify(imported.data));
    assert.equal(imported.data.documents[0].source.id,reference.id);
    assert.deepEqual(Buffer.from((await call('GET',`/documents/${imported.data.documents[0].id}/content`)).data.base64,'base64'),bytes);
});
test('a labeled date before truncated PDF remainder stays a candidate and cannot make its identity or deadline pass', async () => {
    const archive=(await write('/projects',{project:{name:'截断工程',identityConfirmed:true,applicability:{'documents-identity':true,'contract-deadline':true,'feasibility-order':false,'feasibility-numbers':false}}})).data.project;
    for(const [i,role] of ['award-notice','contract'].entries()) {
        const bytes=labeledPdf([{text:'日期：2026-08-01',y:780},...(i?Array.from({length:2000},(_,n)=>({text:'unrelated fixture remainder '+n,x:20,y:760-(n%60)*10})):[])]);
        const doc=(await write(`/projects/${archive.id}/documents`,{sources:[{kind:'upload',name:role+'.pdf',base64:bytes.toString('base64')}]})).data.documents[0];
        await call('PUT',`/documents/${doc.id}/assignment`,{requestId:'trunc-role-'+i,expectedRevision:revision,role,identityConfirmed:true,selected:true});
    }
    const checked=(await write(`/projects/${archive.id}/batches`,{})).data.batch;
    assert.ok(checked.documents.some(d=>d.processing.status==='unreadable'),JSON.stringify(checked.documents.map(d=>d.processing)));
    assert.equal(checked.results.find(r=>r.id==='documents-identity').conclusion,'insufficient');
    assert.equal(checked.results.find(r=>r.id==='contract-deadline').conclusion,'insufficient');
});
test('HTTP limits reject excess selected files and a 21 MiB upload within the production JSON limit', async () => {
    const source={kind:'upload',name:'预算.csv',base64:Buffer.from('项目名称\n预算\n').toString('base64')};
    assert.equal((await write(`/projects/${project.id}/documents`,{sources:Array.from({length:33},()=>source)})).status,413);
    assert.equal((await largeRequest(`/projects/${project.id}/documents`,{requestId:'large-file',expectedRevision:revision,sources:[{...source,base64:Buffer.alloc(21*1024**2,65).toString('base64')}]})).status,413);
});
test('damaged snapshot bytes are reported as execution failure, separately from rule conclusion and human review', async () => {
    const archive=(await write('/projects',{project:{name:'损坏工程',identityConfirmed:true,applicability:{'documents-identity':true,'contract-deadline':true,'feasibility-order':false,'feasibility-numbers':false}}})).data.project;
    const docs=[];
    for(const [i,role] of ['award-notice','contract'].entries()) {
        const doc=(await write(`/projects/${archive.id}/documents`,{sources:[{kind:'upload',name:role+'.csv',base64:Buffer.from(`项目名称,日期,说明\n损坏工程,2026-08-01,${i}\n`).toString('base64')}]})).data.documents[0]; docs.push(doc);
        await call('PUT',`/documents/${doc.id}/assignment`,{requestId:'failed-role-'+i,expectedRevision:revision,role,identityConfirmed:true,selected:true});
    }
    // Filesystem fault fixture, observations remain exclusively authenticated HTTP.
    fs.writeFileSync(path.join(agent,'pivane-compliance',docs[1].hash+'.bin'),'damaged');
    const checked=(await write(`/projects/${archive.id}/batches`,{})).data.batch, result=checked.results.find(r=>r.id==='contract-deadline');
    assert.equal(result.execution,'failed'); assert.equal(result.conclusion,'insufficient'); assert.equal(checked.execution.status,'failed'); assert.equal(result.review.status,'unreviewed'); assert.ok(result.sources.some(source=>source.documentId===docs[1].id));
});
