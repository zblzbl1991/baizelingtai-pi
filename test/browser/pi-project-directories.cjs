// Isolated real directory API + synthetic chat: never sends messages to a real worker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-directory-ui-')));
const project = path.join(root, '中文 项目'); fs.mkdirSync(project);
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent'); process.env.PI_PROJECT_ROOTS = project;
process.env.PI_WEB_TOKEN = 'isolated-directory-browser'; process.env.PI_OFFLINE = '1';
const { createPiAgentGateway } = require('../../server/pi-agent-routes');
const evidence = process.env.PIVANE_TEST_SCREENSHOT_DIR || path.join(root, 'screenshots');
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 32000 };
const session = { id: 'fixture', cwd: project, name: 'Fixture', messageCount: 0 };

async function run(browser, base, width, locale) {
    const context = await browser.newContext({ viewport: { width, height: width < 680 ? 844 : 1000 }, locale, reducedMotion: 'reduce' });
    const page = await context.newPage(), errors = [], writes = [];
    let held, releaseHeld;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ project, token }) => {
        localStorage.setItem('pi.web.cwd', project); localStorage.setItem('pi.web.session:' + project, 'fixture');
        sessionStorage.setItem('pi.web.token', token);
        localStorage.setItem('pi.workspace.theme', 'dark');
    }, { project, token: process.env.PI_WEB_TOKEN });
    await page.route('https://**', route => route.abort());
    await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, createDirectories: true, defaultProject: project, projectRoots: [project] } });
        if (url.pathname === '/api/pi/directories') {
            if (request.method() === 'POST') {
                const body = request.postDataJSON(); writes.push(body);
                if (body.name === 'denied') return route.fulfill({ status: 403, json: { error: '当前目录没有创建权限，请选择其他目录', code: 'DIRECTORY_DENIED' } });
                if (body.name === 'uncertain') return route.fulfill({ status: 503, json: { error: 'synthetic unavailable' } });
                if (body.name === 'late-' + width) {
                    const response = await route.fetch();
                    held = true; await new Promise(resolve => { releaseHeld = resolve; });
                    return route.fulfill({ response });
                }
            }
            return route.continue();
        }
        const data = url.pathname === '/api/pi/projects' ? { projects: [{ cwd: project, name: 'Fixture', sessionCount: 1 }], roots: [project] }
            : url.pathname === '/api/pi/sessions' ? { sessions: url.searchParams.get('cwd') === project ? [session] : [] }
                : url.pathname === '/api/pi/activity' ? { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] }
                    : url.pathname.includes('history') || url.pathname === '/api/prompts' ? [] : {};
        return route.fulfill({ json: data });
    });
    await page.routeWebSocket('**/api/pi/ws', socket => socket.onMessage(raw => {
        const command = JSON.parse(raw), state = { model, isStreaming: false, thinkingLevel: 'off' };
        const messages = { messages: [], webLive: { runtimeId: 'fixture', sequence: 0, tools: [], running: false } };
        const data = command.type === 'open_session' ? { session, state, messages, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] }, stats: {} }
            : command.type === 'get_state' ? state : command.type === 'get_messages' ? messages : {};
        socket.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
    }));
    try {
        await page.goto(base, { waitUntil: 'load' });
        await page.locator('#pi-input:not([disabled])').waitFor();
        await page.locator('#pi-input').fill('Preserve this draft');
        const open = async () => {
            await page.locator(width < 680 ? '#pi-mobile-summary' : '#pi-project-button').click();
            await page.waitForFunction(() => !document.querySelector('#pi-directory-create').disabled);
        };
        const start = async value => { await page.locator('#pi-directory-create').click(); await page.locator('#pi-directory-name').fill(value); };
        await open();
        assert.equal(await page.locator('#pi-directory-create').innerText(), locale === 'en-US' ? 'New folder' : '新建文件夹');
        await page.locator('#pi-directory-up').click();
        await page.waitForFunction(() => document.querySelector('#pi-directory-current').textContent === window.PiI18n.t('可选位置'));
        assert.equal(await page.locator('#pi-directory-create').isDisabled(), true);
        await page.locator('#pi-directory-list button').first().click();
        await page.waitForFunction(() => !document.querySelector('#pi-directory-create').disabled);
        await start('cancelled'); await page.locator('#pi-directory-create-cancel').click();
        assert.equal(writes.length, 0);
        await start('a/b'); await page.locator('#pi-directory-create-submit').click();
        assert.equal(writes.length, 0); assert.equal(await page.locator('#pi-directory-create-error').isVisible(), true);
        await page.locator('#pi-directory-name').fill('中文 文件夹-' + width);
        // A typed absolute path must not change the parent of the displayed directory.
        await page.locator('#pi-project-input').fill(path.join(project, 'unbrowsed'));
        await page.locator('#pi-directory-create-submit').click();
        const created = path.join(project, '中文 文件夹-' + width);
        await page.waitForFunction(created => document.querySelector('#pi-directory-current').textContent === created, created);
        assert.ok(fs.statSync(created).isDirectory()); assert.equal(writes.at(-1).parent, project);
        assert.equal(await page.locator('#pi-project-input').inputValue(), created);
        // The active project stays unchanged until the separate Open action.
        assert.equal(await page.evaluate(() => localStorage.getItem('pi.web.cwd')), project);
        await page.locator('#pi-directory-up').click();
        await page.waitForFunction(project => document.querySelector('#pi-directory-current').textContent === project, project);
        await start('中文 文件夹-' + width); await page.locator('#pi-directory-create-submit').click();
        await page.locator('#pi-directory-create-error:not([hidden])').waitFor();
        assert.equal(await page.locator('#pi-directory-name').inputValue(), '中文 文件夹-' + width);
        await page.locator('#pi-directory-name').fill('denied'); await page.locator('#pi-directory-create-submit').click();
        await page.waitForFunction(() => !document.querySelector('#pi-directory-name').disabled);
        assert.equal(await page.locator('#pi-directory-name').inputValue(), 'denied');
        await page.locator('#pi-directory-name').fill('uncertain'); await page.locator('#pi-directory-create-submit').click();
        await page.waitForFunction(() => !document.querySelector('#pi-directory-name').disabled && document.querySelector('#pi-directory-create-submit').disabled);
        assert.equal(writes.filter(row => row.name === 'uncertain').length, 1);
        await page.screenshot({ path: path.join(evidence, `directory-error-${width}.png`) });
        await page.locator('#pi-project-dialog-close').click(); await open();
        await start('late-' + width); await page.locator('#pi-directory-create-submit').click();
        await page.waitForFunction(() => document.querySelector('#pi-directory-create-form').getAttribute('aria-busy') === 'true');
        await page.locator('#pi-project-dialog-close').click();
        await page.locator(width < 680 ? '#pi-mobile-summary' : '#pi-project-button').click();
        for (let i = 0; !held && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(held, true); releaseHeld();
        await page.waitForFunction(() => !document.querySelector('#pi-directory-create').disabled);
        assert.equal(await page.locator('#pi-directory-current').textContent(), project);
        assert.ok(fs.statSync(path.join(project, 'late-' + width)).isDirectory());
        await start('下一层 文件夹');
        const geometry = await page.evaluate(() => {
            const selectors = ['.project-dialog', '.pi-directory-head', '#pi-directory-current', '#pi-directory-create', '#pi-directory-name', '.pi-directory-create-actions'];
            return selectors.map(selector => { const node = document.querySelector(selector), rect = node.getBoundingClientRect(); return { selector, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, scroll: node.scrollWidth, client: node.clientWidth, font: parseFloat(getComputedStyle(node).fontSize) }; });
        });
        for (const box of geometry) {
            assert.ok(box.left >= 0 && box.right <= width && box.width > 0
                && (box.selector === '#pi-directory-current' || box.scroll <= box.client + 1), JSON.stringify(box));
        }
        if (width < 680) assert.ok(geometry.find(box => box.selector === '#pi-directory-name').font >= 16);
        await page.screenshot({ path: path.join(evidence, `directory-create-${width}.png`) });
        await page.locator('#pi-directory-name').press('Escape');
        assert.equal(await page.locator('#pi-directory-create-form').isHidden(), true);
        await page.locator('#pi-project-dialog-close').click();
        assert.equal(await page.locator('#pi-input').inputValue(), 'Preserve this draft');
        await open();
        await page.locator('#pi-directory-list button').filter({ hasText: '中文 文件夹-' + width }).click();
        await page.waitForFunction(created => document.querySelector('#pi-project-input').value === created, created);
        await page.locator('#pi-project-form [type="submit"]').click();
        await page.waitForFunction(created => localStorage.getItem('pi.web.cwd') === created, created);
        assert.equal(await page.locator('#pi-project-dialog').isHidden(), true);
        assert.deepEqual(errors, []);
    } finally { if (releaseHeld) releaseHeld(); await context.close(); }
}
(async () => {
    fs.mkdirSync(evidence, { recursive: true });
    const gateway = createPiAgentGateway(), app = express();
    app.use(express.json()); gateway.mount(app);
    const repository = path.resolve(__dirname, '../..');
    app.use('/vendor/marked', express.static(path.join(repository, 'node_modules/marked/lib')));
    app.use('/vendor/dompurify', express.static(path.join(repository, 'node_modules/dompurify/dist')));
    app.use('/vendor/highlight', express.static(path.join(repository, 'node_modules/@highlightjs/cdn-assets')));
    app.use(express.static(path.join(repository, 'public')));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
    try {
        for (const [width, locale] of [[1440, 'en-US'], [390, 'zh-CN']]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, locale);
        assert.equal(gateway.supervisor.workers.size, 0);
        console.log('directory creation: desktop/phone, real API, errors, draft and stale responses passed');
    } finally {
        await browser.close(); await gateway.dispose(); await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
