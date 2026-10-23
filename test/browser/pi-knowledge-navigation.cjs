// Real browser modules with synthetic API/WS responses; no live identity or model.
const { selectBrowserTargets } = require('./targets.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cwd = '/fixture/knowledge-navigation';
const profile = { id: '11111111-1111-4111-8111-111111111111', name: 'Knowledge assistant', enabled: true };
const project = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Reference', cwd, profileIds: [profile.id], archived: false };
const session = { id: 'knowledge-thread', cwd, runtimeId: 'knowledge-runtime', name: 'Reference conversation', messageCount: 1,
    agentProfile: profile, assistantProject: { ...project, available: true } };
const model = { provider: 'fixture', id: 'fixture', name: 'Synthetic model', input: ['text'] };
const knowledgeBases = [
    { id: 'kb-standards', name: '工程技术标准', description: '施工规范、技术规程与质量验收标准', document_count: 24 },
    { id: 'kb-policy', name: '项目管理制度', description: '项目流程、资料归档与管理办法', document_count: 18 },
    { id: 'kb-contracts', name: '合同与合规', description: '合同条款与业务合规参考', document_count: 9 }
];

(async () => {
    const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true });
    try {
        for (const [width, locale, theme] of selectBrowserTargets([[1440, 'zh-CN', 'light'], [1280, 'en', 'dark']])) {
            const context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
            const page = await context.newPage(), errors = [], writes = [], commands = [];
            let savedPreferences = { knowledgeBaseIds: [], limit: 5, vectorThreshold: 0.5, keywordThreshold: 0.3 }, preferenceRevision = 1, saveMode = 'ok', legacyBackend = true;
            let startupDisconnected = true, startupChecks = 0;
            page.on('pageerror', error => errors.push(error.message));
            await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.abort());
            await page.addInitScript(({ cwd, theme }) => {
                localStorage.setItem('pi.web.cwd', cwd);
                localStorage.setItem(`pi.web.session:${cwd}`, 'knowledge-thread');
                localStorage.setItem('pi.workspace.theme', theme);
                window.nativeContextEvents = 0;
                window.addEventListener('workspace:native-runtime-changed', () => window.nativeContextEvents++);
            }, { cwd, theme });
            await page.route('**/api/**', route => {
                const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
                const json = value => route.fulfill({ json: value });
                if (request.method() !== 'GET') {
                    const input = request.postDataJSON(); writes.push({ endpoint, input });
                    if (endpoint === '/api/pi/settings/mcp' && input.action === 'knowledge') {
                        if (saveMode === 'conflict') return route.fulfill({ status: 409, json: { error: 'MCP_CHANGED', code: 'MCP_CHANGED' } });
                        savedPreferences = input.knowledgeSettings; preferenceRevision++;
                        if (saveMode === 'unknown') return route.abort();
                        return json({ ok: true, requiresRuntimeRestart: true });
                    }
                    if (endpoint.endsWith('/mcp') && input.action === 'snapshot') return json({ outcome: 'completed', servers: [{ name: 'weknora', state: ++startupChecks === 1 ? 'connecting' : startupDisconnected ? 'disconnected' : 'connected' }] });
                    if (endpoint.endsWith('/mcp') && input.action === 'reconnect') { startupDisconnected = false; return json({ outcome: 'completed', servers: [{ name: 'weknora', state: 'connected' }] }); }
                    if (endpoint.endsWith('/mcp') && input.action === 'knowledge-catalog') return json({ revision: 'catalog-1', servers: startupDisconnected ? [] : [{ name: 'weknora', operations: { bases: 'list_knowledge_bases', search: 'search_knowledge', documents: 'list_documents' } }] });
                    if (endpoint.endsWith('/mcp') && input.action === 'knowledge-read') return json({ value: input.operation === 'bases' ? { knowledge_bases: knowledgeBases } : { results: [{
                        knowledge_id: input.kbId === 'kb-policy' ? 'document-policy' : 'document-standards',
                        title: input.kbId === 'kb-policy' ? '项目资料归档制度' : '施工资料归档规范',
                        content: '工程资料应随施工进度同步整理，分类归档并保留来源记录。引用资料时，应核对适用范围、版本与原文。',
                        source_url: 'https://example.invalid/documents/reference'
                    }] } });
                    return json({ ok: true });
                }
                if (endpoint === '/api/pi/status') return json({ ok: true, agentProfiles: true, assistantProjects: true, nativeResources: true, defaultProject: cwd, projectRoots: ['/fixture'] });
                if (endpoint === '/api/pi/projects') return json({ projects: [{ cwd, name: 'Reference', sessionCount: 1 }], roots: ['/fixture'] });
                if (endpoint === '/api/pi/profiles') return json({ version: 1, revision: 'profiles-1', defaultAssistantId: profile.id, profiles: [profile] });
                if (endpoint === '/api/pi/assistant-projects') return json({ version: 1, revision: 'projects-1', projects: [project] });
                if (endpoint === '/api/pi/sessions' || endpoint.endsWith('/sessions')) return json({ sessions: [session] });
                if (endpoint === '/api/pi/activity') return json({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
                if (endpoint === '/api/pi/settings/mcp') return json({ scope: url.searchParams.get('scope'), revision: `mcp-${preferenceRevision}`, capabilities: legacyBackend ? { native: true } : { native: true, knowledgeSearchSettings: true }, servers: url.searchParams.get('scope') === 'global' ? [{ name: 'weknora', valid: true, enabled: true, ...(!legacyBackend ? { knowledgeSettings: { supported: true, valid: true, value: savedPreferences } } : {}) }] : [], trust: { effective: false } });
                if (endpoint === '/api/pi/settings/native/resources') return json({ cwd, revision: 'resources-1', packages: [], resources: [], trust: { effective: false } });
                return json(endpoint === '/api/prompts' || endpoint.includes('history') ? [] : {});
            });
            await page.routeWebSocket('**/api/pi/ws', socket => socket.onMessage(async raw => {
                const input = JSON.parse(raw); commands.push(input.type);
                if (input.type === 'open_session') await new Promise(resolve => setTimeout(resolve, 150));
                const state = { model, isStreaming: false, thinkingLevel: 'off', webShell: { runtimeId: session.runtimeId, revision: 1, busy: false } };
                const data = input.type === 'open_session' ? { session, state,
                    messages: { messages: [] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } }
                    : input.type === 'get_state' ? state : {};
                socket.send(JSON.stringify({ type: 'response', id: input.id, command: input.type, success: true, data }));
            }));
            // A restart restores the saved native session after the knowledge panel
            // is already open. It must load without a manual refresh or a chat visit.
            await page.goto(`${process.env.PI_KNOWLEDGE_NAVIGATION_URL}/#/extensions?tab=knowledge`, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.getElementById('pi-input')?.disabled === false);
            await page.getByRole('checkbox', { name: knowledgeBases[0].name, exact: true }).waitFor({ timeout: 3000 });
            assert.equal(writes.filter(write => write.input.operation === 'bases').length, 1, 'cold knowledge entry loads after native session restoration');
            assert.equal(commands.filter(type => type === 'open_session').length, 1, 'restoration uses one managed session');
            assert.equal(writes.filter(write => write.input.action === 'reconnect').length, 1, 'a disconnected configured service connects once after startup settles');
            assert.ok(await page.evaluate(() => nativeContextEvents > 0), 'the real chat host publishes runtime readiness');
            assert.equal(commands.filter(type => type === 'prompt').length, 0);
            await page.goto(`${process.env.PI_KNOWLEDGE_NAVIGATION_URL}/#/assistant?profileId=${profile.id}&projectId=${project.id}&sessionId=${session.id}`, { waitUntil: 'domcontentloaded' });
            writes.length = 0;
            await page.waitForFunction(() => document.getElementById('pi-input')?.disabled === false);
            await page.locator('#pi-input').fill('Retained assistant draft');
            await page.locator('#pi-file-input').setInputFiles({ name: 'reference.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic reference') });
            await page.waitForFunction(() => document.querySelectorAll('#pi-attachments .pi-attachment-chip').length === 1 && document.getElementById('pi-attachments').getAttribute('aria-busy') === 'false');
            await page.evaluate(() => window.PiWorkspaceRoute.navigate('extensions', { tab: 'knowledge' }));
            await page.locator('.knowledge-base.active').waitFor();
            await page.getByRole('checkbox', { name: knowledgeBases[0].name, exact: true }).waitFor();
            assert.equal(writes.filter(write => write.input.operation === 'bases').length, 1, 'connected knowledge bases load automatically');
            await page.locator('.knowledge-preferences > summary').click();
            assert.match(await page.locator('.knowledge-preferences').innerText(), locale === 'en' ? /backend.*restart|Restart.*backend/i : /后端.*重启|重启.*后端/, 'an older backend must not be misreported as a custom MCP service');
            assert.equal(await page.locator('.knowledge-preference-fields').isVisible(), false);
            legacyBackend = false;
            await page.getByRole('button', { name: locale === 'en' ? 'Check settings again' : '重新检查设置', exact: true }).click();
            await page.getByRole('checkbox', { name: knowledgeBases[0].name, exact: true }).waitFor();
            assert.equal(await page.locator('.knowledge-preference-fields').isVisible(), true, 'settings appear once the backend reports support');
            await page.locator('.knowledge-preferences > summary').click();
            await page.getByRole('checkbox', { name: knowledgeBases[0].name, exact: true }).check();
            await page.getByRole('checkbox', { name: knowledgeBases[1].name, exact: true }).check();
            const keywords = page.getByRole('searchbox', { name: locale === 'en' ? 'Search keywords' : '检索关键词', exact: true });
            await keywords.fill('制度');
            await page.getByRole('button', { name: locale === 'en' ? 'Search knowledge base' : '搜索知识库', exact: true }).click();
            await page.waitForFunction(() => document.querySelectorAll('.knowledge-result').length === 2);
            assert.deepEqual(writes.filter(write => write.input.operation === 'search').map(write => write.input.kbId), ['kb-standards', 'kb-policy']);
            assert.equal(await page.getByRole('button', { name: locale === 'en' ? 'Browse documents' : '浏览文档', exact: true }).isDisabled(), true);
            assert.equal(await page.locator('.knowledge-search button').count(), 1);
            assert.equal(await page.locator('.knowledge-base textarea').count(), 0);
            await page.locator('.knowledge-preferences > summary').click();
            await page.getByRole('button', { name: locale === 'en' ? 'Use selected knowledge bases' : '使用左侧已选范围', exact: true }).click();
            const recall = page.getByRole('spinbutton', { name: /每库召回条数|Results per knowledge base/ });
            await recall.fill('8');
            await page.getByRole('spinbutton', { name: /向量匹配阈值|Vector match threshold/ }).fill('0.8');
            await page.getByRole('spinbutton', { name: /关键词匹配阈值|Keyword match threshold/ }).fill('0.45');
            const save = page.getByRole('button', { name: locale === 'en' ? 'Save search settings' : '保存检索设置', exact: true });
            await save.dblclick();
            await page.locator('.knowledge-settings-feedback').filter({ hasText: locale === 'en' ? 'Saved.' : '已保存' }).waitFor();
            const saves = () => writes.filter(write => write.input.action === 'knowledge');
            assert.equal(saves().length, 1, 'double click saves a preference batch only once');
            assert.deepEqual(saves()[0].input, { cwd, scope: 'global', expectedRevision: 'mcp-1', confirmed: true, action: 'knowledge', name: 'weknora', knowledgeSettings: { knowledgeBaseIds: ['kb-standards', 'kb-policy'], limit: 8, vectorThreshold: 0.8, keywordThreshold: 0.45 } });
            assert.equal(await save.isDisabled(), true, 'saved values are not resubmitted');
            if (process.env.PIVANE_TEST_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, `knowledge-settings-${locale}-${width}.png`), fullPage: true });
            saveMode = 'conflict'; await recall.fill('9'); await save.click();
            await page.locator('.knowledge-settings-feedback').filter({ hasText: locale === 'en' ? 'Configuration changed' : '配置已变化' }).waitFor();
            assert.equal(await save.isDisabled(), true);
            await page.locator('.knowledge-connection-tools').evaluate(el => { el.open = true; });
            await page.getByRole('button', { name: locale === 'en' ? 'Refresh configuration and tools' : '刷新配置与工具', exact: true }).click();
            await page.getByRole('checkbox', { name: knowledgeBases[0].name, exact: true }).waitFor();
            assert.equal(await recall.inputValue(), '8', 'refresh restores the actual saved value after a rejected save');
            saveMode = 'unknown'; await recall.fill('9'); await save.click();
            await page.locator('.knowledge-settings-feedback').filter({ hasText: locale === 'en' ? 'outcome is unconfirmed' : '保存结果未确认' }).waitFor();
            assert.equal(await save.isDisabled(), true);
            await page.waitForTimeout(80); assert.equal(saves().length, 3, 'an uncertain save is never replayed');
            saveMode = 'ok';
            await page.getByRole('button', { name: locale === 'en' ? 'Refresh configuration and tools' : '刷新配置与工具', exact: true }).click();
            await page.getByRole('checkbox', { name: knowledgeBases[0].name, exact: true }).waitFor();
            assert.equal(await recall.inputValue(), '9', 'refresh checks whether the uncertain save committed');
            await page.locator('.knowledge-preferences > summary').click();
            await page.locator('.knowledge-connection-tools').evaluate(el => { el.open = false; });
            const bounds = await page.locator('.knowledge-base').evaluate(root => ({ viewport: innerWidth, overflow: [...root.querySelectorAll('input, select, button')].filter(el => el.getClientRects().length && el.getBoundingClientRect().right > innerWidth + 1).length }));
            assert.equal(bounds.viewport, width); assert.equal(bounds.overflow, 0);
            if (process.env.PIVANE_TEST_SCREENSHOT_DIR) {
                fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true });
                await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, `knowledge-navigation-${locale}-${width}.png`) });
            }
            const priorWrites = writes.length, priorPrompts = commands.filter(type => type === 'prompt').length;
            await page.getByRole('button', { name: locale === 'en' ? 'Go to assistant' : '前往助手对话', exact: true }).click();
            await page.waitForFunction(() => window.PiWorkspaceRoute.current().tab === 'assistant' && document.getElementById('pi-input')?.disabled === false);
            assert.equal(await page.locator('#chat-tab.active').isVisible(), true);
            assert.equal(await page.locator('#workspace-settings-dialog').isVisible(), false);
            assert.equal(await page.locator('#pi-input').inputValue(), 'Retained assistant draft');
            assert.equal(await page.locator('#pi-attachments .pi-attachment-chip').count(), 1);
            assert.equal(await page.locator('#pi-assistant-profile').inputValue(), profile.id);
            assert.equal(writes.length, priorWrites, 'navigation does not read knowledge or create another session');
            assert.equal(commands.filter(type => type === 'prompt').length, priorPrompts, 'navigation does not send a question');
            assert.deepEqual(errors, []);
            await context.close();
            console.log(`knowledge navigation ${width}/${locale}/${theme}: PASS`);
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
