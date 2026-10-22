const { browserTargetEnabled } = require('./targets.cjs');
// Real feature HTTP and private ledger. Synthetic transcript and unrelated workspace APIs.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..'), temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-cards-')));
process.env.PI_CODING_AGENT_DIR = temporary;
const { PiProfileRegistry } = require('../../server/pi-profile-registry'), { StaffingService } = require('../../server/staffing/service');
const { mountStaffingRoutes } = require('../../server/staffing/routes'), { WorkspaceAccessService } = require('../../server/workspace-access-service');
async function run(browser, width, raceOnly = false) {
    if (!browserTargetEnabled(width)) return;
    const actualWidth = process.env.PI_STAFFING_VIEWPORT ? Number(process.env.PI_STAFFING_VIEWPORT) : width;
    assert.ok(Number.isInteger(actualWidth) && actualWidth >= 320, 'valid staffing test viewport');
    const stage = name => console.log(`staffing cards ${width}: ${name} ${new Date().toISOString()}`);
    stage('start');
    const agent = path.join(temporary, (raceOnly ? 'race-' : '') + width); fs.mkdirSync(agent); process.env.PI_CODING_AGENT_DIR = agent;
    const service = new StaffingService({ profiles: new PiProfileRegistry({ resolveProject: value => value }) });
    const enabled = await service.enable({ requestId: 'enable', expectedRevision: 0 });
    const initial = await service.initialize({ requestId: 'initialize', expectedRevision: enabled.revision, historyComplete: false, projects: [], occupancies: [],
        people: [{ id: 'P1', name: '<img src=x onerror=alert(1)>', department: 'A', direct: true }, { id: 'P2', name: 'Two', department: 'A', direct: false },
            { id: 'P3', name: 'Three', department: 'A', direct: false }, { id: 'P4', name: 'Borrowed', department: 'B', direct: true }] });
    const ready = await service.confirmInitial({ requestId: 'review', expectedRevision: initial.revision, reviewed: true });
    const source = { cwd: '/projects/synthetic', sessionId: 'synthetic-session', sessionPath: path.join(agent, 'synthetic.jsonl'), profileId: enabled.profileId };
    const project = { id: 'new', name: 'New', owner: 'Owner', department: 'A', start: '2026-11-01', end: '2026-11-05', minimum: 2 };
    const recommendation = await service.query({ kind: 'recommend', project }, source);
    const plan = await service.prepareChange({ requestId: 'prepare', expectedRevision: ready.revision, project, personIds: recommendation.selected.map(person => person.id) }, source);
    const typed = width === 320 ? { version: 2, reference: { id: plan.id, originId: plan.id, revision: plan.revision, kind: 'assign', source: { cwd: source.cwd, sessionId: source.sessionId } } } : { version: 1, plan };
    const message = { role: 'toolResult', toolName: width === 320 ? 'staffing_operation_status' : 'staffing_prepare_change', toolCallId: 'call-plan', isError: false,
        content: [{ type: 'text', text: 'Synthetic plan prepared' }], details: { pivaneStaffing: typed }, timestamp: Date.now() };
    const history = [message];
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => '' }), app = express();
    access.mount(app); app.use(express.json()); const router = express.Router(); router.use(access.middleware());
    mountStaffingRoutes(router, service, { resolveSource: async input => { assert.deepEqual({ ...input }, { cwd: source.cwd, sessionId: source.sessionId }); return source; } });
    app.use('/api/pi', router);
    app.get('/card-fixture.html', (_req, res) => res.type('html').send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/pi-staffing.css"><style>body{max-width:700px;margin:auto;padding:16px;font-family:sans-serif}</style></head><body><main id="cards"></main><script src="/pi-staffing-cards.js"></script></body></html>'));
    for (const [name, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', folder)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext({ viewport: { width: actualWidth, height: 900 }, locale: 'zh-CN', hasTouch: actualWidth < 900 }), page = await context.newPage();
    const errors = [], planReads = []; let commits = 0, dropped = false, releaseCommit;
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(30000);
    page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/pi/staffing/plans/')) planReads.push({ event: 'request', at: Date.now() }); });
    page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/api/pi/staffing/plans/')) planReads.push({ event: 'response', status: response.status(), at: Date.now() }); });
    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.abort());
    await page.addInitScript(({ cwd, sessionId }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, sessionId); }, source);
    await page.route('**/api/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/api/pi/staffing/commit') {
            commits++;
            if (raceOnly) await new Promise(resolve => { releaseCommit = resolve; });
            if (!raceOnly && width === 1440 && !dropped) { dropped = true; const response = await route.fetch(); assert.equal(response.status(), 200); return route.abort('failed'); }
        }
        if (pathname.startsWith('/api/pi/staffing') || pathname.startsWith('/api/access')) return route.continue();
        if (pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, staffing: true, defaultProject: source.cwd, projectRoots: ['/projects'] } });
        if (pathname === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (pathname === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd: source.cwd, name: 'Synthetic', sessionCount: 1 }], roots: ['/projects'] } });
        if (pathname === '/api/pi/sessions') return route.fulfill({ json: { sessions: [{ id: source.sessionId, cwd: source.cwd, name: 'Synthetic', messageCount: 1 }] } });
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => { ws.onMessage(raw => {
        const command = JSON.parse(raw), model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 32000 };
        const state = { model, thinkingLevel: 'off', isStreaming: false };
        const data = command.type === 'open_session' ? { session: { id: source.sessionId, cwd: source.cwd, name: 'Synthetic', messageCount: 1 }, state,
            messages: { messages: history }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } }
            : command.type === 'get_state' ? state : command.type === 'get_messages' ? { messages: history } : {};
        ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
    }); });
    try {
        if (raceOnly) {
            await page.goto(origin + '/card-fixture.html', { waitUntil: 'domcontentloaded' });
            await page.evaluate(({ source, message }) => {
                globalThis.fixtureCards = PiStaffingCards.create({ context: () => ({ cwd: source.cwd, sessionId: source.sessionId }), fetch: async (url, options) => {
                    const response = await fetch(url, options), data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status }); return data;
                } });
                document.getElementById('cards').append(fixtureCards.render(message));
            }, { source, message });
            await page.locator('.staffing-plan-card').first().locator('[data-staffing-person="P1"]').waitFor();
            await page.evaluate(message => document.getElementById('cards').append(fixtureCards.render(message)), message);
            let latest = page.locator('.staffing-plan-card').last(); await latest.locator('[data-staffing-person="P1"]').waitFor();
            console.log('Duplicate card ready:', JSON.stringify(await latest.evaluate(card => ({ connected: card.isConnected, fields: [...card.querySelectorAll('input')].map(input => ({ person: input.dataset.staffingPerson, disabled: input.disabled, connected: input.isConnected, checked: input.checked, rect: input.getBoundingClientRect().toJSON() })) }))), 'Plan GET:', JSON.stringify(planReads));
            await latest.locator('[data-staffing-person="P2"]').uncheck(); await latest.locator('[data-staffing-person="P3"]').check();
            await latest.locator('[data-staffing-action="revise"]').click(); await latest.locator('[data-staffing-action="reserve"]').waitFor();
            const old = page.locator('.staffing-plan-card').first();
            assert.equal(await old.locator('[data-staffing-action="reserve"]').isDisabled(), true);
            await old.locator('[data-staffing-action="reserve"]').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); assert.equal(commits, 0);
            await latest.locator('[data-staffing-action="reserve"]').click(); await latest.locator('[data-staffing-action="lookup"]').waitFor();
            await page.evaluate(message => document.getElementById('cards').append(fixtureCards.render(message)), message);
            latest = page.locator('.staffing-plan-card').last(); await latest.locator('[data-staffing-action="lookup"]').waitFor();
            assert.equal(await latest.locator('[data-staffing-action="lookup"]').isDisabled(), true);
            releaseCommit(); await latest.locator('[data-staffing-outcome="completed"]').waitFor();
            assert.equal(commits, 1); assert.deepEqual((await service.ledger()).occupancies.map(row => row.personId), ['P1', 'P3']);
            assert.equal(await page.evaluate(message => fixtureCards.render({ ...message, details: { pivaneStaffing: { version: 1, plan: { id: message.details.pivaneStaffing.plan.id, source: message.details.pivaneStaffing.plan.source } } } }) === null, message), true);
            assert.deepEqual(errors, []); stage('duplicate and in-flight cards passed'); return;
        }
        await page.goto(origin + '/#/chat', { waitUntil: 'domcontentloaded' });
        stage('page ready');
        let card = page.locator('.staffing-plan-card').last(); await card.waitFor();
        await card.locator('[data-staffing-person="P1"]').waitFor();
        stage('card loaded');
        if (process.env.PIVANE_TEST_SCREENSHOT_DIR) { fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true }); await card.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, `staffing-card-plan-${width}.png`) }); }
        assert.match(await card.locator('label').filter({ has: page.locator('[data-staffing-person="P1"]') }).innerText(), /P1/);
        assert.match(await card.innerText(), /最低人数：2.*本次选中人数：2/);
        assert.equal(await card.locator('img').count(), 0); assert.match(await card.innerText(), /<img src=x/);
        assert.equal((await service.ledger()).occupancies.length, 0);
        if (width === 393) {
            await card.locator('[data-staffing-cross]').check();
            await card.locator('[data-staffing-action="revise"]').click();
            await card.locator('[data-staffing-person="P4"]').waitFor();
            await card.locator('[data-staffing-person="P1"]').uncheck();
            await card.locator('[data-staffing-person="P2"]').uncheck();
            await card.locator('[data-staffing-person="P3"]').check();
            await card.locator('[data-staffing-person="P4"]').check();
        } else if (width === 320) await card.locator('[data-staffing-person="P1"]').uncheck();
        else { await card.locator('[data-staffing-person="P2"]').uncheck(); await card.locator('[data-staffing-person="P3"]').check(); }
        assert.equal(await card.locator('[data-staffing-action="reserve"]').isDisabled(), true);
        await card.locator('[data-staffing-action="revise"]').click();
        await card.locator('[data-staffing-action="reserve"]').click();
        if (width === 1440) {
            await card.locator('[data-staffing-action="lookup"]').waitFor();
            assert.ok(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('pivane.staffing.pending:'))));
            await page.reload(); card = page.locator('.staffing-plan-card').last();
        }
        await card.locator('[data-staffing-outcome="completed"]').waitFor();
        stage('confirmed');
        if (process.env.PIVANE_TEST_SCREENSHOT_DIR) await card.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, `staffing-card-saved-${width}.png`) });
        assert.equal(commits, 1); assert.deepEqual((await service.ledger()).occupancies.map(row => row.personId), width === 320 ? ['P2'] : width === 393 ? ['P3', 'P4'] : ['P1', 'P3']);
        await page.reload(); await page.locator('[data-staffing-outcome="completed"]').waitFor();
        assert.equal(await page.locator('[data-staffing-action="reserve"]').count(), 0);
        if (width === 320) assert.match(await page.locator('.staffing-plan-card').innerText(), /缺直签/);
        assert.deepEqual(await page.evaluate(() => ['body', '.staffing-plan-card'].filter(selector => { const el = document.querySelector(selector); return el && el.scrollWidth > el.clientWidth + 1; })), []);
        assert.deepEqual(errors, []); console.log(`staffing cards case ${width}: actual ${actualWidth}px passed`);
    } catch (error) {
        console.error('Card DOM:', JSON.stringify(await page.locator('.staffing-plan-card').evaluateAll(cards => cards.map((card, index) => ({ index, connected: card.isConnected, rect: card.getBoundingClientRect().toJSON(), fields: [...card.querySelectorAll('input')].map(input => ({ person: input.dataset.staffingPerson, disabled: input.disabled, connected: input.isConnected, checked: input.checked, rect: input.getBoundingClientRect().toJSON() })) })))), 'Plan GET:', JSON.stringify(planReads));
        if (process.env.PIVANE_TEST_SCREENSHOT_DIR) { fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, `staffing-card-failure-${width}.png`), fullPage: true }).catch(() => {}); }
        console.error('Card state:', await page.locator('.staffing-plan-card').allTextContents(), 'Page errors:', errors); throw error; }
    finally { releaseCommit?.(); await context.close(); await service.dispose(); access.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
(async () => { console.log('staffing cards: launch ' + new Date().toISOString()); const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
    try { await run(browser, 1440, true); for (const width of [1440, 393, 320]) await run(browser, width); }
    finally { await browser.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
