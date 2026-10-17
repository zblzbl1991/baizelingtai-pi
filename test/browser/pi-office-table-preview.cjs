// Desktop only: actual XLSX/XLS bytes -> production Worker -> verified DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = require('../office-workbook-fixtures.cjs');
const base = process.env.OFFICE_TABLE_TEST_URL || 'http://127.0.0.1:3118';
async function run(browser, viewport) {
    const context = await browser.newContext({ viewport, locale: 'zh-CN' }), page = await context.newPage(), errors = [], remote = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (!r.url().startsWith(base)) remote.push(r.url()); });
    await page.goto(base + '/pi-office-table-preview.css');
    await page.setContent('<!doctype html><html><head></head><body style="margin:0"><main id="preview" style="height:700px;width:100%;display:flex;overflow:hidden"></main></body></html>');
    await page.addStyleTag({ url: base + '/pi-office-table-preview.css' });
    await page.addScriptTag({ url: base + '/vendor/office-preview/workbook-model.js' });
    await page.addScriptTag({ url: base + '/pi-office-table-preview.js' });
    await page.evaluate(() => {
        const Native = Worker; window.workerCounts = { created: 0, active: 0, terminated: 0 };
        window.Worker = class extends Native {
            constructor(...args) { super(...args); workerCounts.created++; workerCounts.active++; this.done = false; }
            terminate() { if (!this.done) { this.done = true; workerCounts.active--; workerCounts.terminated++; } return super.terminate(); }
        };
        window.mount = (base64, format = 'xlsx') => { window.dispose?.(); window.dispose = PiOfficeTablePreview.render(document.querySelector('#preview'), { format }, { state: {}, bytes: async () => Uint8Array.from(atob(base64), c => c.charCodeAt(0)) }); };
    });
    await page.evaluate(bytes => mount(bytes), fixture.workbook().toString('base64'));
    await page.locator('td[data-address=A1]').waitFor();
    assert.match(await page.locator('td[data-address=A1]').innerText(), /中文 <img src=x onerror=alert\(1\)>/);
    assert.equal(await page.locator('#preview img, #preview script, #preview iframe').count(), 0);
    await page.locator('td[data-address=C1]').click(); assert.match(await page.locator('.pi-office-table-selection').innerText(), /已保存值：false/);
    await page.locator('td[data-address=D1]').click(); assert.match(await page.locator('.pi-office-table-selection').innerText(), /已保存值：""/);
    assert.equal(await page.locator('select option').count(), 2);
    await page.locator('select').selectOption('1'); assert.equal(await page.locator('td[data-address=A1]').innerText(), '123.5');
    await page.locator('select').selectOption('0');
    assert.equal(await page.locator('td[data-address=B1]').count(), 0); // hidden column is not exposed
    assert.equal(await page.locator('td[data-address=A2]').count(), 0); // hidden row is not exposed
    await page.locator('td[data-address=A4]').click(); assert.match(await page.locator('.pi-office-table-selection').innerText(), /共享主原式：B3\+1/);
    if (process.env.PIVANE_TEST_SCREENSHOT_DIR) { fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, `desktop-${viewport.width}.png`) }); }
    const files = fixture.files(); files['xl/sheets/one.xml'] = files['xl/sheets/one.xml'].replace('A1:D8', 'A1:DP120').replace('A7:D8', 'A49:DP52').replace('<cols><col min="2" max="2" width="22" hidden="1"/></cols>', '').replace(' hidden="1"', '');
    await page.evaluate(bytes => mount(bytes), fixture.zip(files).toString('base64')); await page.locator('td[data-address=A1]').waitFor();
    assert.ok(await page.locator('td').count() <= 5000);
    assert.ok(await page.locator('td,th').count() <= 5000);
    await page.getByRole('button', { name: '下一页', exact: true }).click(); assert.match(await page.locator('td[data-address=A51]').innerText(), /合并延续/);
    await page.getByRole('button', { name: '后列', exact: true }).click(); assert.ok(await page.locator('td').count() <= 5000);
    const captured = await page.evaluate(() => { const view = dispose.captureView(); dispose.resize(view); return dispose.captureView(); }); assert.equal(captured.rowPage, 1); assert.equal(captured.columnPage, 1);
    const widths = await page.locator('.pi-office-table-preview').evaluate(el => ({ root: el.getBoundingClientRect().width, parent: el.parentElement.getBoundingClientRect().width, scroll: el.querySelector('.pi-office-table-scroll').getBoundingClientRect().width }));
    assert.ok(widths.root <= widths.parent + 1); assert.ok(widths.scroll <= widths.parent + 1);
    const xls = fs.readFileSync(path.join(__dirname, '../fixtures/office/preview.xls'));
    await page.evaluate(bytes => mount(bytes, 'xls'), xls.toString('base64')); await page.locator('td[data-address=A1]').waitFor(); assert.equal(await page.locator('td[data-address=A1]').innerText(), 'Office preview 中文文档');
    await page.evaluate(bytes => mount(bytes, 'xls'), fixture.xlsBiff5().toString('base64')); await page.locator('td[data-address=A1]').waitFor(); assert.equal(await page.locator('td[data-address=A1]').innerText(), '中文');
    // Real workers repeatedly start and terminate; no retained mount or late bytes.
    for (let i = 0; i < 20; i++) { await page.evaluate(bytes => mount(bytes), fixture.workbook().toString('base64')); await page.locator('td[data-address=A1]').waitFor(); }
    const counts = await page.evaluate(async () => {
        dispose(); let release; const bytes = new Promise(resolve => { release = resolve; });
        const close = PiOfficeTablePreview.render(document.querySelector('#preview'), { format: 'xlsx' }, { bytes: () => bytes }); close();
        release(new Uint8Array([1])); await Promise.resolve(); await Promise.resolve(); return workerCounts;
    });
    assert.equal(counts.active, 0); assert.equal(counts.created, counts.terminated); assert.equal(await page.locator('.pi-office-table-preview').count(), 0);
    const cancellation = await page.evaluate(async bytes => {
        const Native = window.Worker; let created;
        const ready = new Promise(resolve => { created = resolve; });
        window.Worker = class extends Native { constructor(...args) { super(...args); created(); } };
        mount(bytes); await ready; dispose(); window.Worker = Native;
        await new Promise(resolve => setTimeout(resolve, 50));
        return { ...workerCounts, mounts: document.querySelectorAll('.pi-office-table-preview').length };
    }, fixture.workbook().toString('base64'));
    assert.equal(cancellation.active, 0); assert.equal(cancellation.mounts, 0); assert.equal(cancellation.created, cancellation.terminated);
    // Timeout trigger uses controlled time; actual Worker object is still terminated.
    await page.evaluate(bytes => {
        const set = window.setTimeout; window.restoreTimeout = () => { window.setTimeout = set; }; window.setTimeout = (fn, ms, ...args) => set(fn, ms === 15000 ? 1 : ms, ...args);
        mount(bytes);
    }, fixture.workbook().toString('base64'));
    await page.locator('[role=alert]').waitFor(); assert.match(await page.locator('[role=alert]').innerText(), /超时/);
    await page.evaluate(() => restoreTimeout());
    assert.equal(await page.evaluate(() => workerCounts.active), 0);
    await page.evaluate(() => dispose());
    assert.deepEqual(errors, []); assert.deepEqual(remote, []);
    console.log(JSON.stringify({ viewport, counts, widths, pageerrors: errors.length, externalRequests: remote.length }));
    await context.close();
}
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
    try { for (const viewport of [{ width: 1440, height: 1100 }, { width: 1024, height: 900 }]) await run(browser, viewport); }
    finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
