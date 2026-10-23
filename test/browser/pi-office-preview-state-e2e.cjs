// Real draft upload, session switch, socket reconnection and font-refresh lifecycle.
// pivane-browser: office-native
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { startOfficePreviewServer } = require('../office-preview-real-server.cjs');
const { openInspector } = require('./pi-mobile-view-helper.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
async function main() {
    const output = process.env.PIVANE_TEST_SCREENSHOT_DIR || path.join(os.tmpdir(), 'pivane-office-preview-state'); fs.mkdirSync(output, { recursive: true });
    const fixture = await startOfficePreviewServer(), facts = []; let browser;
    try {
        fs.copyFileSync(path.join(__dirname, '../fixtures/office/missing-font.docx'), path.join(fixture.cwd, 'missing-font.docx'));
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
        for (const width of [1440, 1024]) {
            const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'zh-CN' });
            await context.addInitScript(({ cwd, id }) => {
                localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, id);
                const sockets = [], NativeSocket = WebSocket;
                globalThis.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); sockets.push(this); } };
                globalThis.socketCount = () => sockets.length;
                globalThis.disconnectPreviewSocket = () => sockets.filter(s => s.readyState === NativeSocket.OPEN).forEach(s => s.close(1000, 'synthetic preview reconnect'));
                let clickAt = 0, noticeAt = 0;
                document.addEventListener('click', () => { clickAt = performance.now(); noticeAt = 0; }, true);
                new MutationObserver(() => { if (clickAt && !noticeAt && document.querySelector('.pi-office-file-preview [role=status]')) noticeAt = performance.now(); }).observe(document, { childList: true, subtree: true });
                globalThis.previewFeedback = () => ({ clickAt, noticeAt, durationMs: noticeAt - clickAt });
            }, { cwd: fixture.cwd, id: fixture.session.id });
            const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
            const ready = () => page.waitForFunction(() => document.querySelector('#pi-file-body .pi-file-pdf-text pre')?.textContent.includes('WORD-PAGE-ONE'));
            try {
                await page.goto(fixture.origin + '/#/chat'); await page.locator('#pi-input:not([disabled])').waitFor();
                const toolCount = await page.locator('#pi-transcript-content .pi-tool-row').count(); assert.ok(toolCount >= 1);
                await page.locator('#pi-input').fill('Draft retained across preview, threads and reconnect');
                await page.locator('#pi-file-input').setInputFiles({ name: 'draft.docx', mimeType: 'application/octet-stream', buffer: fixture.originals.docx.bytes });
                await page.waitForFunction(() => document.querySelector('#pi-attachments')?.getAttribute('aria-busy') === 'false' && document.querySelector('[data-preview-attachment]'));
                await page.locator('[data-preview-attachment]').click(); await ready();
                const feedback = await page.evaluate(() => previewFeedback()); assert.ok(feedback.noticeAt > 0 && feedback.durationMs <= 250, JSON.stringify(feedback));
                const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/pi/office/preview' && response.request().postDataJSON()?.refresh === true); refreshed.catch(() => {});
                await page.locator('#pi-file-refresh').click(); assert.equal((await refreshed).status(), 200); await ready(); await page.locator('#pi-close-inspector').click();
                await page.locator(`[data-session-id="${fixture.otherSession.id}"] .pi-session-main`).click();
                await page.waitForFunction(id => location.hash.includes(id) && !document.querySelector('#pi-input').disabled, fixture.otherSession.id);
                assert.equal(await page.locator('#pi-attachments .pi-attachment-chip').count(), 0); await page.locator('#pi-input').fill('Independent other draft');
                await page.locator(`[data-session-id="${fixture.session.id}"] .pi-session-main`).click();
                await page.waitForFunction(id => location.hash.includes(id) && !document.querySelector('#pi-input').disabled, fixture.session.id);
                assert.equal(await page.locator('#pi-input').inputValue(), 'Draft retained across preview, threads and reconnect');
                assert.equal(await page.locator('#pi-attachments .pi-attachment-chip').count(), 1);
                const workerBefore = fixture.gateway.supervisor.getActiveWorker(fixture.session.path); assert.ok(workerBefore);
                await page.locator('[data-preview-attachment]').click(); await ready(); const socketCount = await page.evaluate(() => socketCount());
                await page.evaluate(() => disconnectPreviewSocket());
                await page.waitForFunction(() => !document.querySelector('#pi-file-body .pi-office-file-preview'));
                await page.waitForFunction(count => socketCount() > count && !document.querySelector('#pi-input').disabled, socketCount);
                assert.equal(fixture.gateway.supervisor.getActiveWorker(fixture.session.path), workerBefore, 'Reconnect reuses the supervised native-session worker');
                await page.locator('#pi-files-uploads').click();
                await page.locator('#pi-uploads-list .pi-delivery-card').filter({ hasText: 'draft.docx' }).click(); await ready();
                await page.locator('#pi-close-inspector').click();
                assert.equal(await page.locator('#pi-input').inputValue(), 'Draft retained across preview, threads and reconnect'); assert.equal(await page.locator('#pi-transcript-content .pi-tool-row').count(), toolCount);
                await page.locator('[data-preview-attachment]').click(); await ready(); await page.locator('#pi-close-inspector').click();
                await openInspector(page, 'changes'); await page.locator('#pi-files-browse').click(); await page.locator('.pi-file-tree-row[data-path="missing-font.docx"]').click();
                await page.waitForFunction(() => document.querySelector('#pi-file-body .pi-file-pdf-text pre')?.textContent.includes('WORD-PAGE-ONE'));
                assert.match(await page.locator('#pi-file-body').innerText(), /PivaneFixtureMissingFont2026/);
                const fontRefresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/pi/office/preview' && response.request().postDataJSON()?.refresh === true); fontRefresh.catch(() => {});
                await page.locator('#pi-file-refresh').click(); const result = await (await fontRefresh).json(); assert.ok(result.warnings.some(warning => warning.includes('PivaneFixtureMissingFont2026')));
                await page.waitForFunction(() => document.querySelector('#pi-file-body .pi-file-pdf-text pre')?.textContent.includes('WORD-PAGE-ONE'));
                await page.screenshot({ path: path.join(output, `missing-font-${width}.png`) });
                await page.locator('#pi-close-inspector').click(); assert.deepEqual(errors, []); assert.equal(fixture.providerRequests.length, 0);
                facts.push({ width, feedback, draftUpload: true, threadDraftIsolation: true, sameWorkerAfterReconnect: true, missingFontRefresh: result.warnings, errors });
            } catch (error) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: path.join(output, `failure-${width}.png`) }); throw error; }
            finally { await context.close(); }
        }
        console.log('Two desktop widths: real draft preview/refresh, thread isolation, socket reconnect, missing-font refresh and provider=0 passed');
    } finally { fs.writeFileSync(path.join(output, 'states.json'), JSON.stringify({ facts, providerRequests: fixture.providerRequests }, null, 2)); await browser?.close(); await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
