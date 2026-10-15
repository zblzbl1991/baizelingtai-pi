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
test('human first-page verification distinguishes a confirmed absent number from an unreadable scan', async () => {
    const project = (await write('/projects', { project: { name: '文号人工复核', identityConfirmed: true, applicability: { 'documents-identity': true, 'feasibility-numbers': true, 'contract-deadline': false, 'feasibility-order': false } } })).project;
    const canvas = require('@napi-rs/canvas').createCanvas(80, 60), docs = [];
    for (const [i, role] of ['feasibility-review', 'feasibility-approval'].entries()) {
        canvas.getContext('2d').fillRect(i * 20, 20, 10, 10); const document = (await write(`/projects/${project.id}/documents`, { sources: [{ kind: 'upload', name: role + '.png', base64: canvas.toBuffer('image/png').toString('base64') }] })).documents[0]; docs.push(document);
        await write(`/documents/${document.id}/assignment`, { role, identityConfirmed: true, selected: true }, 'PUT');
    }
    let batch = (await write(`/projects/${project.id}/batches`, {})).batch;
    for (const [i, raw] of ['审〔2026〕2号', null].entries()) {
        const proposal = (await write(`/batches/${batch.id}/review-proposals`, { ...originInput(), batchRevision: batch.revision, change: { kind: 'field', documentId: docs[i].id, key: 'documentNumber', raw, ...(i ? { absent: true } : {}), location: { page: 1, region: 'upper', excerpt: i ? '逐处查看首页上方，未见文号' : '首页上方完整文号' }, reason: '已人工查看发文首页上方' } })).proposal;
        batch = (await write(`/review-proposals/${proposal.id}/confirm`, { ...originInput(), contentHash: proposal.contentHash })).batch;
        assert.equal(batch.results.find(r => r.id === 'feasibility-numbers').conclusion, i ? 'issue' : 'insufficient');
    }
    assert.equal(batch.documents.every(d => d.processing.status === 'unreadable'), true); assert.equal(batch.fields.find(f => f.documentId === docs[1].id).humanValue.status, 'absent');
});
test('two native chats competing on one revision commit at most one exact correction and reject altered card contents', async () => {
    const batch = await batchFor(), secondSession = await write('/sessions', { cwd });
    const first = (await write(`/batches/${batch.id}/review-proposals`, { ...originInput(), batchRevision: batch.revision, change: fieldChange(batch, '2026-08-30') })).proposal;
    const second = (await write(`/batches/${batch.id}/review-proposals`, { cwd, sessionId: secondSession.id, batchRevision: batch.revision, change: fieldChange(batch, '2026-08-31') })).proposal;
    const wrongOrigin = await call('POST', `/review-proposals/${first.id}/confirm`, { cwd, sessionId: secondSession.id, requestId: 'wrong-origin', expectedRevision: revision, contentHash: first.contentHash }); assert.equal(wrongOrigin.data.code, 'COMPLIANCE_STALE');
    const altered = await call('POST', `/review-proposals/${first.id}/confirm`, { ...originInput(), requestId: 'altered-card', expectedRevision: revision, contentHash: '0'.repeat(64) }); assert.equal(altered.data.code, 'COMPLIANCE_STALE');
    const changedPayload = await call('POST', `/review-proposals/${first.id}/confirm`, { ...originInput(), requestId: 'payload-card', expectedRevision: revision, contentHash: first.contentHash, raw: '2026-01-01' }); assert.equal(changedPayload.status, 400);
    await call('GET', ''); const currentRevision = revision;
    const outcomes = await Promise.all([[first, session], [second, secondSession]].map(([card, source], index) => call('POST', `/review-proposals/${card.id}/confirm`, { cwd, sessionId: source.id, requestId: 'race-' + index, expectedRevision: currentRevision, contentHash: card.contentHash })));
    assert.equal(outcomes.filter(outcome => outcome.status === 200).length, 1); assert.equal(outcomes.filter(outcome => outcome.status === 409).length, 1);
    const saved = (await call('GET', `/batches/${batch.id}`)).data.batch; assert.equal(saved.corrections.length, 1); assert.equal(saved.history.length, 1);
    const successful = outcomes.find(result => result.status === 200).data; const operation = await call('GET', '/operations/race-' + outcomes.findIndex(result => result.status === 200)); assert.deepEqual(operation.data, successful);
});
test('reports preserve old bytes and separately export original fields, human values, conclusions and history', async () => {
    let batch = await batchFor(); const oldReport = (await write(`/batches/${batch.id}/reports`, { batchRevision: batch.revision })).report;
    const oldHtml = (await call('GET', `/reports/${oldReport.id}/files/0`)).data.content;
    const field = (await write(`/batches/${batch.id}/review-proposals`, { ...originInput(), batchRevision: batch.revision, change: fieldChange(batch, '2026-08') })).proposal;
    batch = (await write(`/review-proposals/${field.id}/confirm`, { ...originInput(), contentHash: field.contentHash })).batch;
    const conclusion = (await write(`/batches/${batch.id}/review-proposals`, { ...originInput(), batchRevision: batch.revision, change: { kind: 'conclusion', resultId: 'contract-deadline', conclusion: 'insufficient', reason: '人工要求补充签订落款证明' } })).proposal;
    batch = (await write(`/review-proposals/${conclusion.id}/confirm`, { ...originInput(), contentHash: conclusion.contentHash })).batch;
    const report = (await write(`/batches/${batch.id}/reports`, { batchRevision: batch.revision })).report; assert.equal(report.batchRevision, batch.revision);
    const html = (await call('GET', `/reports/${report.id}/files/0`)).data.content;
    assert.match(html, /原始提取原文/); assert.match(html, /人工核对值与出处（非原件）/); assert.match(html, /2026-09-01/); assert.match(html, /2026-08/); assert.match(html, /人工要求补充签订落款证明/); assert.match(html, /humanDecision/); assert.match(html, /历史修订与确认/);
    const xlsx = (await call('GET', `/reports/${report.id}/files/1`)).data; const xml = Buffer.from(xlsx.base64, 'base64').toString('utf8');
    assert.match(xml, /t="inlineStr"/); assert.doesNotMatch(xml, /<f[ >]/); assert.match(xml, /人工要求补充签订落款证明/); assert.match(xml, /humanValue|人工核对值/);
    assert.equal((await call('GET', `/reports/${oldReport.id}/files/0`)).data.content, oldHtml); assert.doesNotMatch(oldHtml, /人工要求补充签订落款证明/);
});
