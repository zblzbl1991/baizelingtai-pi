const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-setup-flow-')));
const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'work');
fs.mkdirSync(agentDir); fs.mkdirSync(cwd);
Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_PROJECT_ROOTS: root,
    PI_OFFLINE: '1', PI_WEB_DEFERRED_FILE: path.join(root, 'deferred.json') });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('setup persists real model preferences, protected identity and a classified blank native session without model execution', async t => {
    let modelCalls = 0;
    const provider = http.createServer((req, res) => { modelCalls++; res.writeHead(500).end(); });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'setup-fixture': {
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic-setup-key',
        models: [{ id: 'setup-model', name: 'Setup model', input: ['text'], contextWindow: 32000, maxTokens: 1000 }]
    } } }));
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const { WorkspaceAccessService } = require('../server/workspace-access-service');
    const gateway = createPiAgentGateway({ accessService: new WorkspaceAccessService({ envToken: () => 'synthetic-setup-token' }),
        deferredFilePath: process.env.PI_WEB_DEFERRED_FILE,
        officePreviewEngine: { generation: 'setup-fixture', status: async () => ({ available: false }),
            convert: async () => { throw new Error('Unexpected conversion'); }, dispose: async () => {} } });
    t.after(() => gateway.dispose());
    const express = require('express'), app = express(); app.use(express.json()); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}/api/pi`;
    const call = async (method, url, body) => {
        const response = await fetch(base + url, { method, headers: { Authorization: 'Bearer synthetic-setup-token', 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, data: await response.json() };
    };
    const list = await call('GET', '/profiles'); assert.equal(list.status, 200);
    const id = list.data.defaultAssistantId, profile = list.data.profiles.find(profile => profile.id === id);
    assert.equal(profile.name, '小白');
    assert.equal((await call('PUT', '/profiles', { expectedRevision: list.data.revision, profile: { ...profile, enabled: false } })).data.code, 'DEFAULT_ASSISTANT_PROTECTED');
    const trash = await call('POST', `/profiles/${id}/trash`, { expectedRevision: list.data.revision });
    assert.equal(trash.status, 409); assert.equal(trash.data.code, 'DEFAULT_ASSISTANT_PROTECTED');
    assert.equal((await call('GET', '/profiles')).data.revision, list.data.revision);
    const modelList = await call('GET', '/settings/models'); assert.equal(modelList.status, 200);
    assert.equal(modelList.data.models.find(model => model.provider === 'setup-fixture' && model.id === 'setup-model')?.available, true);
    const preferred = await call('POST', '/settings/models/preferences', { defaultProvider: 'setup-fixture', defaultModel: 'setup-model' });
    assert.equal(preferred.status, 200);
    const preferences = (await call('GET', '/settings/models')).data.preferences;
    assert.equal(preferences.defaultProvider, 'setup-fixture'); assert.equal(preferences.defaultModel, 'setup-model');
    const groups = await call('GET', `/assistant-projects?profileId=${id}`);
    const saved = await call('PUT', '/assistant-projects', { expectedRevision: groups.data.revision,
        project: { name: 'First task', description: '', instructions: '', cwd, profileIds: [id], archived: false } });
    assert.equal(saved.status, 200);
    const created = await call('POST', '/sessions', { cwd, profileId: id, assistantProjectId: saved.data.project.id });
    assert.equal(created.status, 201);
    assert.equal(created.data.agentProfile.id, id); assert.equal(created.data.assistantProject.id, saved.data.project.id);
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.open(created.data.path);
    assert.equal(require('../server/pi-profile-state').readProfileBinding(manager).profileId, id);
    assert.equal(manager.getEntries().filter(entry => entry.type === 'message').length, 0);
    assert.equal(gateway.supervisor.workers.size, 0);
    assert.equal(modelCalls, 0, 'setup must not test, prompt or auto-learn');
});
