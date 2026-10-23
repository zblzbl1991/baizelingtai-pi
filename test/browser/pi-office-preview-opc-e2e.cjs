// Real custom OPC part + Strict/Transitional + UTF8/UTF16 browser and draft upload chain.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { createHash } = require('node:crypto');
const { startOfficePreviewServer } = require('../office-preview-real-server.cjs');
const { openInspector } = require('./pi-mobile-view-helper.cjs');
const fixtures = require('../office-workbook-fixtures.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function variants() {
    const values = [];
    for (const strict of [false, true]) for (const encoding of ['utf-8', 'utf-16le', 'utf-16be']) {
        const files = fixtures.files({ strict });
        files['xl/sheets/two.xml'] = files['xl/sheets/two.xml'].replace('</sheetData>', '<row r="2"><c r="A2" t="inlineStr"><is><t>（无已保存结果）</t></is></c></row></sheetData>');
        for (const name of Object.keys(files)) if (/\.(xml|rels)$/.test(name)) {
            const text = '<?xml version="1.0" encoding="' + encoding.toUpperCase() + '"?>' + files[name];
            const bytes = Buffer.from(text, encoding === 'utf-8' ? 'utf8' : 'utf16le'); if (encoding === 'utf-16be') bytes.swap16();
            files[name] = encoding === 'utf-8' ? bytes : Buffer.concat([Buffer.from(encoding === 'utf-16le' ? [255, 254] : [254, 255]), bytes]);
        }
        const bytes = fixtures.zip(files); values.push({ strict, encoding, name: `opc-${strict}-${encoding}.xlsx`, bytes, sha256: hash(bytes) });
    }
    for (const [declaration, options] of [['default', {}], ['override', { strict: true, mainOverride: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' }]]) {
        const files = fixtures.defaultTypesFiles(options);
        files['xl/sheets/two.xml'] = files['xl/sheets/two.xml'].replace('</sheetData>', '<row r="2"><c r="A2" t="inlineStr"><is><t>（无已保存结果）</t></is></c></row></sheetData>');
        const bytes = fixtures.zip(files);
        values.push({ strict: !!options.strict, encoding: 'utf-8', declaration, name: 'opc-types-' + declaration + '.xlsx', bytes, sha256: hash(bytes) });
    }
    return values;
}
async function ready(page, host) {
    await page.locator(host + ' td[data-address=A1]').waitFor();
    assert.equal(await page.locator(host + ' td[data-address=A1]').innerText(), '中文 <img src=x onerror=alert(1)>');
    assert.equal(await page.locator(host + ' img').count(), 0, 'Cell text cannot create active markup');
    assert.equal(await page.locator(host + ' td[data-address=C1]').innerText(), 'false');
    assert.deepEqual(await page.locator(host + ' select option').allTextContents(), ['销售', '第二页']);
    assert.equal(await page.locator(host + ' td[data-address=B1]').count(), 0, 'Hidden column remains omitted');
    await page.locator(host + ' td[data-address=A4]').click(); assert.match(await page.locator(host + ' .pi-office-table-selection').innerText(), /6/);
    await page.locator(host + ' select').selectOption('1'); assert.equal(await page.locator(host + ' td[data-address=A2]').innerText(), '（无已保存结果）', 'A literal document string matching feedback is never translated');
    await page.locator(host + ' select').selectOption('0');
}
async function main() {
    const output = process.env.PIVANE_TEST_SCREENSHOT_DIR || path.join(os.tmpdir(), 'pivane-office-opc-e2e'); fs.mkdirSync(output, { recursive: true });
    const fixture = await startOfficePreviewServer(), inputs = variants(), matrix = []; let browser;
    try {
        for (const value of inputs) fs.writeFileSync(path.join(fixture.cwd, value.name), value.bytes);
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
        for (const width of [1440, 1024]) {
            const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: width === 1440 ? 'zh-CN' : 'en', acceptDownloads: true });
            await context.addInitScript(({ cwd, id }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, id); }, { cwd: fixture.cwd, id: fixture.session.id });
            const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
            try {
                await page.goto(fixture.origin + '/#/chat'); await page.locator('#pi-input:not([disabled])').waitFor();
                await page.locator('#pi-input').fill('OPC retained draft');
                const notice = page.locator('#pi-update-notice-close'); if (await notice.isVisible()) await notice.click();
                for (const source of ['project', 'draft-upload']) for (const input of inputs) {
                    if (source === 'project') {
                        await openInspector(page, 'changes'); await page.locator('#pi-files-browse').click(); await page.locator(`.pi-file-tree-row[data-path="${input.name}"]`).click();
                    } else {
                        if (await page.locator('#pi-close-inspector').isVisible()) await page.locator('#pi-close-inspector').click();
                        await page.locator('#pi-file-input').setInputFiles({ name: input.name, mimeType: 'application/octet-stream', buffer: input.bytes });
                        await page.waitForFunction(() => document.querySelectorAll('#pi-attachments .pi-attachment-chip').length === 1 && document.querySelector('#pi-attachments').getAttribute('aria-busy') === 'false');
                        await page.locator('[data-preview-attachment]').click();
                    }
                    const host = '#pi-file-body'; await ready(page, host);
                    const event = page.waitForEvent('download'); event.catch(() => {}); await page.locator('#pi-file-download').click();
                    assert.equal(hash(fs.readFileSync(await (await event).path())), input.sha256);
                    matrix.push({ width, source, strict: input.strict, encoding: input.encoding, declaration: input.declaration || 'override', mainPart: 'xl/book.xml', sha256: input.sha256 });
                    if (source !== 'project') { await page.locator('#pi-close-inspector').click(); await page.locator('[data-remove-attachment]').click(); }
                    assert.equal(await page.locator('#pi-input').inputValue(), 'OPC retained draft');
                }
                assert.deepEqual(errors, []); await page.screenshot({ path: path.join(output, `opc-${width}.png`) });
            } finally { await context.close(); }
        }
        assert.equal(matrix.length, 32); assert.equal(fixture.providerRequests.length, 0); console.log('32 actual custom-main/content-types/encoding/project/draft-upload browser combinations passed');
    } finally { fs.writeFileSync(path.join(output, 'opc-matrix.json'), JSON.stringify({ matrix, providerRequests: fixture.providerRequests }, null, 2)); await browser?.close(); await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
