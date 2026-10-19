const { selectBrowserTargets, browserTargetEnabled } = require('./targets.cjs');
// Browser full chain: upload DOCX → managed work copy → native OfficeCLI MCP edit →
// deliver_files → viewer download. Real gateway, managed worker, stdio OfficeCLI process
// and deliverable snapshots; only the model is a local synthetic provider.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const screenshots = path.resolve(process.env.PIVANE_TEST_SCREENSHOT_DIR || path.join(os.tmpdir(), 'pivane-office-e2e'));
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const SETTLE_TIMEOUT = 180000;

async function main() {
    // Read runner-provided paths first, then drop inherited identities and provider credentials.
    for (const key of Object.keys(process.env)) if (/^(?:PI_|PIVANE_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|OPENROUTER_|AZURE_OPENAI_|AWS_|BEDROCK_|MISTRAL_|GROQ_|XAI_|DEEPSEEK_)/.test(key) && !['PIVANE_BROWSER_TARGET', 'PIVANE_BROWSER_AUDIT_FILE'].includes(key)) delete process.env[key];
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-office-e2e-')));
    const agent = path.join(root, 'agent'), cwd = path.join(root, '合同项目');
    fs.mkdirSync(agent); fs.mkdirSync(cwd); fs.mkdirSync(screenshots, { recursive: true });
    Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, PI_PROJECT_ROOTS: root, PI_OFFLINE: '1', PI_WEB_TOKEN: '' });
    let provider, access, gateway, server, wss, browser;
    const requests = [], facts = {};
    let providerFailure = null;
    try {
        const { Document, Paragraph, TextRun, Packer } = require('docx');
        const original = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({
            children: [new TextRun('名称：'), new TextRun({ text: '示例', bold: true, color: '0000FF' }),
                new TextRun({ text: '公司', italics: true, color: 'FF0000' }), new TextRun('。保持后缀。')] })] }] }));
        const sse = (res, delta, reason = null) => res.write(`data: ${JSON.stringify({ id: 'office-e2e', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
        const call = (res, id, name, input) => { sse(res, { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, 'tool_calls'); res.end('data: [DONE]\n\n'); };
        const reply = res => { sse(res, { role: 'assistant', content: facts.reply || '好的。' }, 'stop'); res.end('data: [DONE]\n\n'); };
        const lastTool = messages => [...messages].reverse().find(message => message.role === 'tool');
        const toolJson = message => {
            const text = Array.isArray(message.content) ? message.content.map(block => block.text ?? '').join('') : message.content;
            try { return JSON.parse(text); } catch { return { raw: text }; }
        };
        const editCode = () => {
            const command = ['set', facts.copyPath, '/body/p[1]', '--find', '示例公司', '--replace', '演示单位', '--prop', 'revision.author=白泽灵台验证', '--json'];
            return `text(await tools.mcp__pivane_officecli__officecli(${JSON.stringify({ command })}))`;
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
                    return call(res, 'office-prepare', 'prepare_office_document', { id: marker[1], requestId: 'office-e2e-v1' });
                }
                if (tool.tool_call_id === 'office-prepare') {
                    const result = toolJson(tool);
                    facts.copyPath = result?.path;
                    assert.ok(facts.copyPath, `prepare returns the work copy path: ${JSON.stringify(result).slice(0, 300)}`);
                    return call(res, 'office-edit', 'codemode', { code: editCode() });
                }
                if (tool.tool_call_id === 'office-edit') {
                    const result = toolJson(tool);
                    if ((result?.isError || result?.raw !== undefined) && (facts.editRetries = (facts.editRetries || 0) + 1) <= 40) {
                        await new Promise(resolve => setTimeout(resolve, 250));
                        return call(res, 'office-edit', 'codemode', { code: editCode() });
                    }
                    assert.ok(!result?.isError, `OfficeCLI edit succeeds: ${JSON.stringify(result).slice(0, 300)}`);
                    return call(res, 'office-deliver', 'deliver_files', { requestId: 'office-e2e-delivery-v1', title: 'Office 修订验证', files: [facts.copyPath] });
                }
                if (tool.tool_call_id === 'office-deliver') {
                    const result = toolJson(tool);
                    facts.delivery = result?.delivery?.reference ? result.delivery : result;
                    assert.ok(facts.delivery?.reference?.id, `delivery published: ${JSON.stringify(result).slice(0, 300)}`);
                    assert.equal(facts.delivery.files.length, 1);
                    facts.reply = `修订完成：[${facts.delivery.files[0].name}](${facts.delivery.files[0].href})。原件保持不变，请在 Word/WPS 中核对修订记录。`;
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
    if (!browserTargetEnabled(width)) return;
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
            await page.locator('#pi-file-input').setInputFiles({ name: '合作合同.docx',
                mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: original });
            await page.locator('#pi-attachments .pi-attachment-chip').waitFor();
            await page.locator('#pi-input').fill('同意把“示例公司”改为“演示单位”，修改后交付 Word，保留原件。');
            await page.locator('#pi-send-button').click();
            const link = page.locator('#pi-transcript-content .assistant a[href*="#pi-delivery="]').first();
            const providerFailed = async () => { while (!providerFailure) await new Promise(resolve => setTimeout(resolve, 300)); throw providerFailure; };
            await Promise.race([link.waitFor({ timeout: SETTLE_TIMEOUT }), providerFailed()]);
            // The whole model chain runs on raw uploads: original bytes never enter the provider.
            assert.ok(!JSON.stringify(requests).includes(original.toString('base64')), 'original bytes stay out of model context');
            assert.deepEqual(desktop.errors, []);
            await link.click();
            await page.locator('#pi-file-viewer').waitFor();
            await page.locator('#pi-file-download:not([disabled])').waitFor();
            // A floating engine-update notice may legally cover the inspector toolbar;
            // dismiss it like a user would before using the viewer actions.
            const noticeClose = page.locator('#pi-update-notice-close');
            if (await noticeClose.isVisible().catch(() => false)) await noticeClose.click().catch(() => {});
            const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
            downloadPromise.catch(() => {});
            try { await page.locator('#pi-file-download').click({ timeout: 10000 }); }
            catch (error) {
                console.error('download click diagnostics:', JSON.stringify(await page.evaluate(() => {
                    const button = document.querySelector('#pi-file-download'), rect = button?.getBoundingClientRect();
                    const hit = rect ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) : null;
                    return { rect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
                        hit: hit ? { tag: hit.tagName, id: hit.id, cls: String(hit.className).slice(0, 80) } : null,
                        viewerHidden: document.querySelector('#pi-file-viewer')?.hidden,
                        inspector: document.querySelector('#pi-inspector')?.className };
                })));
                throw error;
            }
            const bytes = fs.readFileSync(await (await downloadPromise).path());
            const xml = require('../../server/pi-document-parser').officeZip(bytes).read('word/document.xml').toString('utf8');
            assert.match(xml, /<w:ins\b/, 'replacement is a tracked Word revision');
            assert.ok(xml.includes('演示单位') && xml.includes('保持后缀'), 'edited and untouched text present');
            assert.ok(xml.includes('白泽灵台验证'), 'revision author recorded');
            assert.equal(await page.locator('#pi-transcript-content .pi-tool-row').count() >= 2, true, 'tool progress rows rendered');
            const originalDownload = page.waitForEvent('download');
            await page.locator('.pi-document-card button').first().click();
            assert.equal(fs.readFileSync(await (await originalDownload).path()).equals(original), true, 'uploaded original bytes unchanged');
            assert.deepEqual(await gateway.documents.bytes(await gateway.documents.object(facts.attachmentId)), original);
            await page.locator('#pi-files-deliveries').click();
            await page.locator('.pi-delivery-card').first().waitFor();
            assert.equal(await page.locator('.pi-delivery-card').count(), 1);
            await page.screenshot({ path: path.join(screenshots, 'office-e2e-desktop.png') });
            const sessionId = new URLSearchParams(page.url().split('?')[1]).get('sessionId');
            const reopenedWidth = browserTargetEnabled(390) ? 390 : 1440;
            const mobile = await openPage(reopenedWidth, sessionId);
            try {
                await mobile.page.locator('#pi-transcript-content .assistant a[href*="#pi-delivery="]').first().waitFor({ timeout: 30000 });
                const overflow = await mobile.page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
                assert.ok(overflow.document <= overflow.viewport + 1 && overflow.body <= overflow.viewport + 1, `mobile overflow: ${JSON.stringify(overflow)}`);
                assert.deepEqual(mobile.errors, []);
                await mobile.page.screenshot({ path: path.join(screenshots, reopenedWidth === 1440 ? 'office-e2e-reopened-desktop.png' : 'office-e2e-mobile.png') });
            } finally { await mobile.context.close(); }
            console.log('office editing e2e: upload → prepare → native MCP edit → deliver → viewer download passed (initial and reopened session)');
        } finally { await desktop.context.close(); }
        console.log(JSON.stringify({ status: 'passed', copyPath: Boolean(facts.copyPath), delivery: facts.delivery?.reference?.id, requests: requests.length, screenshots }));
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
