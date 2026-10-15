const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), express = require('express');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-review-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(cwd); process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
const { PiSessionStore } = require('../server/pi-session-store'), { PiProfileRegistry } = require('../server/pi-profile-registry');
const { ComplianceService, mountCompliance } = require('../server/pi-compliance'), { DocumentUploads } = require('../server/pi-document-uploads');
const { WorkspaceAccessService } = require('../server/workspace-access-service');
const store = new PiSessionStore(), profiles = new PiProfileRegistry(store); store.profiles = profiles;
let service, documents, access, server, origin, revision = 0, sequence = 0, session;
async function open() {
    documents = new DocumentUploads({ store, supervisor: { getActiveWorker: () => null, removing: new Set(), moving: new Set() } });
    service = new ComplianceService({ store, profiles, documents, createModelRuntime: async () => ({ getAvailable: async () => [{ provider: 'fixture', id: 'text', input: ['text'] }] }) });
    access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => 'synthetic-review' });
    const app = express(); access.mount(app); app.use(express.json({ limit: '32mb' })); const router = express.Router(); router.use(access.middleware()); mountCompliance(router, service); app.use('/api/pi', router);
    server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
}
async function close() { await service.dispose(); await documents.dispose(); access.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
async function call(method, route, input) {
    const response = await fetch(origin + '/api/pi/compliance' + route, { method, headers: { Authorization: 'Bearer synthetic-review', 'Content-Type': 'application/json', Connection: 'close' }, body: input && JSON.stringify(input) });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    if (response.ok && data.revision !== undefined) revision = data.revision; return { status: response.status, data };
}
async function write(route, input, method = 'POST') { await call('GET', ''); const result = await call(method, route, { requestId: 'review-' + ++sequence, expectedRevision: revision, ...input }); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
async function batchFor(first = '2026-08-01', second = '2026-09-01', budget) {
    const project = (await write('/projects', { project: { name: '复核工程' + sequence, identityConfirmed: true, applicability: { 'documents-identity': true, 'contract-deadline': true, 'feasibility-numbers': false, 'feasibility-order': false } } })).project;
    const docs = (await write(`/projects/${project.id}/documents`, { sources: [first, second].map((date, i) => ({ kind: 'upload', name: i + '.csv', base64: Buffer.from(`项目名称,日期,说明\n${project.name},${date},${i}\n`).toString('base64') })) })).documents;
    for (const [i, role] of ['award-notice', 'contract'].entries()) await write(`/documents/${docs[i].id}/assignment`, { role, selected: true, identityConfirmed: true }, 'PUT');
    return (await write(`/projects/${project.id}/batches`, budget ? { budget } : {})).batch;
}
const originInput = () => ({ cwd, sessionId: session.id });
const fieldChange = (batch, raw = '2026-08-31') => ({ kind: 'field', documentId: batch.documents.find(d => d.assignment.role === 'contract').id, key: 'date', raw, location: { sheet: 'CSV', row: 2, column: 2, excerpt: '人工查看合同日期' }, reason: '已核对原件，修正日期' });
test.after(async () => { if (server?.listening) await close(); fs.rmSync(root, { recursive: true, force: true }); });
test('a human card corrects the effective field, recomputes frozen rules and retains original evidence across reopening', async () => {
    await open(); await write('/settings', { enabled: true, mainModel: { provider: 'fixture', modelId: 'text' } }, 'PUT');
    session = await write('/sessions', { cwd }); const batch = await batchFor();
    assert.equal(batch.results.find(r => r.id === 'contract-deadline').conclusion, 'issue');
    const prepared = await write(`/batches/${batch.id}/review-proposals`, { ...originInput(), batchRevision: batch.revision, change: fieldChange(batch) });
    const card = prepared.proposal; assert.equal(card.batchRevision, batch.revision); assert.equal(card.change.raw, '2026-08-31'); assert.equal(card.before.raw, '2026-09-01');
    const result = await write(`/review-proposals/${card.id}/confirm`, { ...originInput(), contentHash: card.contentHash });
    const corrected = result.batch, field = corrected.fields.find(f => f.documentId === card.change.documentId && f.key === 'date');
    assert.equal(field.raw, '2026-09-01'); assert.equal(field.humanValue.raw, '2026-08-31'); assert.equal(field.humanValue.precision, 'day');
    assert.equal(corrected.results.find(r => r.id === 'contract-deadline').conclusion, 'passed'); assert.equal(corrected.review.status, 'unreviewed');
    assert.equal(corrected.history.at(-1).revision, batch.revision); assert.equal(corrected.history.at(-1).results.find(r => r.id === 'contract-deadline').conclusion, 'issue');
    assert.deepEqual(corrected.documents, batch.documents); assert.deepEqual(corrected.rulePackage, batch.rulePackage); assert.deepEqual(corrected.configurationSnapshot, batch.configurationSnapshot);
    await close(); await open(); assert.deepEqual((await call('GET', `/batches/${batch.id}`)).data.batch, corrected);
});
test('human conclusions have durable same-input receipts, stale competing cards and immutable decision history', async () => {
    const batch = await batchFor(), otherSession = await write('/sessions', { cwd });
    const change = { kind: 'conclusion', resultId: 'contract-deadline', conclusion: 'insufficient', reason: '原合同落款不清，人工保留待补证' };
    const first = (await write(`/batches/${batch.id}/review-proposals`, { ...originInput(), batchRevision: batch.revision, change })).proposal;
    const second = (await write(`/batches/${batch.id}/review-proposals`, { cwd, sessionId: otherSession.id, batchRevision: batch.revision, change: { ...change, conclusion: 'issue', reason: '另一聊天核对候选问题' } })).proposal;
    const input = { ...originInput(), requestId: 'human-decision', expectedRevision: revision, contentHash: first.contentHash };
    const accepted = await call('POST', `/review-proposals/${first.id}/confirm`, input); assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    const result = accepted.data.batch.results.find(r => r.id === 'contract-deadline');
    assert.equal(result.conclusion, 'issue'); assert.equal(result.humanDecision.conclusion, 'insufficient'); assert.equal(result.review.status, 'confirmed'); assert.equal(accepted.data.batch.review.status, 'partial');
    assert.deepEqual((await call('POST', `/review-proposals/${first.id}/confirm`, input)).data, accepted.data);
    assert.equal((await call('POST', `/review-proposals/${first.id}/confirm`, { ...input, contentHash: second.contentHash })).data.code, 'COMPLIANCE_CONFLICT');
    const stale = await call('POST', `/review-proposals/${second.id}/confirm`, { cwd, sessionId: otherSession.id, requestId: 'stale-decision', expectedRevision: revision, contentHash: second.contentHash }); assert.equal(stale.status, 409); assert.equal(stale.data.code, 'COMPLIANCE_STALE');
    assert.equal((await call('GET', `/review-proposals/${second.id}`)).data.proposal.status, 'stale');
    const corrected = await write(`/batches/${batch.id}/review-proposals`, { ...originInput(), batchRevision: accepted.data.batch.revision, change: fieldChange(accepted.data.batch, '2026-08') });
    const changed = await write(`/review-proposals/${corrected.proposal.id}/confirm`, { ...originInput(), contentHash: corrected.proposal.contentHash });
    assert.equal(changed.batch.results.find(r => r.id === 'contract-deadline').review.status, 'unreviewed');
    assert.equal(changed.batch.history.at(-1).results.find(r => r.id === 'contract-deadline').humanDecision.conclusion, 'insufficient');
    const human = changed.batch.fields.find(f => f.humanValue)?.humanValue; assert.equal(human.precision, 'month'); assert.deepEqual(human.value, { start: '2026-08-01', end: '2026-08-31' });
    assert.deepEqual((await call('GET', '/operations/human-decision')).data, accepted.data);
    const pending = (await write(`/batches/${batch.id}/review-proposals`, { ...originInput(), batchRevision: changed.batch.revision, change })).proposal;
    await write('/settings', { enabled: false }, 'PUT');
    const disabled = await call('POST', `/review-proposals/${pending.id}/confirm`, { ...originInput(), requestId: 'disabled-card', expectedRevision: revision, contentHash: pending.contentHash }); assert.equal(disabled.data.code, 'COMPLIANCE_DISABLED');
    assert.deepEqual((await call('GET', '/operations/human-decision')).data, accepted.data);
    await write('/settings', { enabled: true }, 'PUT');
    assert.equal((await call('GET', `/review-proposals/${pending.id}`)).data.proposal.status, 'stale');
});
test('explicit human dates can supply missing fields without turning unreadable originals into successful OCR', async () => {
    const project = (await write('/projects', { project: { name: '无识别工程', identityConfirmed: true, applicability: { 'documents-identity': true, 'contract-deadline': true, 'feasibility-numbers': false, 'feasibility-order': false } } })).project;
    const canvas = require('@napi-rs/canvas').createCanvas(80, 60), docs = [];
    for (const [i, role] of ['award-notice', 'contract'].entries()) {
        canvas.getContext('2d').fillRect(i * 20, 0, 10, 10);
        const doc = (await write(`/projects/${project.id}/documents`, { sources: [{ kind: 'upload', name: role + '.png', base64: canvas.toBuffer('image/png').toString('base64') }] })).documents[0]; docs.push(doc);
        await write(`/documents/${doc.id}/assignment`, { role, identityConfirmed: true, selected: true }, 'PUT');
    }
    let batch = (await write(`/projects/${project.id}/batches`, {})).batch; const originalDocuments = structuredClone(batch.documents);
    assert.equal(batch.fields.length, 0); assert.equal(batch.results.find(r => r.id === 'contract-deadline').conclusion, 'insufficient');
    for (const [i, raw] of ['2026-08-01', '2026-08-31'].entries()) {
        const proposal = (await write(`/batches/${batch.id}/review-proposals`, { ...originInput(), batchRevision: batch.revision, change: { kind: 'field', documentId: docs[i].id, key: 'date', raw, location: { page: 1, region: 'body', excerpt: '人工回看落款日期' }, reason: '已逐件核验原件落款' } })).proposal;
        batch = (await write(`/review-proposals/${proposal.id}/confirm`, { ...originInput(), contentHash: proposal.contentHash })).batch;
        assert.equal(batch.results.find(r => r.id === 'contract-deadline').conclusion, i ? 'passed' : 'insufficient');
    }
    assert.deepEqual(batch.documents, originalDocuments);
    assert.equal(batch.results.find(r => r.id === 'documents-identity').conclusion, 'insufficient');
    assert.equal(batch.fields.every(f => f.raw === null && f.status === 'unknown' && f.location === null && f.humanValue.status === 'known'), true);
    assert.equal(batch.results.find(r => r.id === 'contract-deadline').manualInputs.length, 2);
});
test('continuing a paused batch retains exact human input and archives the prior human conclusion before recomputation', async () => {
    let batch = await batchFor('2026-08-01', '2026-09-01', { pages: 1, modelCalls: 20, runMs: 600000 });
    assert.equal(batch.execution.status, 'paused');
    for (const [role, raw] of [['award-notice', '2026-08-01'], ['contract', '2026-08-31']]) {
        const doc = batch.documents.find(d => d.assignment.role === role);
        const proposal = (await write(`/batches/${batch.id}/review-proposals`, { ...originInput(), batchRevision: batch.revision, change: { ...fieldChange(batch, raw), documentId: doc.id } })).proposal;
        batch = (await write(`/review-proposals/${proposal.id}/confirm`, { ...originInput(), contentHash: proposal.contentHash })).batch;
    }
    const decision = (await write(`/batches/${batch.id}/review-proposals`, { ...originInput(), batchRevision: batch.revision, change: { kind: 'conclusion', resultId: 'contract-deadline', conclusion: 'passed', reason: '已人工核验两个落款日期' } })).proposal;
    const reviewed = (await write(`/review-proposals/${decision.id}/confirm`, { ...originInput(), contentHash: decision.contentHash })).batch;
    batch = (await write(`/batches/${batch.id}/continue`, { budget: { pages: 200, modelCalls: 20, runMs: 600000 } })).batch;
    assert.equal(batch.execution.status, 'completed'); assert.equal(batch.results.find(r => r.id === 'contract-deadline').conclusion, 'passed');
    assert.equal(batch.fields.find(f => f.documentId === decision.sources.find(s => s.documentId === batch.documents.find(d => d.assignment.role === 'contract').id).documentId && f.key === 'date').humanValue.raw, '2026-08-31');
    assert.equal(batch.review.status, 'unreviewed');
    assert.equal(batch.history.some(item => item.revision === reviewed.revision && item.results.find(r => r.id === 'contract-deadline').humanDecision?.conclusion === 'passed'), true);
});
