const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-gongwen-runtime-')));
const agent = path.join(root, 'agent'), cwd = path.join(root, 'project'); fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('native tool generates versioned files, publishes authorized snapshots, downloads exact bytes and retains branch proof after restart', { timeout: 120000 }, async () => {
    const input = { requestId: 'runtime-v1', kind: 'notice', title: '培训通知', unit: '示例单位', recipient: '各部门', date: '2026年10月15日',
        body: [{ type: 'paragraph', text: '现将有关事项通知如下。' }] };
    let pending = true, toolName = 'generate_gongwen', toolInput = input; const requests = [];
    const provider = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk); requests.push(JSON.parse(Buffer.concat(chunks)));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (pending) {
            pending = false;
            send({ role: 'assistant', tool_calls: [{ index: 0, id: toolInput.requestId, type: 'function', function: { name: toolName, arguments: JSON.stringify(toolInput) } }] }); send({}, 'tool_calls');
        } else { send({ role: 'assistant', content: 'Synthetic generation complete' }); send({}, 'stop'); }
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 2000 }] } } }));
    const { WorkspaceAccessService } = require('../server/workspace-access-service'), { createPiAgentGateway } = require('../server/pi-agent-routes');
    const token = 'synthetic-gongwen-access';
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => token });
    const gateway = createPiAgentGateway({ accessService: access, deferredFilePath: path.join(agent, 'deferred.json'), cronFilePath: path.join(agent, 'cron.sqlite') });
    const app = express(); access.mount(app); app.use(express.json({ limit: '32mb' })); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`; process.env.PI_WORKSPACE_INTERNAL_ORIGIN = origin;
    try {
        const session = await gateway.store.createSession(cwd, 'Gongwen fixture');
        let worker = await gateway.supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
        const resources = await worker.getNativeResources();
        assert.equal(resources.tools.filter(item => item.name === 'generate_gongwen').length, 1);
        assert.equal(resources.tools.filter(item => item.name === 'revise_gongwen').length, 1);
        assert.equal(resources.skills.filter(item => item.name === 'gongwen').length, 1);
        assert.equal((await worker.request('get_commands')).commands.filter(item => item.name === 'skill:gongwen').length, 1);
        const run = async (message = 'Generate the synthetic training notice') => {
            let off;
            const settled = new Promise(resolve => { off = worker.subscribe(event => { if (event.type === 'agent_settled') resolve(); }); });
            try { await worker.request('prompt', { message }); await settled; } finally { off(); }
        };
        await run();
        const entries = (await worker.request('get_entries')).entries;
        const tool = entries.find(entry => entry.message?.role === 'toolResult' && entry.message.toolName === 'generate_gongwen')?.message;
        assert.ok(tool && !tool.isError, JSON.stringify(tool));
        const generated = tool.details.pivaneGongwen;
        assert.equal(generated.status, 'checked'); assert.equal(generated.delivery.files.length, 2);
        const ref = generated.delivery.reference;
        const verifiedSession = await gateway.store.getSession(cwd, session.id);
        assert.deepEqual({ id: worker.sessionId, cwd: worker.cwd, disposed: Boolean(worker.disposed), restarting: Boolean(worker.restarting) },
            { id: verifiedSession.id, cwd: verifiedSession.cwd, disposed: false, restarting: false });
        assert.equal(entries.filter(entry => entry.customType === 'pivane-deliverable').length, 1);
        const fetchFile = async (sessionId, index, authenticated = true) => {
            const query = new URLSearchParams({ cwd, sessionId, id: ref.id, index: String(index) });
            return fetch(`${origin}/api/pi/deliverables?${query}`, { headers: authenticated ? { Authorization: `Bearer ${token}` } : {} });
        };
        assert.equal((await fetchFile(session.id, 0, false)).status, 401);
        const download = await fetchFile(session.id, 0);
        const response = await download.json(); assert.equal(download.status, 200, JSON.stringify(response)); assert.equal(response.encoding, 'base64');
        const bytes = Buffer.from(response.base64, 'base64'); await require('../server/gongwen/render').structure(bytes);
        const report = await fetchFile(session.id, 1); assert.equal(report.status, 200);
        assert.match((await report.json()).content, /规则机检：通过/);
        const other = await gateway.store.createSession(cwd, 'Other fixture');
        assert.equal((await fetchFile(other.id, 0)).status, 403);
        pending = true; await run();
        assert.equal((await worker.request('get_entries')).entries.filter(entry => entry.customType === 'pivane-deliverable').length, 1);
        const repeated = (await worker.request('get_entries')).entries.filter(entry => entry.message?.toolName === 'generate_gongwen').at(-1).message;
        assert.equal(repeated.details.pivaneGongwen.reused, true);
        input.requestId = 'runtime-v2'; input.date = '2026年10月16日'; pending = true; await run();
        assert.equal((await worker.request('get_entries')).entries.filter(entry => entry.customType === 'pivane-deliverable').length, 2);
        const originalFile = path.join(root, 'handwritten.docx'); await require('../vendor/gongwen-kit/tests/messy-docx').build(originalFile);
        const original = fs.readFileSync(originalFile), uploadQuery = new URLSearchParams({ cwd, sessionId: session.id, requestId: 'uploaded-original', name: '培训通知.docx' });
        const uploaded = await fetch(`${origin}/api/pi/uploads?${uploadQuery}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: original });
        assert.equal(uploaded.status, 200); const attachment = await uploaded.json();
        toolName = 'revise_gongwen'; toolInput = { requestId: 'native-revision', id: attachment.reference.id, action: 'revise', layout: true }; pending = true;
        await run('Revise the synthetic official document\n' + attachment.marker);
        const revisionMessage = (await worker.request('get_entries')).entries.find(entry => entry.message?.toolName === 'revise_gongwen')?.message;
        assert.ok(revisionMessage && !revisionMessage.isError, JSON.stringify(revisionMessage));
        const revised = revisionMessage.details.pivaneGongwen; assert.equal(revised.editing, 'complete', JSON.stringify(revised));
        assert.equal(revised.status, 'needs-review'); assert.equal(revised.layoutApplied, true); assert.ok(revised.comments.placed > 0);
        const fetchRevision = async (index, sid = session.id) => fetch(`${origin}/api/pi/deliverables?${new URLSearchParams({ cwd, sessionId: sid, id: revised.delivery.reference.id, index: String(index) })}`, { headers: { Authorization: `Bearer ${token}` } });
        const revisionDownload = await fetchRevision(0); assert.equal(revisionDownload.status, 200);
        const revisionBytes = Buffer.from((await revisionDownload.json()).base64, 'base64'); await require('../server/gongwen/render').structure(revisionBytes);
        const xml = require('../server/pi-document-parser').officeZip(revisionBytes).read('word/document.xml').toString('utf8');
        assert.ok(xml.includes(revised.revisionAuthor)); assert.ok(xml.includes('<w:ins '));
        assert.equal((await fetchRevision(0, other.id)).status, 403);
        assert.deepEqual(await gateway.documents.bytes(await gateway.documents.object(attachment.reference.id)), original);
        assert.ok(!JSON.stringify(requests).includes(original.toString('base64')), 'raw Office transport never enters model context');
        const privateRead = async authorization => fetch(`${origin}/api/pi/uploads/read`, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: attachment.reference.id, action: 'source' }) });
        assert.equal((await privateRead(`Bearer ${token}`)).status, 403);
        const otherWorker = await gateway.supervisor.getWorker({ cwd, sessionPath: other.path, sessionId: other.id });
        assert.equal((await privateRead(`Bearer ${otherWorker.navigationToken}`)).status, 403);
        await gateway.supervisor.stopSession(other.path);
        const sourceResponse = await privateRead(`Bearer ${worker.navigationToken}`); assert.equal(sourceResponse.status, 200);
        assert.deepEqual(Buffer.from((await sourceResponse.json()).base64, 'base64'), original);
        assert.equal(worker.documentReads, 0); assert.equal(gateway.documents.active, 0);
        pending = true; await run('Return the existing revision');
        const last = (await worker.request('get_entries')).entries.filter(entry => entry.message?.toolName === 'revise_gongwen').at(-1).message;
        assert.equal(last.details.pivaneGongwen.reused, true);
        assert.equal((await worker.request('get_entries')).entries.filter(entry => entry.customType === 'pivane-deliverable').length, 3);
        await gateway.supervisor.stopSession(session.path);
        const restored = await fetchFile(session.id, 0); assert.equal(restored.status, 200);
        assert.deepEqual(Buffer.from((await restored.json()).base64, 'base64'), bytes);
        assert.equal((await fetchRevision(1)).status, 200);
        assert.equal(gateway.supervisor.workers.size, 0, 'reading a stopped thread does not launch a worker');
        worker = await gateway.supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
        assert.equal((await fetchFile(session.id, 1)).status, 200);
    } finally {
        await gateway.dispose(); access.dispose(); server.closeAllConnections(); provider.closeAllConnections();
        await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    }
});
