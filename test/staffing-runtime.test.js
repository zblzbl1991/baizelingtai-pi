'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), express = require('express');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-runtime-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
process.env.PI_WEB_DEFERRED_FILE = path.join(agent, 'deferred.json');
test('real managed supplier requests isolate staffing resources and reject disabled worker continuations', { timeout: 180000 }, async t => {
    const stage = name => console.log('staffing runtime:', name, new Date().toISOString());
    stage('start');
    const requests = []; let tool = null, argumentsForTool;
    const provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
        const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-staffing', type: 'function', function: { name: tool, arguments: JSON.stringify(argumentsForTool) } }] }
            : { role: 'assistant', content: 'Fixture complete' };
        const finish = tool ? 'tool_calls' : 'stop'; tool = null;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`); res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultProjectTrust: 'never', enableInstallTelemetry: false,
        skills: [path.resolve(__dirname, '../server/staffing/skills/staffing-management')], extensions: [path.resolve(__dirname, '../server/staffing/extension.ts')] }));
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic',
        models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    const { WorkspaceAccessService } = require('../server/workspace-access-service'), { createPiAgentGateway } = require('../server/pi-agent-routes');
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => 'synthetic-staffing-token' });
    const gateway = createPiAgentGateway({ accessService: access, deferredFilePath: path.join(agent, 'deferred.json'), cronFilePath: path.join(agent, 'cron.sqlite') });
    const app = express(); access.mount(app); app.use(express.json()); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`; process.env.PI_WORKSPACE_INTERNAL_ORIGIN = origin;
    const call = (url, body, token = 'synthetic-staffing-token', method = 'POST') => fetch(origin + '/api/pi/staffing' + url, { method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Origin: origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const prompt = async (worker, message) => { let off; const settled = new Promise(resolve => { off = worker.subscribe(event => { if (event.type === 'agent_settled') resolve(); }); });
        try { await worker.request('prompt', { message }); await settled; } finally { off(); } };
    const sockets = [];
    let cleaning;
    const cleanup = () => cleaning ||= (async () => {
        for (const socket of sockets) socket.terminate(); await gateway.dispose(); access.dispose(); server.closeAllConnections(); provider.closeAllConnections();
        await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
        fs.rmSync(root, { recursive: true, force: true });
    })();
    t.after(cleanup);
    try {
        const enabled = await gateway.staffing.enable({ requestId: 'enable', expectedRevision: 0 });
        stage('enabled');
        const initialized = await gateway.staffing.initialize({ requestId: 'initial', expectedRevision: enabled.revision,
            people: [{ id: 'P1', name: 'Direct', department: 'A', direct: true }], projects: [], occupancies: [], historyComplete: false });
        await gateway.staffing.confirmInitial({ requestId: 'review', expectedRevision: initialized.revision, reviewed: true });
        const otherProfile = (await gateway.store.profiles.save({ expectedRevision: (await gateway.store.profiles.state()).revision,
            profile: { name: 'Other', description: '', soul: 'Other neutral role', enabled: true } })).profile;
        const ledgerPath = path.join(agent, 'pivane-staffing', 'ledger.json'), originalLedger = fs.readFileSync(ledgerPath), ordinarySessions = new Map();
        try {
            fs.writeFileSync(ledgerPath, '{broken');
            for (const profileId of [null, otherProfile.id]) {
                const session = await gateway.store.createSession(cwd, 'Optional capability unavailable', { agentProfileId: profileId });
                const worker = await gateway.supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
                await prompt(worker, 'Neutral request with optional data unavailable');
                assert.doesNotMatch(JSON.stringify(requests.at(-1)), /staffing_query|staffing_prepare_change|staffing_operation_status|staffing-management|pivane-staffing|人员调配/);
                ordinarySessions.set(profileId, { session, worker });
            }
        } finally { fs.writeFileSync(ledgerPath, originalLedger); }
        let ordinary;
        for (const profileId of [null, otherProfile.id, enabled.profileId]) {
            const cached = ordinarySessions.get(profileId);
            const session = cached?.session || await gateway.store.createSession(cwd, 'Fixture', { agentProfileId: profileId });
            const worker = cached?.worker || await gateway.supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
            if (!profileId) ordinary = worker;
            const resources = await worker.getNativeResources();
            stage(profileId === enabled.profileId ? 'dedicated resources' : profileId ? 'other resources' : 'ordinary resources');
            assert.equal(resources.tools.some(item => item.name === 'staffing_query'), profileId === enabled.profileId);
            assert.equal(resources.skills.filter(item => item.name === 'staffing-management').length, profileId === enabled.profileId ? 1 : 0);
            await prompt(worker, 'Neutral synthetic request');
            const actual = JSON.stringify(requests.at(-1));
            if (profileId === enabled.profileId) {
                assert.match(actual, /staffing_query/); assert.match(actual, /staffing_prepare_change/); assert.match(actual, /staffing_operation_status/); assert.match(actual, /staffing-management/);
                assert.match(actual, /staffing_prepare_import/); assert.match(actual, /staffing_export/); assert.match(actual, /staffing_ledger_status/);
                tool = 'staffing_ledger_status'; argumentsForTool = {};
                await prompt(worker, 'Read the synthetic ledger revision');
                const statusEntries = await worker.request('get_entries'), statusMessage = statusEntries.entries.findLast(entry => entry.message?.toolName === 'staffing_ledger_status')?.message;
                assert.equal(statusMessage?.isError, false, JSON.stringify(statusMessage));
                const ledgerStatus = JSON.parse(statusMessage.content.find(item => item.type === 'text').text);
                assert.equal(ledgerStatus.revision, (await gateway.staffing.status()).revision); assert.equal(ledgerStatus.counts.people, 1);
                const project = { id: 'new', name: 'New', owner: 'Owner', department: 'A', start: '2026-11-01', end: '2026-11-02', minimum: 1 };
                tool = 'staffing_prepare_change'; argumentsForTool = { requestId: 'prepare', expectedRevision: (await gateway.staffing.status()).revision, project, personIds: ['P1'] };
                await prompt(worker, 'Prepare synthetic plan');
                const entries = await worker.request('get_entries');
                const result = entries.entries.findLast(entry => entry.message?.toolName === 'staffing_prepare_change')?.message;
                assert.equal(result?.isError, false, JSON.stringify(result)); const plan = result.details.pivaneStaffing.plan;
                assert.equal((await gateway.staffing.ledger()).occupancies.length, 0);
                const source = { cwd, sessionId: session.id };
                let adjusted = plan;
                for (const requestId of ['revise-one', 'revise-two']) {
                    const response = await call('/revise', { requestId, planId: adjusted.id, expectedRevision: adjusted.revision, personIds: ['P1'], allowCrossDepartment: false, source });
                    assert.equal(response.status, 200, await response.clone().text()); adjusted = await response.json();
                }
                const inspected = await call('/plans/' + plan.id + '?' + new URLSearchParams(source), undefined, 'synthetic-staffing-token', 'GET');
                assert.equal((await inspected.json()).id, adjusted.id, 'derived cards retain only the original native origin reference');
                const commit = { requestId: 'commit', planId: adjusted.id, expectedRevision: adjusted.revision, action: 'reserve', source };
                assert.equal((await call('/commit', commit, worker.navigationToken)).status, 403);
                assert.equal((await call('/agent/query', { kind: 'recommend', project }, ordinary.navigationToken)).status, 403);
                assert.equal((await call('/agent/query', { kind: 'recommend', project }, 'wrong-token')).status, 401);
                assert.equal((await call('/agent/query', { kind: 'recommend', project })).status, 403);
                const response = await call('/commit', commit); assert.equal(response.status, 200, await response.clone().text());
                stage('page confirmed');
                assert.equal((await response.json()).coverage.satisfied, true);
                tool = 'staffing_export'; argumentsForTool = { requestId: 'runtime-export', expectedRevision: (await gateway.staffing.status()).revision };
                await prompt(worker, 'Explicitly export synthetic ledger');
                const exportedEntries = await worker.request('get_entries'), exportedMessage = exportedEntries.entries.findLast(entry => entry.message?.toolName === 'staffing_export')?.message;
                assert.equal(exportedMessage?.isError, false, JSON.stringify(exportedMessage));
                const report = JSON.parse(exportedMessage.content.find(item => item.type === 'text').text);
                assert.equal(report.phase, 'saved'); assert.equal((await gateway.artifacts.preview(report.artifactKey)).revision, report.sha256);
                stage('native export independently saved');
                const status = await gateway.staffing.status(); await gateway.staffing.disable({ requestId: 'disable', expectedRevision: status.revision });
                const count = requests.length;
                await prompt(worker, 'Disabled synthetic request');
                assert.equal(requests.length, count, 'disabled session must send no provider request with old schemas');
                const disabled = await gateway.staffing.status(); await gateway.staffing.enable({ requestId: 'enable-again', expectedRevision: disabled.revision });
                assert.equal((await call('/agent/query', { kind: 'recommend', project }, worker.navigationToken)).status, 403, 'a live old-epoch worker credential does not regain tool authority');
                await prompt(worker, 'Old resource epoch after enable');
                assert.equal(requests.length, count, 're-enable does not revive stale resource authority');
                await worker.reloadResources(); await prompt(worker, 'Explicitly refreshed session');
                stage('reloaded');
                assert.equal(requests.length, count + 1); assert.match(JSON.stringify(requests.at(-1)), /staffing_query/);
                const removed = await fetch(origin + '/api/pi/sessions/' + encodeURIComponent(session.id) + '?' + new URLSearchParams({ cwd }), { method: 'DELETE', headers: { Authorization: 'Bearer synthetic-staffing-token', Origin: origin } });
                assert.equal(removed.status, 200, await removed.clone().text());
                assert.equal((await gateway.artifacts.preview(report.artifactKey)).revision, report.sha256, 'independent saved bytes survive native source removal');
                await assert.rejects(gateway.artifacts.preview(report.sourceKey));
            } else {
                assert.doesNotMatch(actual, /staffing_query|staffing_prepare_change|staffing_operation_status|staffing-management|pivane-staffing|人员调配/);
                if (profileId) await gateway.supervisor.stopSession(session.path);
            }
        }
    } finally { await cleanup(); }
});
