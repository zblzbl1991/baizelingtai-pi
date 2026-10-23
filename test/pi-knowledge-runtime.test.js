const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const { validateRequest } = require('../server/pi-mcp-runtime-control');

test('knowledge requests reject arbitrary tools, unconfirmed reads, invalid revision and unbounded input', () => {
    const valid = { action: 'knowledge-read', runtimeId: 'fixture', confirmed: true, server: 'weknora', expectedRevision: 'a'.repeat(64), operation: 'search', query: '问题' };
    assert.deepEqual(validateRequest(valid), valid);
    for (const change of [{ tool: 'delete_document' }, { operation: 'delete' }, { confirmed: false }, { expectedRevision: 'old' }, { query: 'x'.repeat(4001) }, { page: 0 }, { offset: -1 }, { server: '__bad/name' }]) assert.throws(() => validateRequest({ ...valid, ...change }), { code: 'MCP_INVALID_ACTION' });
    assert.throws(() => validateRequest({ action: 'knowledge-catalog', runtimeId: 'fixture', query: 'unexpected' }), { code: 'MCP_INVALID_ACTION' });
});

test('WeKnora 0.7 schemas use kb_id, base pages and per-page Unicode content offsets', async () => {
    const { argumentsFor } = await import('../server/pi-knowledge-runtime.mjs');
    const bridge = (raw, fields) => ({ raw, parameters: { properties: Object.fromEntries(fields.map(key => [key, {}])) } });
    const input = { kbId: 'kb-1', documentId: 'doc-1', query: '规范', page: 3, contentOffset: 12000 };
    assert.deepEqual(argumentsFor(bridge('list_knowledge_bases', ['page', 'page_size']), input), { page: 3, page_size: 20 });
    assert.deepEqual(argumentsFor(bridge('list_documents', ['kb_id']), input), { kb_id: 'kb-1', page: 3, page_size: 20 });
    assert.deepEqual(argumentsFor(bridge('search_knowledge', ['kb_id']), input), { query: '规范', kb_id: 'kb-1' });
    assert.deepEqual(argumentsFor(bridge('search_knowledge', ['kb_id']), { query: '默认范围' }), { query: '默认范围' });
    assert.deepEqual(argumentsFor(bridge('read_document', ['content_offset']), input), { knowledge_id: 'doc-1', page: 3, page_size: 20, content_offset: 12000 });
    assert.deepEqual(argumentsFor(bridge('search_knowledge', ['knowledge_base_ids']), input), { query: '规范', knowledge_base_ids: ['kb-1'], limit: 10 });
    const request = { action: 'knowledge-read', runtimeId: 'fixture', confirmed: true, server: 'weknora', expectedRevision: 'a'.repeat(64), operation: 'read', documentId: 'doc-1', contentOffset: 100000000 };
    assert.deepEqual(validateRequest(request), request);
    for (const contentOffset of [-1, 100000001, 1.5, '1']) assert.throws(() => validateRequest({ ...request, contentOffset }), { code: 'MCP_INVALID_ACTION' });
});

