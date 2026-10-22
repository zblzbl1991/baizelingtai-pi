const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const host = path.resolve(__dirname, '../server/builtin-mcp/host.mjs');
const privateCheck = require('./private-file-helper.cjs').assertPrivateFile;
async function fixture(t, handle) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-builtin-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
    fs.mkdirSync(agent); fs.mkdirSync(cwd);
    const calls = [], sockets = new Set();
    const api = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        calls.push({ method: req.method, url: req.url, raw, headers: req.headers });
        try { await handle(req, res, raw); } catch { if (!res.destroyed) res.writeHead(500).end(); }
    });
    api.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    api.listen(0, '127.0.0.1'); await once(api, 'listening');
    const clients = [], base = `http://127.0.0.1:${api.address().port}`;
    t.after(async () => { for (const client of clients) await client.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => api.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    const connect = async (kind, directory = cwd) => {
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
        const client = new Client({ name: 'synthetic-test', version: '1' });
        const transport = new StdioClientTransport({ command: process.execPath, args: [host, kind], cwd: directory, stderr: 'pipe',
            env: { PI_CODING_AGENT_DIR: agent, PI_PROJECT_ROOTS: root, PI_OFFLINE: '1', OCR_BASE_URL: base, OCR_API_KEY: 'synthetic-ocr-key', WEKNORA_BASE_URL: base + '/api/v1', WEKNORA_API_KEY: 'synthetic-weknora-key' } });
        let stderr = ''; transport.stderr.on('data', chunk => { stderr += chunk; });
        await client.connect(transport); clients.push(client);
        return { client, call: (name, args = {}, options) => client.callTool({ name, arguments: args }, undefined, options), stderr: () => stderr };
    };
    return { root, agent, cwd, calls, connect };
}
const json = (res, data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };

test('bundled OCR stdio verifies uploads, retains task IDs, scopes history, saves private output and never retries uncertain submission', { timeout: 90000 }, async t => {
    let uncertain = false, creates = 0;
    const f = await fixture(t, async (req, res) => {
        assert.equal(req.headers['x-api-key'], 'synthetic-ocr-key');
        if (req.url.includes('task/create')) {
            creates++; if (uncertain) { res.writeHead(503).end('synthetic-secret'); return; }
            json(res, { code: 200, data: { task_ids: ['task-1', 'task-2'] } });
        } else if (req.url.endsWith('md_file/export')) res.end('exported markdown');
        else json(res, { code: 200, data: { status: 2, total_count: 1, is_whole: true, parse_result: { markdown: '甲😀乙结果' } } });
    });
    const input = path.join(f.cwd, 'source.pdf'); fs.writeFileSync(input, '%PDF-synthetic');
    const outside = path.join(f.root, 'outside.pdf'); fs.writeFileSync(outside, '%PDF-private-outside');
    const escape = path.join(f.cwd, 'escape.pdf'); fs.symlinkSync(outside, escape);
    fs.writeFileSync(path.join(f.cwd, '.env'), 'OCR_BASE_URL=http://invalid.invalid\nOCR_API_KEY=do-not-load');
    const c = await f.connect('ocr');
    assert.equal((await c.client.listTools()).tools.length, 5);
    assert.equal((await c.call('ocr_health_check')).structuredContent.ok, true);
    for (const file_path of [path.join(f.cwd, '.env'), outside, escape, 'relative.pdf']) {
        const reply = await c.call('ocr_parse_document', { file_path }); assert.equal(reply.isError, true);
    }
    assert.equal(creates, 0);
    const parsed = (await c.call('ocr_parse_document', { file_path: input })).structuredContent;
    assert.deepEqual(parsed.task_ids, ['task-1', 'task-2']); assert.equal(creates, 1);
    assert.ok(f.calls.find(call => call.url.includes('task/create')).raw.includes('%PDF-synthetic'));
    assert.equal((await c.call('ocr_get_task', { task_id: 'task-1' })).structuredContent.status, 'succeeded');
    assert.equal((await c.call('ocr_get_task', { task_id: 'unknown' })).isError, true);
    const result = (await c.call('ocr_get_result', { task_id: 'task-1', max_chars: 2 })).structuredContent;
    assert.equal(result.content, '甲😀'); assert.equal(result.next_offset, 2); privateCheck(result.artifact_path);
    assert.equal(fs.readFileSync(result.artifact_path, 'utf8'), '甲😀乙结果');
    assert.equal(result.artifact_sha256, createHash('sha256').update('甲😀乙结果').digest('hex'));
    fs.writeFileSync(result.artifact_path, 'changed-result');
    assert.equal((await c.call('ocr_get_result', { task_id: 'task-1' })).isError, true);
    fs.unlinkSync(result.artifact_path); fs.symlinkSync(outside, result.artifact_path);
    assert.equal((await c.call('ocr_get_result', { task_id: 'task-1' })).isError, true);
    assert.equal(fs.readFileSync(outside, 'utf8'), '%PDF-private-outside');
    fs.unlinkSync(result.artifact_path);
    const exported = (await c.call('ocr_export', { task_id: 'task-2' })).structuredContent;
    assert.equal(fs.readFileSync(exported.artifact_path, 'utf8'), 'exported markdown'); privateCheck(exported.artifact_path);
    const taskDirectory = path.join(f.agent, 'pivane-mcp/ocr', createHash('sha256').update(f.cwd).digest('hex'), 'node-tasks');
    for (const name of fs.readdirSync(taskDirectory)) privateCheck(path.join(taskDirectory, name));
    // Remote success is still reported if a duplicate/corrupt local record fails.
    fs.writeFileSync(path.join(taskDirectory, createHash('sha256').update('task-1').digest('hex') + '.json'), '{}');
    const retained = (await c.call('ocr_parse_document', { file_path: input })).structuredContent;
    assert.deepEqual(retained.task_ids, ['task-1', 'task-2']); assert.ok(retained.registry_error);
    const other = path.join(f.root, 'other'); fs.mkdirSync(other);
    const second = await f.connect('ocr', other);
    assert.equal((await second.call('ocr_get_task', { task_id: 'task-2' })).isError, true);
    uncertain = true;
    const failed = await c.call('ocr_parse_document', { file_path: input });
    assert.equal(failed.isError, true); assert.equal(failed.structuredContent.submission_uncertain, true);
    assert.ok(!JSON.stringify(failed).includes('synthetic-secret')); assert.equal(creates, 3);
    assert.equal(c.stderr(), '');
});

test('bundled WeKnora stdio reads 0.7 REST, projects safe metadata, pages and continues Unicode chunks', { timeout: 60000 }, async t => {
    const f = await fixture(t, async (req, res, raw) => {
        assert.equal(req.headers['x-api-key'], 'synthetic-weknora-key');
        const url = new URL(req.url, 'http://fixture');
        if (url.pathname.endsWith('/knowledge-bases')) json(res, { success: true, data: Array.from({ length: 21 }, (_, n) => ({ id: `kb-${n}`, name: `库${n}`, model_config: { api_key: 'synthetic-private' } })) });
        else if (url.pathname.endsWith('/hybrid-search')) { assert.equal(req.method, 'POST'); assert.equal(JSON.parse(raw).query_text, '验收'); json(res, { success: true, data: [{ knowledge_id: 'doc-1', chunk_type: 'summary', content: '验收片段', secret: 'synthetic-private' }] }); }
        else if (url.pathname.includes('/chunks/')) json(res, { success: true, total: 21, data: [{ id: 'chunk-1', content: '甲😀'.repeat(7000), chunk_type: 'text' }] });
        else if (url.pathname.endsWith('/knowledge/doc-1')) json(res, { success: true, data: { id: 'doc-1', title: '规范', storage_config: 'synthetic-private' } });
        else json(res, { success: true, total: 21, data: [{ id: 'doc-1', title: '规范' }] });
    });
    const c = await f.connect('weknora');
    assert.equal((await c.client.listTools()).tools.length, 5);
    assert.equal((await c.call('weknora_health_check')).structuredContent.ok, true);
    const bases = (await c.call('list_knowledge_bases', { page: 1, page_size: 20 })).structuredContent;
    assert.equal(bases.next_page, 2); assert.equal(bases.knowledge_bases.length, 20); assert.ok(!JSON.stringify(bases).includes('synthetic-private'));
    assert.equal((await c.call('list_knowledge_bases', { page: 2, page_size: 20 })).structuredContent.knowledge_bases[0].id, 'kb-20');
    assert.equal((await c.call('search_knowledge', { query: '验收' })).isError, true);
    const search = (await c.call('search_knowledge', { kb_id: 'kb-1', query: '验收' })).structuredContent;
    assert.equal(search.results[0].chunk_type, 'summary'); assert.equal(search.retrieval, 'raw_hybrid_without_rerank');
    assert.equal((await c.call('list_documents', { kb_id: 'kb-1', page_size: 20 })).structuredContent.next_page, 2);
    const first = (await c.call('read_document', { knowledge_id: 'doc-1', page_size: 20 })).structuredContent;
    assert.equal(first.next_page, 2); assert.equal(first.chunks[0].next_content_offset, 12000); assert.ok(!JSON.stringify(first).includes('synthetic-private'));
    const tail = (await c.call('read_document', { knowledge_id: 'doc-1', page_size: 20, content_offset: 12000 })).structuredContent;
    assert.equal(Array.from(tail.chunks[0].content).length, 2000); assert.equal(tail.chunks[0].content_truncated, false);
    assert.equal(c.stderr(), '');
});

for (const kind of ['ocr', 'weknora']) test(`${kind} stdio cancellation closes the active HTTP request without retry`, { timeout: 60000 }, async t => {
    let received, closed;
    const started = new Promise(resolve => { received = resolve; }), disconnected = new Promise(resolve => { closed = resolve; });
    const f = await fixture(t, async (req, res) => { received(); res.on('close', closed); });
    const c = await f.connect(kind), controller = new AbortController();
    const input = path.join(f.cwd, 'cancel.pdf'); fs.writeFileSync(input, '%PDF-synthetic');
    const pending = c.call(kind === 'ocr' ? 'ocr_parse_document' : 'weknora_health_check', kind === 'ocr' ? { file_path: input } : {}, { signal: controller.signal });
    await started; controller.abort(); await assert.rejects(pending);
    await Promise.race([disconnected, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('HTTP request remained active after MCP cancellation')), 3000); timer.unref(); })]);
    assert.equal(f.calls.length, 1);
});
