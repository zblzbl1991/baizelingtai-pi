// Chromium settings UI with an isolated native provider store; no model requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { selectBrowserTargets } = require('./targets.cjs');
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-provider-preset-'));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { PiSettingsService } = require('../../server/pi-settings-service');
const service = new PiSettingsService({ cwd: agentDir, workspacePreferencesOptions: { filePath: path.join(agentDir, 'workspace.json') } });

async function run(browser, english, theme) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: english ? 'en-US' : 'zh-CN' });
    const page = await context.newPage(), errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ english, theme }) => {
        localStorage.setItem('pi.workspace.theme', theme);
    }, { english, theme });
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('https://fonts.gstatic.com/**', route => route.abort());
    await page.route('**/api/**', async route => {
        const request = route.request(), pathname = new URL(request.url()).pathname;
        if (request.method() !== 'GET') {
            writes.push(pathname);
            assert.equal(pathname, '/api/pi/settings/custom-providers', 'only explicit provider save may write');
            return route.fulfill({ json: await service.upsertCustomProvider(request.postDataJSON()) });
        }
        if (pathname === '/api/pi/settings/models') return route.fulfill({ json: await service.getModelSnapshot() });
        if (pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, projectRoots: [agentDir] } });
        if (pathname === '/api/pi/projects') return route.fulfill({ json: { projects: [], roots: [agentDir] } });
        if (pathname === '/api/pi/sessions') return route.fulfill({ json: { sessions: [] } });
        if (pathname === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (pathname.includes('history') || pathname === '/api/prompts') return route.fulfill({ json: [] });
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', () => { throw new Error('Provider settings must not open a session'); });
    await page.goto(process.env.PI_SETTINGS_TEST_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#workspace-settings-toggle').click();
    await page.locator('[data-settings-tab="providers"]').click();
    await page.locator('#settings-model-search').fill('deepseek-v4-flash');
    const group = page.locator('.settings-model-group').filter({ has: page.locator('summary[data-provider="xingtong"]') });
    await group.locator('[data-action="configure"]').waitFor();
    assert.ok((await group.locator('summary').textContent()).includes('星通'));
    assert.equal(await group.locator('.model-row').count(), 1);
    assert.equal(await group.locator('.model-row button').count(), 0, 'preview cannot test or select an unsaved model');
    assert.deepEqual(writes, []);
    assert.equal(fs.existsSync(path.join(agentDir, 'models.json')), false);
    await group.locator('[data-action="configure"]').click();
    const form = page.locator('#settings-provider-form');
    assert.equal(await form.locator('[name="id"]').inputValue(), 'xingtong');
    assert.equal(await form.locator('[name="baseUrl"]').inputValue(), 'http://token.xt.com/v1');
    assert.equal(await form.locator('[name="authHeader"]').isChecked(), true);
    assert.equal(await form.locator('input[readonly]').last().inputValue(), 'deepseek-v4-flash');
    const widths = await page.evaluate(() => ['.workspace-settings-dialog', '#settings-model-list', '.settings-editor-dialog', '.settings-editor-body'].map(selector => {
        const el = document.querySelector(selector); return { selector, width: el.clientWidth, scroll: el.scrollWidth };
    }));
    for (const metric of widths) assert.ok(metric.width > 0 && metric.scroll <= metric.width + 1, JSON.stringify(metric));
    await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, `xingtong-${english ? 'en' : 'zh'}-${theme}.png`) });
    await form.locator('[type="submit"]').click();
    await page.locator('#workspace-settings-editor').waitFor({ state: 'hidden' });
    await group.locator('[data-action="key"]').waitFor();
    assert.equal(await group.locator('[data-action="configure"]').count(), 0);
    const snapshot = await service.getModelSnapshot();
    assert.equal(snapshot.customProviders.find(provider => provider.id === 'xingtong').models[0].id, 'deepseek-v4-flash');
    assert.equal(snapshot.preferences.defaultProvider, '');
    assert.equal(await group.locator('.model-row [data-action="test"]').isDisabled(), true);
    assert.deepEqual(writes, ['/api/pi/settings/custom-providers']);
    assert.deepEqual(errors, []);
    await context.close();
    await service.deleteCustomProvider('xingtong');
    // Restore the fresh-store condition for the second language/theme scenario.
    fs.unlinkSync(path.join(agentDir, 'models.json'));
    console.log(JSON.stringify({ english, theme, widths, pageerrors: errors.length }));
}

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
    try {
        for (const [, english, theme] of selectBrowserTargets([[1440, false, 'light'], [1440, true, 'dark']])) await run(browser, english, theme);
    } finally { await browser.close(); fs.rmSync(agentDir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
