'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), { pathToFileURL } = require('node:url');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-paths-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';

test('explicit native path spellings cannot put staffing resources in ordinary supplier requests', { timeout: 180000 }, async t => {
    const { PiAgentSupervisor } = require('../server/pi-agent-supervisor'), supervisor = new PiAgentSupervisor();
    const requests = [], alias = path.join(root, 'staffing-alias'), neutral = path.join(root, 'neutral-skill');
    const provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk; requests.push(JSON.parse(raw));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Complete' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    t.after(async () => {
        await supervisor.dispose(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
        if (fs.existsSync(alias)) fs.unlinkSync(alias);
        fs.rmSync(root, { recursive: true, force: true });
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    fs.symlinkSync(path.resolve(__dirname, '../server/staffing'), alias, process.platform === 'win32' ? 'junction' : 'dir');
    fs.mkdirSync(neutral); fs.writeFileSync(path.join(neutral, 'SKILL.md'), '---\nname: neutral-alias-fixture\ndescription: Neutral fixture marker.\n---\nNeutral fixture.\n');
    const variants = [
        ['file URL', file => pathToFileURL(path.join(alias, file)).href],
        ['tilde', file => '~/staffing-alias/' + file],
        ...(process.platform === 'win32' ? ['/mnt/', '/', '/cygdrive/'].map(prefix => [prefix + 'drive', file => {
            const absolute = path.join(alias, file).replaceAll('\\', '/'); return prefix + absolute[0].toLowerCase() + absolute.slice(2);
        }]) : []),
    ];
    for (const [label, resource] of variants) await t.test(label, async () => {
        const worker = await supervisor.createEphemeralWorker(cwd, { env: { HOME: root, USERPROFILE: root },
            extraArgs: ['--no-extensions', '--no-skills', '--skill', neutral, '--skill', resource('skills/staffing-management'), '-e', resource('extension.ts')] });
        try {
            const before = requests.length;
            let off; const settled = new Promise(resolve => { off = worker.subscribe(event => { if (event.type === 'agent_settled') resolve(); }); });
            try { await worker.request('prompt', { message: 'Neutral explicit resource request' }); await settled; } finally { off(); }
            assert.equal(requests.length, before + 1, 'check the actual supplier request');
            const actual = JSON.stringify(requests.at(-1)); assert.match(actual, /neutral-alias-fixture/);
            assert.doesNotMatch(actual, /staffing_query|staffing_prepare_change|staffing_operation_status|staffing-management|pivane-staffing|人员调配/);
        } finally { await worker.dispose(); }
    });
});
