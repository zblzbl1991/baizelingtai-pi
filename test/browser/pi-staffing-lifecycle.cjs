const { browserTargetEnabled } = require('./targets.cjs');
// Real workspace HTTP/WS, native worker, local provider, ledger and artifact store.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), express = require('express'), { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
async function main() {
    const widths = process.env.PI_STAFFING_VIEWPORT ? [Number(process.env.PI_STAFFING_VIEWPORT)] : [1440, 393, 320];
    assert.ok(widths.every(width => Number.isInteger(width) && width >= 320), 'valid staffing lifecycle viewports');
    const cleanups = [], cleanupErrors = [], diagnosticErrors = [], closed = [], failures = [];
    const own = (name, priority, close) => cleanups.push({ name, priority, close, order: cleanups.length });
    const closeServer = server => new Promise((resolve, reject) => server.close(error => {
        // A created server whose listen failed never acquired a listener.
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
    }));
    let temporary, temporaryFd, temporaryIdentity, temporaryStat, removed = false;
    const io = require('../../server/pi-file-io'), { descriptorPathSync } = require('../../server/pi-file-descriptor');
    try {
    const temporaryParent = fs.realpathSync.native(os.tmpdir());
    temporary = fs.mkdtempSync(path.join(temporaryParent, 'staffing-full-browser-'));
    temporaryFd = io.openReadSync(temporary); temporaryStat = fs.fstatSync(temporaryFd, { bigint: true }); temporaryIdentity = io.identity(temporaryFd);
    assert.equal(descriptorPathSync(temporaryFd), temporary);
    const agent = path.join(temporary, 'agent'), cwd = path.join(temporary, 'project'); fs.mkdirSync(agent); fs.mkdirSync(cwd);
    process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = temporary; process.env.PI_OFFLINE = '1'; process.env.PI_WEB_DEFERRED_FILE = path.join(agent, 'deferred.json');
    const toolQueue = [], requests = [], uploads = []; let call = 0;
    const provider = http.createServer(async (req, res) => {
        let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw); requests.push(body);
        const tool = body.tools?.some(item => item.function?.name === 'staffing_query') ? toolQueue.shift() : null;
        let exported = false; try { exported = JSON.parse(body.messages.findLast(message => message.role === 'tool')?.content || '{}').phase === 'saved'; } catch { /* This is only a deterministic synthetic reply. */ }
        const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'browser-' + ++call, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { role: 'assistant', content: exported ? '合成 Excel 已保存到成果。' : '合成方案已准备，请核对具体卡片。' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    own('provider listener', 50, () => closeServer(provider)); own('provider connections', 50, () => provider.closeAllConnections());
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    const { WorkspaceAccessService } = require('../../server/workspace-access-service'), { createPiAgentGateway } = require('../../server/pi-agent-routes');
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => '' });
    own('access', 30, () => access.dispose());
    const gateway = createPiAgentGateway({ accessService: access, deferredFilePath: path.join(agent, 'deferred.json'), cronFilePath: path.join(agent, 'cron.sqlite') });
    own('gateway', 20, () => gateway.dispose());
    const app = express();
    app.use((req, res, next) => {
        if (req.url.startsWith('/api/pi/staffing/excel/uploads')) {
            const row = { method: req.method, at: Date.now(), bytes: req.headers['content-length'], ended: false }; uploads.push(row);
            req.on('end', () => { row.ended = true; }); req.on('aborted', () => { row.aborted = true; }); req.on('error', error => { row.error = error.code; });
            res.on('finish', () => { row.status = res.statusCode; }); res.on('close', () => { row.closed = true; });
        }
        next();
    });
    access.mount(app); app.use(express.json()); gateway.mount(app);
    for (const [name, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', folder)));
    app.use(express.static(path.join(root, 'public'))); const server = http.createServer(app);
    own('workspace listener', 40, () => closeServer(server)); own('workspace connections', 40, () => server.closeAllConnections());
    gateway.attachWebSocket(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`; process.env.PI_WORKSPACE_INTERNAL_ORIGIN = origin;
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
    own('browser', 10, () => browser.close());
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' }); own('browser context', 10, () => context.close());
    const page = await context.newPage(), errors = []; own('page', 10, () => page.close());
    const stages = [], dialogs = [], sockets = [], network = [], lifecycle = [], targetCrashes = [];
    const cdp = await context.newCDPSession(page); own('page CDP', 10, () => cdp.detach());
    const browserCdp = await browser.newBrowserCDPSession(); own('browser CDP', 10, () => browserCdp.detach());
    await cdp.send('Page.enable'); await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }); await cdp.send('Performance.enable');
    await browserCdp.send('Target.setDiscoverTargets', { discover: true });
    const browserVersion = await browserCdp.send('Browser.getVersion');
    cdp.on('Page.lifecycleEvent', event => { lifecycle.push({ name: event.name, timestamp: event.timestamp }); if (lifecycle.length > 100) lifecycle.shift(); });
    browserCdp.on('Target.targetCrashed', event => targetCrashes.push({ status: event.status, errorCode: event.errorCode }));
    const performanceMetrics = async () => { try { return (await cdp.send('Performance.getMetrics')).metrics; } catch (error) { return { error: error.message }; } };
    page.on('pageerror', error => errors.push(error.message));
    page.on('crash', () => errors.push('Browser renderer crashed'));
    page.on('dialog', async dialog => { dialogs.push({ type: dialog.type(), message: dialog.message().slice(0, 120) }); await dialog.dismiss(); });
    page.on('requestfailed', request => network.push({ event: 'failed', method: request.method(), path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
    page.on('response', response => { if (response.status() >= 400) network.push({ event: 'response', path: new URL(response.url()).pathname, status: response.status() }); });
    page.on('websocket', socket => {
        sockets.push({ event: 'open' }); socket.on('close', () => sockets.push({ event: 'close' }));
        for (const event of ['framesent', 'framereceived']) socket.on(event, frame => {
            try { const value = JSON.parse(String(frame.payload)); sockets.push({ event, type: value.type, command: value.command, state: typeof value.state === 'string' ? value.state : undefined }); if (sockets.length > 100) sockets.shift(); } catch { /* Only structured protocol metadata is retained. */ }
        });
    });
    const foreground = async stage => {
        const record = async position => stages.push({ stage, position, ...await page.evaluate(async () => ({
            visibility: document.visibilityState, focus: document.hasFocus(),
            frame: await Promise.race([new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve('two frames')))), new Promise(resolve => setTimeout(() => resolve('no frames in 500ms'), 500))])
        })) });
        await record('before'); await page.bringToFront(); await record('after'); stages.at(-1).performance = await performanceMetrics();
    };
    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.abort());
    await page.addInitScript(cwd => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.language', 'zh'); window.staffingAudit = [];
        const record = type => { const panel = document.querySelector('.staffing-panel'); window.staffingAudit.push({ type, at: performance.now(), state: panel?.dataset.staffingState,
            revision: panel?.textContent.match(/台账版本：\s*(\d+)/)?.[1], open: panel?.querySelector('[data-staffing-advanced]')?.open, draftLength: panel?.querySelector('textarea')?.value.length }); if (window.staffingAudit.length > 100) window.staffingAudit.shift(); };
        for (const type of ['workspace:tabchanged', 'workspace:access-ready', 'workspace:staffing-changed', 'workspace:agent-profiles-changed']) window.addEventListener(type, () => record(type), true);
        document.addEventListener('DOMContentLoaded', () => new MutationObserver(records => { if (records.some(row => row.target.matches?.('.staffing-panel'))) record('panel render'); }).observe(document.body, { subtree: true, childList: true }));
    }, cwd);
    const screenshot = async (phase, locator, focus) => {
        for (const width of widths) {
            if (!browserTargetEnabled(width)) continue;
            await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ colorScheme: width === 393 ? 'dark' : 'light' });
            if (focus) await focus.scrollIntoViewIfNeeded();
            assert.deepEqual(await page.evaluate(() => ['body', '#staffing-tab', '.staffing-panel', '.staffing-views', '.staffing-plan-card'].filter(selector => { const node = document.querySelector(selector); return node && node.offsetParent !== null && node.scrollWidth > node.clientWidth + 1; })), [], phase + ' actual width at ' + width);
            if (process.env.PIVANE_TEST_SCREENSHOT_DIR) { fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true }); await (locator || page).screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, `staffing-lifecycle-${phase}-${width}.png`) }); }
        }
    };
    let phase = 'initial ledger';
    try {
        await page.goto(origin + '/#/staffing', { waitUntil: 'domcontentloaded' }); await foreground('initial ledger'); await page.locator('#staffing-enable').click();
        await page.locator('[data-staffing-advanced] > summary').click();
        const initial = { people: [{ id: 'P1', name: '<img src=x onerror=alert(1)>', department: 'A', direct: true }, { id: 'P2', name: '同名人员', department: 'A', direct: false }, { id: 'P3', name: '同名人员', department: 'A', direct: true }], projects: [], occupancies: [], historyComplete: false };
        await page.locator('#staffing-initial-json').fill(JSON.stringify(initial)); await page.locator('#staffing-import').click(); await page.locator('#staffing-reviewed').check(); await page.locator('#staffing-confirm-initial').click();
        await page.locator('[data-staffing-state="ready"]').waitFor();
        if (process.env.PIVANE_TEST_SCREENSHOT_DIR) { fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, 'initial-audit.json'), JSON.stringify(await page.evaluate(() => window.staffingAudit), null, 2)); }
        phase = 'native chat'; console.log('staffing full shell:', phase, new Date().toISOString());
        const ready = await gateway.staffing.status(), session = await gateway.store.createSession(cwd, '合成人员调配完整流程', { agentProfileId: ready.profileId });
        const worker = await gateway.supervisor.getWorker({ cwd, sessionPath: session.path, sessionId: session.id });
        const project = { id: 'J1', name: '合成项目', owner: '合成负责人', department: 'A', start: '2030-11-01', end: '2030-11-05', minimum: 2 };
        toolQueue.push({ name: 'staffing_query', input: { kind: 'recommend', project } }, { name: 'staffing_prepare_change', input: { requestId: 'browser-prepare', expectedRevision: ready.revision, project, personIds: ['P1', 'P2'] } });
        const assistantUrl = origin + '/#/assistant?profileId=' + encodeURIComponent(ready.profileId);
        await page.goto(assistantUrl, { waitUntil: 'domcontentloaded' }); await foreground('native chat'); await page.locator('[data-session-id="' + session.id + '"]').first().click();
        await page.locator('#pi-input').fill('请为合成项目准备完整名单'); await page.locator('#pi-send-button').click();
        let card = page.locator('.staffing-plan-card').last(); await card.locator('[data-staffing-person="P1"]').waitFor();
        assert.equal(await card.locator('img').count(), 0); assert.match(await card.innerText(), /P1/); assert.match(await card.innerText(), /最低人数：2/);
        const native = await worker.request('get_entries'), typed = native.entries.findLast(entry => entry.message?.toolName === 'staffing_prepare_change')?.message.details?.pivaneStaffing;
        assert.equal(typed?.version, 2); assert.equal(typed.reference.kind, 'assign'); assert.equal((await gateway.staffing.ledger()).occupancies.length, 0);
        const turnSummary = page.locator('.pi-turn-group > summary').last(); await turnSummary.click();
        await page.locator('.pi-process-group:visible > summary').first().waitFor();
        const processSummaries = await page.locator('.pi-process-group:visible > summary').all();
        for (const summary of processSummaries) await summary.click();
        await page.locator('[data-tool-name="staffing_prepare_change"] .pi-tool-status').filter({ hasText: '完成' }).last().waitFor();
        for (const summary of processSummaries.reverse()) await summary.click(); await turnSummary.click();
        await screenshot('card', card);
        await page.locator('#pi-input').fill('尚未发送的合成草稿'); await page.locator('#pi-composer-add-button').click(); await page.locator('#pi-composer-add-menu').waitFor();
        assert.equal(await page.locator('#pi-attach-button').isVisible(), true); await page.keyboard.press('Escape');
        if (await page.locator('#pi-toggle-sessions').isVisible()) {
            await page.locator('#pi-toggle-sessions').click(); await page.waitForFunction(() => document.querySelector('#pi-session-pane').classList.contains('open'));
            assert.equal(await page.locator('#pi-session-pane').evaluate(node => node.inert), false);
            await page.locator('#pi-close-sessions').click(); await page.waitForFunction(() => !document.querySelector('#pi-session-pane').classList.contains('open'));
        } else {
            assert.equal(await page.locator('#pi-session-pane').isVisible(), true);
            assert.equal(await page.locator('#pi-session-pane').evaluate(node => node.inert), false);
        }
        assert.equal(await page.locator('#pi-input').inputValue(), '尚未发送的合成草稿');
        await card.locator('[data-staffing-action="reserve"]').click(); await card.locator('[data-staffing-outcome="completed"]').waitFor();
        assert.equal(await page.locator('#pi-input').inputValue(), '尚未发送的合成草稿'); assert.equal((await gateway.staffing.ledger()).occupancies.length, 2);
        phase = 'ledger views'; console.log('staffing full shell:', phase, new Date().toISOString());
        await page.goto(origin + '/#/staffing', { waitUntil: 'domcontentloaded' }); await foreground('ledger views'); await page.locator('[data-staffing-project="J1"]').waitFor();
        await page.selectOption('#staffing-change-kind', 'formalize'); await page.locator('#staffing-prepare-adjustment').click(); await page.locator('[data-staffing-action="apply"]').click();
        await page.locator('[data-staffing-project="J1"]').filter({ hasText: '全部人员已正式确认' }).waitFor();
        await page.selectOption('#staffing-change-kind', 'absence'); await page.selectOption('#staffing-change-person', 'P1'); await page.fill('#staffing-change-start', '2030-11-03'); await page.fill('#staffing-change-end', '2030-11-03'); await page.fill('#staffing-change-reason', '合成临时请假');
        await page.locator('#staffing-prepare-adjustment').click(); await page.locator('[data-staffing-action="apply"]').click(); await page.locator('[data-staffing-project="J1"]').filter({ hasText: '缺直签' }).waitFor();
        const original = (await gateway.staffing.ledger()).occupancies.find(row => row.personId === 'P1' && row.kind === 'project');
        await page.selectOption('#staffing-change-kind', 'replace'); await page.selectOption('#staffing-change-project', 'J1'); await page.selectOption('#staffing-change-occupancy', original.id); await page.selectOption('#staffing-change-replacement', 'P3');
        await page.fill('#staffing-change-start', '2030-11-03'); await page.fill('#staffing-change-end', '2030-11-03'); await page.fill('#staffing-change-reason', '合成直签替班'); await page.locator('#staffing-prepare-adjustment').click(); await page.locator('[data-staffing-action="apply"]').click();
        await page.locator('[data-staffing-project="J1"]').filter({ hasText: '人数和直签已达标' }).waitFor(); await screenshot('projects', page.locator('.staffing-view-results'));
        await page.locator('[data-staffing-view="availability"]').click(); await page.fill('#staffing-view-start', '2030-11-06'); await page.fill('#staffing-view-end', '2030-11-06'); await page.locator('#staffing-view-refresh').click(); await page.locator('[data-staffing-available="P1"]').waitFor();
        await page.locator('[data-staffing-view="people"]').click(); await page.fill('#staffing-view-start', '2030-11-03'); await page.fill('#staffing-view-end', '2030-11-03'); await page.locator('#staffing-view-refresh').click(); await page.locator('[data-staffing-person-calendar="P1"]').filter({ hasText: '请假' }).waitFor();
        assert.ok(await page.locator('#staffing-change-start').evaluate(node => parseFloat(getComputedStyle(node).fontSize)) >= 16); await screenshot('people', page.locator('.staffing-view-results'));
        phase = 'Excel import'; console.log('staffing full shell:', phase, new Date().toISOString());
        const ledger = await gateway.staffing.ledger(), changed = { people: ledger.people.map(person => person.id === 'P2' ? { ...person, name: '更新后的同名人员' } : person), projects: ledger.projects, occupancies: ledger.occupancies, historyComplete: ledger.historyComplete };
        const bytes = gateway.staffingExcel.workbook(changed, { revision: ledger.revision, ledgerId: ready.profileId, generatedAt: new Date().toISOString() });
        await page.locator('[data-staffing-excel-file]').setInputFiles({ name: 'staffing.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes }); await page.locator('[data-staffing-excel-import]').click(); await page.locator('[data-staffing-import-confirm]').click();
        await page.locator('#staffing-change-person option[value="P2"]').filter({ hasText: '更新后的同名人员' }).waitFor({ state: 'attached' });
        assert.equal((await gateway.staffing.ledger()).people.find(person => person.id === 'P2').name, '更新后的同名人员'); await screenshot('excel-page');
        phase = 'native Excel export'; console.log('staffing full shell:', phase, new Date().toISOString());
        toolQueue.push({ name: 'staffing_export', input: { requestId: 'browser-native-export', expectedRevision: (await gateway.staffing.status()).revision } });
        await page.goto(assistantUrl, { waitUntil: 'domcontentloaded' }); await foreground('native Excel export');
        if (page.viewportSize().width <= 900 && !await page.locator('#pi-session-pane').evaluate(node => node.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
        await page.locator('[data-session-id="' + session.id + '"]').first().click();
        if (page.viewportSize().width <= 900 && await page.locator('#pi-session-pane').evaluate(node => node.classList.contains('open'))) await page.locator('#pi-close-sessions').click();
        await page.locator('#pi-input').fill('导出当前合成安排并保存到成果'); await page.locator('#pi-send-button').click();
        await page.getByText('合成 Excel 已保存到成果。', { exact: true }).last().waitFor();
        const exportEntries = await worker.request('get_entries'), exportMessage = exportEntries.entries.findLast(entry => entry.message?.toolName === 'staffing_export')?.message;
        assert.equal(exportMessage?.isError, false, JSON.stringify(exportMessage)); const report = JSON.parse(exportMessage.content.find(part => part.type === 'text').text);
        assert.equal(report.phase, 'saved', JSON.stringify(report)); await screenshot('excel-saved', undefined, page.getByText('合成 Excel 已保存到成果。', { exact: true }).last());
        await page.goto(origin + '/#/staffing', { waitUntil: 'domcontentloaded' }); await page.locator('[data-staffing-project="J1"]').waitFor();
        const deleted = await fetch(origin + '/api/pi/sessions/' + session.id + '?' + new URLSearchParams({ cwd }), { method: 'DELETE', headers: { Origin: origin } }); assert.equal(deleted.status, 200, await deleted.clone().text());
        assert.equal((await gateway.artifacts.preview(report.artifactKey)).revision, report.sha256); await assert.rejects(gateway.artifacts.preview(report.sourceKey));
        const old = await gateway.staffing.prepareAdjustment({ requestId: 'old-page-plan', expectedRevision: (await gateway.staffing.status()).revision, kind: 'absence', personId: 'P2', absenceKind: 'training', start: '2030-11-06', end: '2030-11-06', reason: '合成旧方案' }, await gateway.staffing.pageSource());
        await page.reload(); await page.locator('#staffing-disable').click(); await page.locator('#staffing-enable').click(); await page.locator('[data-staffing-state="ready"]').waitFor();
        assert.equal((await gateway.staffing.status()).profileId, ready.profileId); assert.ok((await gateway.staffing.ledger()).occupancies.length > 0);
        const stale = await fetch(origin + '/api/pi/staffing/commit', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'old-after-enable', planId: old.id, expectedRevision: (await gateway.staffing.status()).revision, action: 'apply', source: { kind: 'page' } }) }); assert.equal(stale.status, 409);
        assert.equal((await gateway.artifacts.preview(report.artifactKey)).revision, report.sha256); assert.deepEqual(errors, []); assert.deepEqual(dialogs, []); assert.deepEqual(targetCrashes, []); assert.ok(requests.some(body => body.tools?.some(tool => tool.function?.name === 'staffing_query')));
        if (process.env.PIVANE_TEST_SCREENSHOT_DIR) fs.writeFileSync(path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, 'completed.json'), JSON.stringify({ browserVersion, performance: await performanceMetrics(), lifecycle, targetCrashes, stages, dialogs, sockets, network, uploads, screenshots: widths }, null, 2));
        console.log('staffing full workspace lifecycle: actual native provider/cards/views/Excel/artifacts/disable; ' + widths.join('/') + ' passed');
    } catch (error) {
        console.error('staffing lifecycle failed phase:', phase, 'pageerrors:', errors);
        try {
        console.error('staffing controls:', JSON.stringify(await page.evaluate(() => ['#staffing-import', '#staffing-initial-json', '[data-staffing-advanced]'].map(selector => { const e = document.querySelector(selector); return { selector, exists: Boolean(e), open: e?.open, disabled: e?.disabled, rect: e?.getBoundingClientRect().toJSON(), visibility: e && getComputedStyle(e).visibility, display: e && getComputedStyle(e).display }; }))));
        const diagnostic = await page.evaluate(async () => ({ visibility: document.visibilityState, focus: document.hasFocus(), audit: window.staffingAudit,
            frame: await Promise.race([new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve('two frames')))), new Promise(resolve => setTimeout(() => resolve('no frames in 500ms'), 500))]),
            animations: document.getAnimations().map(animation => ({ state: animation.playState, time: animation.currentTime, target: animation.effect?.target?.id })),
            scroll: ['html', 'body', '.main-content', '#staffing-tab'].map(selector => { const e = document.querySelector(selector); return { selector, height: e?.clientHeight, scrollHeight: e?.scrollHeight, scrollTop: e?.scrollTop, overflow: e && getComputedStyle(e).overflowY }; }) }));
        console.error('staffing async audit:', JSON.stringify(diagnostic));
        if (process.env.PIVANE_TEST_SCREENSHOT_DIR) { fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, 'failure.json'), JSON.stringify({ phase, error: error.message, diagnostic, browserVersion, performance: await performanceMetrics(), lifecycle, targetCrashes, stages, dialogs, sockets, network, uploads }, null, 2)); try { await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, 'failure.png') }); } catch (capture) { console.error('failure capture:', capture.message); } }
        } catch (diagnosticError) { diagnosticErrors.push(diagnosticError); console.error('staffing failure diagnostics:', diagnosticError); }
        throw error;
    }
    } catch (error) { failures.push(error); }
    finally {
        // Keep browser -> gateway/SQLite -> HTTP/provider dependency order, and
        // still attempt every acquired resource after an earlier close fails.
        for (const cleanup of cleanups.sort((a, b) => a.priority - b.priority || b.order - a.order)) {
            try { await cleanup.close(); closed.push(cleanup.name); }
            catch (error) { cleanupErrors.push(new Error('Cleanup failed: ' + cleanup.name, { cause: error })); }
        }
        try {
            if (temporary && !cleanupErrors.length) {
                const named = fs.lstatSync(temporary, { bigint: true }), opened = temporaryFd === undefined ? null : fs.fstatSync(temporaryFd, { bigint: true });
                assert.ok(opened?.isDirectory() && named.isDirectory() && !named.isSymbolicLink(), 'temporary cleanup root must remain a real directory');
                assert.equal(path.dirname(temporary), fs.realpathSync.native(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('staffing-full-browser-'));
                assert.equal(fs.realpathSync.native(temporary), temporary); assert.equal(descriptorPathSync(temporaryFd), temporary);
                assert.ok(['dev', 'ino', 'mode'].every(key => temporaryStat[key] === opened[key] && opened[key] === named[key]));
                assert.ok(['size', 'mtimeNs', 'ctimeNs'].every(key => opened[key] === named[key]));
                assert.equal(io.identity(temporaryFd), temporaryIdentity); assert.ok(io.sameIdentityAtPath(temporary, temporaryIdentity));
                fs.rmSync(temporary, { recursive: true, force: true }); removed = true;
            }
        } catch (error) { cleanupErrors.push(new Error('Temporary root cleanup failed', { cause: error })); }
        finally { if (temporaryFd !== undefined) try { fs.closeSync(temporaryFd); closed.push('temporary root descriptor'); } catch (error) { cleanupErrors.push(new Error('Temporary root descriptor close failed', { cause: error })); } }
        console.log('staffing lifecycle cleanup:', JSON.stringify({ closed, cleanupErrors: cleanupErrors.map(error => error.message), temporary: !temporary ? 'not-created' : removed ? 'removed' : 'not-confirmed-removed', temporaryRoot: temporary }));
        if (temporary && !removed) console.error('Staffing fixture root not confirmed removed:', temporary);
    }
    failures.push(...diagnosticErrors, ...cleanupErrors);
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Staffing lifecycle and cleanup failures');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
