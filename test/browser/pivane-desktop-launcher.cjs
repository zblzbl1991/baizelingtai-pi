// pivane-browser: manual — Windows native tray + isolated real server.
// PLAYWRIGHT_MODULE and CHROMIUM_PATH select installed QA dependencies.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createApplication } = require('../desktop-launcher-fixture.cjs');

async function main() {
    assert.equal(process.platform, 'win32', 'native Windows required');
    const fixture = createApplication(), { root, env } = fixture;
    const evidence = process.env.PIVANE_DESKTOP_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-tray-evidence-'));
    fs.mkdirSync(evidence, { recursive: true });
    env.PIVANE_DESKTOP_SMOKE_ROOT = root;
    const args = ['//B', '//Nologo', path.join(root, '启动白泽灵台.vbs')];
    const tray = spawn('wscript.exe', args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(tray, 'close'), events = [];
    let pending = '', errors = '', browser;
    tray.stdout.setEncoding('utf8'); tray.stdout.on('data', text => {
        pending += text; let at;
        while ((at = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, at).trim(); pending = pending.slice(at + 1);
            if (line) events.push(JSON.parse(line));
        }
    });
    tray.stderr.on('data', bytes => { errors += bytes; });
    try {
        const deadline = Date.now() + 45000;
        const live = path.join(root, '.pivane-runtime/desktop/smoke-ready.json');
        while (!fs.existsSync(live)) {
            if (tray.exitCode !== null && tray.exitCode !== 0 || Date.now() > deadline) throw Error(`Tray did not start: ${errors}; fixture=${root}`);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const ready = JSON.parse(fs.readFileSync(live, 'utf8'));
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
        const pageErrors = [];
        for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
            const context = await browser.newContext({ viewport, locale: 'zh-CN', isMobile: name === 'mobile', hasTouch: name === 'mobile' });
            const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
            await page.goto(ready.url, { waitUntil: 'networkidle' });
            assert.equal(await page.title(), '白泽灵台');
            assert.equal(await page.locator('body').evaluate(element => element.classList.contains('workspace-access-locked')), false);
            assert.equal(await page.locator('#workspace-sidebar h2').textContent(), '白泽灵台');
            assert.equal(await page.locator('#chat-tab').isVisible(), true);
            if (await page.locator('#pi-project-dialog-close').isVisible()) await page.locator('#pi-project-dialog-close').click();
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
            assert.equal(await page.locator('#pi-attachments').isVisible(), false, 'fresh instance has no inherited attachments');
            if (name === 'mobile') {
                await page.locator('#pi-toggle-sessions').click();
                assert.equal(await page.locator('#pi-session-pane').evaluate(element => element.classList.contains('open')), true);
                await page.locator('#pi-toggle-sessions').click();
                assert.equal(await page.locator('#pi-session-pane').evaluate(element => element.classList.contains('open')), false);
            }
            await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true });
            await context.close();
        }
        assert.deepEqual(pageErrors, []);
        // Exercise the second-click path while the first tray owns the service.
        const second = spawn('wscript.exe', args, { env, windowsHide: true, stdio: 'ignore' });
        const [secondCode] = await once(second, 'close'); assert.equal(secondCode, 0);
        const secondOpen = path.join(root, '.pivane-runtime/desktop/smoke-open-2.json'), openDeadline = Date.now() + 30000;
        while (!fs.existsSync(secondOpen)) { assert.ok(Date.now() < openDeadline, 'duplicate entry must reach the existing tray'); await new Promise(resolve => setTimeout(resolve, 100)); }
        if (process.argv.includes('--inspect')) {
            console.log(JSON.stringify({ inspectionUrl: ready.url }));
            if (!process.stdin.readableEnded) await Promise.race([once(process.stdin, 'data'), once(process.stdin, 'end')]);
        }
        fs.writeFileSync(path.join(root, '.pivane-launcher-stop'), 'finish synthetic verification\n');
        const [code] = await exited;
        const resultFile = path.join(root, '.pivane-runtime/desktop/smoke-result.json');
        const stoppedDeadline = Date.now() + 30000;
        while (!fs.existsSync(resultFile)) { assert.ok(Date.now() < stoppedDeadline, 'tray must finish normal shutdown'); await new Promise(resolve => setTimeout(resolve, 100)); }
        const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        assert.equal(code, 0, errors);
        assert.equal(report.filter(event => event.type === 'browser-opened').length, 2, 'initial launch and duplicate VBS click each open exactly once');
        assert.equal(report.filter(event => event.type === 'ready').length, 1, 'readiness is processed once even when ShellExecute pumps messages');
        assert.equal(report.filter(event => event.type === 'error').length, 0);
        assert.ok(report.some(event => event.type === 'exited' && event.exitCode === 0), 'menu stop waited for actual exit');
        await assert.rejects(fetch(ready.url), /fetch failed/);
        fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ platform: process.platform, node: process.version, report, pageErrors }, null, 2));
        console.log(JSON.stringify({ ok: true, evidence, url: ready.url, browserOpened: true, cleanExit: true }));
    } finally {
        await browser?.close();
        fs.writeFileSync(path.join(root, '.pivane-launcher-stop'), 'finish synthetic verification\n');
        // Exercise the real menu's shutdown and retain failed fixtures for diagnosis.
        await exited;
    }
    fs.rmSync(fixture.base, { recursive: true, force: true });
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
