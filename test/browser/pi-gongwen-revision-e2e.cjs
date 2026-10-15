// Browser full chain: upload official DOCX → revise_gongwen (tracked revisions + report)
// → delivery links → viewer preview/download. Real gateway, managed worker and the
// gongwen child process; only the model is a local synthetic provider.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const screenshots = path.resolve(process.env.PIVANE_TEST_SCREENSHOT_DIR || path.join(os.tmpdir(), 'pivane-gongwen-e2e'));
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const SETTLE_TIMEOUT = 180000;

async function main() {
    for (const key of Object.keys(process.env)) if (/^(?:PI_|PIVANE_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|OPENROUTER_|AZURE_OPENAI_|AWS_|BEDROCK_|MISTRAL_|GROQ_|XAI_|DEEPSEEK_)/.test(key)) delete process.env[key];
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-gongwen-e2e-')));
    const agent = path.join(root, 'agent'), cwd = path.join(root, '公文项目');
    fs.mkdirSync(agent); fs.mkdirSync(cwd); fs.mkdirSync(screenshots, { recursive: true });
    Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, PI_PROJECT_ROOTS: root, PI_OFFLINE: '1', PI_WEB_TOKEN: '' });
    let provider, access, gateway, server, wss, browser;
    const requests = [], facts = {};
    let providerFailure = null;
    try {
        const sourceFile = path.join(root, '原稿.docx');
        await require('../../vendor/gongwen-kit/tests/messy-docx').build(sourceFile);
        const original = fs.readFileSync(sourceFile);
        const sse = (res, delta, reason = null) => res.write(`data: ${JSON.stringify({ id: 'gongwen-e2e', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
        const call = (res, id, name, input) => { sse(res, { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, 'tool_calls'); res.end('data: [DONE]\n\n'); };
        const reply = res => { sse(res, { role: 'assistant', content: facts.reply || '好的。' }, 'stop'); res.end('data: [DONE]\n\n'); };
        const lastTool = messages => [...messages].reverse().find(message => message.role === 'tool');
        const toolJson = message => {
            const text = Array.isArray(message.content) ? message.content.map(block => block.text ?? '').join('') : message.content;
            try { return JSON.parse(text); } catch { return { raw: text }; }
        };
        provider = http.createServer(async (req, res) => {
            try {
                let text = ''; for await (const part of req) text += part;
                const body = JSON.parse(text); requests.push(body);
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                const tool = lastTool(body.messages);
                if (!tool) {
                    // The real prompt carries the attachment marker anywhere in the request
                    // (a document-index message trails it); later auxiliary requests such as
                    // session titles repeat the transcript and must not restart the chain.
                    const marker = facts.chainStarted ? null : /<pivane_document id=\\*"([a-f0-9]{64})\\*"/.exec(JSON.stringify(body.messages));
                    if (!marker) return reply(res);
                    facts.chainStarted = true;
                    facts.attachmentId = marker[1];
                    return call(res, 'gongwen-revise', 'revise_gongwen', { requestId: 'gongwen-e2e-v1', id: marker[1], action: 'revise', layout: true });
                }
                if (tool.tool_call_id === 'gongwen-revise') {
                    const result = toolJson(tool);
                    facts.delivery = result?.delivery;
                    facts.revisionAuthor = result?.revisionAuthor;
                    assert.ok(facts.delivery?.reference?.id, `revision delivery published: ${JSON.stringify(result).slice(0, 300)}`);
                    assert.equal(facts.delivery.files.length, 2, 'revised DOCX and check report delivered');
                    const links = facts.delivery.files.map(file => `[${file.name}](${file.href})`).join(' · ');
                    facts.reply = `规范修订完成：${links}。本处修订可在 Word/WPS 审阅中逐条接受或拒绝。`;
                    return reply(res);
                }
                return reply(res);
            } catch (error) {
                providerFailure = error;
                if (!res.headersSent) { res.writeHead(500); res.end('synthetic provider failure'); }
                else res.end('data: [DONE]\n\n');
            }
        });
        provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
        fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
        fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
            api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'synthetic',
            models: [{ id: 'fixture', name: 'Local fixture', input: ['text'], contextWindow: 32000, maxTokens: 2000 }] } } }));
        const { createPiAgentGateway } = require('../../server/pi-agent-routes');
        const { WorkspaceAccessService } = require('../../server/workspace-access-service');
        access = new WorkspaceAccessService({ envToken: () => '' });
        gateway = createPiAgentGateway({ accessService: access, deferredFilePath: path.join(root, 'deferred.json') });
        const app = express(); access.mount(app); app.use(express.json({ limit: '32mb' })); gateway.mount(app);
        const repository = path.resolve(__dirname, '../..');
        for (const [route, dir] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']])
            app.use(`/vendor/${route}`, express.static(path.join(repository, 'node_modules', dir)));
        app.use(express.static(path.join(repository, 'public')));
        server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
        wss = gateway.attachWebSocket(server);
        const origin = `http://127.0.0.1:${server.address().port}`;
        process.env.PI_WORKSPACE_INTERNAL_ORIGIN = origin;
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
        const openPage = async (width, sessionId) => {
            const context = await browser.newContext({ viewport: { width, height: width < 680 ? 844 : 1000 }, locale: 'zh-CN', reducedMotion: 'reduce', acceptDownloads: true });
            await context.addInitScript(({ cwd, sessionId }) => {
                localStorage.setItem('pi.web.cwd', cwd);
                if (sessionId) localStorage.setItem('pi.web.session:' + cwd, sessionId);
                localStorage.setItem('pi.workspace.theme', 'dark');
            }, { cwd, sessionId });
            const page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', request => new URL(request.request().url()).origin === origin ? request.continue() : request.abort());
            await page.goto(`${origin}/#/chat`, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => !document.querySelector('#pi-project-button')?.disabled);
            if (await page.locator('#pi-project-dialog').isVisible()) {
                await page.locator('#pi-project-input').fill(cwd);
                await page.locator('#pi-project-form [type=submit]').click();
                await page.locator('#pi-project-dialog').waitFor({ state: 'hidden' });
            }
            // A stored session restores itself; a fresh project needs an explicit new chat.
            // The composer stays disabled until a session opens, so restore is polled first.
            for (let i = 0; i < 24 && !(await page.evaluate(() => location.hash.includes('sessionId='))); i++) await page.waitForTimeout(500);
            if (!(await page.evaluate(() => location.hash.includes('sessionId=')))) {
                const chat = page.locator('.nav-btn[data-tab=chat]');
                if (await chat.count()) await chat.click();
                await page.locator('#pi-new-session').click();
            }
            await page.waitForFunction(() => location.hash.includes('sessionId=') && !document.querySelector('#pi-input')?.disabled, null, { timeout: 30000 });
            return { context, page, errors };
        };
        const desktop = await openPage(1440, null);
        const { page } = desktop;
        try {
            await page.locator('#pi-file-input').setInputFiles({ name: '培训通知.docx',
                mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: original });
            await page.locator('#pi-attachments .pi-attachment-chip').waitFor();
            await page.locator('#pi-input').fill('按公文规范修复这份通知，直接调整版式，另存带修订痕迹的 Word，保留原件。');
            await page.locator('#pi-send-button').click();
            const links = page.locator('#pi-transcript-content .assistant a[href*="#pi-delivery="]');
            const providerFailed = async () => { while (!providerFailure) await new Promise(resolve => setTimeout(resolve, 300)); throw providerFailure; };
            await Promise.race([links.first().waitFor({ timeout: SETTLE_TIMEOUT }), providerFailed()]);
            assert.equal(await links.count(), 2, 'revised DOCX and report links rendered');
            assert.ok(!JSON.stringify(requests).includes(original.toString('base64')), 'original bytes stay out of model context');
            assert.deepEqual(desktop.errors, []);
            await links.first().click();
            await page.locator('#pi-file-viewer').waitFor();
            await page.locator('#pi-file-download:not([disabled])').waitFor();
            // A floating engine-update notice may legally cover the inspector toolbar;
            // dismiss it like a user would before using the viewer actions.
            const noticeClose = page.locator('#pi-update-notice-close');
            if (await noticeClose.isVisible().catch(() => false)) await noticeClose.click().catch(() => {});
            const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
            downloadPromise.catch(() => {});
            await page.locator('#pi-file-download').click();
            const revisedBytes = fs.readFileSync(await (await downloadPromise).path());
            const xml = require('../../server/pi-document-parser').officeZip(revisedBytes).read('word/document.xml').toString('utf8');
            assert.match(xml, /<w:ins /, 'normalization is a tracked Word revision');
            assert.ok(facts.revisionAuthor && xml.includes(facts.revisionAuthor), 'revision author recorded in the document');
            // The report opens as a readable markdown preview next to the document download.
            await links.nth(1).click();
            await page.waitForFunction(() => document.querySelector('#pi-file-body')?.textContent.includes('规则机检'), null, { timeout: 30000 });
            const originalDownload = page.waitForEvent('download');
            await page.locator('.pi-document-card button').first().click();
            assert.equal(fs.readFileSync(await (await originalDownload).path()).equals(original), true, 'uploaded original bytes unchanged');
            assert.deepEqual(await gateway.documents.bytes(await gateway.documents.object(facts.attachmentId)), original);
            await page.locator('#pi-files-deliveries').click();
            await page.locator('.pi-delivery-card').first().waitFor();
            assert.equal(await page.locator('.pi-delivery-card').count(), 2, 'both delivered files listed');
            await page.screenshot({ path: path.join(screenshots, 'gongwen-e2e-desktop.png') });
            const sessionId = new URLSearchParams(page.url().split('?')[1]).get('sessionId');
            const mobile = await openPage(390, sessionId);
            try {
                await mobile.page.locator('#pi-transcript-content .assistant a[href*="#pi-delivery="]').first().waitFor({ timeout: 30000 });
                const overflow = await mobile.page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
                assert.ok(overflow.document <= overflow.viewport + 1 && overflow.body <= overflow.viewport + 1, `mobile overflow: ${JSON.stringify(overflow)}`);
                assert.deepEqual(mobile.errors, []);
                await mobile.page.screenshot({ path: path.join(screenshots, 'gongwen-e2e-mobile.png') });
            } finally { await mobile.context.close(); }
            console.log('gongwen revision e2e: upload → revise_gongwen → delivery links → preview/download passed (desktop + mobile)');
        } finally { await desktop.context.close(); }
        console.log(JSON.stringify({ status: 'passed', delivery: facts.delivery?.reference?.id, requests: requests.length, screenshots }));
    } catch (error) {
        if (providerFailure) console.error('synthetic provider failure:', providerFailure.stack || providerFailure.message);
        console.error(JSON.stringify({ status: 'failed', requests: requests.length, facts: { ...facts, delivery: facts.delivery?.reference?.id } }));
        throw error;
    } finally {
        if (browser) await browser.close();
        for (const socket of wss?.clients || []) socket.terminate();
        if (gateway) await gateway.dispose();
        access?.dispose();
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
        fs.rmSync(root, { recursive: true, force: true });
        // dispose() waits for the RPC child's exit, but on Windows the kill can land a
        // moment after dispose resolves; let the pipes close so the loop can empty.
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; }).finally(() => {
    // Safety net: if any non-daemon handle survives cleanup, report the recorded
    // result instead of hanging the suite; a healthy run empties the loop first.
    setTimeout(() => { console.error('cleanup left live handles; exiting with the recorded result'); process.exit(process.exitCode || 0); }, 5000).unref();
});
