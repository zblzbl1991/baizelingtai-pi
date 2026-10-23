const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-weknora-chat-')));
const agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
process.env.PI_WEB_DEFERRED_FILE = path.join(root, 'deferred.json'); delete process.env.PI_WEB_APPROVE_PROJECTS;
fs.mkdirSync(agent); fs.mkdirSync(cwd);
const { createPiAgentGateway } = require('../server/pi-agent-routes');
const { WorkspaceAccessService } = require('../server/workspace-access-service');

test('chat configures built-in WeKnora through the managed worker with scoped authorization and secret-free receipts', { timeout: 90000 }, async () => {
    let nextTool = null, allow = false;
    const calls = [], confirmations = [];
    const provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const part of req) raw += part;
        calls.push(JSON.parse(raw));
        const tool = nextTool; nextTool = null;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (tool) { chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + calls.length, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }); chunk({}, 'tool_calls'); }
        else { chunk({ role: 'assistant', content: 'FIXTURE_OK' }); chunk({}, 'stop'); }
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', enableInstallTelemetry: false, defaultProjectTrust: 'never' }));
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    const access = new WorkspaceAccessService({ envToken: () => 'fixture-web-token' });
    const gateway = createPiAgentGateway({ accessService: access });
    const app = require('express')(); app.use(require('express').json()); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`; process.env.PI_WORKSPACE_INTERNAL_ORIGIN = base;
    const api = async (endpoint, input, token = access.extensionAssistantToken, extra = {}) => {
        const response = await fetch(base + '/api/pi' + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify(input) });
        return { status: response.status, data: await response.json() };
    };
    try {
        const session = (await api('/extension-assistant/sessions', { cwd, scope: 'global', language: 'zh-CN' }, 'fixture-web-token')).data;
        assert.equal(calls.length, 0);
        const worker = await gateway.supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
        worker.subscribe(event => {
            if (event.type === 'extension_ui_request' && event.method === 'confirm') {
                confirmations.push(event); worker.send({ type: 'extension_ui_response', id: event.id, confirmed: allow });
            }
        });
        const run = async (name, args) => {
            nextTool = { name, args };
            const settled = new Promise(resolve => { const unsubscribe = worker.subscribe(event => { if (event.type === 'agent_settled') { unsubscribe(); resolve(); } }); });
            await worker.request('prompt', { message: '帮我配置内置 WeKnora 知识库，使用本次合成测试凭据。' });
            await Promise.race([settled, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('settle timeout')), 15000); timer.unref(); })]);
            return (await worker.request('get_messages')).messages.findLast(message => message.role === 'toolResult' && message.toolName === name);
        };
        const input = { cwd, sessionId: session.id };
        const inventory = await api('/extension-assistant/mcp-inventory', input);
        assert.equal(inventory.status, 200); assert.equal(inventory.data.scope, 'global');
        assert.equal((await api('/extension-assistant/mcp-inventory', input, access.internalToken)).status, 401);
        assert.equal((await api('/extension-assistant/mcp-inventory', input, access.extensionAssistantToken, { Origin: 'https://evil.invalid' })).status, 403);
        const ordinary = await gateway.store.createSession(cwd, 'Ordinary');
        assert.equal((await api('/extension-assistant/mcp-inventory', { cwd, sessionId: ordinary.id })).status, 400);
        assert.equal((await api('/sessions', { cwd })).status, 401);
        const nativeInventory = await run('extensions_mcp_inventory', {});
        assert.equal(nativeInventory.isError, false); assert.equal(JSON.parse(nativeInventory.content[0].text).revision, inventory.data.revision);
        const config = { baseUrl: 'http://127.0.0.1:1/api/v1', apiKey: 'synthetic-chat-secret', expectedRevision: inventory.data.revision };
        assert.equal((await run('extensions_weknora_configure', config)).details.pivaneMcpConfiguration.status, 'cancelled');
        assert.equal(fs.existsSync(path.join(agent, 'mcp.json')), false);
        allow = true;
        const result = await run('extensions_weknora_configure', config);
        assert.equal(result.isError, false); assert.equal(result.details.pivaneMcpConfiguration.requiresRuntimeRestart, true);
        assert.equal(result.details.pivaneMcpConfiguration.connectionStatus, 'not_checked');
        assert.equal(confirmations.length, 2); assert.ok(!JSON.stringify(confirmations).includes(config.apiKey));
        assert.ok(!JSON.stringify(result).includes(config.apiKey));
        assert.equal(JSON.parse(fs.readFileSync(path.join(agent, 'mcp.json'))).mcpServers['pivane-weknora'].env.WEKNORA_API_KEY, config.apiKey);
        assert.equal((await api('/extension-assistant/weknora-configure', { ...input, ...config, confirmed: true })).status, 409);
        assert.equal((await api('/extension-assistant/weknora-configure', { ...input, ...config, confirmed: true, scope: 'project' })).status, 400);
        assert.ok(!JSON.stringify((await api('/extension-assistant/mcp-inventory', input)).data).includes(config.apiKey));
        assert.ok(!JSON.stringify(calls).includes(access.extensionAssistantToken));
    } finally {
        await gateway.dispose(); access.dispose(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => provider.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
