'use strict';
// Fixture setup uses the native SessionManager before a supervised worker opens it.
// Public browser/API operations below use the unmodified gateway and real engine.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function startOfficePreviewServer({ automaticUpdates = false } = {}) {
    const controls = new Set(['PIVANE_BROWSER_TARGET', 'PIVANE_BROWSER_AUDIT_FILE', 'PIVANE_TEST_HERMES_BUNDLE', 'PIVANE_TEST_SCREENSHOT_DIR']);
    for (const key of Object.keys(process.env)) if (/^(?:PI_|PIVANE_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|OPENROUTER_|AZURE_OPENAI_|AWS_|BEDROCK_|MISTRAL_|GROQ_|XAI_|DEEPSEEK_)/.test(key) && !controls.has(key)) delete process.env[key];
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-preview-real-')));
    const agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
    fs.mkdirSync(agent); fs.mkdirSync(cwd);
    Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, PI_PROJECT_ROOTS: root, PI_OFFLINE: '1', PI_WEB_TOKEN: '', PI_WEB_DEFERRED_FILE: path.join(root, 'deferred.json') });
    const providerRequests = [], provider = http.createServer((req, res) => { providerRequests.push({ method: req.method, url: req.url }); res.writeHead(500); res.end('Preview must not call a provider'); });
    let access, gateway, server, wss, stopping;
    const close = () => stopping ||= (async () => {
        for (const socket of wss?.clients || []) socket.terminate();
        try { await gateway?.dispose(); }
        finally {
            access?.dispose(); server?.closeAllConnections(); provider.closeAllConnections();
            await Promise.all([server ? new Promise(resolve => server.close(resolve)) : undefined, new Promise(resolve => provider.close(resolve))]);
        }
        // Failed disposal preserves the owned fixture for diagnosis.
        fs.rmSync(root, { recursive: true, force: true });
    })();
    try {
        provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
        fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
        fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'synthetic', models: [{ id: 'fixture', name: 'Preview fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
        const { WorkspaceAccessService } = require('../server/workspace-access-service');
        const { createPiAgentGateway } = require('../server/pi-agent-routes');
        const { DeliverableService, ENTRY } = require('../server/pi-deliverables');
        access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => '' });
        gateway = createPiAgentGateway({ accessService: access, deferredFilePath: path.join(root, 'deferred.json'), cronFilePath: path.join(root, 'cron.sqlite') });
        const { getSdk } = require('../server/pi-session-store'), { SessionManager } = await getSdk();
        const session = await gateway.store.createSession(cwd, 'Office real preview'), otherSession = await gateway.store.createSession(cwd, 'Other preview thread');
        const manager = SessionManager.open(session.path), originalManager = SessionManager.open(otherSession.path);
        manager.appendModelChange('fixture', 'fixture'); manager.appendThinkingLevelChange('off');
        originalManager.appendModelChange('fixture', 'fixture'); originalManager.appendThinkingLevelChange('off');
        originalManager.appendMessage({ role: 'user', content: 'Other synthetic thread', timestamp: 1 });
        manager.appendMessage({ role: 'user', content: 'Synthetic preview originals only', timestamp: 1 });
        const originals = {}, deliveries = {}, uploads = {};
        const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        const deliveryService = new DeliverableService({ store: gateway.store, supervisor: gateway.supervisor });
        const fixtureDir = path.join(__dirname, 'fixtures/office'), manifest = require('./fixtures/office/rich-manifest.json');
        for (const format of ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']) {
            const name = 'rich.' + format, bytes = fs.readFileSync(path.join(fixtureDir, name));
            if (digest(bytes) !== manifest.files[name].sha256) throw Error('Fixture hash mismatch: ' + name);
            originals[format] = { name, bytes, sha256: digest(bytes) }; fs.writeFileSync(path.join(cwd, name), bytes);
            const receipt = await deliveryService.objects.publish({ cwd, sessionId: session.id }, { requestId: 'preview-' + format, title: 'delivery-' + format, files: [name] });
            manager.appendCustomEntry(ENTRY, receipt.reference); deliveries[format] = receipt;
            const uploaded = await gateway.documents.upload({ cwd, sessionId: session.id, requestId: 'preview-' + format, name }, bytes);
            manager.appendMessage({ role: 'user', content: uploaded.marker, timestamp: 2 }); uploads[format] = uploaded;
        }
        manager.appendMessage({ role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: 3,
            content: [{ type: 'toolCall', id: 'fixture-tool', name: 'read', arguments: { path: 'README.md' } }] });
        manager.appendMessage({ role: 'toolResult', toolCallId: 'fixture-tool', toolName: 'read', content: [{ type: 'text', text: 'Synthetic retained tool result' }], isError: false, timestamp: 4 });
        manager.appendMessage({ role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'stop', timestamp: 5,
            content: [{ type: 'text', text: Object.entries(deliveries).map(([format, receipt]) => `[delivery-${format}](#pi-delivery=${receipt.reference.id}/0)`).join(' · ') }] });
        const express = require('express'), app = express(), repository = path.resolve(__dirname, '..');
        access.mount(app); app.use(express.json({ limit: '32mb' })); gateway.mount(app);
        for (const [route, dir] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${route}`, express.static(path.join(repository, 'node_modules', dir)));
        for (const dir of ['legacy/build', 'cmaps', 'standard_fonts', 'wasm']) app.use(`/vendor/pdfjs/${dir}`, express.static(path.join(repository, 'node_modules/pdfjs-dist', dir), { index: false }));
        app.use(express.static(path.join(repository, 'public')));
        server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
        wss = gateway.attachWebSocket(server); const origin = `http://127.0.0.1:${server.address().port}`;
        process.env.PI_WORKSPACE_INTERNAL_ORIGIN = origin;
        // A preview fixture has no reason to query the release registry. This is the
        // real public preference endpoint on this throwaway instance, not an API mock.
        const notifications = await fetch(origin + '/api/pi/settings/updates/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ enabled: automaticUpdates }) });
        if (!notifications.ok) throw Error('Could not disable update notifications in isolated preview fixture');
        return { root, cwd, session, otherSession, gateway, originals, deliveries, uploads, providerRequests, origin, close };
    } catch (error) { await close(); throw error; }
}
module.exports = { startOfficePreviewServer };
