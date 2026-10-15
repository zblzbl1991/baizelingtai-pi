const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), express = require('express');
const { once } = require('node:events');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-report-rpc-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project'); fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1'; process.env.PI_WEB_DEFERRED_FILE = path.join(agent, 'deferred.json');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test('managed report tool and browser delivery share one native reference, XLSX reuploads through read_document, and explicit saves outlive the source chat', { timeout: 300000 }, async () => {
    let operation, failAcknowledgement = false, holdPublication = false, publicationReached, releasePublication; const calls = [];
    const provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); calls.push(body);
        const at = body.messages.findLastIndex(m => m.role === 'user' && JSON.stringify(m).includes('fixture'));
        const run = at >= 0 && !body.messages.slice(at + 1).some(m => m.role === 'tool') && operation;
        const delta = run ? { role: 'assistant', tool_calls: [{ index: 0, id: 'op-' + calls.length, type: 'function', function: { name: operation.name, arguments: JSON.stringify(operation.input) } }] } : { role: 'assistant', content: 'fixture done' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'text', choices: [{ index: 0, delta, finish_reason: run ? 'tool_calls' : 'stop' }] })}\n\n`); res.end('data: [DONE]\n\n');
    }); provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'text', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'text', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    const { createPiAgentGateway } = require('../server/pi-agent-routes'), { WorkspaceAccessService } = require('../server/workspace-access-service');
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => 'synthetic-report' });
    const gateway = createPiAgentGateway({ accessService: access, deferredFilePath: path.join(agent, 'deferred.json'), cronFilePath: path.join(agent, 'cron.sqlite') });
    const app = express(); access.mount(app); app.use(express.json());
    app.use((req,res,next) => {
        if (req.path === '/api/pi/compliance/tool' && req.body?.operation === 'reports') {
            if (failAcknowledgement && req.body.action === 'acknowledge') { failAcknowledgement = false; return res.status(503).json({error:'Synthetic lost acknowledgement'}); }
            if (holdPublication && req.body.action === 'publish') {
                const json = res.json;
                res.json = data => { if (!data.reference) return json.call(res,data); holdPublication = false; releasePublication = () => { releasePublication = undefined; return json.call(res,data); }; publicationReached(); return res; };
            }
        }
        next();
    });
    gateway.mount(app); const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`; process.env.PI_WORKSPACE_INTERNAL_ORIGIN = origin; let revision = 0;
    const api = async (method, route, body) => { const r = await fetch(origin + '/api/pi' + route, { method, headers: { Authorization: 'Bearer synthetic-report', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); const data = await r.json(); assert.equal(r.status, 200, JSON.stringify(data)); if (Number.isSafeInteger(data.revision) && route.startsWith('/compliance')) revision = data.revision; return data; };
    const write = async (route, body = {}, method = 'POST') => api(method, '/compliance' + route, { requestId: require('node:crypto').randomUUID(), expectedRevision: revision, ...body });
    const prompt = async (worker, input, marker = '') => {
        operation = input; let off, timer; const settled = new Promise((resolve, reject) => { off = worker.subscribe(e => { if (e.type === 'agent_settled') resolve(); }); timer = setTimeout(() => reject(new Error('fixture not settled')), 25000); });
        try { await worker.request('prompt', { message: 'fixture report operation\n' + marker }); await settled; } finally { off(); clearTimeout(timer); }
        const message = (await worker.request('get_entries')).entries.findLast(e => e.message?.toolName === input.name)?.message; assert.ok(message && !message.isError, JSON.stringify(message)); return message.details.pivaneCompliance || message.details.pivaneDocument;
    };
    try {
        await write('/settings', { enabled: true, mainModel: { provider: 'fixture', modelId: 'text' } }, 'PUT');
        const project = (await write('/projects', { project: { name: '=工程 <script>', identityConfirmed: true, applicability: { 'contract-deadline': true, 'feasibility-numbers': false } } })).project;
        const imported = (await write(`/projects/${project.id}/documents`, { sources: [{ kind: 'upload', name: '合同.csv', base64: Buffer.from('项目名称,日期\n=工程 <script>,2026-09\n').toString('base64') }] })).documents[0];
        await write(`/documents/${imported.id}/assignment`, { role: 'contract', identityConfirmed: true, selected: true }, 'PUT');
        const batch = (await write(`/projects/${project.id}/batches`)).batch;
        console.log('reports runtime: authenticated frozen batch ready');
        const dedicated = await write('/sessions', { cwd }); const worker = await gateway.supervisor.getWorker({ cwd, sessionId: dedicated.id, sessionPath: dedicated.path });
        console.log('reports runtime: native worker ready');
        assert.ok((await worker.getNativeResources()).tools.some(t => t.name === 'compliance_report'));
        const generated = await prompt(worker, { name: 'compliance_report', input: { action: 'generate', batchId: batch.id, batchRevision: batch.revision, requestId: 'rpc-report-generate', expectedRevision: revision } }); const report = generated.report;
        console.log('reports runtime: native report generation complete');
        assert.equal(report.status, 'generated'); revision = generated.revision;
        const input = { requestId: 'browser-report-deliver', expectedRevision: revision, cwd, sessionId: dedicated.id };
        const delivered = await api('POST', `/compliance/reports/${report.id}/delivery`, input); assert.equal(delivered.report.status, 'delivered'); assert.ok(delivered.report.delivery.reference);
        assert.deepEqual((await api('POST', `/compliance/reports/${report.id}/delivery`, input)).report.delivery, delivered.report.delivery);
        const ref = delivered.report.delivery.reference, query = new URLSearchParams({ cwd, sessionId: dedicated.id, id: ref.id, index: '0' });
        const html = await api('GET', '/deliverables?' + query); assert.equal(html.absolutePath, null); assert.equal(html.kind, 'html'); assert.match(html.content, /&lt;script&gt;/);
        const entries = await worker.request('get_entries'); assert.equal(entries.entries.filter(e => e.customType === 'pivane-deliverable' && e.data.id === ref.id).length, 1);
        const repeated = await prompt(worker, { name: 'compliance_report', input: { action: 'deliver', reportId: report.id, requestId: input.requestId, expectedRevision: input.expectedRevision } }); assert.equal(repeated.report.status, 'delivered');
        assert.equal((await worker.request('get_entries')).entries.filter(e => e.customType === 'pivane-deliverable' && e.data.id === ref.id).length, 1);
        const xlsx = await api('GET', `/compliance/reports/${report.id}/files/1`); assert.equal(xlsx.absolutePath, undefined);
        const up = await fetch(origin + '/api/pi/uploads?' + new URLSearchParams({ cwd, sessionId: dedicated.id, requestId: 'report-reupload', name: '报告.xlsx' }), { method: 'POST', headers: { Authorization: 'Bearer synthetic-report', 'Content-Type': 'application/octet-stream' }, body: Buffer.from(xlsx.base64, 'base64') }); assert.equal(up.status, 200); const attachment = await up.json();
        const read = await prompt(worker, { name: 'read_document', input: { id: attachment.reference.id, action: 'read', sheet: '报告信息', start: 1, count: 20, columns: 20 } }, attachment.marker);
        assert.equal(read.rows[1].cells[1].value, '=工程 <script>'); assert.equal(read.rows[1].cells[1].type, 'inlineStr'); assert.ok(read.rows.every(r => r.cells.every(c => c.formula === undefined)));
        const fields = await prompt(worker, { name: 'read_document', input: { id: attachment.reference.id, action: 'read', sheet: '字段与证据', start: 1, count: 20, columns: 20 } }); assert.ok(fields.rows.some(r => r.cells.some(c => c.value === 'month')));
        console.log('reports runtime: delivered bytes reuploaded and read_document verified');
        assert.ok(calls.some(p => p.tools?.some(t => t.function?.name === 'compliance_report')));
        await api('GET','/compliance'); holdPublication = true;
        const reached = new Promise(resolve => { publicationReached = resolve; });
        const settlingInput = {requestId:'disable-after-publication',expectedRevision:revision,cwd,sessionId:dedicated.id};
        const settlingDelivery = api('POST',`/compliance/reports/${report.id}/delivery`,settlingInput); settlingDelivery.catch(()=>{});
        await new Promise((resolve,reject) => { const timer = setTimeout(()=>reject(new Error('held publication not reached')),25000); reached.then(()=>{clearTimeout(timer);resolve();}); });
        await api('GET','/compliance'); await write('/settings',{enabled:false},'PUT');
        console.log('reports runtime: durable publication held, capability disabled before native acknowledgement');
        const beforeSettlementCalls = calls.length;
        releasePublication(); assert.equal((await settlingDelivery).report.status,'delivered','accepted native delivery acknowledges after disable without new inference');
        console.log('reports runtime: accepted delivery settled after disable');
        assert.equal(calls.length,beforeSettlementCalls);
        const disabledGeneration = await fetch(origin+`/api/pi/compliance/batches/${batch.id}/reports`,{method:'POST',headers:{Authorization:'Bearer synthetic-report','Content-Type':'application/json'},body:JSON.stringify({requestId:'disabled-new-report',expectedRevision:revision,batchRevision:batch.revision})}); assert.equal(disabledGeneration.status,409);
        await api('GET','/compliance'); await write('/settings',{enabled:true},'PUT');
        await api('GET', '/compliance'); failAcknowledgement = true;
        const uncertain = { requestId: 'native-before-ack', expectedRevision: revision, cwd, sessionId: dedicated.id };
        const interrupted = await fetch(origin + `/api/pi/compliance/reports/${report.id}/delivery`, { method:'POST',headers:{Authorization:'Bearer synthetic-report','Content-Type':'application/json'},body:JSON.stringify(uncertain) }); assert.equal(interrupted.status,500);
        const published = (await api('GET', `/compliance/reports/${report.id}`)).report; assert.equal(published.status,'published');
        assert.equal((await api('GET','/deliverables?'+new URLSearchParams({cwd,sessionId:dedicated.id,id:published.delivery.reference.id,index:'0'}))).content,html.content);
        await gateway.supervisor.stopSession(dedicated.path);
        await api('GET','/compliance'); await write('/settings',{enabled:false},'PUT');
        const beforeReconcileCalls = calls.length;
        const reconciled = await api('GET','/compliance/operations/native-before-ack'); assert.equal(reconciled.report?.status,'delivered','observing the durable native reference reconciles its receipt without a worker, inference or new native writes');
        assert.equal(calls.length,beforeReconcileCalls); assert.equal(gateway.supervisor.workers.size,0);
        const artifacts = await api('GET', '/artifacts?' + new URLSearchParams({ cwd, sessionId: dedicated.id })); const group = artifacts.items.find(i => i.files.some(f => f.name === report.files[0].name)); assert.ok(group);
        const saved = await api('POST', '/artifacts/batch', { requestId: 'save-report-independent', action: 'save', files: group.files.map(f => ({ key: f.key })) }); assert.ok(saved.results.every(r => r.ok)); const libraryId = saved.results[0].item.key;
        assert.ok((await api('GET', `/compliance/reports/${report.id}`)).report.savedFiles.every(Boolean));
        await api('GET', '/compliance'); await write('/settings', { enabled: false }, 'PUT');
        await api('DELETE', '/sessions/' + dedicated.id + '?' + new URLSearchParams({ cwd }));
        assert.equal((await api('GET', '/artifacts/' + libraryId + '/preview')).content, html.content);
        assert.equal((await api('GET', `/compliance/batches/${batch.id}`)).batch.review.status, 'unreviewed');
    } finally { releasePublication?.(); await gateway.dispose(); access.dispose(); server.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => provider.close(r))]); }
});
