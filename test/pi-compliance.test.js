const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-compliance-')));
const agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
const { PiSessionStore } = require('../server/pi-session-store');
const { PiProfileRegistry } = require('../server/pi-profile-registry');
const { ComplianceService, mountCompliance } = require('../server/pi-compliance');
const { WorkspaceAccessService } = require('../server/workspace-access-service');
let service, server, access, origin;
const store = new PiSessionStore(), profiles = new PiProfileRegistry(store); store.profiles = profiles;
const models = [{ provider: 'fixture', id: 'text', input: ['text'] }, { provider: 'fixture', id: 'vision', input: ['text', 'image'] }];
async function open() {
    service = new ComplianceService({ store, profiles, createModelRuntime: async () => ({ getAvailable: async () => models }) });
    access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => 'synthetic-compliance-token' });
    const app = express(); access.mount(app); app.use(express.json());
    const router = express.Router(); router.use(access.middleware()); mountCompliance(router, service); app.use('/api/pi', router);
    server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
}
async function close() { await service?.dispose(); access?.dispose(); server?.closeAllConnections(); if (server) await new Promise(r => server.close(r)); }
async function call(method, route, body, token = 'synthetic-compliance-token') {
    const res = await fetch(origin + '/api/pi/compliance' + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
}
test.after(async () => { await close(); fs.rmSync(root, { recursive: true, force: true }); });

test('authenticated reviewer explicitly enables compliance and retains one dedicated profile after reopening', async () => {
    await open();
    assert.equal((await call('GET', '', undefined, 'wrong')).status, 401);
    const initial = await call('GET', ''); assert.equal(initial.status, 200); assert.equal(initial.data.enabled, false); assert.equal(initial.data.profileId, null);
    const refused = await call('POST', '/projects', { requestId: 'before-enable', expectedRevision: 0, project: { name: '工程甲' } }); assert.equal(refused.status, 409);
    const input = { requestId: 'enable-1', expectedRevision: initial.data.revision, enabled: true, mainModel: { provider: 'fixture', modelId: 'text' }, extractionModel: null };
    const enabled = await call('PUT', '/settings', input); assert.equal(enabled.status, 200, JSON.stringify(enabled.data)); assert.equal(enabled.data.enabled, true); assert.equal(enabled.data.scanStatus, 'unconfigured');
    const id = enabled.data.profileId; assert.match(id, /^[a-f0-9-]{36}$/);
    assert.equal((await call('PUT', '/settings', input)).data.profileId, id);
    const registry = await profiles.list(); const profile = registry.profiles.find(p => p.id === id);
    await profiles.save({ expectedRevision: registry.revision, profile: { ...profile, name: '我的审查助手', soul: '保留我的说明。' } });
    const disabled = await call('PUT', '/settings', { requestId: 'disable-1', expectedRevision: enabled.data.revision, enabled: false }); assert.equal(disabled.status, 200);
    await close(); await open();
    const reopened = await call('GET', ''); assert.equal(reopened.data.enabled, false); assert.equal(reopened.data.profileId, id);
    const reenabled = await call('PUT', '/settings', { requestId: 'enable-2', expectedRevision: reopened.data.revision, enabled: true }); assert.equal(reenabled.status, 200); assert.equal(reenabled.data.profileId, id);
    assert.equal((await profiles.list()).profiles.length, 1); assert.equal((await profiles.getProfile(id)).name, '我的审查助手'); assert.equal((await profiles.getProfile(id)).soul, '保留我的说明。');
});

test('engineering project identity is durable, unknown stays unknown, and receipts reject competing changes', async () => {
    const settings = (await call('GET', '')).data;
    const input = { requestId: 'create-project', expectedRevision: settings.revision, project: {
        name: '工程甲 <script>', number: 'P-001', organization: null, year: '2026', phase: null, type: null, stage: '合同阶段',
        identityConfirmed: true, applicability: { 'documents-identity': true, 'feasibility-numbers': null, 'contract-deadline': true, 'feasibility-order': false }
    } };
    const created = await call('POST', '/projects', input); assert.equal(created.status, 200, JSON.stringify(created.data));
    const project = created.data.project; assert.match(project.id, /^[a-f0-9-]{36}$/); assert.equal(project.organization, null); assert.equal(project.type, null);
    assert.equal(project.applicability['feasibility-numbers'], null);
    assert.deepEqual((await call('POST', '/projects', input)).data, created.data);
    const reordered = { project: Object.fromEntries(Object.entries(input.project).reverse()), expectedRevision: input.expectedRevision, requestId: input.requestId };
    assert.deepEqual((await call('POST', '/projects', reordered)).data, created.data, 'same semantic input recovers the same receipt regardless of JSON key order');
    assert.equal((await call('POST', '/projects', { ...input, project: { ...input.project, name: '另一个工程' } })).status, 409);
    assert.equal((await call('POST', '/projects', { ...input, requestId: 'stale-create' })).status, 409);
    assert.equal((await call('GET', '/projects')).data.projects.length, 1);
    const edit = { requestId: 'edit-project', expectedRevision: created.data.revision, project: { ...input.project, organization: '甲单位' } };
    const saved = await call('PUT', '/projects/' + project.id, edit); assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.project.organization, '甲单位');
    assert.equal((await call('PUT', '/projects/' + project.id, { ...edit, requestId: 'other-chat', project: { ...edit.project, organization: '乙单位' } })).status, 409);
    const receipt = await call('GET', '/operations/edit-project'); assert.equal(receipt.status, 200); assert.deepEqual(receipt.data, saved.data);
    await close(); await open();
    assert.deepEqual((await call('GET', '/projects/' + project.id)).data.project, saved.data.project);
    assert.equal((await call('POST', '/tool', { action: 'list' })).status, 403, 'a user token cannot impersonate a live worker');
    assert.equal((await call('POST', '/projects', { ...input, requestId: 'invalid-fields', expectedRevision: saved.data.revision, project: { ...input.project, guessed: true } })).status, 400);
});

test('dedicated chat creation has a stable receipt and cannot duplicate a native session on repeat', async () => {
    const current = (await call('GET', '')).data;
    const input = { cwd, requestId: 'dedicated-chat', expectedRevision: current.revision };
    const created = await call('POST', '/sessions', input); assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.equal(created.data.agentProfile.id, current.profileId);
    assert.deepEqual((await call('POST', '/sessions', { expectedRevision: input.expectedRevision, requestId: input.requestId, cwd })).data, created.data);
    assert.deepEqual((await call('GET', '/operations/dedicated-chat')).data, created.data);
});
