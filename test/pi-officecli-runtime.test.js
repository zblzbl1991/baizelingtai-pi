const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-office-runtime-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('uploaded original → managed copy → native MCP edit/rollback/validate → delivery, restart and disable', { timeout: 120000 }, async () => {
    let calls = [], reference; const requests = [];
    const provider = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk); requests.push(JSON.parse(Buffer.concat(chunks)));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (calls.length) {
            const next = calls.shift(); send({ role: 'assistant', tool_calls: [{ index: 0, id: 'office-' + requests.length, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.input) } }] }); send({}, 'tool_calls');
        } else { send({ role: 'assistant', content: 'Synthetic Office task complete' }); send({}, 'stop'); }
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 2000 }] } } }));
    const { WorkspaceAccessService } = require('../server/workspace-access-service'), { createPiAgentGateway } = require('../server/pi-agent-routes');
    const token = 'synthetic-office-access', access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => token });
    const gateway = createPiAgentGateway({ accessService: access, deferredFilePath: path.join(agent, 'deferred.json'), cronFilePath: path.join(agent, 'cron.sqlite') });
    const app = express(); access.mount(app); app.use(express.json({ limit: '32mb' })); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`; process.env.PI_WORKSPACE_INTERNAL_ORIGIN = origin;
    try {
        const { Document, Paragraph, TextRun, Packer } = require('docx');
        const original = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('名称：'), new TextRun({ text: '示例', bold: true, color: '0000FF' }), new TextRun({ text: '公司', italics: true, color: 'FF0000' }), new TextRun('。保持后缀。')] })] }] }));
        const session = await gateway.store.createSession(cwd, 'Office MCP fixture');
        let worker = await gateway.supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
        const query = new URLSearchParams({ cwd, sessionId: session.id, requestId: 'original', name: '原稿 空格.docx' });
        const response = await fetch(`${origin}/api/pi/uploads?${query}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: original });
        assert.equal(response.status, 200); const uploaded = await response.json(); reference = uploaded.reference;
        const run = async (name, input, message = '同意 R1 的 C01：示例公司改为演示单位，其余保留。') => {
            calls = [{ name, input }]; let off;
            const settled = new Promise(resolve => { off = worker.subscribe(event => { if (event.type === 'agent_settled') resolve(); }); });
            try { await worker.request('prompt', { message }); await settled; } finally { off(); }
            return (await worker.request('get_entries')).entries.filter(entry => entry.message?.toolName === name).at(-1)?.message;
        };
        const prepared = await run('prepare_office_document', { id: reference.id, requestId: 'approved-v1' }, '准备工作副本\n' + uploaded.marker);
        assert.ok(prepared && !prepared.isError, JSON.stringify(prepared)); const copy = prepared.details.pivaneOffice;
        assert.deepEqual(fs.readFileSync(copy.path), original);
        const mcp = 'mcp__pivane_officecli__officecli';
        let found = false;
        for (let i = 0; i < 100; i++) {
            if ((await worker.getNativeResources()).tools.some(tool => tool.name === mcp)) { found = true; break; }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(found, 'OfficeCLI native MCP connects');
        const invoke = command => run('codemode', { code: `text(await tools.${mcp}(${JSON.stringify({ command })}));` });
        const edited = await invoke(['set', copy.path, '/body/p[1]', '--find', '示例公司', '--replace', '演示单位', '--prop', 'revision.author=白泽灵台验证', '--json']);
        assert.ok(edited && !edited.isError, JSON.stringify(edited));
        const xml = require('../server/pi-document-parser').officeZip(fs.readFileSync(copy.path)).read('word/document.xml').toString('utf8');
        assert.match(xml, /<w:ins\b/); assert.match(xml, /演示单位/); assert.match(xml, /保持后缀/);
        const before = fs.readFileSync(copy.path);
        const batch = [{ command: 'set', path: '/body/p[1]/r[1]', props: { text: 'must roll back' } }, { command: 'set', path: '/body/p[9999]', props: { text: 'fail' } }];
        await invoke(['batch', copy.path, '--commands', JSON.stringify(batch), '--json']); assert.deepEqual(fs.readFileSync(copy.path), before);
        const validated = await invoke(['validate', copy.path, '--json']); assert.ok(!validated.isError, JSON.stringify(validated));
        const blocked = await invoke(['open', copy.path]); assert.match(JSON.stringify(blocked), /受管文档/);
        const delivery = await run('deliver_files', { requestId: 'office-delivery-v1', title: 'Office 修订验证', files: [copy.path] });
        assert.ok(delivery && !delivery.isError, JSON.stringify(delivery));
        const entries = (await worker.request('get_entries')).entries, ref = entries.find(entry => entry.customType === 'pivane-deliverable').data;
        const downloadQuery = new URLSearchParams({ cwd, sessionId: session.id, id: ref.id, index: '0' });
        const download = await fetch(`${origin}/api/pi/deliverables?${downloadQuery}`, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(download.status, 200); assert.deepEqual(Buffer.from((await download.json()).base64, 'base64'), before);
        assert.deepEqual(await gateway.documents.bytes(await gateway.documents.object(reference.id)), original);
        assert.ok(!JSON.stringify(requests).includes(original.toString('base64')));
        const spreadsheet = path.join(cwd, '工作簿.xlsx'), slides = path.join(cwd, '演示.pptx');
        for (const command of [ ['create', spreadsheet], ['set', spreadsheet, '/Sheet1/A1', '--prop', 'value=123'],
            ['get', spreadsheet, '/Sheet1/A1', '--json'], ['create', slides], ['add', slides, '/', '--type', 'slide', '--prop', 'title=合成演示'],
            ['get', slides, '/slide[1]', '--json'] ]) {
            const result = await invoke(command); assert.ok(result && !result.isError, JSON.stringify(result));
        }
        for (const [name, file] of [['sheet', spreadsheet], ['slides', slides]]) {
            const uploadQuery = new URLSearchParams({ cwd, sessionId: session.id, requestId: name, name: path.basename(file) });
            const upload = await fetch(`${origin}/api/pi/uploads?${uploadQuery}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(file) });
            assert.equal(upload.status, 200); const item = await upload.json();
            const result = await run('prepare_office_document', { id: item.reference.id, requestId: name + '-copy' }, '准备工作副本\n' + item.marker);
            assert.ok(result && !result.isError, JSON.stringify(result)); assert.deepEqual(fs.readFileSync(result.details.pivaneOffice.path), fs.readFileSync(file));
        }
        await gateway.supervisor.stopSession(session.path);
        worker = await gateway.supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
        const reused = await run('prepare_office_document', { id: reference.id, requestId: 'approved-v1' });
        assert.equal(reused.details.pivaneOffice.reused, true); assert.deepEqual(fs.readFileSync(copy.path), before);
        await gateway.supervisor.stopSession(session.path);
        const saved = JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8'));
        saved.pivaneBuiltins = { officecli: { extensions: [] } }; fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify(saved));
        worker = await gateway.supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
        const disabled = await worker.getNativeResources();
        assert.equal(disabled.tools.some(tool => tool.name === 'prepare_office_document' || tool.name === mcp), false);
    } finally {
        await gateway.dispose(); access.dispose(); server.closeAllConnections(); provider.closeAllConnections();
        await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    }
});
