const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), express = require('express');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-reports-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(cwd); process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
const { PiSessionStore } = require('../server/pi-session-store'), { PiProfileRegistry } = require('../server/pi-profile-registry');
const { ComplianceService, mountCompliance } = require('../server/pi-compliance'), { DocumentUploads } = require('../server/pi-document-uploads');
const { WorkspaceAccessService } = require('../server/workspace-access-service');
let service, documents, access, server, origin, revision = 0, batch, report;
const store = new PiSessionStore(), profiles = new PiProfileRegistry(store); store.profiles = profiles;
async function open() {
    documents = new DocumentUploads({ store, supervisor: { getActiveWorker: () => null, removing: new Set(), moving: new Set() } });
    service = new ComplianceService({ store, profiles, documents, createModelRuntime: async () => ({ getAvailable: async () => [{ provider: 'fixture', id: 'text', input: ['text'] }] }) });
    access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => 'synthetic-reports' });
    const app = express(); access.mount(app); app.use(express.json({ limit: '32mb' })); const router = express.Router(); router.use(access.middleware()); mountCompliance(router, service); app.use('/api/pi', router);
    server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
}
async function close() { await service.dispose(); await documents.dispose(); access.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
async function call(method, url, input, token = 'synthetic-reports') { const r = await fetch(origin + '/api/pi/compliance' + url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: input && JSON.stringify(input) }); const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; } if (r.ok && Number.isSafeInteger(data.revision)) revision = data.revision; return { status: r.status, data }; }
const write = (url, input = {}, method = 'POST') => call(method, url, { requestId: require('node:crypto').randomUUID(), expectedRevision: revision, ...input });
test.after(async () => { if (server) await close(); fs.rmSync(root, { recursive: true, force: true }); });
test('reviewer generates an immutable unreviewed report from a fixed batch and retrieves the same bytes after reopening', async () => {
    await open(); await write('/settings', { enabled: true, mainModel: { provider: 'fixture', modelId: 'text' } }, 'PUT');
    const project = (await write('/projects', { project: { name: '=工程 <script>alert(1)</script>', number: 'P-1', identityConfirmed: true, applicability: { 'documents-identity': true, 'contract-deadline': true, 'feasibility-numbers': false } } })).data.project;
    const sources = ['2026-08-01', '2026-09'].map((date, index) => ({ kind: 'upload', name: ['通知书', '合同'][index] + '.csv', base64: Buffer.from(`项目名称,项目编号,日期\n=工程 <script>alert(1)</script>,P-1,${date}\n`).toString('base64') }));
    const imported = (await write(`/projects/${project.id}/documents`, { sources })).data.documents;
    for (let i = 0; i < 2; i++) await write(`/documents/${imported[i].id}/assignment`, { role: ['award-notice', 'contract'][i], identityConfirmed: true, selected: true }, 'PUT');
    batch = (await write(`/projects/${project.id}/batches`)).data.batch;
    const input = { requestId: 'generate-report', expectedRevision: revision, batchRevision: batch.revision };
    const result = await call('POST', `/batches/${batch.id}/reports`, input); assert.equal(result.status, 200, JSON.stringify(result.data)); report = result.data.report;
    assert.equal(report.status, 'generated'); assert.equal(report.batchRevision, batch.revision); assert.equal(report.ruleVersion, '1.0.0'); assert.equal(report.review.status, 'unreviewed');
    assert.deepEqual(report.files.map(f => f.format), ['html', 'xlsx']); assert.ok(report.files.every(f => f.size <= 16 * 1024 ** 2));
    const html = (await call('GET', `/reports/${report.id}/files/0`)).data;
    assert.equal(html.kind, 'html'); assert.match(html.content, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/); assert.doesNotMatch(html.content, /<script>/);
    for (const literal of ['2026-09', 'month', 'unreviewed', 'insufficient', 'not-applicable', 'issue', '2026-09-30', '1.0.0', 'row']) assert.ok(html.content.includes(literal), literal);
    for (const result of batch.results) assert.ok(html.content.includes(result.id), result.id);
    assert.deepEqual((await call('POST', `/batches/${batch.id}/reports`, input)).data.report, report);
    assert.equal((await call('POST', `/batches/${batch.id}/reports`, { ...input, batchRevision: 99 })).status, 409);
    assert.equal((await write(`/batches/${batch.id}/reports`, { batchRevision: 99 })).status, 409);
    assert.equal((await call('GET', `/reports/${report.id}/files/0`, undefined, 'wrong')).status, 401);
    const safe = await fetch(origin + `/api/pi/compliance/reports/${report.id}`, { headers: { Authorization:'Bearer synthetic-reports' } }); assert.equal(safe.headers.get('cache-control'),'no-store'); assert.equal(safe.headers.get('x-content-type-options'),'nosniff'); assert.match(safe.headers.get('content-security-policy'),/sandbox/); await safe.json();
    assert.equal((await call('GET', `/reports/${report.id}/files/9`)).status, 400);
    assert.equal((await write(`/batches/${batch.id}/reports`, { batchRevision: 1, files: ['private'] })).status, 400);
    const second = await write(`/batches/${batch.id}/reports`, { batchRevision: batch.revision }); assert.equal(second.status, 200); assert.notEqual(second.data.report.id, report.id);
    await close(); await open(); const recovered = (await call('GET', `/reports/${report.id}`)).data.report;
    assert.deepEqual(recovered, report); assert.equal((await call('GET', `/reports/${report.id}/files/0`)).data.content, html.content);
    assert.deepEqual((await call('GET', `/batches/${batch.id}`)).data.batch, batch, 'generation never modifies conclusions or review');
    assert.equal((await call('GET', '/operations/generate-report')).data.report.id, report.id);
});
test('report retains failed execution and refuses an oversized Excel cell without truncating or changing the batch', async () => {
    await call('GET', '');
    const created = await write('/projects', { project: { name: '预算样例', applicability: { 'contract-deadline': true } } }); assert.equal(created.status,200,JSON.stringify(created.data)); const project = created.data.project;
    const source = async (name, csv) => { const imported = await write(`/projects/${project.id}/documents`, { sources: [{ kind: 'upload', name, base64: Buffer.from(csv).toString('base64') }] }); assert.equal(imported.status,200,JSON.stringify(imported.data)); return imported.data.documents[0]; };
    const header = ['项目名称','日期',...Array.from({length:48},(_,i)=>'额外字段'+i)].join(',');
    const failure = await source('解析输出超限.csv', header + '\n' + Array.from({ length: 100 }, () => ['预算样例','2026-09',...Array(48).fill('x'.repeat(100))].join(',')).join('\n'));
    await write(`/documents/${failure.id}/assignment`, { role: 'contract', identityConfirmed: true, selected: true }, 'PUT');
    const failedBatch = (await write(`/projects/${project.id}/batches`)).data.batch;
    assert.equal(failedBatch.execution.status, 'failed');
    const exported = await write(`/batches/${failedBatch.id}/reports`, { batchRevision: failedBatch.revision }); assert.equal(exported.status, 200);
    const html = (await call('GET', `/reports/${exported.data.report.id}/files/0`)).data.content;
    assert.match(html, /failed/); assert.match(html, /解析输出超限/); assert.match(html, /COMPLIANCE_PARSE_FAILED|DOCUMENT_LIMIT/); assert.match(html, /未完成/);
    await write(`/documents/${failure.id}/assignment`, { role: 'contract', identityConfirmed: true, selected: false }, 'PUT');
    const dense = await source('字段长候选.csv', '项目名称,日期\n' + Array.from({ length: 400 }, (_, i) => `预算样例,2026-${i}-` + 'x'.repeat(180)).join('\n'));
    await write(`/documents/${dense.id}/assignment`, { role: 'contract', identityConfirmed: true, selected: true }, 'PUT');
    const largeBatch = (await write(`/projects/${project.id}/batches`)).data.batch;
    const rejected = await write(`/batches/${largeBatch.id}/reports`, { batchRevision: largeBatch.revision }); assert.equal(rejected.status, 413, JSON.stringify(rejected.data)); assert.equal(rejected.data.code, 'COMPLIANCE_REPORT_LIMIT');
    assert.equal((await call('GET', `/batches/${largeBatch.id}/reports`)).data.reports.length, 0);
    assert.deepEqual((await call('GET', `/batches/${largeBatch.id}`)).data.batch, largeBatch);
});
