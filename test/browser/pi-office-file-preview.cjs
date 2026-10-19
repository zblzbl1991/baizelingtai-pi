// Desktop component integration: real PDF/Worker rendering, mocked source/converter HTTP.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixtures = require('../office-workbook-fixtures.cjs'), { pdf } = require('../file-preview-fixtures.cjs');
const base = process.env.OFFICE_FILE_TEST_URL || 'http://127.0.0.1:3118';
const root = path.resolve(__dirname, '../..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const originals = Object.fromEntries(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].map(format => [format, format === 'xlsx' ? fixtures.workbook() : format === 'xls' ? fs.readFileSync(path.join(root, 'test/fixtures/office/preview.xls')) : Buffer.from(`synthetic original ${format} (converter mocked)`)]));
async function run(browser, viewport, locale) {
    const context = await browser.newContext({ viewport, locale, acceptDownloads: true }), page = await context.newPage(), errors = [], requests = [];
    let format = 'docx', fail = false, hold = false, delayed;
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https:\/\//, route => route.abort());
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url()), raw = originals[format], name = `report.${format}`;
        const source = { name, kind: 'binary', mime: 'application/octet-stream', encoding: 'base64', base64: raw.toString('base64'), revision: hash(raw), size: raw.length, path: name, absolutePath: '/fixture/' + name, readAt: new Date().toISOString() };
        if (url.pathname === '/api/pi/office/preview') {
            const input = req.postDataJSON(); requests.push(input);
            assert.equal(req.headers()['content-type'], 'application/json');
            const bytes = ['xls', 'xlsx'].includes(format) ? raw : pdf();
            const respond = () => route.fulfill(fail ? { status: 503, json: { code: 'OFFICE_UNAVAILABLE', error: '组件缺失' } } : { json: { source: { name, format, revision: hash(raw) }, preview: { kind: ['xls', 'xlsx'].includes(format) ? 'workbook' : 'pdf', encoding: 'base64', base64: bytes.toString('base64'), size: bytes.length }, warnings: ['近似预览，字体与分页可能不同', '缺少字体：Synthetic Font'] } });
            if (hold) { delayed = respond; return; } return respond();
        }
        if (url.pathname === '/api/pi/uploads') return route.fulfill({ body: raw, contentType: 'application/octet-stream' });
        return route.fulfill({ json: source });
    });
    await page.goto(base + '/pi-file-viewer.css');
    await page.setContent(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
    await page.evaluate(() => {
        const reader = document.querySelector('#pi-file-reader'), inspector = document.createElement('section'), changes = document.createElement('section');
        inspector.id = 'pi-inspector'; inspector.className = 'open show-changes'; inspector.style.cssText = 'position:static;display:flex;width:100%;height:800px;max-width:100%;transform:none';
        changes.id = 'pi-changes'; changes.className = 'file-current-only'; changes.style.cssText = 'display:flex;width:100%;height:100%';
        changes.append(reader); inspector.append(changes); document.body.replaceChildren(inspector);
        document.querySelector('#pi-changes-content').hidden = false;
        document.documentElement.style.overflow = 'auto'; document.body.style.cssText = 'display:block;margin:0;overflow:hidden';
    });
    for (const file of ['pi-i18n-catalog.js', 'pi-i18n.js', 'pi-file-policy.js', 'pi-file-previews.js', 'vendor/office-preview/workbook-model.js', 'pi-office-table-preview.js', 'pi-office-file-preview.js', 'pi-file-viewer.js', 'pi-artifacts-ui.js', 'pi-artifacts-preview.js', 'pi-document-references.js', 'pi-document-attachments.js']) await page.addScriptTag({ url: `${base}/${file}` });
    await page.evaluate(() => {
        PiI18n.translateStatic(document);
        window.scope = { cwd: '/fixture', sessionId: 'fixture', session: { id: 'fixture' }, key: 'fixture', connected: true, generation: 1 };
        window.api = async (url, options) => { const response = await fetch(url, options), data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error), { data }); return data; };
        window.viewer = new PiFileViewer({ context: () => ({ ...scope }), api, notify: () => {}, copy: async () => {} }); viewer.enabled = viewer.previewsEnabled = true;
        window.artifact = new PiArtifactPreview(api);
        window.attachments = new PiDocumentAttachments({ context: () => ({ ...scope }), api, fetchBytes: (...args) => fetch(...args), toast: () => {} }); attachments.enabled = true;
    });
    const ready = async (host, format) => {
        if (['xls', 'xlsx'].includes(format)) await page.locator(`${host} td[data-address="A1"]`).waitFor();
        else await page.waitForFunction(selector => { const canvas = document.querySelector(selector + ' canvas'); return canvas && canvas.width > 0 && document.querySelector(selector + ' input[type=number]')?.disabled === false; }, host);
    };
    let lateImport;
    await page.route('**/vendor/pdfjs/legacy/build/pdf.mjs', route => { lateImport = route; });
    await page.evaluate(() => viewer.setFile({ identity: 'late-import', path: 'report.docx', writes: [], hasDiff: false }));
    while (!lateImport) await page.waitForTimeout(10);
    await page.evaluate(() => { scope.generation++; viewer.clear(); });
    await lateImport.continue(); await page.unroute('**/vendor/pdfjs/legacy/build/pdf.mjs');
    await page.waitForTimeout(60); assert.equal(await page.locator('#pi-file-body canvas').count(), 0);
    for (const sourceType of ['project', 'delivery', 'artifact', 'upload']) for (format of Object.keys(originals)) {
        await page.evaluate(({ sourceType, format, revision, size }) => {
            viewer.clear(); artifact.close(); attachments.closePreview(); scope.connected = true;
            const name = 'report.' + format;
            if (sourceType === 'project' || sourceType === 'delivery') viewer.setFile({ identity: sourceType + format, path: name, writes: [], hasDiff: false, ...(sourceType === 'delivery' ? { deliveryId: 'd'.repeat(64), index: 0 } : {}) });
            else if (sourceType === 'artifact') artifact.open({ key: 'a'.repeat(64), title: name, independent: true, files: [{ key: 'b'.repeat(64), name, size }], types: ['document'] });
            else attachments.preview({ id: 'c'.repeat(64), revision, name, format, size });
        }, { sourceType, format, revision: hash(originals[format]), size: originals[format].length });
        const host = sourceType === 'artifact' ? '#artifacts-preview-body' : sourceType === 'upload' ? '.pi-document-preview-body' : '#pi-file-body';
        await ready(host, format); assert.equal(requests.at(-1).source.type, sourceType);
        assert.match(await page.locator(host + ' .pi-office-preview-notice').first().innerText(), locale === 'en' ? /Approximate/ : /近似/);
        assert.match(await page.locator(host).innerText(), /Synthetic Font/);
        if (locale === 'en') {
            const uiText = await page.locator(host).innerText(); assert.ok(!/正在|预览|公式|工作表|已保存|下一页|上一页/.test(uiText), uiText);
        }
        const download = page.waitForEvent('download');
        if (sourceType === 'artifact') await page.locator('#artifacts-detail [data-action=download]').click();
        else if (sourceType === 'upload') await page.locator('.pi-document-preview header button').first().click();
        else await page.locator('#pi-file-download').click();
        const file = await download; assert.equal(hash(fs.readFileSync(await file.path())), hash(originals[format]));
        if (sourceType === 'project' && format === 'docx') {
            await page.locator(host + ' input[type=number]').fill('2'); await page.locator(host + ' input[type=number]').dispatchEvent('change');
            await page.evaluate(() => { window.readingCanvas = document.querySelector('#pi-file-body canvas'); });
            await page.locator('#pi-file-fullscreen').click(); await page.waitForFunction(() => viewer.fullscreen.open);
            assert.equal(await page.locator('#pi-file-fullscreen-dialog input[type=number]').inputValue(), '2');
            await page.keyboard.press('Escape'); assert.equal(await page.locator('#pi-file-fullscreen-dialog').evaluate(n => n.open), false);
            assert.equal(await page.locator('#pi-file-body input[type=number]').inputValue(), '2');
            assert.equal(await page.evaluate(() => readingCanvas === document.querySelector('#pi-file-body canvas')), true);
            assert.equal(await page.evaluate(() => document.activeElement.id), 'pi-file-fullscreen');
            await page.locator('#pi-file-refresh').click(); await ready(host, format); assert.equal(requests.at(-1).refresh, true);
        }
        if (sourceType === 'project' && format === 'xlsx') {
            await page.locator(host + ' select').selectOption('1'); await page.locator('#pi-file-fullscreen').click();
            assert.equal(await page.locator('#pi-file-fullscreen-dialog select').last().inputValue(), '1');
            await page.keyboard.press('Escape'); assert.equal(await page.locator(host + ' select').inputValue(), '1');
        }
    }
    await page.evaluate(() => { artifact.close(); attachments.closePreview(); viewer.clear(); });
    // Late conversion responses and socket-generation changes cannot mount stale PDF imports.
    format = 'docx'; hold = true;
    await page.evaluate(() => viewer.setFile({ identity: 'held', path: 'report.docx', writes: [], hasDiff: false }));
    while (!delayed) await page.waitForTimeout(10);
    await page.evaluate(() => { scope.generation++; }); await page.waitForTimeout(150); hold = false; await delayed();
    await page.waitForTimeout(150); assert.equal(await page.locator('#pi-file-body canvas').count(), 0);
    fail = true;
    await page.evaluate(() => viewer.setFile({ identity: 'failed', path: 'report.docx', writes: [], hasDiff: false }));
    await page.locator('#pi-file-body [role=alert]').waitFor(); assert.match(await page.locator('#pi-file-body').innerText(), locale === 'en' ? /unavailable/ : /不可用/);
    fail = false; await page.locator('#pi-file-body button').last().click(); await ready('#pi-file-body', format); assert.equal(requests.at(-1).refresh, true);
    const widths = await page.locator('#pi-file-body').evaluate(n => ({ actual: n.getBoundingClientRect().width, parent: n.parentElement.getBoundingClientRect().width })); assert.ok(widths.actual <= widths.parent + 1);
    if (process.env.PIVANE_TEST_SCREENSHOT_DIR) { fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, `${viewport.width}-${locale}.png`) }); }
    assert.deepEqual(errors, []); await context.close();
    console.log(`${viewport.width} ${locale}: 24 source/format UI combinations, original hashes, actual PDF/Worker, refresh/fullscreen/late/error passed`);
}
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { await run(browser, { width: 1440, height: 1100 }, 'zh-CN'); await run(browser, { width: 1024, height: 900 }, 'en'); }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
