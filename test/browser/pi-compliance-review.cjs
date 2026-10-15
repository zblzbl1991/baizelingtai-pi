const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), express = require('express'), { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..'), temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-review-browser-'))), agent = path.join(temporary, 'agent'), cwd = path.join(temporary, 'project'); fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = temporary; process.env.PI_OFFLINE = '1';
const { PiSessionStore } = require('../../server/pi-session-store'), { PiProfileRegistry } = require('../../server/pi-profile-registry'), { ComplianceService, mountCompliance } = require('../../server/pi-compliance'), { WorkspaceAccessService } = require('../../server/workspace-access-service');
const store = new PiSessionStore(), profiles = new PiProfileRegistry(store); store.profiles = profiles;
const documents = new (require('../../server/pi-document-uploads').DocumentUploads)({ store, supervisor: { getActiveWorker: () => null, removing: new Set(), moving: new Set() } });
const models = [{ provider: 'fixture', id: 'text', name: '合成文本', input: ['text'], available: true }], token = 'synthetic-review-browser';
const service = new ComplianceService({ store, profiles, documents, createModelRuntime: async () => ({ getAvailable: async () => models }) }), access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => token });
let sequence = 0;
async function run(browser, origin, width) {
    const api = async (method, route, body) => { const response = await fetch(origin + '/api/pi/compliance' + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Connection: 'close' }, body: body && JSON.stringify(body) }); const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data; };
    const write = async (route, body, method = 'POST') => api(method, route, { requestId: 'browser-review-' + ++sequence, expectedRevision: (await api('GET', '')).revision, ...body });
    await write('/settings', { enabled: true, mainModel: { provider: 'fixture', modelId: 'text' } }, 'PUT'); const session = await write('/sessions', { cwd });
    const project = (await write('/projects', { project: { name: '人工复核 <script> ' + width, identityConfirmed: true, applicability: { 'documents-identity': true, 'contract-deadline': true, 'feasibility-numbers': false, 'feasibility-order': false } } })).project;
    const image = require('@napi-rs/canvas').createCanvas(80,60);image.getContext('2d').fillRect(10,10,20,20);
    const docs = (await write(`/projects/${project.id}/documents`, { sources: [...['2026-08-01', '2026-09-01'].map((date, i) => ({ kind: 'upload', name: i ? '合同.csv' : '通知书.csv', base64: Buffer.from(`项目名称,日期\n${project.name},${date}\n`).toString('base64') })),{kind:'upload',name:'批复首页.png',base64:image.toBuffer('image/png').toString('base64')}] })).documents;
    for (const [i, role] of ['award-notice', 'contract'].entries()) await write(`/documents/${docs[i].id}/assignment`, { role, identityConfirmed: true, selected: true }, 'PUT');
    await write(`/documents/${docs[2].id}/assignment`,{role:'feasibility-approval',identityConfirmed:true,selected:true},'PUT');
    await write(`/projects/${project.id}/batches`, {});
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 1000 }, isMobile: width < 900, hasTouch: width < 900 }), page = await context.newPage(), errors = []; let loseConfirm = width > 900, confirmPosts = 0, holdCard = false, releaseCard, cardRequested;
    let busyPrepare = width > 900, preparePosts = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, token, session, width }) => { if (window.top !== window.self) return; localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, session.id); sessionStorage.setItem('pi.web.token', token); localStorage.setItem('pi.workspace.theme', width < 900 ? 'dark' : 'daylight'); if (width < 900) { Object.defineProperty(crypto, 'randomUUID', { value: undefined }); Object.defineProperty(crypto, 'subtle', { value: undefined }); } }, { cwd, token, session, width });
    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.abort());
    await page.route('**/api/**', async route => {
        const req = route.request(), endpoint = new URL(req.url()).pathname, json = data => route.fulfill({ json: data });
        if (endpoint.endsWith('/review-proposals') && req.method() === 'POST') { preparePosts++; if (busyPrepare) { busyPrepare = false; return route.fulfill({status:409,json:{error:'实际操作忙碌，尚未接纳本次确认卡',code:'COMPLIANCE_BUSY',operationAccepted:false}}); } }
        if (endpoint.endsWith('/confirm') && req.method() === 'POST') { confirmPosts++; if (loseConfirm) { loseConfirm = false; await route.fetch(); return route.abort(); } }
        if (holdCard && /\/review-proposals\/[^/]+$/.test(endpoint) && req.method() === 'GET') { holdCard = false; const response = await route.fetch(); cardRequested(); await new Promise(resolve => { releaseCard = () => route.fulfill({ response }).then(resolve); }); return; }
        if (endpoint.startsWith('/api/pi/compliance') || endpoint === '/api/pi/profiles') return route.continue();
        if (endpoint === '/api/pi/status') return json({ ok: true, sessionWorkflows: true, projectRoots: [temporary] });
        if (endpoint === '/api/pi/projects') return json({ projects: [{ cwd, name: 'Review fixture', sessionCount: 1 }], roots: [temporary] });
        if (endpoint === '/api/pi/sessions') return json({ sessions: [session] });
        if (endpoint === '/api/pi/activity') return json({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (endpoint === '/api/pi/settings/models') return json({ models, providers: [{ id: 'fixture' }], preferences: {} });
        if (endpoint.endsWith('/deferred')) return json({ jobs: [] });
        if (endpoint.endsWith('/workflow')) return json({ leafId: 'leaf', prompts: [], versions: [] });
        if (req.method() !== 'GET') throw new Error('Unexpected write: ' + endpoint);
        return json(endpoint.includes('history') ? [] : {});
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => { const cmd = JSON.parse(raw), state = { model: models[0], thinkingLevel: 'off', isStreaming: false, isCompacting: false }, send = data => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
        if (cmd.type === 'open_session') return send({ session, state, messages: { messages: [] }, stats: {}, models: { models }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
        if (cmd.type === 'get_messages') return send({ messages: [] }); if (cmd.type === 'get_state') return send(state); if (cmd.type === 'get_session_stats') return send({}); throw new Error('Unexpected RPC: ' + cmd.type);
    }));
    try {
        await page.goto(origin + '/#/chat', { waitUntil: 'domcontentloaded' }); await page.locator('#pi-compliance-open').click(); await page.locator('.compliance-project-list').getByRole('button', { name: project.name, exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#compliance-results')?.textContent.includes('合同签订期限：发现候选问题'));
        assert.equal(await page.locator('#compliance-review-form').count(), 1, 'the trusted app exposes human review form');
        await page.locator('#pi-input').fill('保留复核草稿');
        await page.locator('#compliance-review-document').selectOption(docs[1].id); await page.locator('#compliance-review-key').selectOption('date'); await page.locator('#compliance-review-value').fill('2026-08-31');
        await page.locator('#compliance-review-excerpt').fill('人工核对合同日期列'); await page.locator('#compliance-review-reason').fill('核对原件，日期应为八月三十一日'); await page.locator('#compliance-review-prepare').click();
        if(width>900){await page.waitForFunction(()=>document.querySelector('#compliance-review-status')?.textContent.includes('尚未接纳'));await page.locator('#compliance-review-prepare').click();}
        await page.locator('#compliance-review-card').waitFor();if(width>900)assert.equal(preparePosts,2,'an explicitly rejected operation allows an explicit new attempt'); assert.match(await page.locator('#compliance-review-card').textContent(), /2026-09-01/); assert.match(await page.locator('#compliance-review-card').textContent(), /2026-08-31/);
        await page.locator('#compliance-review-card').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR || os.tmpdir(), 'compliance-review-card-' + width + '.png') });
        await page.locator('#compliance-review-confirm').click();
        if (width > 900) { await page.waitForFunction(() => document.querySelector('#compliance-review-status')?.textContent.includes('Failed') || document.querySelector('#compliance-review-status')?.textContent.includes('fetch')); await page.locator('#compliance-review-receipt').click(); }
        await page.waitForFunction(() => document.querySelector('#compliance-results')?.textContent.includes('合同签订期限：通过')); assert.equal(confirmPosts, 1, 'receipt recovery does not resend confirmation');
        await page.locator('#compliance-review-kind').selectOption('conclusion'); await page.locator('#compliance-review-rule').selectOption('contract-deadline'); await page.locator('#compliance-review-conclusion').selectOption('insufficient'); await page.locator('#compliance-review-reason').fill('人工要求补充正式落款依据'); await page.locator('#compliance-review-prepare').click(); await page.locator('#compliance-review-confirm').click();
        await page.waitForFunction(() => document.querySelector('#compliance-results')?.textContent.includes('人工结论：证据不足'));
        await page.locator('#compliance-review-kind').selectOption('field');await page.locator('#compliance-review-document').selectOption(docs[2].id);await page.locator('#compliance-review-key').selectOption('documentNumber');
        await page.locator('#compliance-review-number-absent').check();assert.equal(await page.locator('#compliance-review-value').isDisabled(),true);await page.locator('#compliance-review-region').selectOption('upper');await page.locator('#compliance-review-excerpt').fill('人工逐处核对首页上方，未见文号');await page.locator('#compliance-review-reason').fill('明确缺失与无法识别分开');await page.locator('#compliance-review-prepare').click();await page.locator('#compliance-review-confirm').click();
        await page.waitForFunction(id=>document.querySelector('#compliance-review-document')?.value===id,docs[0].id);
        const currentBatch=(await api('GET',`/projects/${project.id}/batches`)).batches[0];const reviewed=(await api('GET',`/batches/${currentBatch.id}`)).batch;assert.equal(reviewed.fields.find(f=>f.documentId===docs[2].id&&f.key==='documentNumber').humanValue.status,'absent');
        assert.match(await page.locator('#compliance-results').textContent(), /合同签订期限：通过/); assert.equal(await page.locator('#pi-input').inputValue(), '保留复核草稿');
        assert.equal(await page.locator('#pi-compliance-drawer script').count(), 0);
        const typography = await page.locator('#compliance-review-reason').evaluate(el => ({ size: getComputedStyle(el).fontSize, styles: [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules].filter(rule => rule.selectorText && el.matches(rule.selectorText) && (rule.style.font || rule.style.fontSize)).map(rule => ({ href: sheet.href, rule: rule.cssText })); } catch { return []; } }) }));
        fs.writeFileSync(path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR || os.tmpdir(), 'compliance-review-font-' + width + '.json'), JSON.stringify(typography, null, 2));
        assert.ok(parseFloat(typography.size) >= 16, JSON.stringify({ width, typography }));
        assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false); assert.equal(await page.locator('#pi-compliance-drawer').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
        await page.locator('#compliance-results').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR || os.tmpdir(), 'compliance-review-result-' + width + '.png') }); assert.deepEqual(errors, []);
        const cards = page.locator('.compliance-review > details'); await cards.locator('summary').click(); holdCard = true; const requested = new Promise(resolve => { cardRequested = resolve; }); await cards.getByRole('button').first().click(); await requested;
        await page.locator('#pi-compliance-close').click(); releaseCard(); await page.waitForTimeout(50); assert.equal(await page.locator('#pi-compliance-drawer').isVisible(), false); assert.equal(await page.locator('#pi-input').inputValue(), '保留复核草稿'); assert.deepEqual(errors, []);
    } finally { await context.close(); }
}
(async () => {
    const app = express(); for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', directory))); app.use(express.static(path.join(root, 'public'))); access.mount(app); app.use(express.json({ limit: '32mb' })); const router = express.Router(); router.use(access.middleware()); mountCompliance(router, service); router.get('/profiles', async (_req, res) => res.json(await profiles.list())); app.use('/api/pi', router);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
    try { for (const width of [1440, 393]) await run(browser, `http://127.0.0.1:${server.address().port}`, width); } finally { await browser.close(); await service.dispose(); await documents.dispose(); access.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
