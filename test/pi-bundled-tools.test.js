const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-bundled-tools-'));
const agentDir = path.join(fixture, 'agent');
fs.mkdirSync(agentDir);
fs.writeFileSync(path.join(agentDir, 'web-search.json'), JSON.stringify({ ssrf: { allowRanges: ['127.0.0.1/32'] } }));
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

test('Windows bundled native helper speaks the reviewed protocol without observing user applications', { skip: process.platform !== 'win32' }, () => {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(path.resolve(__dirname, '../vendor/pi-computer-use/prebuilt/windows/windows-bridge.exe'), [], {
        input: JSON.stringify({ protocolVersion: 4, id: 'fixture', cmd: 'diagnostics', args: {} }) + '\n',
        encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout.trim());
    assert.equal(response.id, 'fixture'); assert.equal(response.ok, true);
    assert.equal(response.result.protocolVersion, 4); assert.equal(response.result.os, 'windows');
});

test('desktop helper paths follow the actual identity while preserving explicit paths', () => {
    const { configureComputerHelpers } = require('../server/pi-bundled-computer-config');
    const identity = path.resolve('fixture-identity'), env = { PI_COMPUTER_USE_WINDOWS_HELPER_PATH: 'custom-helper' };
    configureComputerHelpers(identity, env);
    assert.equal(env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH, 'custom-helper');
    assert.equal(env.PI_COMPUTER_USE_LINUX_HELPER_PATH, path.join(identity, 'helpers/pi-computer-use/0.5.1/linux-bridge'));
    assert.equal(env.PI_COMPUTER_USE_HELPER_APP_PATH, path.join(identity, 'helpers/pi-computer-use/0.5.1/pi-computer-use.app'));
});

test('bundled skill update guidance preserves the existing prompt and pins the containing application', async () => {
    const { default: guidance } = await import('../server/pi-bundled-guidance.mjs');
    let beforeStart;
    guidance({ on: (name, handler) => { assert.equal(name, 'before_agent_start'); beforeStart = handler; } });
    const result = beforeStart({ systemPrompt: 'User context' });
    assert.ok(result.systemPrompt.startsWith('User context\n\n'));
    assert.match(result.systemPrompt, /git fetch\/pull.*do not apply/);
    assert.match(result.systemPrompt, /HTML presentations, not editable PPTX/);
});

test('managed web tools await execution and prevent detached fetch and curator workflows', async () => {
    const { webApi } = await import('../server/pi-bundled-web.mjs');
    const tools = [], commands = [];
    const api = webApi({ registerTool: tool => tools.push(tool), registerCommand: name => commands.push(name), registerShortcut: name => commands.push(name) });
    let finish, received;
    api.registerTool({ name: 'custom_search', label: 'Web Search', description: 'Search',
        parameters: { type: 'object', properties: { query: { type: 'string' }, includeContent: {}, workflow: {} } },
        execute: (_id, params) => { received = params; return new Promise(resolve => { finish = resolve; }); } });
    api.registerCommand('curator', {}); api.registerShortcut('ctrl+shift+s', {});
    const tool = tools[0];
    assert.deepEqual(Object.keys(tool.parameters.properties), ['query']);
    const pending = tool.execute('call', { query: 'fixture', includeContent: true, workflow: 'summary-review' });
    assert.deepEqual(received, { query: 'fixture', includeContent: false, workflow: 'none' });
    finish({ content: [{ type: 'text', text: 'fixture result' }] });
    assert.deepEqual(await pending, { content: [{ type: 'text', text: 'fixture result' }] });
    assert.deepEqual(commands, []);
    const fetch = { name: 'fetch_content', label: 'Fetch Content' };
    api.registerTool(fetch); assert.equal(tools[1], fetch);
});

test('bundled web reader fetches a synthetic page using its locked extraction dependencies', async t => {
    const http = require('node:http'), { once } = require('node:events');
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>Fixture research page</title></head><body><article><h1>Fixture research page</h1>'
            + '<p>BUNDLEDWEBREADEROK. This synthetic article verifies local extraction without using private documents or provider credentials. Its content is served by an isolated local HTTP fixture.</p>'.repeat(12) + '</article></body></html>');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const tools = [];
    const { default: bundledWeb } = await import('../server/pi-bundled-web.mjs');
    bundledWeb(new Proxy({ registerTool: tool => tools.push(tool) }, { get(target, key) { return target[key] || (() => {}); } }));
    const result = await tools.find(tool => tool.name === 'fetch_content').execute('fixture',
        { url: `http://127.0.0.1:${server.address().port}/article`, mode: 'readable', proxy: '' }, AbortSignal.timeout(10000), () => {}, { hasUI: false });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.match(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'), /BUNDLEDWEBREADEROK/);
});

test('desktop configuration respects project trust and opening a session stays lazy', async () => {
    const cwd = path.join(fixture, 'project'); fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.pi/computer-use.json'), JSON.stringify({ browser_use: false }));
    const { configureComputerHelpers, setComputerConfigScope } = require('../server/pi-bundled-computer-config');
    configureComputerHelpers(agentDir);
    const jiti = require(process.env.PIVANE_TEST_PI_JITI || 'jiti').createJiti(__filename);
    const { default: bundledComputer } = await jiti.import(path.resolve(__dirname, '../server/pi-bundled-computer-use.ts'));
    for (const trusted of [false, true]) {
        setComputerConfigScope(cwd, agentDir, trusted);
        const events = new Map(), commands = new Map(); let notice = '';
        bundledComputer({ registerTool() {}, on: (event, handler) => events.set(event, handler), registerCommand: (name, command) => commands.set(name, command) });
        const ctx = { cwd, hasUI: true, sessionManager: { getBranch: () => [] }, ui: { notify: message => { notice = message; } } };
        await events.get('session_start')({}, ctx);
        await commands.get('computer-use').handler('', ctx);
        assert.match(notice, new RegExp('browser_use: ' + (trusted ? 'disabled' : 'enabled')));
        assert.equal(fs.existsSync(path.join(agentDir, 'helpers')), false);
        await events.get('session_shutdown')();
    }
});
