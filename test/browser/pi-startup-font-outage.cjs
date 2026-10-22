const { browserTargetEnabled } = require('./targets.cjs');
// Public workbench boot must remain usable when the optional external font never responds.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_STARTUP_FONT_TEST_URL || 'http://127.0.0.1:3001';
const cwd = '/fixture/font-outage';
const session = { cwd, id: 'font-fixture', name: 'Font outage fixture', messageCount: 0 };
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'], available: true };

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try {
        for (const width of (process.env.PI_TEST_DESKTOP_ONLY === '1' ? [1440] : [1440, 393, 320])) {
            if (!browserTargetEnabled(width)) continue;
            const context = await browser.newContext({ viewport: { width, height: 950 }, locale: 'zh-CN', isMobile: width < 900, hasTouch: width < 900 });
            const page = await context.newPage(), errors = [], commands = [];
            page.setDefaultTimeout(12000);
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(cwd => {
                localStorage.setItem('pi.web.cwd', cwd);
                localStorage.setItem('pi.web.session:' + cwd, 'font-fixture');
            }, cwd);
            let releaseFont, fontRequested = false, fontReleased = false;
            const fontBarrier = new Promise(resolve => { releaseFont = resolve; });
            await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, async route => {
                fontRequested = true;
                await fontBarrier;
                fontReleased = true;
                await route.fulfill({ contentType: 'text/css', body: '' });
            });
            await page.route('**/api/**', route => {
                const pathname = new URL(route.request().url()).pathname;
                const data = pathname === '/api/pi/status' ? { ok: true, defaultProject: cwd, projectRoots: ['/fixture'] }
                    : pathname === '/api/pi/projects' ? { roots: ['/fixture'], projects: [{ cwd, name: 'Fixture', sessionCount: 1 }] }
                    : pathname === '/api/pi/sessions' ? { sessions: [session] }
                    : pathname === '/api/pi/activity' ? { runtimes: [], replyNotices: [] }
                    : pathname === '/api/pi/settings/models' ? { models: [model], providers: [], preferences: {} }
                    : pathname.endsWith('/history') || pathname === '/api/prompts' ? [] : {};
                return route.fulfill({ json: data });
            });
            await page.routeWebSocket('**/api/pi/ws', socket => socket.onMessage(raw => {
                const command = JSON.parse(raw); commands.push(command.type);
                const state = { model, isStreaming: false, thinkingLevel: 'off' };
                const data = command.type === 'open_session'
                    ? { session, state, messages: { messages: [] }, models: { models: [model] }, stats: {}, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } }
                    : command.type === 'get_state' ? state
                    : command.type === 'get_available_models' ? { models: [model] } : {};
                socket.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
            }));
            try {
                await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 12000 });
                await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
                await page.locator('#pi-input').fill('字体不可达时仍可编辑');
                assert.equal(await page.locator('#pi-input').inputValue(), '字体不可达时仍可编辑');
                assert.ok(commands.includes('open_session'), 'the real workbench completed session initialization');
                await page.locator('#workspace-settings-toggle').click();
                await page.locator('#workspace-settings-close').waitFor({ state: 'visible' });
                const sizes = await page.locator('body').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
                assert.ok(sizes.scroll <= sizes.width + 1, JSON.stringify(sizes));
                assert.deepEqual(errors, []);
                assert.equal(fontReleased, false, 'workbench is usable before the held optional font responds');
                const screenshots = process.env.PIVANE_TEST_SCREENSHOT_DIR || path.join(os.tmpdir(), 'pivane-startup-font-outage');
                fs.mkdirSync(screenshots, { recursive: true });
                await page.screenshot({ path: path.join(screenshots, `startup-${width}.png`) });
                console.log(JSON.stringify({ width, usableWhileFontHeld: true, fontRequested }));
                releaseFont();
                await page.waitForLoadState('load', { timeout: 12000 });
            } catch (error) {
                console.error(JSON.stringify({ width, fontRequested, commands, symptom: error.message.split('\n')[0] }));
                throw error;
            } finally {
                releaseFont();
                await context.close();
            }
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
