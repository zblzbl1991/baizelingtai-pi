const { selectBrowserTargets, browserTargetEnabled } = require('./targets.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createDesktopStartup } = require('../../server/pivane-desktop-startup');
const root = path.resolve(__dirname, '../..');

async function main() {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
    const errors = [];
    const target = http.createServer((_request, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><meta charset="utf-8"><title>合成工作台</title><main>工作台已就绪</main>');
    });
    await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
    const targetUrl = `http://127.0.0.1:${target.address().port}/`;
    const evidence = process.env.PIVANE_TEST_SCREENSHOT_DIR;
    if (evidence) fs.mkdirSync(evidence, { recursive: true });
    try {
        for (const [name, width, scheme] of selectBrowserTargets([['desktop', 1440, 'light'], ['mobile', 390, 'light'], ['dark', 1440, 'dark']])) {
            const startup = await createDesktopStartup({ root });
            const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900, colorScheme: scheme });
            const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
            try {
                await page.goto(startup.url, { waitUntil: 'domcontentloaded' });
                await page.locator('#startup-title').waitFor();
                assert.equal(await page.locator('#startup-title').textContent(), '正在启动');
                assert.equal(page.url(), startup.url, 'an unready service never redirects the browser');
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
                assert.ok(await page.locator('main').evaluate(element => element.getBoundingClientRect().width <= innerWidth));
                assert.equal(await page.locator('.brand:visible').evaluate(image => image.complete && image.naturalWidth > 0), true);
                if (evidence) await page.screenshot({ path: path.join(evidence, `${name}.png`) });
                startup.ready(targetUrl);
                await page.waitForURL(targetUrl);
                assert.equal(await page.title(), '合成工作台');
                assert.equal(await page.evaluate(() => history.length), 2, 'redirect replaces the startup entry');
            } finally { await context.close(); await startup.close(); }
        }
        const failed = await createDesktopStartup({ root });
        const context = await browser.newContext({ viewport: { width: process.env.PIVANE_BROWSER_TARGET === 'desktop' ? 1440 : 390, height: 844 }, reducedMotion: 'reduce' });
        const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
        try {
            await page.goto(failed.url, { waitUntil: 'domcontentloaded' });
            assert.equal(await page.locator('.waiting').evaluate(element => getComputedStyle(element).animationName), 'none');
            const message = '<img src=x onerror="window.injected=true"> 合成启动失败';
            failed.fail(message);
            await page.waitForFunction(() => document.body.dataset.state === 'error');
            assert.equal(await page.locator('#startup-title').textContent(), '启动失败');
            assert.equal(await page.locator('#startup-detail').textContent(), message);
            assert.equal(await page.locator('#startup-detail img').count(), 0);
            assert.equal(await page.evaluate(() => window.injected), undefined);
            assert.equal(page.url(), failed.url);
            if (evidence) await page.screenshot({ path: path.join(evidence, 'failure-mobile.png') });
        } finally { await context.close(); await failed.close(); }
        const lost = await createDesktopStartup({ root });
        const lostContext = await browser.newContext();
        const lostPage = await lostContext.newPage(); lostPage.on('pageerror', error => errors.push(error.message));
        try {
            await lostPage.goto(lost.url, { waitUntil: 'domcontentloaded' });
            await lost.close();
            await lostPage.waitForFunction(() => document.getElementById('startup-title').textContent === '启动连接已断开');
            assert.equal(lostPage.url(), lost.url);
        } finally { await lostContext.close(); await lost.close(); }
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ ok: true, viewports: process.env.PIVANE_BROWSER_TARGET === 'desktop' ? ['desktop'] : ['desktop', 'mobile'], themes: ['light', 'dark'], pageErrors: errors, evidence }));
    } finally {
        await browser.close();
        await new Promise(resolve => target.close(resolve));
    }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
