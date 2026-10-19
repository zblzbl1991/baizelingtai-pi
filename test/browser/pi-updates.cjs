const { selectBrowserTargets, browserTargetEnabled } = require('./targets.cjs');
const assert = require('node:assert/strict');
const { selectMessageView } = require('./pi-mobile-view-helper.cjs');
const express = require('express');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const cwd = '/fixture/updates';
const session = { id: 'updates-fixture', cwd, name: 'Fixture conversation', messageCount: 2 };
const model = { provider: 'fixture', id: 'fixture-model', name: 'Fixture', input: ['text', 'image'], contextWindow: 32000, available: true, thinkingLevels: ['off'] };
const empty = () => ({ appVersion: '1.0.0-rc.2', piVersion: '0.85.0', bundledPiVersion: '0.85.0', dependencyMatches: true,
    channel: 'preview', platform: 'linux', checkedAt: null,
    pivane: { status: 'unchecked', releasesUrl: 'https://github.com/zblzbl1991/baizelingtai-pi/releases' },
    pi: { status: 'unchecked', releasesUrl: 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent' } });
async function run(browser, base, width, language) {
    if (!browserTargetEnabled(width)) return;
    const english = language === 'en-US';
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: language, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = [], writes = [], rpc = [];
    let mode = 'success', hold, releaseResponse;
    let noticeState = { enabled: false, available: false, eligible: false, idle: true, currentVersion: '0.85.0', version: '0.86.0', nextCheckAt: Date.now() + 86400000 };
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ cwd }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'updates-fixture'); }, { cwd });
    await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, r => r.abort());
    await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') writes.push(url.pathname);
        let data = {};
        if (url.pathname === '/api/pi/settings/updates/notifications') return route.fulfill({ json: noticeState });
        if (url.pathname.startsWith('/api/pi/settings/updates')) {
            if (url.pathname.includes('/review') || url.pathname.includes('/execute') || url.pathname.includes('/maintenance')) throw Error('Maintenance UI must not call maintenance endpoints');
            if (mode === 'old') return route.fulfill({ status: 404, json: { error: 'Not found' } });
            if (request.method() === 'GET') return route.fulfill({ json: empty() });
            if (hold) await hold;
            data = empty(); data.checkedAt = '2026-09-12T00:00:00Z';
            data.pi = { ...data.pi, version: '0.86.0', status: 'available' };
            data.pivane = mode === 'error' ? { ...data.pivane, status: 'error' } : mode === 'empty' ? { ...data.pivane, status: 'no-release' } : {
                status: 'available', version: '1.0.0-rc.10', prerelease: true,
                releasesUrl: 'https://github.com/zblzbl1991/baizelingtai-pi/releases/tag/v1.0.0-rc.10',
                downloadUrl: 'https://github.com/zblzbl1991/baizelingtai-pi/releases/download/v1.0.0-rc.10/pivane-1.0.0-rc.10.tar.gz',
                checksumUrl: 'https://github.com/zblzbl1991/baizelingtai-pi/releases/download/v1.0.0-rc.10/pivane-1.0.0-rc.10.tar.gz.sha256' };
            if (mode.startsWith('intranet')) {
                data.source = { type: 'manifest', origin: 'http://gitlab.example:8080', url: 'http://gitlab.example:8080/api/v4/projects/team%2Fbaizelingtai/repository/files/updates%2Flatest.json/raw?ref=HEAD' };
                data.pivane = { version: '1.8.0', status: 'available', packageFormat: 'windows-portable-zip', sha256: 'a'.repeat(64),
                    bytes: 1234,
                    releasesUrl: 'http://gitlab.example:8080/team/baizelingtai/-/releases/v1.8.0',
                    downloadUrl: 'http://gitlab.example:8080/api/v4/projects/20/packages/generic/baizelingtai/1.8.0/baizelingtai-1.8.0.zip' };
                data.pi = { version: '1.1.0', status: 'available', bundled: true, releasesUrl: data.pivane.releasesUrl };
                noticeState = { ...noticeState, supported: false, enabled: false, available: false };
                if (mode === 'intranet-error') {
                    const releasesUrl = 'http://gitlab.example:8080/team/baizelingtai/-/releases';
                    data.pivane = { status: 'error', releasesUrl };
                    data.pi = { status: 'error', bundled: true, releasesUrl };
                }
            }
        } else if (url.pathname === '/api/pi/status') data = { ok: true, updateChecks: true, projectRoots: ['/fixture'], defaultProject: cwd };
        else if (url.pathname === '/api/pi/projects') data = { roots: ['/fixture'], projects: [{ cwd, name: 'Fixture', sessionCount: 1 }] };
        else if (url.pathname === '/api/pi/sessions') data = { sessions: [session] };
        else if (url.pathname === '/api/pi/activity') data = { runtimes: [], replyNotices: [], pinnedProjects: [], hiddenProjects: [] };
        else if (url.pathname === '/api/pi/settings/models') data = { models: [model], providers: [{ id: 'fixture', name: 'Fixture', configured: true, authMethods: {} }], customProviders: [], preferences: {} };
        else if (url.pathname === '/api/pi/settings/session-titles') data = { enabled: false };
        else if (url.pathname.endsWith('/history')) data = [];
        return route.fulfill({ json: data });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const command = JSON.parse(raw); rpc.push(command.type);
        const state = { model, isStreaming: false, thinkingLevel: 'off' };
        let data = {};
        const messages = [{ role: 'user', content: [{ type: 'text', text: 'Fixture question' }] },
            { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: '/fixture/example.txt' } }] },
            { role: 'toolResult', toolCallId: 't1', toolName: 'read', isError: false, content: [{ type: 'text', text: 'Fixture tool output' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'Fixture reply' }], stopReason: 'stop' }];
        if (command.type === 'open_session') data = { session, state, messages: { messages }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
        else if (command.type === 'get_state') data = state;
        else if (command.type === 'get_messages') data = { messages };
        else if (command.type === 'get_available_models') data = { models: [model] };
        else if (command.type === 'get_available_thinking_levels') data = { levels: ['off'] };
        ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
    }));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('pi-input').disabled);
    await page.locator('#pi-input').fill('Unsent update discussion');
    await page.locator('#pi-file-input').setInputFiles({ name: 'update-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic data') });
    await page.locator('#pi-attachments .pi-attachment-chip').first().waitFor();
    await selectMessageView(page, 'full');
    await page.locator('.pi-tool-row summary').first().click();
    assert.equal(await page.locator('.pi-tool-output').textContent(), 'Fixture tool output');
    await page.locator('#workspace-settings-toggle').click(); await page.locator('[data-settings-tab="updates"]').click();
    await page.locator('#updates-check').waitFor();
    assert.equal(await page.locator('#settings-updates-panel h3').textContent(), english ? 'Versions and updates' : '版本与更新');
    assert.equal(await page.locator('#updates-channel, #updates-install-pivane, #maintenance-update, #maintenance-backup, #maintenance-restart').count(), 0);
    assert.equal(await page.locator('#settings-updates-panel .network-settings-link, #settings-updates-panel a[href*="section=proxy"]').count(), 0);
    await page.locator('#updates-pivane [data-state="available"]').waitFor();
    assert.ok(writes.filter(path => path === '/api/pi/settings/updates/check').length <= 1, 'initial visit checks once if uncached');
    assert.ok((await page.locator('#updates-pivane').innerText()).includes('1.0.0-rc.10'));
    assert.equal(await page.locator('#updates-pi').isVisible(), false);
    await page.locator('#updates-engine-details summary').click();
    assert.ok((await page.locator('#updates-pi').innerText()).includes('0.86.0'));
    assert.equal(await page.locator('#updates-pivane a[href$=".tar.gz"]').count(), 0);
    assert.equal(await page.locator('#updates-pivane a[href$=".sha256"]').count(), 0);
    assert.equal(await page.locator('#updates-pivane a[href*="github.com"]').isVisible(), false);
    assert.equal(await page.locator('#updates-agent-guide').isVisible(), false);
    assert.equal(await page.locator('#updates-agent-guide summary').isVisible(), false);
    assert.equal(await page.locator('#updates-copy-prompt').isVisible(), false);
    const prompt = await page.locator('#updates-agent-prompt').inputValue();
    assert.ok((await page.locator('#updates-pivane h4').textContent()).includes('白泽灵台'));
    assert.ok(prompt.includes('白泽灵台') && !prompt.includes('Pivane'));
    assert.ok(prompt.includes('UPDATES.md') && prompt.includes('INSTALL_RECOVERY.md'));
    assert.ok(!prompt.includes('https://github.com'), 'update prompt must not hard-code an external repository');
    assert.ok(prompt.includes(english ? 'independent Agent' : '独立 Agent'));
    assert.ok(prompt.includes(english ? 'existing authorization' : '已有授权'));
    assert.ok(prompt.includes(english ? 'stop or restart the service hosting' : '不要停止或重启承载当前对话的服务'));
    const overflow = async () => {
        const metrics = await page.evaluate(() => [...document.querySelectorAll('.workspace-settings-dialog, .workspace-settings-body, .workspace-settings-content, .workspace-settings-nav, #settings-updates-panel, #settings-updates-panel *')].filter(e => e.clientWidth).map(e => ({ id: e.id || e.className || e.tagName, client: e.clientWidth, scroll: e.scrollWidth })));
        for (const m of metrics) assert.ok(m.scroll <= m.client + 1, `${language}/${width}: ${JSON.stringify(m)}`);
    };
    for (const theme of ['daylight', 'mint', 'dark']) { await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await overflow(); }
    if (width < 600) assert.ok(await page.locator('#updates-agent-prompt').evaluate(e => parseFloat(getComputedStyle(e).fontSize)) >= 16);
    await page.screenshot({ path: path.join(process.env.PI_BROWSER_ARTIFACT_DIR || os.tmpdir(), `pivane-updates-${language}-${width}.png`) });
    // A delayed check cannot overwrite the reopened view or change the prompt.
    hold = new Promise(resolve => { releaseResponse = resolve; });
    const checkingRequest = page.waitForRequest(r => r.url().endsWith('/settings/updates/check'));
    await page.locator('#updates-check').click(); await checkingRequest;
    await page.waitForFunction(() => document.getElementById('updates-check').disabled);
    assert.equal(await page.locator('#updates-engine-details').evaluate(e => e.open), true);
    await page.locator('#workspace-settings-close').click(); await page.locator('#workspace-settings-toggle').click();
    await page.waitForFunction(() => !document.getElementById('updates-check').disabled);
    const lateResponse = page.waitForResponse(r => r.url().endsWith('/settings/updates/check'));
    releaseResponse(); hold = null; await lateResponse;
    assert.equal(await page.locator('#updates-pivane [data-state="unchecked"]').count(), 1);
    assert.equal(await page.locator('#updates-pivane a[href*="github.com"]').isVisible(), false);
    mode = 'error'; await page.locator('#updates-check').click(); await page.locator('#updates-pivane [data-state="error"]').waitFor();
    assert.equal(await page.locator('#updates-pi [data-state="available"]').count(), 1);
    mode = 'empty'; await page.locator('#updates-check').click(); await page.locator('#updates-pivane [data-state="no-release"]').waitFor();
    mode = 'intranet'; await page.locator('#updates-check').click(); await page.locator('#updates-source').waitFor();
    assert.equal(await page.locator('#updates-agent-guide').isVisible(), false);
    assert.ok((await page.locator('#updates-source').textContent()).includes('http://gitlab.example:8080'));
    const zip = page.locator('#updates-pivane a[href$="baizelingtai-1.8.0.zip"]');
    assert.equal(await zip.textContent(), english ? 'Download Windows ZIP' : '下载 Windows ZIP');
    assert.equal(await zip.getAttribute('href'), 'http://gitlab.example:8080/api/v4/projects/20/packages/generic/baizelingtai/1.8.0/baizelingtai-1.8.0.zip');
    assert.equal(await zip.getAttribute('rel'), 'noopener noreferrer');
    assert.ok((await page.locator('#updates-package-hash').textContent()).includes('a'.repeat(64)));
    assert.ok((await page.locator('#updates-pi').textContent()).includes(english ? 'Bundled version' : '整包配套版本'));
    const intranetPrompt = await page.locator('#updates-agent-prompt').inputValue();
    assert.ok(intranetPrompt.includes('http://gitlab.example:8080/api/v4/projects/team%2Fbaizelingtai/repository/files/updates%2Flatest.json/raw?ref=HEAD'));
    for (const field of ['latest.json', 'SemVer', 'version', 'package', 'bytes', 'sha256']) assert.ok(intranetPrompt.includes(field));
    assert.ok(intranetPrompt.includes(english ? 'stop if there is no newer release' : '没有新版就结束'));
    assert.ok(intranetPrompt.includes(english ? 'verification mismatches' : '校验不符'));
    for (const cached of ['1.0.0-rc.2', '1.8.0', '1.1.0', '1234', 'a'.repeat(64)]) assert.ok(!intranetPrompt.includes(cached), 'prompt must read fresh target values from the manifest');
    assert.ok(intranetPrompt.length < (english ? 1400 : 650), 'manifest-first prompt stays concise');
    assert.ok(intranetPrompt.includes(english ? 'original absolute data paths' : '原数据绝对路径'));
    assert.ok(intranetPrompt.includes(english ? 'back up' : '备份') && intranetPrompt.includes(english ? 'roll back' : '回退'));
    assert.ok(intranetPrompt.includes(english ? 'existing authorization' : '已有授权'));
    assert.ok(intranetPrompt.includes(english ? 'pause schedules' : '暂停预约'));
    assert.ok(!intranetPrompt.includes('https://github.com/YogurtJ/pivane'));
    await page.waitForFunction(() => document.getElementById('updates-auto-check').closest('section').hidden);
    await overflow();
    await page.screenshot({ path: path.join(process.env.PI_BROWSER_ARTIFACT_DIR || os.tmpdir(), `pivane-intranet-updates-${language}-${width}.png`) });
    mode = 'intranet-error'; await page.locator('#updates-check').click(); await page.locator('#updates-pivane [data-state="error"]').waitFor();
    assert.equal(await page.locator('#updates-agent-guide').isVisible(), false);
    assert.equal(await page.locator('#updates-pivane a').getAttribute('href'), 'http://gitlab.example:8080/team/baizelingtai/-/releases');
    const unverified = await page.locator('#updates-agent-prompt').inputValue();
    assert.equal(unverified, intranetPrompt, 'check failures must retain the same manifest-first prompt');
    assert.ok(!unverified.includes('a'.repeat(64)) && !unverified.includes('baizelingtai-1.8.0.zip'));
    assert.ok(!unverified.includes('https://github.com'));
    assert.ok(unverified.includes(english ? 'without automatic retries' : '不自动重试'));
    mode = 'old'; await page.locator('[data-settings-tab="providers"]').click(); await page.locator('[data-settings-tab="updates"]').click();
    await page.waitForFunction(() => document.getElementById('updates-feedback')?.textContent.includes('稍后') || document.getElementById('updates-feedback')?.textContent.includes('later'));
    await page.locator('#workspace-settings-close').click();
    assert.equal(await page.locator('#pi-input').inputValue(), 'Unsent update discussion');
    assert.ok((await page.locator('#pi-attachments').innerText()).includes('update-notes.txt'));
    assert.ok(writes.every(p => ['/api/pi/settings/updates/check', '/api/pi/settings/updates/notifications'].includes(p)));
    assert.ok(!rpc.includes('prompt') && !rpc.includes('abort') && !rpc.includes('restart_runtime'));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ language, width, errors, readOnly: true, draftsPreserved: true }));
    await context.close();
}
(async () => {
    const app = express();
    for (const [name, dir] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', dir)));
    app.use(express.static(path.join(root, 'public')));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try { for (const language of ['zh-CN', 'en-US']) for (const width of selectBrowserTargets([320, 393, 1024, 1440])) await run(browser, `http://127.0.0.1:${server.address().port}`, width, language); }
    finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
