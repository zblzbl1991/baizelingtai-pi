const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-compliance-rpc-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1'; process.env.PI_WEB_DEFERRED_FILE = path.join(agent, 'deferred.json');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test('managed compliance tools and four skills reach only verified dedicated sessions, including actual provider payloads', { timeout: 300000 }, async () => {
    const calls = []; let createArguments;
    const provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); calls.push(body);
        const wantsCreate = JSON.stringify(body.messages.at(-1)).includes('fixture create project');
        const wantsList = JSON.stringify(body.messages.at(-1)).includes('fixture list projects');
        const delta = wantsCreate ? { role: 'assistant', tool_calls: [{ index: 0, id: 'create-project', type: 'function', function: { name: 'compliance_project', arguments: JSON.stringify(createArguments) } }] }
            : wantsList ? { role: 'assistant', tool_calls: [{ index: 0, id: 'list-projects', type: 'function', function: { name: 'compliance_project', arguments: JSON.stringify({ action: 'list' }) } }] }
            : { role: 'assistant', content: 'Fixture complete.' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: wantsCreate || wantsList ? 'tool_calls' : 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'text', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'text', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
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
        const system = JSON.stringify(payload.messages.filter(message => message.role === 'system'));
        assert.doesNotMatch(system, /compliance-materials|compliance-checks|compliance-review|compliance-reports|Read and maintain the engineering project/);
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
        const forbidden = await fetch(origin + '/api/pi/compliance/tool', { method: 'POST', headers: { Authorization: 'Bearer ' + normalWorker.navigationToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'list' }) }); assert.equal(forbidden.status, 403);
        const saved = await api('GET', '/compliance');
        await api('PUT', '/compliance/settings', { requestId: 'disable', expectedRevision: saved.revision, enabled: false });
        const disabledCall = await prompt(worker, 'fixture after disable');
        assert.ok(!(disabledCall.tools || []).some(tool => tool.function?.name === 'compliance_project'));
        await worker.reloadResources(); assert.equal((await resources(worker)).skills.filter(skill => skill.name.startsWith('compliance-')).length, 0);
        assert.equal((await api('GET', '/compliance/projects')).projects[0].id, project.id);
    } finally {
        await gateway.dispose(); access.dispose(); server.closeAllConnections(); provider.closeAllConnections();
        await Promise.all([new Promise(r => server.close(r)), new Promise(r => provider.close(r))]);
    }
});
