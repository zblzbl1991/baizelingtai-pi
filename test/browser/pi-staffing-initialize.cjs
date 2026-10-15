// Real staffing HTTP + persistence, synthetic identity and unrelated shell responses.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-browser-')));
process.env.PI_CODING_AGENT_DIR = temporary;
const { PiProfileRegistry } = require('../../server/pi-profile-registry');
const { StaffingService } = require('../../server/staffing/service');
const { mountStaffingRoutes } = require('../../server/staffing/routes');
const { WorkspaceAccessService } = require('../../server/workspace-access-service');

async function run(browser, width, locale) {
    const agent = path.join(temporary, String(width)); fs.mkdirSync(agent); process.env.PI_CODING_AGENT_DIR = agent;
    const profiles = new PiProfileRegistry({ resolveProject: value => value });
    const service = new StaffingService({ profiles });
    await service.status(); // Prepare the isolated identity before timing browser interactions.
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => '' });
    const app = express(); app.use(express.json({ limit: '10mb' })); access.mount(app);
    const router = express.Router(); router.use(access.middleware()); mountStaffingRoutes(router, service); app.use('/api/pi', router);
    for (const [name, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${name}`, express.static(path.join(root, 'node_modules', folder)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [];
    let enableRequests = 0, dropped = false;
    page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.abort());
    await page.addInitScript(() => { localStorage.setItem('pi.web.cwd', '/projects/staffing-fixture'); localStorage.setItem('pi.web.session:/projects/staffing-fixture', 'synthetic-session'); });
    await page.route('**/api/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/api/pi/staffing/enable' && route.request().method() === 'POST') {
            enableRequests++;
            if (width === 1440 && !dropped) { dropped = true; const response = await route.fetch(); assert.equal(response.status(), 200); return route.abort('failed'); }
        }
        if (pathname.startsWith('/api/pi/staffing') || pathname.startsWith('/api/access')) return route.continue();
        if (pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, staffing: true, defaultProject: '/projects/staffing-fixture', projectRoots: ['/projects'] } });
        if (pathname === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (pathname === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd: '/projects/staffing-fixture', name: 'Synthetic', sessionCount: 1 }], roots: ['/projects'] } });
        if (pathname === '/api/pi/sessions') return route.fulfill({ json: { sessions: [{ id: 'synthetic-session', cwd: '/projects/staffing-fixture', name: 'Synthetic', messageCount: 1 }] } });
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => { const command = JSON.parse(raw);
        const model = { provider: 'synthetic', id: 'synthetic', name: 'Synthetic', input: ['text'], contextWindow: 128000 };
        const state = { model, thinkingLevel: 'off', isStreaming: false };
        const data = command.type === 'open_session' ? { session: { id: 'synthetic-session', cwd: '/projects/staffing-fixture', name: 'Synthetic', messageCount: 1 }, state, messages: { messages: [] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } } : command.type === 'get_state' ? state : {};
        ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data })); }));
    try {
        await page.goto(origin + '/#/staffing', { waitUntil: 'domcontentloaded' });
        await page.locator('#staffing-enable').click();
        if (width === 1440) {
            await page.locator('#staffing-check-operation').click();
            assert.equal(enableRequests, 1, 'an uncertain result must be queried without a second write');
        }
        await page.locator('[data-staffing-advanced] > summary').click();
        await page.locator('#staffing-initial-json').waitFor();
        if (width < 680) assert.ok(await page.locator('#staffing-initial-json').evaluate(element => parseFloat(getComputedStyle(element).fontSize)) >= 16);
        const initial = { people: [{ id: 'P1', name: '<img src=x onerror=alert(1)>', department: 'A', direct: true }],
            projects: [], occupancies: [], historyComplete: false };
        await page.locator('#staffing-initial-json').fill(JSON.stringify(initial));
        await page.locator('#staffing-import').click();
        await page.locator('#staffing-reviewed').waitFor();
        assert.equal(await page.locator('#staffing-confirm-initial').isDisabled(), true);
        assert.equal(await page.locator('#staffing-tab img').count(), 0);
        assert.match(await page.locator('#staffing-tab').innerText(), /<img src=x/);
        await page.locator('#staffing-edit-initial').click();
        assert.deepEqual(JSON.parse(await page.locator('#staffing-initial-json').inputValue()), initial);
        await page.locator('#staffing-import').click();
        await page.locator('#staffing-reviewed').waitFor();
        assert.equal(await page.locator('#staffing-confirm-initial').isDisabled(), true);
        await page.locator('#staffing-reviewed').check();
        await page.locator('#staffing-confirm-initial').click();
        await page.locator('[data-staffing-state="ready"]').waitFor();
        const profileId = (await service.status()).profileId;
        await page.locator('#staffing-disable').click();
        await page.locator('#staffing-enable').click();
        await page.locator('[data-staffing-state="ready"]').waitFor();
        assert.equal((await service.status()).profileId, profileId);
        assert.equal((await profiles.list()).profiles.length, 1);
        assert.equal((await service.ledger()).people.length, 1);
        assert.deepEqual(await page.evaluate(() => ['body', '#staffing-tab', '.staffing-panel'].filter(selector => { const el = document.querySelector(selector); return el && el.scrollWidth > el.clientWidth + 1; })), []);
        if (process.env.PIVANE_TEST_SCREENSHOT_DIR) { fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, `staffing-${width}.png`) }); }
        assert.deepEqual(errors, []);
        console.log(`staffing initialize: ${width}px ${locale} passed`);
    } finally { await context.close(); await service.dispose(); access.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const [width, locale] of [[1440, 'zh-CN'], [393, 'zh-CN'], [320, 'en']]) await run(browser, width, locale); }
    finally { await browser.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
