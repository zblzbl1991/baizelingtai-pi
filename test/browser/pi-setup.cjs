// Synthetic first-use UI. All API and RPC traffic stays in this fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { selectBrowserTargets } = require('./targets.cjs');
const base = process.env.PI_SETUP_URL;
const profileId = '11111111-1111-4111-8111-111111111111';
const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const cwd = '/fixture/work';
const profile = { id: profileId, name: '小白', description: '', soul: '', enabled: true,
    memory: { enabled: true, autoLearn: false }, skills: { learnedEnabled: true } };
const model = { provider: 'fixture', id: 'local', name: 'Fixture model', input: ['text'], available: true };

async function fixture(browser, { width = 1280, english = false, hash = '', ready = false, uncertain = false, slowStatus = false, slowModels = false, extensionAssistant = true } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: english ? 'en-US' : 'zh-CN' });
    const page = await context.newPage(), errors = [], writes = [], commands = [];
    let available = ready, groups = [], sessions = [], preferences = ready ? { defaultProvider: model.provider, defaultModel: model.id } : {};
    let releaseStatus, releaseModels;
    const statusGate = slowStatus ? new Promise(resolve => { releaseStatus = resolve; }) : null;
    const modelsGate = slowModels ? new Promise(resolve => { releaseModels = resolve; }) : null;
    await page.addInitScript(({ english }) => {
        localStorage.setItem('pi.workspace.language', english ? 'en' : 'zh-CN');
        localStorage.setItem('pi.workspace.theme', english ? 'dark' : 'daylight');
        localStorage.setItem('pi.workspace.sidebarCollapsed', 'false');
    }, { english });
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.abort());
    await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
        const json = data => route.fulfill({ json: data });
        if (request.method() !== 'GET') {
            const body = request.postDataJSON(); writes.push({ pathname, body });
            if (pathname === '/api/pi/settings/models/preferences') { preferences = { ...preferences, ...body }; return json({ ok: true }); }
            if (pathname === '/api/pi/assistant-projects') {
                assert.equal(body.project.profileIds[0], profileId);
                groups = [{ ...body.project, id: projectId }];
                return json({ ok: true, revision: 'projects-2', project: groups[0] });
            }
            if (pathname === '/api/pi/extension-assistant/sessions') {
                assert.equal(body.cwd, cwd);
                const session = { id: 'configuration-session', cwd, name: 'Extension assistant', messageCount: 0,
                    assistant: { kind: 'extensions', scope: body.scope, language: body.language, returnSessionId: body.returnSessionId } };
                sessions.push(session); return json(session);
            }
            if (pathname === '/api/pi/sessions') {
                assert.deepEqual(body, { cwd, profileId, assistantProjectId: projectId });
                if (uncertain) return route.fulfill({ status: 503, json: { error: 'Synthetic uncertain creation' } });
                const session = { id: 'first-session', cwd, name: 'First conversation', messageCount: 0,
                    modified: '2026-10-22T00:00:00Z', created: '2026-10-22T00:00:00Z', agentProfile: profile,
                    assistantProject: { ...groups[0], available: true } };
                sessions.push(session); return json(session);
            }
            return json({ ok: true });
        }
        if (pathname === '/api/pi/status') { if (statusGate) await statusGate; return json({ agentProfiles: true, assistantProjects: true, modelCatalog: true, extensionAssistant, projectRoots: ['/fixture'], defaultProject: cwd }); }
        if (pathname === '/api/pi/settings/models') { if (modelsGate) await modelsGate; return json({ version: 1, models: available ? [model] : [], providers: [], customProviders: [], preferences }); }
        if (pathname === '/api/pi/profiles') return json({ version: 1, profiles: [profile], defaultAssistantId: profileId, revision: 'profiles-1', trash: [], profileRevisions: { [profileId]: 'profile-1' } });
        if (pathname === '/api/pi/assistant-projects') return json({ version: 1, revision: 'projects-' + (groups.length ? '2' : '1'), projects: groups });
        if (pathname === '/api/pi/projects') return json({ projects: [{ cwd, name: 'Work', sessionCount: sessions.length }], roots: ['/fixture'] });
        if (pathname === '/api/pi/sessions' || /\/assistant-projects\/[^/]+\/sessions$/.test(pathname)) return json({ sessions });
        if (pathname === '/api/pi/activity') return json({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (pathname === '/api/pi/directories') {
            const current = url.searchParams.get('path');
            return json({ current: current || null, parent: null, directories: current ? [] : [{ name: 'work', path: cwd }] });
        }
        return json({});
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const command = JSON.parse(raw); commands.push(command.type);
        const data = command.type === 'open_session' ? { session: sessions.find(session => session.id === command.sessionId),
            state: { model, isStreaming: false, thinkingLevel: 'off' }, messages: { messages: [] }, stats: {},
            models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } }
            : command.type === 'get_state' ? { model, isStreaming: false, thinkingLevel: 'off' } : {};
        ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
    }));
    await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
    return { page, context, errors, writes, commands, connect: () => { available = true; }, releaseStatus, releaseModels, groups: () => groups };
}
async function fillProject(page, english) {
    await page.locator('#setup-tab').getByRole('button', { name: english ? 'Choose folder and create project' : '选择目录并创建项目', exact: true }).click();
    const dialog = page.locator('.pi-assistant-project-editor[open]');
    assert.equal(await dialog.locator('[name="instructions"]').isVisible(), false);
    await dialog.locator('[data-browse]').click();
    await dialog.locator('[data-path="/fixture/work"]').click();
    await dialog.locator('[data-choose]').click();
    await dialog.locator('[name="name"]').fill('First work <img src=x>');
    await dialog.locator('[type="submit"]').click();
    await page.locator('#pi-setup-project').waitFor();
}
async function main() {
    assert.ok(base, 'Run through npm run test:browser');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
    const evidence = process.env.PIVANE_TEST_SCREENSHOT_DIR;
    if (evidence) fs.mkdirSync(evidence, { recursive: true });
    try {
        for (const width of selectBrowserTargets([1280, 1440])) {
            const english = width === 1440;
            const view = await fixture(browser, { width, english }), { page } = view;
            const root = page.locator('#setup-tab');
            const next = () => root.getByRole('button', { name: english ? 'Next' : '下一步', exact: true });
            await page.waitForURL('**/#/setup');
            await root.getByRole('button', { name: english ? 'Connect model service' : '连接模型服务', exact: true }).waitFor();
            const entry = page.locator('[data-setup-entry]');
            const entryLabel = english ? 'Setup' : '引导';
            assert.equal((await entry.innerText()).trim(), entryLabel, 'expanded setup entry shows its label once');
            await page.locator('#workspace-sidebar-toggle').click();
            await page.waitForFunction(() => Math.abs(document.querySelector('#workspace-sidebar').getBoundingClientRect().width - 72) < 1);
            assert.equal((await entry.innerText()).trim(), entryLabel, 'collapsed setup entry shows its short label once');
            await page.locator('#workspace-brand-toggle').click();
            await page.waitForFunction(() => Math.abs(document.querySelector('#workspace-sidebar').getBoundingClientRect().width - 184) < 1);
            assert.equal((await entry.innerText()).trim(), entryLabel, 'expanding the sidebar keeps one setup label');
            assert.equal(await entry.evaluate(button => button.scrollWidth <= button.clientWidth), true, 'setup label fits the sidebar');
            assert.equal(await next().isEnabled(), false);
            assert.equal(await page.locator('[data-work-chat-nav]').isVisible(), false);
            assert.equal(await page.locator('#workspace-assistant-toggle').isVisible(), true);
            assert.equal(await page.locator('#workspace-profiles-toggle').isVisible(), true);
            assert.equal(view.writes.length, 0);
            if (evidence) await page.screenshot({ path: path.join(evidence, `setup-model-${width}.png`) });
            await root.getByRole('button', { name: english ? 'Connect model service' : '连接模型服务', exact: true }).click();
            await page.locator('.pi-setup-return').waitFor({ state: 'visible' });
            await page.locator('[data-settings-tab="models"]').click();
            assert.equal(await page.locator('.pi-setup-return').isVisible(), true, 'settings subnavigation keeps the setup return action');
            view.connect();
            await page.locator('.pi-setup-return button').click();
            await page.locator('#pi-setup-model').waitFor();
            await next().click();
            await root.getByRole('heading', { name: '小白', exact: true }).waitFor();
            assert.equal(view.writes.filter(write => write.pathname.endsWith('/preferences')).length, 1);
            await root.getByRole('button', { name: english ? 'Customize assistant (optional)' : '调整助手设定（可选）', exact: true }).click();
            const toggle = page.locator('#pi-profiles-content [name="enabled"]');
            await toggle.waitFor(); assert.equal(await toggle.isDisabled(), true);
            await page.locator('.pi-setup-return button').click();
            await root.getByRole('heading', { name: '小白', exact: true }).waitFor();
            await page.reload();
            await root.getByRole('heading', { name: '小白', exact: true }).waitFor();
            await next().click();
            assert.equal(await next().isEnabled(), false, 'a work folder is required before the optional knowledge step');
            await fillProject(page, english);
            assert.equal(await root.locator('img[src="x"]').count(), 0);
            assert.equal(await root.locator('.pi-setup-path').textContent(), cwd);
            assert.equal(view.writes.filter(write => write.pathname === '/api/pi/sessions').length, 0);
            await next().click();
            await root.locator('.pi-setup-example').waitFor();
            assert.equal(await root.locator('.pi-setup-steps li').count(), 4);
            assert.match(await root.locator('.pi-setup-example').textContent(), /url[:：]\s*xxx\nkey[:：]\s*xxx/);
            await page.reload();
            await root.locator('.pi-setup-example').waitFor();
            const writesBeforeExample = view.writes.length;
            await root.getByRole('button', { name: english ? 'Configure WeKnora with AI' : '让助手配置 WeKnora', exact: true }).click();
            const dialog = page.locator('#pi-extension-assistant-dialog');
            await dialog.waitFor({ state: 'visible' });
            assert.equal(await dialog.getAttribute('data-cwd'), cwd);
            assert.equal(await page.locator('#pi-extension-assistant-need').inputValue(), await root.locator('.pi-setup-example').textContent());
            assert.equal(await page.locator('#pi-extension-assistant-scope').inputValue(), 'global');
            assert.equal(view.writes.length, writesBeforeExample, 'opening the example does not create a session or save configuration');
            assert.equal(view.commands.includes('prompt'), false);
            await page.keyboard.press('Escape');
            assert.equal(await root.isVisible(), true, 'cancelling the example stays in setup');
            const dimensions = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
            assert.equal(dimensions.width, dimensions.viewport);
            assert.equal(await root.locator('.pi-setup-steps button, .pi-setup-example').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth)), true);
            if (evidence) await page.screenshot({ path: path.join(evidence, `setup-ready-${width}.png`) });
            await root.getByRole('button', { name: english ? 'Start first conversation' : '开始第一段对话', exact: true }).evaluate(button => { button.click(); button.click(); });
            await page.waitForURL('**/*sessionId=first-session');
            await page.waitForFunction(() => document.querySelector('#pi-input')?.disabled === false);
            assert.equal(view.writes.filter(write => write.pathname === '/api/pi/sessions').length, 1);
            assert.equal(view.commands.includes('prompt'), false);
            assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('pivane.setup.v1'))).status, 'complete');
            assert.equal(await page.locator('.pi-setup-return').isVisible(), false, 'completion closes the setup return action');
            // A saved completion survives a new root visit; work chat stays optional.
            await page.goto(base + '/');
            await page.locator('#pi-assistant-profile option').first().waitFor({ state: 'attached' });
            assert.equal(await root.isVisible(), false);
            assert.equal(await page.locator('#pi-assistant-profile').inputValue(), profileId);
            await page.evaluate(() => {
                const control = document.querySelector('#workspace-show-workChat'); control.checked = true;
                control.dispatchEvent(new Event('change', { bubbles: true }));
            });
            assert.equal(await page.locator('[data-work-chat-nav]').isVisible(), true);
            await page.locator('[data-work-chat-nav]').click();
            assert.ok(page.url().endsWith('#/chat'));
            assert.deepEqual(view.errors, []);
            await view.context.close();
        }
        // Entering the configuration conversation carries a draft, never sends it, and can return to setup.
        const configuration = await fixture(browser, { ready: true });
        const configurationRoot = configuration.page.locator('#setup-tab');
        await configuration.page.locator('#pi-setup-model').waitFor();
        await configurationRoot.getByRole('button', { name: '下一步', exact: true }).click();
        await configurationRoot.getByRole('heading', { name: '小白', exact: true }).waitFor();
        await configurationRoot.getByRole('button', { name: '下一步', exact: true }).click();
        await fillProject(configuration.page, false);
        await configurationRoot.getByRole('button', { name: '下一步', exact: true }).click();
        await configurationRoot.getByRole('button', { name: '让助手配置 WeKnora', exact: true }).click();
        await configuration.page.locator('#pi-extension-assistant-create').click();
        await configuration.page.locator('#pi-extension-assistant-banner').waitFor({ state: 'visible' });
        await configuration.page.waitForFunction(() => document.querySelector('#pi-input')?.disabled === false);
        assert.match(await configuration.page.locator('#pi-input').inputValue(), /WeKnora/);
        assert.equal(configuration.writes.filter(write => write.pathname === '/api/pi/extension-assistant/sessions').length, 1);
        assert.equal(configuration.writes.filter(write => write.pathname === '/api/pi/sessions' || write.pathname.includes('/settings/mcp')).length, 0);
        assert.equal(configuration.commands.includes('prompt'), false);
        await configuration.page.locator('.pi-setup-return button').click();
        await configurationRoot.locator('.pi-setup-example').waitFor();
        assert.equal(await configurationRoot.getByRole('button', { name: '开始第一段对话', exact: true }).isEnabled(), true);
        assert.deepEqual(configuration.errors, []); await configuration.context.close();
        // Skipping never changes configuration or creates sessions, and can be resumed.
        const skipped = await fixture(browser);
        await skipped.page.waitForURL('**/#/setup');
        await skipped.page.locator('#setup-tab').getByRole('button', { name: '暂时跳过', exact: true }).click();
        await skipped.page.waitForURL('**/#/assistant*');
        await skipped.page.goto(base + '/');
        await skipped.page.locator('#pi-assistant-profile option').first().waitFor({ state: 'attached' });
        assert.equal(await skipped.page.locator('#setup-tab').isVisible(), false);
        await skipped.page.locator('[data-setup-entry]').click();
        await skipped.page.locator('#setup-tab').getByRole('button', { name: '连接模型服务', exact: true }).waitFor();
        assert.equal(skipped.writes.length, 0);
        assert.deepEqual(skipped.errors, []); await skipped.context.close();
        // Reading configuration does not trap a user who chooses to skip.
        const slow = await fixture(browser, { slowModels: true });
        await slow.page.waitForURL('**/#/setup');
        await slow.page.locator('#setup-tab').getByRole('button', { name: '暂时跳过', exact: true }).click();
        await slow.page.waitForURL('**/#/assistant*');
        slow.releaseModels();
        await slow.page.locator('#pi-assistant-profile option').first().waitFor({ state: 'attached' });
        assert.equal(await slow.page.locator('#setup-tab').isVisible(), false);
        assert.deepEqual(slow.errors, []); await slow.context.close();
        // A late bootstrap answer must not steal deliberate navigation.
        const late = await fixture(browser, { slowStatus: true });
        await late.page.locator('#workspace-settings-toggle').click();
        const statusResponse = late.page.waitForResponse(response => response.url().endsWith('/api/pi/status'));
        late.releaseStatus(); await statusResponse;
        await late.page.waitForFunction(() => document.querySelector('#pi-project-button')?.disabled === false);
        assert.ok(late.page.url().includes('#/settings'));
        assert.equal(await late.page.locator('#setup-tab').isVisible(), false);
        assert.deepEqual(late.errors, []); await late.context.close();
        // An uncertain creation cannot be replayed by another click or a refresh.
        const unknown = await fixture(browser, { ready: true, uncertain: true, extensionAssistant: false });
        const root = unknown.page.locator('#setup-tab');
        await unknown.page.locator('#pi-setup-model').waitFor();
        await root.getByRole('button', { name: '下一步', exact: true }).click();
        await root.getByRole('heading', { name: '小白', exact: true }).waitFor();
        await root.getByRole('button', { name: '下一步', exact: true }).click();
        await fillProject(unknown.page, false);
        await root.getByRole('button', { name: '下一步', exact: true }).click();
        assert.equal(await root.getByRole('button', { name: '让助手配置 WeKnora', exact: true }).isDisabled(), true, 'configuration remains optional when the extension assistant is unavailable');
        await root.getByRole('button', { name: '开始第一段对话', exact: true }).click();
        await root.locator('[role="status"]').filter({ hasText: '创建结果待核对' }).waitFor();
        assert.equal(await root.getByRole('button', { name: '开始第一段对话', exact: true }).isDisabled(), true);
        await root.getByRole('button', { name: '重新读取配置', exact: true }).click();
        await root.locator('.pi-setup-example').waitFor();
        assert.equal(await root.getByRole('button', { name: '开始第一段对话', exact: true }).isDisabled(), true);
        assert.equal(unknown.writes.filter(write => write.pathname === '/api/pi/sessions').length, 1);
        assert.deepEqual(unknown.errors, []); await unknown.context.close();
        // Explicit bookmarks bypass automatic first-use navigation.
        const direct = await fixture(browser, { hash: '#/chat' });
        await direct.page.waitForFunction(() => window.PiWorkspaceRoute?.current().tab === 'chat');
        assert.equal(await direct.page.locator('#setup-tab').isVisible(), false);
        assert.equal(direct.writes.length, 0);
        assert.deepEqual(direct.errors, []); await direct.context.close();
        console.log('Setup: desktop zh/light + en/dark, settings return, project creation, optional WeKnora draft and configuration return, first session, skip/resume, no model calls, uncertain outcome, bookmarks and pageerrors passed.');
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
