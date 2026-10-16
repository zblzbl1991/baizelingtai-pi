// Actual cron editor + browser DOM and HTTP writes. Synthetic HTTP does not stand in for scheduler persistence.
// The sessions response is held by an explicit gate; no sleep chooses the failing interleaving.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), { randomUUID } = require('node:crypto');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const cwd = '/synthetic/cron-target-refresh', profileId = randomUUID(), sessionId = randomUUID();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

(async () => {
    const app = express(), jobs = [], observed = [], held = deferred(), heldStarted = deferred();
    const now = Date.now(), limits = { maxRunsPerDay: 40, maxTokensPerDay: 400000, maxCostPerDay: null };
    let holdNextSessions = false, heldCount = 0;
    app.use(express.json());
    app.get('/api/pi/projects', (_req, res) => res.json({ projects: [{ cwd, name: 'Synthetic', sessionCount: 1 }] }));
    app.get('/api/pi/profiles', (_req, res) => res.json({ profiles: [{ id: profileId, name: 'Synthetic assistant', enabled: true }] }));
    app.get('/api/pi/cron', (_req, res) => res.json({ jobs, homes: [], limits, today: { runs: 0, tokens: 0, cost: 0 } }));
    app.get('/api/pi/sessions', async (req, res) => {
        const directory = req.query.cwd;
        if (holdNextSessions && directory === cwd) {
            holdNextSessions = false; heldCount++;
            observed.push({ event: 'held-sessions-request', cwd: directory }); heldStarted.resolve();
            await held.promise;
            observed.push({ event: 'held-sessions-response', cwd: directory, sessionId });
            return res.json({ sessions: [{ id: sessionId, cwd, name: 'Refreshed legal target', agentProfile: { id: profileId } }] });
        }
        observed.push({ event: 'initial-sessions-response', cwd: directory });
        res.json({ sessions: directory === cwd ? [{ id: sessionId, cwd, name: 'Initial legal target', agentProfile: { id: profileId } }] : [] });
    });
    app.post('/api/pi/cron/preview', (_req, res) => res.json({ times: Array.from({ length: 5 }, (_, i) => now + (i + 1) * 86400000) }));
    app.put('/api/pi/cron/jobs', (req, res) => {
        // Capture the actual browser request, but reject empty/invalid targets instead of pretending they persisted.
        observed.push({ event: 'put-job', target: req.body.target });
        if (req.body.target?.kind !== 'thread' || req.body.target.cwd !== cwd || req.body.target.sessionId !== sessionId) {
            return res.status(400).json({ error: 'Invalid synthetic task target' });
        }
        const job = { ...req.body, revision: 1, nextAt: now + 86400000 }; jobs.push(job); res.json(job);
    });
    app.get('/api/pi/cron/jobs/:id/runs', (_req, res) => res.json({ runs: [] }));
    app.get('/fixture.html', (_req, res) => res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/pi-cron.css"></head><body><main id="cron-tab" class="cron-page"></main><script src="/pi-cron.js"></script><script>
        window.PiWorkspaceRoute = { current: () => ({ tab: 'cron' }) };
        PiCron.create({ currentCwd: () => ${JSON.stringify(cwd)}, api: async (url, options) => {
            const response = await fetch(url, options), body = await response.json();
            if (!response.ok) throw new Error(body.error); return body;
        } });
    </script></body></html>`));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    let browser, context, page;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
        page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/fixture.html`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: '把重复的事情，交给时间', exact: true }).waitFor();
        await page.getByRole('button', { name: '新建任务', exact: true }).click();
        await page.getByLabel('任务名称', { exact: true }).fill('Controlled target refresh');
        await page.getByLabel('提示词', { exact: true }).fill('Synthetic text only.');
        const target = page.getByLabel('目标线程', { exact: true });
        await target.locator('option', { hasText: 'Initial legal target' }).waitFor({ state: 'attached' });
        await target.selectOption(sessionId);
        assert.equal(await target.inputValue(), sessionId, 'the user first selected a valid target in this directory');
        observed.push({ event: 'selected-before-refresh', sessionId: await target.inputValue() });

        // Same public directory-change event used by the editor, without changing its scope.
        // A choice already made before the read must survive a response that still contains that ID.
        holdNextSessions = true;
        await page.getByLabel('工作目录', { exact: true }).dispatchEvent('change');
        await heldStarted.promise;
        observed.push({ event: 'selection-while-response-held', sessionId: await target.inputValue(), disabled: await target.isDisabled() });
        held.resolve();
        // Changed display text is a public acknowledgement that this exact held response reached the UI.
        // This does not rely on replaceChildren, private draft state, a timer or a particular rendering strategy.
        await target.locator('option', { hasText: 'Refreshed legal target' }).waitFor({ state: 'attached' });
        const after = await target.inputValue();
        observed.push({ event: 'selection-after-response', sessionId: after });
        assert.equal(heldCount, 1);
        assert.equal(after, sessionId, 'a still-valid selected session must not be reset by the pending response');

        const put = page.waitForRequest(request => request.method() === 'PUT' && new URL(request.url()).pathname === '/api/pi/cron/jobs');
        await page.getByRole('button', { name: '保存任务', exact: true }).click();
        const submitted = (await put).postDataJSON();
        assert.deepEqual(submitted.target, { kind: 'thread', cwd, sessionId }, 'the real browser HTTP request must retain the selected target');
        await page.locator('.cron-detail-head').waitFor();
        assert.equal(jobs.length, 1);
        assert.deepEqual(jobs[0].target, { kind: 'thread', cwd, sessionId });
        assert.deepEqual(errors, []);
        console.log('Controlled cron target refresh: same-scope selected target survived held response and actual PUT');
    } catch (error) {
        console.error('Controlled cron observations:', JSON.stringify(observed)); throw error;
    } finally {
        held.resolve();
        const output = process.env.PIVANE_TEST_SCREENSHOT_DIR || path.join(os.tmpdir(), 'pivane-browser', 'pi-cron-target-refresh');
        fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'target-refresh-observations.json'), JSON.stringify(observed, null, 2) + '\n');
        await context?.close(); await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
