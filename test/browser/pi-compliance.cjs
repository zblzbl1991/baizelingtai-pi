const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..'), temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-compliance-browser-')));
const agent = path.join(temporary, 'agent'), cwd = path.join(temporary, 'project'); fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = temporary; process.env.PI_OFFLINE = '1';
const { PiSessionStore } = require('../../server/pi-session-store'), { PiProfileRegistry } = require('../../server/pi-profile-registry');
const { ComplianceService, mountCompliance } = require('../../server/pi-compliance'), { WorkspaceAccessService } = require('../../server/workspace-access-service');
const store = new PiSessionStore(), profiles = new PiProfileRegistry(store); store.profiles = profiles;
const documents = new (require('../../server/pi-document-uploads').DocumentUploads)({ store, supervisor: { getActiveWorker: () => null, removing: new Set(), moving: new Set() } });
const models = [{ provider: 'fixture', id: 'text', name: '文本样例', input: ['text'], available: true }, { provider: 'fixture', id: 'vision', name: '图像样例', input: ['text', 'image'], available: true }];
const service = new ComplianceService({ store, profiles, documents, createModelRuntime: async () => ({ getAvailable: async () => models }) });
const token = 'synthetic-compliance-browser-token', access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => token });
async function run(browser, origin, width, theme) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: width < 900 ? 852 : 1000 }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], sessions = [{ id: 'ordinary', cwd, name: '普通会话', messageCount: 0 }]; let active = 'ordinary', loseImport = false, holdEvidence = false, releaseEvidence, importPosts = 0;
    page.setDefaultTimeout(60000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, token, theme }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'ordinary'); sessionStorage.setItem('pi.web.token', token); localStorage.setItem('pi.workspace.theme', theme); }, { cwd, token, theme });
    if (width < 900) await page.addInitScript(() => { Object.defineProperty(crypto,'randomUUID',{value:undefined}); Object.defineProperty(crypto,'subtle',{value:undefined}); });
    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.abort());
    await page.route('**/api/**', async route => {
        const req = route.request(), endpoint = new URL(req.url()).pathname, json = data => route.fulfill({ json: data });
        if (endpoint.startsWith('/api/pi/compliance') && endpoint.endsWith('/documents') && req.method() === 'POST') {
            importPosts++; if (loseImport) { loseImport = false; await route.fetch(); return route.abort(); }
        }
        if (endpoint.includes('/compliance/batches/') && endpoint.includes('/evidence/') && holdEvidence) {
            holdEvidence = false; const response = await route.fetch(); await new Promise(resolve => { releaseEvidence = () => { route.fulfill({response}).then(resolve); }; }); return;
        }
        if (endpoint === '/api/pi/compliance/sessions' && req.method() === 'POST') {
            const response = await route.fetch(), data = await response.json(); sessions.push(data); return route.fulfill({ response, json: data });
        }
        if (endpoint.startsWith('/api/pi/compliance') || endpoint === '/api/pi/profiles') return route.continue();
        if (endpoint === '/api/pi/status') return json({ ok: true, sessionWorkflows: true, projectRoots: [temporary] });
        if (endpoint === '/api/pi/projects') return json({ projects: [{ cwd, name: 'Synthetic compliance', sessionCount: sessions.length }], roots: [temporary] });
        if (endpoint === '/api/pi/sessions') return json({ sessions });
        if (endpoint === '/api/pi/activity') return json({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (endpoint === '/api/pi/settings/models') return json({ models, providers: [{ id: 'fixture', name: '合成服务' }], preferences: {} });
        if (endpoint.endsWith('/deferred')) return json({ jobs: [] });
        if (endpoint.endsWith('/workflow')) return json({ leafId: 'leaf', prompts: [], versions: [] });
        if (req.method() !== 'GET') throw new Error('Unexpected browser write: ' + endpoint);
        return json(endpoint.includes('history') ? [] : {});
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const cmd = JSON.parse(raw), state = { model: models[0], thinkingLevel: 'off', isStreaming: false, isCompacting: false };
        const send = data => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
        if (cmd.type === 'open_session') { active = cmd.sessionId; return send({ session: sessions.find(session => session.id === active), state, messages: { messages: [] }, stats: {}, models: { models }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } }); }
        if (cmd.type === 'get_messages') return send({ messages: [] });
        if (cmd.type === 'get_state') return send(state);
        if (cmd.type === 'get_session_stats') return send({});
        throw new Error('Unexpected RPC: ' + cmd.type);
    }));
    try {
        await page.goto(origin + '/#/settings?tab=builtins', { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction(() => document.querySelector('#compliance-enabled')?.getBoundingClientRect().width > 0, null, { timeout: 60000 });
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        console.log(`compliance ${width}: settings ready`);
        await page.locator('#compliance-enabled').waitFor(); assert.equal(await page.locator('#compliance-enabled').isChecked(), false);
        await page.locator('#compliance-enabled').check(); await page.locator('#compliance-main-model').selectOption('fixture/text');
        await page.locator('#compliance-save').click(); await page.locator('#compliance-open-chat').waitFor({ state: 'visible' });
        console.log(`compliance ${width}: enabled`);
        assert.match(await page.locator('#compliance-settings-status').textContent(), /已启用/);
        const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
        const setting = await (await fetch(origin + '/api/pi/compliance', { headers: auth })).json();
        assert.equal((await fetch(origin + '/api/pi/compliance/settings', { method: 'PUT', headers: auth, body: JSON.stringify({ requestId: 'other-settings-' + width, expectedRevision: setting.revision, enabled: true }) })).status, 200);
        await page.locator('#compliance-extraction-model').selectOption('fixture/vision'); await page.locator('#compliance-save').click();
        await page.waitForFunction(() => document.querySelector('#compliance-settings-status')?.textContent.includes('已变化'));
        await page.locator('#compliance-save').click();
        await page.waitForFunction(() => document.querySelector('#compliance-settings-status')?.textContent === '已启用');
        assert.equal((await (await fetch(origin + '/api/pi/compliance', { headers: auth })).json()).extractionModel.modelId, 'vision');
        await page.locator('#compliance-open-chat').click();
        await page.locator('#pi-compliance-open').waitFor({ state: 'visible' }); assert.notEqual(active, 'ordinary');
        console.log(`compliance ${width}: dedicated chat ready`);
        await page.locator('#pi-input').fill('保留我的草稿');
        await page.locator('#pi-compliance-open').click();
        await page.locator('#compliance-project-new').click(); await page.locator('#compliance-project-name').fill('工程 <script> ' + width);
        await page.locator('#compliance-project-number').fill('C-' + width); await page.locator('#compliance-project-confirmed').check();
        await page.getByLabel('合同签订期限', { exact: true }).selectOption('yes');
        await page.getByLabel('资料缺失与归属', { exact: true }).selectOption('yes');
        await page.getByLabel('可研评审及批复文号', { exact: true }).selectOption('no');
        await page.getByLabel('可研与评审时序', { exact: true }).selectOption('no');
        const projectState = await (await fetch(origin + '/api/pi/compliance/projects', { headers: auth })).json();
        assert.equal((await fetch(origin + '/api/pi/compliance/projects', { method: 'POST', headers: auth, body: JSON.stringify({ requestId: 'other-project-' + width, expectedRevision: projectState.revision, project: { name: '另一个聊天的工程' } }) })).status, 200);
        await page.locator('#compliance-project-save').click();
        await page.waitForFunction(() => document.querySelector('#compliance-project-status')?.textContent.includes('已变化'));
        await page.locator('#compliance-project-save').click();
        await page.waitForFunction(width => document.querySelector('#pi-compliance-drawer').textContent.includes('C-' + width), width);
        assert.equal(await page.locator('#compliance-project-organization').inputValue(), '');
        assert.match(await page.locator('#compliance-project-status').textContent(), /已保存/);
        console.log(`compliance ${width}: project saved`);
        const name = '工程 <script> ' + width;
        await page.locator('#compliance-upload').setInputFiles(['中标通知书', '合同'].map((title, index) => ({ name: title + '.csv', mimeType: 'text/csv', buffer: Buffer.from(`项目名称,项目编号,日期\n${name},C-${width},2026-08-${index ? '31' : '01'}\n`) })));
        loseImport = width > 900;
        await page.locator('#compliance-import-upload').click();
        if (width > 900) { await page.waitForFunction(() => document.querySelector('#compliance-material-status')?.textContent.includes('Failed') || document.querySelector('#compliance-material-status')?.textContent.includes('fetch')); await page.locator('#compliance-import-upload').click(); }
        await page.waitForFunction(() => document.querySelectorAll('[data-compliance-document]').length === 2);
        assert.equal(importPosts,2,'lost response recovers receipt without resending the first import');
        for (const [title, role] of [['中标通知书.csv', 'award-notice'], ['合同.csv', 'contract']]) {
            const row = page.locator('[data-compliance-document]').filter({ hasText: title });
            await row.locator('select').selectOption(role); await row.getByLabel('归属已核对').check(); await row.getByLabel('选用于新批次').check(); await row.getByRole('button', { name: '保存资料核对' }).click();
            await page.waitForFunction(() => document.querySelector('#compliance-material-status')?.textContent.includes('已保存资料核对'));
        }
        await page.locator('#compliance-run-check').click();
        await page.waitForFunction(() => document.querySelector('#compliance-results')?.textContent.includes('合同签订期限：通过'));
        if (width > 900) {
            holdEvidence = true; await page.locator('#compliance-results').getByRole('button',{name:'查看证据'}).first().click();
            await page.waitForTimeout(50); assert.equal(typeof releaseEvidence,'function'); await page.locator('#pi-compliance-close').click(); releaseEvidence();
            await page.waitForTimeout(50); assert.equal(await page.locator('#pi-compliance-drawer').isVisible(),false);
            await page.locator('#pi-compliance-open').click(); await page.waitForFunction(() => document.querySelector('#compliance-results')?.textContent.includes('合同签订期限：通过'));
        }
        await page.locator('#compliance-results').getByRole('button', { name: '查看证据' }).first().click();
        await page.locator('#compliance-evidence').waitFor({ state: 'visible' }); assert.match(await page.locator('#compliance-evidence').textContent(), /2026-08-01/);
        assert.equal(await page.locator('#pi-compliance-drawer').evaluate(el => [...el.querySelectorAll('input,select,textarea')].every(input => input.getBoundingClientRect().width <= el.clientWidth)), true);
        assert.equal(await page.locator('#pi-input').inputValue(),'保留我的草稿');
        assert.equal(await page.locator('#pi-compliance-drawer script').count(), 0);
        assert.ok(await page.locator('#compliance-project-name').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 16));
        await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR || os.tmpdir(), 'compliance-' + width + '.png') });
        assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false);
        assert.equal(await page.locator('#pi-compliance-drawer').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
        await page.locator('#pi-compliance-close').click();
        await page.evaluate(() => { location.hash = '#/settings?tab=builtins'; });
        await page.locator('#compliance-enabled').waitFor({ state: 'visible' }); await page.locator('#compliance-enabled').uncheck(); await page.locator('#compliance-save').click();
        await page.waitForFunction(() => document.querySelector('#compliance-settings-status')?.textContent.includes('已停用'));
        assert.equal(await page.locator('#compliance-open-chat').isVisible(), false);
        await page.evaluate(() => { location.hash = '#/chat'; }); assert.equal(await page.locator('#pi-compliance-open').isVisible(), false);
        assert.deepEqual(errors, []); console.log(`compliance ${width} ${theme}: actual authenticated settings, dedicated session, project drawer, persistence and disable passed`);
    } catch (error) { console.error({ errors, url: page.url(), message: error.message }); throw error; }
    finally { await context.close(); }
}
(async () => {
    const app = express();
    for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', directory)));
    app.use(express.static(path.join(root, 'public')));
    access.mount(app); app.use(express.json({ limit: '32mb' }));
    const router = express.Router(); router.use(access.middleware()); mountCompliance(router, service);
    router.get('/profiles', async (_req, res) => res.json(await profiles.list())); app.use('/api/pi', router);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR || os.tmpdir(), { recursive: true });
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const width of (process.env.PIVANE_COMPLIANCE_WIDTHS || '1440,393').split(',').map(Number)) await run(browser, `http://127.0.0.1:${server.address().port}`, width, width < 900 ? 'dark' : 'daylight'); }
    finally { await browser.close(); await service.dispose(); await documents.dispose(); access.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
