'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), express = require('express');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-lifecycle-')));
const agent = path.join(root, 'agent'), cwd = path.join(root, 'project'); fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
process.env.PI_WEB_DEFERRED_FILE = path.join(agent, 'deferred.json');

test('a restarted native worker recovers a durable plan through its original operation without replaying preparation', { timeout: 120000 }, async t => {
    const stage = name => console.log('staffing lifecycle:', name, new Date().toISOString()); stage('start');
    let nextTool, nextArguments, callNumber = 0, lostResponse, worker;
    const requests = [], published = Promise.withResolvers();
    const provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk; requests.push(JSON.parse(raw));
        const name = nextTool; nextTool = null;
        const delta = name ? { role: 'assistant', tool_calls: [{ index: 0, id: 'lifecycle-' + ++callNumber, type: 'function', function: { name, arguments: JSON.stringify(nextArguments) } }] }
            : { role: 'assistant', content: 'Synthetic lifecycle finished' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic',
        models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    const { WorkspaceAccessService } = require('../server/workspace-access-service'), { createPiAgentGateway } = require('../server/pi-agent-routes');
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => 'synthetic-lifecycle-token' });
    const gateway = createPiAgentGateway({ accessService: access, deferredFilePath: path.join(agent, 'deferred.json'), cronFilePath: path.join(agent, 'cron.sqlite') });
    const app = express(); access.mount(app); app.use(express.json());
    // Fault the HTTP boundary after the durable public result, before the worker
    // can append its native toolResult. No business service or JSONL is mocked.
    app.use((req, res, next) => {
        if (req.path === '/api/pi/staffing/agent/prepare' && req.body?.requestId === 'lost-prepare') res.json = value => { lostResponse = res; published.resolve(value); return res; };
        next();
    });
    gateway.mount(app); const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`; process.env.PI_WORKSPACE_INTERNAL_ORIGIN = origin;
    t.after(async () => { if (!worker) console.log('staffing lifecycle: no ready worker; provider requests:', requests.length);
        else if (worker.client.stderrTail) console.log('staffing lifecycle synthetic worker diagnostics:', worker.client.stderrTail.slice(-8000));
        lostResponse?.destroy(); await gateway.dispose(); access.dispose(); server.closeAllConnections(); provider.closeAllConnections();
        await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]); fs.rmSync(root, { recursive: true, force: true }); });
    const call = (url, body) => fetch(origin + '/api/pi/staffing' + url, { method: 'POST', headers: { Authorization: 'Bearer synthetic-lifecycle-token', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const prompt = async (worker, message) => {
        let off; const settled = new Promise(resolve => { off = worker.subscribe(event => { if (event.type === 'agent_settled') resolve(); }); });
        try { await worker.request('prompt', { message }); await settled; } finally { off(); }
    };
    const enabled = await gateway.staffing.enable({ requestId: 'enable', expectedRevision: 0 });
    stage('enabled');
    const initialized = await gateway.staffing.initialize({ requestId: 'initial', expectedRevision: enabled.revision, people: [{ id: 'P1', name: 'Direct', department: 'A', direct: true }], projects: [], occupancies: [], historyComplete: true });
    stage('initialized');
    const ready = await gateway.staffing.confirmInitial({ requestId: 'review', expectedRevision: initialized.revision, reviewed: true });
    stage('reviewed');
    const session = await gateway.store.createSession(cwd, 'Recover exact native plan', { agentProfileId: enabled.profileId });
    stage('native session created');
    worker = await gateway.supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
    stage('first worker ready');
    const resources = await worker.getNativeResources(); assert.ok(resources.tools.some(tool => tool.name === 'staffing_prepare_change'), worker.client.stderrTail);
    const project = { id: 'J1', name: 'Recovery', owner: 'Owner', department: 'A', start: '2026-11-01', end: '2026-11-02', minimum: 1 };
    nextTool = 'staffing_prepare_change'; nextArguments = { requestId: 'lost-prepare', expectedRevision: ready.revision, project, personIds: ['P1'] };
    await worker.request('prompt', { message: 'Prepare the exact synthetic plan' });
    const plan = await published.promise; assert.equal((await gateway.staffing.operation('lost-prepare')).state, 'completed');
    stage('durable response withheld');
    const child = worker.client.child, exited = once(child, 'exit'); assert.equal(child.kill('SIGKILL'), true); await exited;
    await gateway.supervisor.stopSession(session.path); lostResponse.destroy();
    const revision = (await gateway.staffing.status()).revision;
    worker = await gateway.supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
    stage('replacement worker ready');
    nextTool = 'staffing_operation_status'; nextArguments = { requestId: 'lost-prepare' };
    await prompt(worker, 'Look up the original request. Do not prepare again.');
    stage('original operation recovered');
    const entries = await worker.request('get_entries');
    assert.equal(entries.entries.some(entry => entry.message?.toolName === 'staffing_prepare_change' && !entry.message.isError), false);
    const recovered = entries.entries.findLast(entry => entry.message?.toolName === 'staffing_operation_status')?.message;
    assert.equal(recovered?.isError, false, JSON.stringify(recovered));
    assert.equal(recovered.details?.pivaneStaffing?.reference?.id, plan.id, 'operation status restores a compact trusted native plan reference');
    assert.equal((await gateway.staffing.status()).revision, revision, 'lookup must not replay preparation');
    const response = await call('/commit', { requestId: 'recover-confirm', planId: plan.id, expectedRevision: plan.revision, action: 'reserve', source: { cwd, sessionId: session.id } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await gateway.staffing.ledger()).occupancies.length, 1);
    assert.ok(requests.length >= 3, 'use the real provider continuation after native tool execution');
    await t.test('the dedicated chat prepares a formalization card and only the page applies it', async () => {
        nextTool = 'staffing_prepare_change'; nextArguments = { requestId: 'formalize-chat', expectedRevision: (await gateway.staffing.status()).revision, kind: 'formalize', projectId: project.id };
        await prompt(worker, 'Prepare formal confirmation of the reserved team');
        const messages = await worker.request('get_entries'), formalize = messages.entries.findLast(entry => entry.message?.toolName === 'staffing_prepare_change')?.message;
        assert.equal(formalize?.isError, false, JSON.stringify(formalize));
        const reference = formalize.details?.pivaneStaffing?.reference; assert.equal(reference?.kind, 'formalize');
        assert.equal((await gateway.staffing.ledger()).occupancies[0].state, 'reserved');
        const input = { requestId: 'apply-formalization', planId: reference.id, expectedRevision: reference.revision, action: 'apply', source: { cwd, sessionId: session.id } };
        const refused = await fetch(origin + '/api/pi/staffing/commit', { method: 'POST', headers: { Authorization: 'Bearer ' + worker.navigationToken, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
        assert.equal(refused.status, 403, 'a model tool credential never confirms its own card');
        const applied = await call('/commit', input); assert.equal(applied.status, 200, await applied.clone().text());
        const ledger = await gateway.staffing.ledger(); assert.equal(ledger.occupancies.length, 1); assert.equal(ledger.occupancies[0].state, 'confirmed');
        const injected = await fetch(origin + '/api/pi/staffing/agent/prepare', { method: 'POST', headers: { Authorization: 'Bearer ' + worker.navigationToken, Origin: origin, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: 'page-permission-injection', expectedRevision: ledger.revision, kind: 'formalize', projectId: project.id, allowCrossDepartment: true, source: { kind: 'page' } }) });
        assert.ok(injected.status >= 400, 'private tools cannot assert page borrowing authority');
    });
});