test('HTTP → unique managed worker → native WeKnora read tools, hooks, lifecycle and real chat citations', { timeout: 120000 }, async t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-knowledge-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
    fs.mkdirSync(agent); fs.mkdirSync(cwd);
    const previous = {};
    for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: agent, PI_PROJECT_ROOTS: root, PI_OFFLINE: '1' })) { previous[key] = process.env[key]; process.env[key] = value; }
    const calls = [], modelRequests = []; let release, hold = false, toolFailure = false, huge = false, modelCall = true, nextChatTool = null;
    const tools = ['list_knowledge_bases', 'list_documents', 'search_knowledge', 'read_document', 'delete_document', 'list_chunks', 'hybrid_search', 'list_knowledge', 'get_knowledge'];
    const mcp = http.createServer(async (req, res) => {
        if (req.url.startsWith('/api/v1/')) {
            let raw = ''; for await (const chunk of req) raw += chunk;
            calls.push({ name: 'bridge-rest', method: req.method, url: req.url, raw });
            const data = req.url.endsWith('/knowledge-bases') ? Array.from({ length: 21 }, (_, n) => ({ id: `kb-${n}`, name: `资料${n}` }))
                : req.url.includes('/hybrid-search') ? [{ knowledge_id: 'doc-1', content: '原文片段' }]
                    : req.url.includes('/chunks/') ? [{ id: 'chunk-1', content: '甲😀'.repeat(7000) }]
                        : req.url.endsWith('/knowledge/doc-1') ? { id: 'doc-1', title: '工程原文' } : [{ id: 'doc-1', title: '工程原文' }];
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, data, total: 21 })); return;
        }
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        let raw = ''; for await (const chunk of req) raw += chunk;
        const msg = JSON.parse(raw);
        if (msg.id === undefined) { res.writeHead(202).end(); return; }
        let result;
        if (msg.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'WeKnora fixture', version: '1' } };
        else if (msg.method === 'tools/list') result = { tools: tools.map(name => ({ name, inputSchema: { type: 'object', properties: { query: { type: 'string' }, kb_id: { type: 'string' }, knowledge_base_id: { type: 'string' }, knowledge_base_ids: { type: 'array', items: { type: 'string' } }, knowledge_id: { type: 'string' }, page: { type: 'integer' }, page_size: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' }, match_count: { type: 'integer' } }, ...(name === 'search_knowledge' ? { required: ['query'] } : {}) } })) };
        else if (msg.method === 'tools/call') {
            calls.push(msg.params);
            if (hold) await new Promise(resolve => { release = resolve; });
            const value = huge ? 'x'.repeat(400000) : msg.params.name === 'list_knowledge_bases' ? { knowledge_bases: [{ id: 'kb-1', name: '工程资料' }] }
                : ['list_documents', 'list_knowledge'].includes(msg.params.name) ? { documents: [{ id: 'doc-1', title: '<script>工程规程</script>' }], total: 1 }
                    : ['read_document', 'get_knowledge', 'list_chunks'].includes(msg.params.name) ? { title: '工程规程', chunks: [{ content: '验收前核对原始记录。' }], next_offset: 20 }
                        : { results: [{ knowledge_id: 'doc-1', title: '工程规程', content: '验收前核对原始记录。' }] };
            result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(toolFailure ? { isError: true } : {}) };
        } else result = {};
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
    const provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk; modelRequests.push(JSON.parse(raw));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (modelCall) { modelCall = false; send({ role: 'assistant', tool_calls: [{ index: 0, id: 'knowledge-chat-call', type: 'function', function: nextChatTool || { name: 'mcp__weknora__search_knowledge', arguments: JSON.stringify({ query: '验收要求', knowledge_base_ids: ['kb-1'] }) } }] }); send({}, 'tool_calls'); }
        else { send({ role: 'assistant', content: '验收前核对原始记录。来源：工程规程（doc-1）。' }); send({}, 'stop'); }
        res.end('data: [DONE]\n\n');
    });
    mcp.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1'); await Promise.all([once(mcp, 'listening'), once(provider, 'listening')]);
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 2000 }] } } }));
    fs.writeFileSync(path.join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { weknora: { url: `http://127.0.0.1:${mcp.address().port}/mcp`, exposure: 'direct', toolExposure: { list_chunks: 'hidden' } }, legacy: { url: `http://127.0.0.1:${mcp.address().port}/mcp`, exposure: 'direct', toolExposure: { search_knowledge: 'hidden', list_documents: 'hidden', read_document: 'hidden' } }, bridge: { type: 'stdio', command: process.execPath, args: [path.resolve(__dirname, '../server/builtin-mcp/host.mjs'), 'weknora'], exposure: 'direct', env: { WEKNORA_BASE_URL: `http://127.0.0.1:${mcp.address().port}/api/v1`, WEKNORA_API_KEY: 'synthetic-bridge-key' } } } }));
    // A real native permission hook must block a read through the UI path too.
    fs.mkdirSync(path.join(agent, 'extensions'));
    fs.writeFileSync(path.join(agent, 'extensions', 'knowledge-guard.ts'), `export default function(pi) { pi.on('tool_call', e => { if(e.input?.query === 'blocked') return {block:true, reason:'synthetic permission denial'}; }); pi.on('tool_result', e => { if(e.input?.query === 'filtered') return {content:[{type:'text',text:'filtered by native hook'}]}; }); }`);
    const { WorkspaceAccessService } = require('../server/workspace-access-service'), { createPiAgentGateway } = require('../server/pi-agent-routes');
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => 'fixture-knowledge-access' });
    const gateway = createPiAgentGateway({ accessService: access, deferredFilePath: path.join(agent, 'deferred.json'), cronFilePath: path.join(agent, 'cron.sqlite') });
    const express = require('express'), app = express(); access.mount(app); app.use(express.json()); gateway.mount(app);
    const api = http.createServer(app); api.listen(0, '127.0.0.1'); await once(api, 'listening');
    const origin = `http://127.0.0.1:${api.address().port}`;
    t.after(async () => { hold = false; release?.(); await gateway.dispose(); access.dispose(); for (const server of [api, mcp, provider]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(root, { recursive: true, force: true }); });
    const session = await gateway.store.createSession(cwd, 'WeKnora fixture');
    const url = `${origin}/api/pi/sessions/${session.id}/mcp`;
    const request = async input => { const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer fixture-knowledge-access', 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, ...input }) }); return { status: response.status, data: await response.json() }; };
    assert.equal((await request({ action: 'knowledge-catalog', runtimeId: 'closed' })).status, 409); assert.equal(gateway.supervisor.workers.size, 0);
    const worker = await gateway.supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
    const bridgeConnection = await worker.mcpControl.request({ action: 'reconnect', runtimeId: worker.shell.runtimeId, server: 'bridge', confirmed: true });
    assert.ok(bridgeConnection.servers.some(item => item.name === 'bridge' && item.state === 'connected'), JSON.stringify(bridgeConnection));
    const catalog = (await request({ action: 'knowledge-catalog', runtimeId: worker.shell.runtimeId })).data;
    assert.ok(catalog.servers?.find(s => s.name === 'weknora')?.operations.search, JSON.stringify(catalog));
    assert.equal(catalog.servers.find(s => s.name === 'weknora').operations.chunks, null);
    assert.equal(modelRequests.length, 0); assert.equal(calls.length, 0);
    const base = { action: 'knowledge-read', runtimeId: worker.shell.runtimeId, server: 'weknora', expectedRevision: catalog.revision, confirmed: true };
    const before = fs.readFileSync(session.path);
    for (const [operation, fields] of [['bases', {}], ['documents', { kbId: 'kb-1', page: 2 }], ['search', { kbId: 'kb-1', query: '验收要求' }], ['read', { documentId: 'doc-1', offset: 20 }]]) {
        const read = await request({ ...base, operation, ...fields }); assert.equal(read.status, 200, JSON.stringify(read)); assert.equal(read.data.operation, operation);
    }
    assert.equal(calls[1].arguments.knowledge_base_id, 'kb-1'); assert.equal(calls[1].arguments.page, 2); assert.deepEqual(calls[2].arguments.knowledge_base_ids, ['kb-1']); assert.equal(calls[3].arguments.offset, 20);
    assert.equal((await request({ ...base, server: 'legacy', operation: 'search', kbId: 'kb-1', query: 'legacy' })).status, 200); assert.equal(calls.at(-1).name, 'hybrid_search');
    assert.equal((await request({ ...base, operation: 'search', query: 'blocked' })).data.code, 'MCP_KNOWLEDGE_READ_FAILED'); assert.equal(calls.at(-1).arguments.query, 'legacy');
    assert.equal((await request({ ...base, operation: 'search', query: 'filtered' })).data.value, 'filtered by native hook');
    assert.equal((await request({ ...base, operation: 'chunks', documentId: 'doc-1' })).data.code, 'MCP_KNOWLEDGE_UNAVAILABLE');
    assert.equal((await request({ ...base, expectedRevision: '0'.repeat(64), operation: 'bases' })).data.code, 'MCP_KNOWLEDGE_CHANGED');
    toolFailure = true; assert.equal((await request({ ...base, operation: 'bases' })).data.code, 'MCP_KNOWLEDGE_READ_FAILED'); toolFailure = false;
    huge = true; assert.equal((await request({ ...base, operation: 'bases' })).data.code, 'MCP_RESPONSE_TOO_LARGE'); huge = false;
    assert.equal(modelRequests.length, 0); assert.deepEqual(fs.readFileSync(session.path), before, 'independent browsing adds no transcript entries');
    assert.equal(catalog.servers.find(s => s.name === 'bridge').searchRequiresBase, true);
    assert.equal((await request({ ...base, server: 'bridge', operation: 'search', query: '规范' })).data.code, 'MCP_KNOWLEDGE_INPUT_REQUIRED');
    const bridge = input => request({ ...base, server: 'bridge', ...input });
    assert.equal((await bridge({ operation: 'bases', page: 2 })).data.value.knowledge_bases[0].id, 'kb-20');
    assert.equal((await bridge({ operation: 'documents', kbId: 'kb-1', page: 2 })).status, 200);
    assert.ok(calls.at(-1).url.includes('page=2&page_size=20'));
    assert.equal((await bridge({ operation: 'search', kbId: 'kb-1', query: '规范' })).status, 200);
    assert.equal(JSON.parse(calls.at(-1).raw).query_text, '规范');
    const source = (await bridge({ operation: 'read', documentId: 'doc-1' })).data.value;
    assert.equal(source.chunks[0].next_content_offset, 12000);
    const tail = (await bridge({ operation: 'read', documentId: 'doc-1', contentOffset: 12000 })).data.value;
    assert.equal(Array.from(tail.chunks[0].content).length, 2000);
    assert.deepEqual(fs.readFileSync(session.path), before);
    hold = true; const pending = request({ ...base, operation: 'bases' });
    for (let i = 0; i < 200 && !release; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(release); assert.equal(worker.mcpControl.busy, true);
    assert.equal((await request({ action: 'knowledge-catalog', runtimeId: worker.shell.runtimeId })).data.code, 'MCP_RUNTIME_BUSY');
    hold = false; release(); assert.equal((await pending).status, 200); assert.equal(worker.mcpControl.busy, false);
    let unsubscribe; const settled = new Promise(resolve => { unsubscribe = worker.subscribe(event => { if (event.type === 'agent_settled') resolve(); }); });
    await worker.request('prompt', { message: '请从 WeKnora 查询验收要求并引用文档。' }); await settled; unsubscribe();
    const entries = (await worker.request('get_entries')).entries;
    assert.ok(entries.some(e => e.message?.role === 'assistant' && JSON.stringify(e.message).includes('doc-1')));
    assert.ok(entries.some(e => e.message?.toolName === 'mcp__weknora__search_knowledge' && !e.message.isError));
    assert.equal(gateway.supervisor.workers.size, 1);
    await worker.reloadResources();
    const reloaded = await request({ action: 'knowledge-catalog', runtimeId: worker.shell.runtimeId });
    assert.equal(reloaded.status, 200);
    // Native resource reload returns before asynchronous MCP discovery completes.
    // The UI offers an explicit connect/refresh, never an implicit tools/call.
    await worker.mcpControl.request({ action: 'reconnect', runtimeId: worker.shell.runtimeId, server: 'weknora', confirmed: true });
    const connected = await request({ action: 'knowledge-catalog', runtimeId: worker.shell.runtimeId });
    assert.ok(connected.data.servers.find(s => s.name === 'weknora')?.operations.search, JSON.stringify(connected));
    await gateway.supervisor.stopSession(session.path);
    assert.equal((await request({ action: 'knowledge-catalog', runtimeId: worker.shell.runtimeId })).status, 409);
    const reopened = await gateway.supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
    assert.equal((await request({ action: 'knowledge-catalog', runtimeId: reopened.shell.runtimeId })).status, 200);
    assert.equal((await request({ ...base, operation: 'bases' })).data.code, 'MCP_RUNTIME_CHANGED');
    // Save through the authenticated HTTP settings route, then prove that the
    // same managed worker applies the defaults only after an explicit reload.
    const settingsUrl = `${origin}/api/pi/settings/mcp`;
    const headers = { Authorization: 'Bearer fixture-knowledge-access', 'Content-Type': 'application/json' };
    const savedSnapshot = await (await fetch(`${settingsUrl}?cwd=${encodeURIComponent(cwd)}&scope=global`, { headers })).json();
    const defaults = { knowledgeBaseIds: ['kb-1', 'kb-2'], limit: 8, vectorThreshold: 0.8, keywordThreshold: 0.4 };
    await reopened.mcpControl.request({ action: 'reconnect', runtimeId: reopened.shell.runtimeId, server: 'bridge', confirmed: true });
    const oldCatalog = (await request({ action: 'knowledge-catalog', runtimeId: reopened.shell.runtimeId })).data;
    const save = await fetch(settingsUrl, { method: 'PUT', headers, body: JSON.stringify({ cwd, scope: 'global', expectedRevision: savedSnapshot.revision, confirmed: true, action: 'knowledge', name: 'bridge', knowledgeSettings: defaults }) });
    assert.equal(save.status, 200); assert.equal((await save.json()).requiresRuntimeRestart, true);
    const oldRead = { action: 'knowledge-read', runtimeId: reopened.shell.runtimeId, server: 'bridge', confirmed: true, expectedRevision: oldCatalog.revision, operation: 'search', query: '规范' };
    assert.equal((await request(oldRead)).data.code, 'MCP_KNOWLEDGE_INPUT_REQUIRED', 'saving does not silently replace the active MCP process');
    await reopened.reloadResources();
    await reopened.mcpControl.request({ action: 'reconnect', runtimeId: reopened.shell.runtimeId, server: 'bridge', confirmed: true });
    const newCatalog = (await request({ action: 'knowledge-catalog', runtimeId: reopened.shell.runtimeId })).data;
    assert.equal(newCatalog.servers.find(item => item.name === 'bridge').searchUsesDefaults, true);
    assert.equal(newCatalog.servers.find(item => item.name === 'bridge').searchRequiresBase, false);
    const priorCalls = calls.length;
    const defaultSearch = await request({ ...oldRead, runtimeId: reopened.shell.runtimeId, expectedRevision: newCatalog.revision });
    assert.equal(defaultSearch.status, 200); assert.deepEqual(defaultSearch.data.value.kb_ids, ['kb-1', 'kb-2']);
    for (const call of calls.slice(priorCalls)) assert.deepEqual(JSON.parse(call.raw), { query_text: '规范', match_count: 8, vector_threshold: 0.8, keyword_threshold: 0.4 });
    assert.equal(calls.length - priorCalls, 2);
    // A synthetic model omits scope/count/thresholds in its native MCP call.
    nextChatTool = { name: 'mcp__bridge__search_knowledge', arguments: JSON.stringify({ query: '助手默认查询' }) }; modelCall = true;
    const modelCallsBefore = calls.length;
    const modelSettled = new Promise(resolve => { const remove = reopened.subscribe(event => { if (event.type === 'agent_settled') { remove(); resolve(); } }); });
    await reopened.request('prompt', { message: '请使用已保存的知识库默认设置查询。' }); await modelSettled;
    const toolResult = (await reopened.request('get_messages')).messages.findLast(message => message.toolName === 'mcp__bridge__search_knowledge');
    assert.equal(toolResult.isError, false);
    assert.equal(calls.length - modelCallsBefore, 2);
    for (const call of calls.slice(modelCallsBefore)) assert.deepEqual(JSON.parse(call.raw), { query_text: '助手默认查询', match_count: 8, vector_threshold: 0.8, keyword_threshold: 0.4 });
    assert.equal(gateway.supervisor.workers.size, 1);
});
