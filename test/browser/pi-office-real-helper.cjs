const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const { openInspector } = require('./pi-mobile-view-helper.cjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const formats = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'];
async function instrument(context, fixture) {
    await context.addInitScript(({ cwd, id }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, id);
        localStorage.setItem('pivane.workspace.showWorkChat', 'true');
        const urls = new Map(), workers = new Set(), create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL), NativeWorker = Worker;
        URL.createObjectURL = value => { const url = create(value); urls.set(url, { type: value.type, bytes: value.size }); return url; };
        URL.revokeObjectURL = url => { urls.delete(url); return revoke(url); };
        globalThis.Worker = class extends NativeWorker { constructor(...args) { super(...args); workers.add(this); } terminate() { workers.delete(this); return super.terminate(); } };
        globalThis.previewResources = () => ({ urls: [...urls.values()], workers: workers.size });
        let clickAt = 0, noticeAt = 0;
        document.addEventListener('click', () => { clickAt = performance.now(); noticeAt = 0; }, true);
        new MutationObserver(() => { if (clickAt && !noticeAt && document.querySelector('.pi-office-file-preview [role=status]')) noticeAt = performance.now(); }).observe(document, { childList: true, subtree: true });
        globalThis.previewFeedback = () => ({ clickAt, noticeAt, durationMs: noticeAt - clickAt });
    }, { cwd: fixture.cwd, id: fixture.session.id });
}
async function ready(page, host, format) {
    if (['xls', 'xlsx'].includes(format)) {
        await page.locator(`${host} td[data-address=A2]`).waitFor();
        assert.equal(await page.locator(`${host} td[data-address=A2]`).innerText(), '2024-01-01');
        assert.equal(await page.locator(`${host} td[data-address=B2]`).innerText(), '¥1,234.50');
        assert.equal(await page.locator(`${host} td[data-address=C2]`).innerText(), '12.50%');
        assert.deepEqual(await page.locator(`${host} select option`).allTextContents(), ['销售', '第二页']);
        assert.ok(await page.locator(`${host} td, ${host} th`).count() <= 5000);
        if (format === 'xlsx' && await page.evaluate(() => PiI18n.locale.startsWith('en'))) assert.equal(await page.locator(`${host} td[data-address=A4]`).innerText(), '(No saved result)');
    } else {
        const landmark = format.startsWith('doc') ? 'WORD-PAGE-ONE' : 'SLIDE-ONE';
        await page.waitForFunction(({ host, landmark }) => document.querySelector(host + ' .pi-file-pdf-text pre')?.textContent.includes(landmark), { host, landmark });
        assert.equal(await page.locator(`${host} input[type=number]`).getAttribute('max'), '3');
        assert.ok(await page.locator(`${host} canvas`).evaluate(canvas => canvas.width > 0 && canvas.height > 0));
    }
    assert.match(await page.locator(host + ' .pi-office-preview-notice').first().innerText(), /近似|Approximate/);
}
async function download(page, button, expected) {
    const hit = await button.evaluate(n => { const r = n.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { button: n.id || n.textContent, disabled: n.disabled, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, hit: { tag: hit?.tagName, id: hit?.id, classes: hit?.className } }; });
    const event = page.waitForEvent('download'); event.catch(() => {});
    try { await button.click({ timeout: 10000 }); }
    catch (error) { console.error('Download click geometry:', JSON.stringify(hit)); throw error; }
    const file = await event;
    assert.equal(file.suggestedFilename(), expected.name);
    const actual = digest(fs.readFileSync(await file.path())); assert.equal(actual, expected.sha256); return actual;
}
const documentCard = (page, name) => page.locator('.pi-document-card').filter({ has: page.locator('strong', { hasText: new RegExp('^' + name.replace('.', '\\.') + '$') }) });
async function runMatrix(browser, fixture, width, matrix, output) {
    const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1100 : 900 }, locale: width === 1440 ? 'zh-CN' : 'en', acceptDownloads: true, reducedMotion: 'reduce' });
    await instrument(context, fixture);
    const page = await context.newPage(), errors = [], network = [], actualWorkers = new Set(), responses = [], failedRequests = [];
    page.on('requestfailed', request => failedRequests.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
    page.on('pageerror', error => errors.push(error.message));
    page.on('worker', worker => { actualWorkers.add(worker); worker.on('close', () => actualWorkers.delete(worker)); });
    page.on('request', request => { if (new URL(request.url()).origin !== fixture.origin && !/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//.test(request.url())) network.push(request.url()); });
    page.on('response', async response => { if (new URL(response.url()).pathname === '/api/pi/office/preview') { try { responses.push({ status: response.status(), request: response.request().postDataJSON(), body: await response.json() }); } catch {} } });
    try {
        await page.goto(fixture.origin + '/#/chat', { waitUntil: 'domcontentloaded' }); await page.locator('#pi-input:not([disabled])').waitFor();
        await page.locator('#pi-input').fill('Retained Office preview draft');
        const toolCount = await page.locator('#pi-transcript-content .pi-tool-row').count(); assert.ok(toolCount >= 1);
        const notice = page.locator('#pi-update-notice-close'); if (await notice.isVisible()) await notice.click();
        for (const source of ['project', 'delivery', 'upload']) for (const format of formats) {
            fs.appendFileSync(path.join(output, 'progress.ndjson'), JSON.stringify({ width, source, format, at: Date.now() }) + '\n');
            const original = fixture.originals[format], start = Date.now();
            if (source === 'project') {
                await openInspector(page, 'changes'); await page.locator('#pi-files-browse').click();
                await page.locator(`.pi-file-tree-row[data-path="${original.name}"]`).click();
            } else if (source === 'delivery') {
                if (await page.locator('#pi-close-inspector').isVisible()) await page.locator('#pi-close-inspector').click();
                await page.locator('#pi-transcript-content .assistant a').filter({ hasText: new RegExp('^delivery-' + format + '$') }).click();
            } else {
                if (await page.locator('#pi-close-inspector').isVisible()) await page.locator('#pi-close-inspector').click();
                await documentCard(page, original.name).getByRole('button', { name: /预览文档|Preview document/, exact: true }).click();
            }
            const host = '#pi-file-body'; await ready(page, host, format);
            const response = responses.at(-1); assert.equal(response.status, 200); assert.equal(response.request.source.type, source); assert.equal(response.body.source.revision, original.sha256); assert.equal(response.body.source.format, format);
            const hash = await download(page, page.locator('#pi-file-download'), original);
            if (source === 'project') {
                await page.screenshot({ path: path.join(output, `${width}-${format}.png`) });
                if (!['xls', 'xlsx'].includes(format)) {
                    await page.locator(host + ' input[type=number]').fill('2'); await page.locator(host + ' input[type=number]').dispatchEvent('change');
                    const landmark = format.startsWith('doc') ? 'WORD-PAGE-TWO' : 'SLIDE-TWO';
                    await page.waitForFunction(({ host, landmark }) => document.querySelector(host + ' .pi-file-pdf-text pre')?.textContent.includes(landmark), { host, landmark });
                    await page.locator('#pi-file-fullscreen').click(); await page.locator('#pi-file-fullscreen-dialog[open]').waitFor();
                    assert.equal(await page.locator('#pi-file-fullscreen-dialog input[type=number]').inputValue(), '2');
                    await page.screenshot({ path: path.join(output, `${width}-${format}-page2-fullscreen.png`) });
                    await page.keyboard.press('Escape'); assert.equal(await page.locator(host + ' input[type=number]').inputValue(), '2');
                } else {
                    await page.locator(host + ' td[data-address=B4]').click(); assert.match(await page.locator(host + ' .pi-office-table-selection').innerText(), /99/);
                    await page.locator(host + ' select').selectOption('1'); await page.locator('#pi-file-fullscreen').click(); await page.locator('#pi-file-fullscreen-dialog[open]').waitFor();
                    assert.equal(await page.locator('#pi-file-fullscreen-dialog select').last().inputValue(), '1'); await page.screenshot({ path: path.join(output, `${width}-${format}-sheet2-fullscreen.png`) }); await page.keyboard.press('Escape'); assert.equal(await page.locator(host + ' select').inputValue(), '1');
                }
            }
            const geometry = await page.locator(host).evaluate(n => ({ actual: n.getBoundingClientRect().width, parent: n.parentElement.getBoundingClientRect().width, viewport: innerWidth, body: document.body.scrollWidth, document: document.documentElement.scrollWidth }));
            assert.ok(geometry.actual <= geometry.parent + 1 && geometry.body <= width + 1 && geometry.document <= width + 1, JSON.stringify(geometry));
            matrix.push({ width, source, format, route: '/api/pi/office/preview', status: response.status, requestedSource: response.request.source, originalSha256: hash, previewKind: response.body.preview.kind, elapsedMs: Date.now() - start, geometry });
            if (source === 'upload') await page.locator('#pi-close-inspector').click();
            assert.equal(await page.locator('#pi-input').inputValue(), 'Retained Office preview draft'); assert.equal(await page.locator('#pi-transcript-content .pi-tool-row').count(), toolCount);
        }
        if (await page.locator('#pi-close-inspector').isVisible()) await page.locator('#pi-close-inspector').click();
        await page.locator('.nav-btn[data-tab=artifacts]').click(); await page.locator('.artifacts-header').waitFor();
        if (width === 1440) {
            await page.locator('.artifacts-views [data-view=all]').click();
            for (const format of formats) {
                const card = page.locator('.artifacts-card-wrap').filter({ has: page.getByRole('heading', { name: 'delivery-' + format, exact: true }) });
                const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/pi/artifacts/batch' && response.request().method() === 'POST');
                await card.locator('[data-action=save]').click(); const result = await (await saved).json(); assert.equal(result.results.length, 1); assert.equal(result.results[0].ok, true);
            }
        }
        await page.locator('.artifacts-views [data-view=saved]').click();
        for (const format of formats) {
            await page.locator('.artifacts-card').filter({ has: page.getByRole('heading', { name: 'rich.' + format, exact: true }) }).click(); await ready(page, '#artifacts-preview-body', format);
            const response = responses.at(-1); assert.equal(response.status, 200); assert.equal(response.request.source.type, 'artifact'); assert.equal(response.body.source.revision, fixture.originals[format].sha256);
            const hash = await download(page, page.locator('#artifacts-detail [data-action=download]'), fixture.originals[format]);
            matrix.push({ width, source: 'artifact', format, route: '/api/pi/office/preview', status: response.status, requestedSource: response.request.source, originalSha256: hash, previewKind: response.body.preview.kind, savedViaPublicUi: true }); await page.locator('#artifacts-detail .artifacts-close').click();
        }
        await page.locator('.nav-btn[data-tab=chat]').click(); const cycles = [];
        for (let index = 0; index < 20; index++) {
            const format = index % 2 ? 'xlsx' : 'docx';
            await documentCard(page, 'rich.' + format).getByRole('button', { name: /预览文档|Preview document/, exact: true }).click(); await ready(page, '#pi-file-body', format);
            const feedback = await page.evaluate(() => previewFeedback()); assert.ok(feedback.noticeAt > 0 && feedback.durationMs <= 250, JSON.stringify(feedback));
            await page.locator('#pi-close-inspector').click();
            await page.waitForFunction(() => previewResources().workers === 0 && previewResources().urls.every(url => url.type !== 'application/pdf'));
            for (let poll = 0; actualWorkers.size && poll < 100; poll++) await page.waitForTimeout(20);
            assert.equal(actualWorkers.size, 0, 'Actual browser worker close events settle after preview close'); cycles.push({ index, format, feedback, ...await page.evaluate(() => previewResources()) });
        }
        assert.equal(await page.locator('#pi-input').inputValue(), 'Retained Office preview draft'); assert.deepEqual(errors, []); assert.deepEqual(network, []); assert.equal(fixture.providerRequests.length, 0);
        const geometry = await page.evaluate(() => ({ width: innerWidth, body: document.body.scrollWidth, document: document.documentElement.scrollWidth })); assert.ok(geometry.document <= width + 1 && geometry.body <= width + 1);
        fs.writeFileSync(path.join(output, `resources-${width}.json`), JSON.stringify({ cycles, errors, network, geometry }, null, 2)); console.log(`${width}: 24 real gateway/native Office combinations and 20 cleanup cycles passed`);
    } catch (error) { await page.screenshot({ path: path.join(output, `failure-${width}.png`) }); console.error(JSON.stringify({ errors, failedRequests })); console.error(await page.locator('body').innerText()); throw error; }
    finally { await context.close(); }
}
module.exports = { runMatrix };
