// 完整合成链路 E2E：真实浏览器 → 真实 HTTP/聊天 WS（gateway.attachWebSocket）→ 唯一受管 worker
// → 本地 SSE 合成供应商 → 合规工具 → 私密账本/原生会话 → 报告 → 原生交付 → 成果中心。
// 替代边界仅三处：供应商网络→本地 SSE stub、
// Google Fonts 屏蔽、本脚本声明的时间等待；不 mock 任何 /api 业务端点，不改既有专项脚本。
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), { randomUUID, createHash } = require('node:crypto'), express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { selectBrowserTargets } = require('./targets.cjs');
const root = path.resolve(__dirname, '../..'), temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-compliance-fullchain-')));
const agent = path.join(temporary, 'agent'), cwd = path.join(temporary, 'project'), mediaData = path.join(temporary, 'media-data');
fs.mkdirSync(agent); fs.mkdirSync(cwd); fs.mkdirSync(mediaData);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = temporary; process.env.PI_OFFLINE = '1';
process.env.PI_WEB_DEFERRED_FILE = path.join(agent, 'deferred.json'); process.env.PI_MEDIA_DATA_DIR = mediaData; process.env.PI_MEDIA_PROFILE = 'clean';
process.env.PI_MEDIA_CONFIG_DIR = path.join(temporary, 'media-config');

const models = [{ provider: 'fixture', id: 'text', name: '文本样例', input: ['text'], available: true }, { provider: 'fixture', id: 'vision', name: '图像样例', input: ['text', 'image'], available: true }];
const providerCalls = []; // 每个供应商请求 payload；资格与计数断言的数据源
let holdRecognitions = 0, releaseHeldRecognitions = [], recognitionFields = null;
const isRecognition = body => Array.isArray(body.messages?.at(-1)?.content) && body.messages.at(-1).content.some(part => part.type === 'image_url');
const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); providerCalls.push(body);
    if (isRecognition(body)) {
        if (holdRecognitions > 0) { holdRecognitions--; await new Promise(resolve => { releaseHeldRecognitions.push(resolve); }); }
        const fields = recognitionFields ?? [{ key: 'date', raw: '2026-03-01', status: 'known', excerpt: '签订日期：2026-03-01', rect: [0, 0, 90, 20] }];
        var delta = { role: 'assistant', content: JSON.stringify({ fields }) };
        var finish = 'stop';
    } else {
        const user = body.messages?.findLast?.(message => message.role === 'user');
        var delta = { role: 'assistant', content: 'Fixture complete.' }; var finish = 'stop';
        if (user && JSON.stringify(user).includes('fixture review submit')) {
            delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'review-submit-' + providerCalls.length, type: 'function', function: { name: 'compliance_review', arguments: JSON.stringify({ action: 'submit-confirm', requestId: 'fixture-submit-' + providerCalls.length }) } }] };
            finish = 'tool_calls';
        }
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    res.end('data: [DONE]\n\n');
});

const token = 'synthetic-fullchain-' + randomUUID();
fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'text', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: 'http://127.0.0.1:0/v1', api: 'openai-completions', apiKey: 'synthetic', models: models.map(m => ({ id: m.id, name: m.name, input: m.input, contextWindow: 32000, maxTokens: 1000 })) } } }));
const { WorkspaceAccessService } = require('../../server/workspace-access-service');
const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => token });
const gateway = require('../../server/pi-agent-routes').createPiAgentGateway({ accessService: access, deferredFilePath: path.join(agent, 'deferred.json'), cronFilePath: path.join(agent, 'cron.sqlite') });
const { compliance: service, store } = gateway;

// 默认生成固定哈希的合成样本；外部样本目录仍须提供 MANIFEST.sha256。
const samplesDir = process.env.COMPLIANCE_FULLCHAIN_SAMPLES || require('../compliance-full-chain-fixtures.cjs').writeSamples(path.join(temporary, 'source-samples'));
const sampleHashes = Object.fromEntries(fs.readFileSync(path.join(samplesDir, 'MANIFEST.sha256'), 'utf8').trim().split('\n').map(line => { const [hash, name] = line.split(/\s+/); return [name, hash]; }));
const fixtureDir = path.join(temporary, 'samples'); fs.mkdirSync(fixtureDir);
for (const name of fs.readdirSync(samplesDir)) {
    if (!fs.statSync(path.join(samplesDir, name)).isFile() || name === 'generate-samples.cjs' || name === 'MANIFEST.sha256') continue;
    const bytes = fs.readFileSync(path.join(samplesDir, name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sampleHashes[name], 'sample integrity: ' + name);
    fs.writeFileSync(path.join(fixtureDir, name), bytes);
}
const sample = name => path.join(fixtureDir, name);

let revision = 0;
const api = async (method, route, body, origin) => {
    const res = await fetch(origin + '/api/pi' + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (Number.isSafeInteger(data.revision)) revision = data.revision;
    return { status: res.status, data };
};
const write = async (route, body = {}, method = 'POST', origin) => api(method, route, { requestId: randomUUID(), expectedRevision: revision, ...body }, origin);

const records = [];
const record = (caseId, status, detail) => { records.push({ caseId, status, detail: String(detail).slice(0, 300) }); console.log(`fullchain [${caseId}] ${status}: ${detail}`); };
const noticeLine = '项目名称,项目编号,日期\n示例工程甲,P-001,2026-03-01\n';
const contractLine = date => '项目名称,项目编号,日期\n示例工程甲,P-001,' + date + '\n';
const contractCsv = (name, date) => { const target = path.join(fixtureDir, name); fs.writeFileSync(target, contractLine(date)); return target; };

// Observe the browser's own cold session opening; never prewarm or send another RPC.
function observeNativeSession(page) {
    const opened = new Map();
    page.on('websocket', socket => {
        if (new URL(socket.url()).pathname !== '/api/pi/ws') return;
        const pending = new Map();
        socket.on('framesent', frame => {
            try {
                const command = JSON.parse(frame.payload.toString());
                if (command.type === 'open_session') pending.set(command.id, command.sessionId);
            } catch { /* Ignore frames outside the JSON RPC protocol. */ }
        });
        socket.on('framereceived', frame => {
            try {
                const response = JSON.parse(frame.payload.toString());
                if (response.type !== 'response' || response.command !== 'open_session' || !pending.has(response.id)) return;
                opened.set(pending.get(response.id), response); pending.delete(response.id);
            } catch { /* Ignore frames outside the JSON RPC protocol. */ }
        });
    });
    return async sessionId => {
        const deadline = Date.now() + 180000;
        while (!opened.has(sessionId) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
        const response = opened.get(sessionId);
        assert.ok(response, 'the requested session must produce its own native open response');
        assert.equal(response.success, true);
        assert.equal(response.data?.session?.id, sessionId);
        await page.waitForFunction(id => window.PiNativeRuntime?.context?.().sessionId === id
            && document.getElementById('pi-input')?.disabled === false, sessionId);
    };
}

async function chatReply(page, message) {
    const before = providerCalls.length;
    await page.locator('#pi-input').fill(message);
    await page.locator('#pi-input').press('Enter');
    await page.waitForFunction(() => document.body.innerText.includes('Fixture complete.'), null, { timeout: 90000 });
    return providerCalls.length - before;
}

async function runCombo(browser, origin, { width, mode, lang, first, ordinarySessionId }) {
    const label = `${width}-${lang}-${mode}`;
    let d2BatchId = '', scanCanvas = null;
    const context = await browser.newContext({ locale: lang === 'en' ? 'en-US' : 'zh-CN', viewport: { width, height: width < 900 ? 852 : 1000 }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [];
    const nativeSessionReady = observeNativeSession(page);
    page.setDefaultTimeout(60000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, token, theme }) => {
        if (window.top !== window.self) return;
        localStorage.setItem('pi.web.cwd', cwd); sessionStorage.setItem('pi.web.token', token); localStorage.setItem('pi.workspace.theme', theme);
    }, { cwd, token, theme: width < 900 ? 'dark' : 'daylight' });
    if (width < 900) await page.addInitScript(() => { if (window.top !== window.self) return; Object.defineProperty(crypto, 'randomUUID', { value: undefined }); Object.defineProperty(crypto, 'subtle', { value: undefined }); });
    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.abort());
    const screenshot = name => page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR || os.tmpdir(), `fullchain-${label}-${name}.png`) });
    // 引擎更新提示浮层会拦截抽屉头部按钮的点击；按真实用户方式先关闭（纯客户端隐藏）
    const dismissUpdateNotice = async () => { const button = page.locator('#pi-update-notice-close'); if (await button.isVisible().catch(() => false)) await button.click().catch(() => {}); };
    try {
        await page.goto(origin + '/#/settings?tab=builtins', { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.locator('#compliance-enabled').waitFor({ state: 'visible' });
        await dismissUpdateNotice();
        if (first) {
            // A1 默认关闭
            assert.equal(await page.locator('#compliance-enabled').isChecked(), false);
            record('A1', 'passed', 'fresh instance starts disabled');
            // A2 启用不自动检查
            await page.locator('#compliance-enabled').check();
            await page.locator('#compliance-main-model').selectOption('fixture/text');
            const callsBeforeEnable = providerCalls.length;
            await page.locator('#compliance-save').click();
            await page.waitForFunction(() => document.querySelector('#compliance-settings-status')?.textContent.includes('已启用'));
            assert.equal(providerCalls.length, callsBeforeEnable, 'enabling and saving must not trigger any model request');
            record('A2', 'passed', 'enable+save triggered zero provider calls');
            console.log(`fullchain ${label}: A1 default-off, A2 enable-without-checks passed`);
        } else {
            await page.waitForFunction(() => document.querySelector('#compliance-settings-status')?.textContent.includes('已启用') || document.querySelector('#compliance-open-chat'));
        }
        // A3 专用聊天资格（真实 WS + 受管 worker + 供应商 payload）
        await page.locator('#compliance-open-chat').click();
        await page.locator('#pi-compliance-open').waitFor({ state: 'visible' });
        await page.locator('#pi-input').waitFor({ state: 'visible' });
        const dedicated = (await api('GET', '/sessions?cwd=' + encodeURIComponent(cwd), undefined, origin)).data.sessions;
        const dedicatedSession = dedicated.find(session => session.agentProfile?.id);
        assert.ok(dedicatedSession, 'dedicated compliance session exists');
        await nativeSessionReady(dedicatedSession.id);
        const callsBeforeDedicated = providerCalls.length;
        const dedicatedCalls = await chatReply(page, '资格检查 fixture');
        assert.ok(dedicatedCalls >= 1, 'dedicated chat reaches the synthetic provider');
        const dedicatedPayload = providerCalls.at(-1);
        assert.ok(JSON.stringify(dedicatedPayload.tools).includes('compliance_project'), 'dedicated chat requests carry compliance tools');
        assert.ok(JSON.stringify(dedicatedPayload.messages).includes('compliance-materials'), 'dedicated chat carries compliance skill index');
        // A3 普通聊天对比：独立上下文打开普通会话，实际供应商请求不得新增合规资源
        const normalContext = await browser.newContext({ locale: lang === 'en' ? 'en-US' : 'zh-CN', viewport: { width, height: width < 900 ? 852 : 1000 }, isMobile: width < 900, hasTouch: width < 900 });
        const normalPage = await normalContext.newPage();
        const normalSessionReady = observeNativeSession(normalPage);
        await normalPage.addInitScript(({ cwd, token, sessionId }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, sessionId); sessionStorage.setItem('pi.web.token', token); }, { cwd, token, sessionId: ordinarySessionId });
        await normalPage.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.abort());
        await normalPage.goto(origin + '/#/chat?' + new URLSearchParams({ cwd, sessionId: ordinarySessionId }), { waitUntil: 'domcontentloaded', timeout: 120000 });
        await normalSessionReady(ordinarySessionId);
        const normalBefore = providerCalls.length;
        await normalPage.locator('#pi-input').fill('普通资格检查 fixture');
        await normalPage.locator('#pi-input').press('Enter');
        await normalPage.waitForFunction(() => document.body.innerText.includes('Fixture complete.'), null, { timeout: 90000 });
        // 多会话并发请求同一供应商：按消息内容定位普通聊天请求，不用 at(-1)；
        // 若普通上下文误开专用会话，该请求会携带合规工具与技能索引，仍会被下两行断言拦住。
        const normalPayload = providerCalls.filter(body => JSON.stringify(body.messages).includes('普通资格检查 fixture')).at(-1);
        assert.ok(normalPayload, 'normal chat request reached the provider');
        assert.ok(!(JSON.stringify(normalPayload.tools) || '').includes('compliance_project'), 'normal chat must not carry compliance tools');
        assert.ok(!(JSON.stringify(normalPayload.messages) || '').includes('compliance-materials'), 'normal chat must not carry compliance skill index');
        await normalContext.close();
        record('A3', 'passed', `dedicated payload carries compliance_project/skills; normal chat payload excludes both (${providerCalls.length - normalBefore} call)`);
        console.log(`fullchain ${label}: A3 dedicated qualification passed`);
        await dismissUpdateNotice();
        await page.locator('#pi-compliance-open').click();
        const selectBatch = async pairs => {
            for (const row of await page.locator('[data-compliance-document]').all()) {
                const checkbox = row.getByLabel('选用于新批次');
                if (await checkbox.isChecked()) { await checkbox.uncheck(); await row.getByRole('button', { name: '保存资料核对' }).click(); await page.waitForFunction(() => document.querySelector('#compliance-material-status')?.textContent.includes('已保存资料核对')); }
            }
            for (const [title, role] of pairs) {
                const row = page.locator('[data-compliance-document]').filter({ hasText: title });
                await row.locator('select').selectOption(role);
                await row.getByLabel('归属已核对').check();
                await row.getByLabel('选用于新批次').check();
                await row.getByRole('button', { name: '保存资料核对' }).click();
                await page.waitForFunction(() => document.querySelector('#compliance-material-status')?.textContent.includes('已保存资料核对'));
            }
            await page.locator('#compliance-run-check').click();
        };
        const runBatch = async pairs => {
            const previous = /批次：([a-f0-9-]+)/.exec(await page.locator('#compliance-results').textContent().catch(() => ''))?.[1] ?? '';
            await selectBatch(pairs);
            await page.waitForFunction(id => {
                const text = document.querySelector('#compliance-results')?.textContent ?? '';
                const match = /批次：([a-f0-9-]+)/.exec(text);
                return match && match[1] !== id && text.includes('执行完成');
            }, previous, { timeout: 120000 });
        };
        // 项目表单保存使用抽屉打开时加载的 loaded.revision（public/pi-compliance.js:168）；
        // 批次/交付等写入会使其过期，产品按设计以 409 拒绝。重开抽屉重新拉取视图。
        const resyncDrawer = async () => {
            await dismissUpdateNotice();
            await page.locator('#pi-compliance-close').click();
            await page.waitForFunction(() => { const drawer = document.getElementById('pi-compliance-drawer'); return !drawer || drawer.hidden; });
            await page.locator('#pi-compliance-open').click();
            await page.locator('#compliance-project-new').waitFor({ state: 'visible' });
        };
        if (mode === 'full') { // ---- full 案例区（min 组合只跑到 A3 资格链路）----
        // B2 项目身份与适用清单（工作台确认）
        await page.locator('#compliance-project-new').click();
        await page.locator('#compliance-project-name').fill('示例工程甲');
        await page.locator('#compliance-project-number').fill('P-001');
        await page.locator('#compliance-project-confirmed').check();
        for (const [name, value] of [['合同签订期限', 'yes'], ['资料缺失与归属', 'yes'], ['可研评审及批复文号', 'no'], ['可研与评审时序', 'no']]) await page.getByLabel(name, { exact: true }).selectOption(value);
        await page.locator('#compliance-project-save').click();
        await page.waitForFunction(() => document.querySelector('#compliance-project-status')?.textContent.includes('已保存'));
        console.log(`fullchain ${label}: B2 project identity confirmed`);
        // 导入与资料核对（UI 文件选择走真实 HTTP）
        await page.locator('#compliance-upload').setInputFiles([sample('notice-0301.pdf'), sample('contract-0228.pdf'), contractCsv('contract-0301.csv', '2026-03-01'), contractCsv('contract-0331.csv', '2026-03-31'), contractCsv('contract-0401.csv', '2026-04-01')]);
        await page.locator('#compliance-import-upload').click();
        await page.waitForFunction(() => document.querySelectorAll('[data-compliance-document]').length === 5);
        // B3 同字节去重
        await page.locator('#compliance-upload').setInputFiles([sample('notice-0301.pdf')]);
        await page.locator('#compliance-import-upload').click();
        await page.waitForFunction(() => document.querySelectorAll('[data-compliance-document]').length === 5, null, { timeout: 20000 });
        console.log(`fullchain ${label}: B3 same-byte dedup held document count at 4`);
        // C3 合同 -1/0/30/31 天（第零天基准 notice-0301）
        await runBatch([['notice-0301', 'award-notice'], ['contract-0301.csv', 'contract']]);
        assert.match(await page.locator('#compliance-results').textContent(), /合同签订期限：通过/);
        console.log(`fullchain ${label}: C3 day-0 passed`);
        await runBatch([['notice-0301', 'award-notice'], ['contract-0331.csv', 'contract']]);
        assert.match(await page.locator('#compliance-results').textContent(), /合同签订期限：通过/);
        console.log(`fullchain ${label}: C3 day-30 passed`);
        await runBatch([['notice-0301', 'award-notice'], ['contract-0228.pdf', 'contract']]);
        assert.match(await page.locator('#compliance-results').textContent(), /合同签订期限：发现候选问题/);
        console.log(`fullchain ${label}: C3 day-minus-1 candidate issue recorded`);
        await runBatch([['notice-0301', 'award-notice'], ['contract-0401.csv', 'contract']]);
        assert.match(await page.locator('#compliance-results').textContent(), /合同签订期限：发现候选问题/);
        console.log(`fullchain ${label}: C3 day-31 candidate issue recorded`);
        // E1 人工复核（先准备再确认，原值/人工值分存；修正后重算为通过）
        const documentChoice = await page.locator('#compliance-review-document').evaluate(el => [...el.options].find(option => /contract-0401/.test(option.textContent))?.value);
        await page.locator('#compliance-review-document').selectOption(documentChoice);
        await page.locator('#compliance-review-key').selectOption('date');
        await page.locator('#compliance-review-value').fill('2026-03-15');
        await page.locator('#compliance-review-excerpt').fill('人工核对合同日期列');
        await page.locator('#compliance-review-reason').fill('核对原件，日期应为三月十五日');
        await page.locator('#compliance-review-prepare').click();
        await page.locator('#compliance-review-card').waitFor();
        assert.match(await page.locator('#compliance-review-card').textContent(), /2026-04-01/);
        assert.match(await page.locator('#compliance-review-card').textContent(), /2026-03-15/);
        await page.locator('#compliance-review-confirm').click();
        await page.waitForFunction(() => document.querySelector('#compliance-results')?.textContent.includes('合同签订期限：通过'));
        console.log(`fullchain ${label}: E1 human review card confirmed and recomputed`);
        // F1 报告生成、预览与 Excel 字节
        await page.locator('#compliance-report-generate').click();
        await page.waitForFunction(() => document.querySelector('[data-compliance-report]')?.textContent.includes('已生成'));
        const reportRow = page.locator('[data-compliance-report]').first();
        await reportRow.getByRole('button', { name: '预览 HTML 报告' }).click();
        const frame = page.locator('.compliance-reports iframe');
        await frame.waitFor();
        assert.equal(await frame.getAttribute('sandbox'), '');
        await page.getByRole('button', { name: '收起报告预览' }).click();
        let excelBytes;
        for (let attempt = 0; ; attempt += 1) {
            const downloadEvent = page.waitForEvent('download');
            await reportRow.getByRole('button', { name: '下载 Excel' }).click();
            const download = await downloadEvent;
            try { excelBytes = fs.readFileSync(await download.path()); break; }
            catch (error) { if (attempt >= 2) throw error; console.log(`fullchain ${label}: excel download canceled, retrying`); }
        }
        const excelHash = createHash('sha256').update(excelBytes).digest('hex');
        const evidenceDir = process.env.COMPLIANCE_FULLCHAIN_EVIDENCE ? path.dirname(process.env.COMPLIANCE_FULLCHAIN_EVIDENCE) : null;
        if (evidenceDir) { fs.mkdirSync(evidenceDir, { recursive: true }); fs.writeFileSync(path.join(evidenceDir, `fullchain-${label}-excel.xlsx`), excelBytes); }
        console.log(`fullchain ${label}: F1 report generated, excel sha256 ${excelHash.slice(0, 12)}…`);
        // F2 原生交付（唯一受管 worker 登记）
        await reportRow.getByRole('button', { name: '交付到当前聊天' }).click();
        await page.waitForFunction(() => document.querySelector('[data-compliance-report]')?.textContent.includes('已交付'));
        const reportId = await reportRow.getAttribute('data-compliance-report');
        const delivered = (await api('GET', '/compliance/reports/' + reportId, undefined, origin)).data.report;
        const sessionFile = fs.realpathSync.native(dedicatedSession.path);
        const nativeText = fs.readFileSync(sessionFile, 'utf8');
        assert.ok(nativeText.includes(delivered.delivery.reference.id), 'native JSONL session records the delivery reference');
        console.log(`fullchain ${label}: F2 native delivery registered in ${path.basename(sessionFile)}`);
        // F3 精确来源保存到成果中心
        await reportRow.getByRole('button', { name: '保存到成果中心' }).click();
        await page.waitForFunction(() => document.querySelector('[data-compliance-report]')?.textContent.includes('已保存到成果中心'));
        record('F', 'passed', 'report generated + native delivery registered + saved to deliverables');
        // C4/C6 与 D1/D2/G1 仅首个 full 组合执行一次：识别模型配置是全局设置，
        // 配置后文本页也会送识别，与文本解析字段叠加会改变 C4 的前提（后续组合重跑会失真）。
        if (first) {
        await resyncDrawer();
        // C4 可研与评审时序三档 + C6 不适用独立展示（独立项目 P-004，仅该规则适用）
        await page.locator('#compliance-project-new').click();
        await page.locator('#compliance-project-name').fill('示例工程甲');
        await page.locator('#compliance-project-number').fill('P-004-' + label);
        await page.locator('#compliance-project-confirmed').check();
        for (const [name, value] of [['合同签订期限', 'no'], ['资料缺失与归属', 'yes'], ['可研评审及批复文号', 'no'], ['可研与评审时序', 'yes']]) await page.getByLabel(name, { exact: true }).selectOption(value);
        await page.locator('#compliance-project-save').click();
        await page.waitForFunction(text => document.querySelector('.compliance-project-list')?.textContent.includes(text), 'P-004');
        await page.waitForFunction(() => document.querySelectorAll('[data-compliance-document]').length === 0, null, { timeout: 20000 });
        await page.locator('#compliance-upload').setInputFiles([sample('review-0201.pdf'), sample('kexing-0110.pdf')]);
        await page.locator('#compliance-import-upload').click();
        await page.waitForFunction(() => document.querySelectorAll('[data-compliance-document]').length === 2);
        await runBatch([['review-0201', 'feasibility-review'], ['kexing-0110', 'feasibility-report']]);
        const c4Results = await page.locator('#compliance-results').textContent();
        assert.match(c4Results, /可研与评审时序：通过/);
        assert.match(c4Results, /不适用/, 'not-applicable must be displayed separately (C6)');
        record('C4', 'passed', 'report strictly before review → passed; non-applicable rules shown separately (C6)');
        await page.locator('#compliance-upload').setInputFiles([sample('kexing-0201.pdf'), sample('kexing-0301.pdf')]);
        await page.locator('#compliance-import-upload').click();
        await page.waitForFunction(() => document.querySelectorAll('[data-compliance-document]').length === 4);
        await runBatch([['review-0201', 'feasibility-review'], ['kexing-0201', 'feasibility-report']]);
        assert.match(await page.locator('#compliance-results').textContent(), /可研与评审时序：发现候选问题/);
        await runBatch([['review-0201', 'feasibility-review'], ['kexing-0301', 'feasibility-report']]);
        assert.match(await page.locator('#compliance-results').textContent(), /可研与评审时序：发现候选问题/);
        record('C4b', 'passed', 'same-day and later report dates both → candidate issues');
        // D1 未配置识别：扫描件诚实缺口。项目身份必须与样本文本一致（示例工程甲/P-001），
        // 否则识别接通后资料工程身份与档案冲突会先于规则结论（产品正确行为）。
        await resyncDrawer();
        await page.locator('#compliance-project-new').click();
        await page.locator('#compliance-project-name').fill('示例工程甲');
        await page.locator('#compliance-project-number').fill('P-001');
        await page.locator('#compliance-project-confirmed').check();
        for (const [name, value] of [['合同签订期限', 'yes'], ['资料缺失与归属', 'yes'], ['可研评审及批复文号', 'no'], ['可研与评审时序', 'no']]) await page.getByLabel(name, { exact: true }).selectOption(value);
        await page.locator('#compliance-project-save').click();
        await page.waitForFunction(() => document.querySelectorAll('[data-compliance-document]').length === 0, null, { timeout: 20000 });
        scanCanvas = require('@napi-rs/canvas').createCanvas(160, 120);
        scanCanvas.getContext('2d').fillStyle = '#1c3d5a'; scanCanvas.getContext('2d').fillRect(8, 8, 64, 40);
        const scanA = path.join(temporary, 'scan-a.png'); fs.writeFileSync(scanA, scanCanvas.toBuffer('image/png'));
        await page.locator('#compliance-upload').setInputFiles([sample('notice-0301.pdf'), scanA]);
        await page.locator('#compliance-import-upload').click();
        await page.waitForFunction(() => document.querySelectorAll('[data-compliance-document]').length === 2);
        await runBatch([['notice-0301', 'award-notice'], ['scan-a', 'contract']]);
        assert.match(await page.locator('#compliance-results').textContent(), /资料读取不完整或需要识别/);
        record('D1', 'passed', 'unconfigured recognition → honest insufficient instead of a guess');
        // D2 配置识别模型：扫描页接通，候选绑定页面证据
        await page.goto(origin + '/#/settings?tab=builtins', { waitUntil: 'domcontentloaded' });
        await page.locator('#compliance-extraction-model').selectOption('fixture/vision');
        await page.locator('#compliance-save').click();
        await page.waitForFunction(() => document.querySelector('#compliance-settings-status')?.textContent.includes('已启用'));
        await page.goto(origin + '/#/chat', { waitUntil: 'domcontentloaded' });
        await page.locator('#pi-input').waitFor({ state: 'visible' });
        await dismissUpdateNotice();
        // 合规模块异步绑定触发器，早到的点击会丢失；重试直到抽屉真正打开
        for (let i = 0; ; i += 1) {
            await dismissUpdateNotice();
            await page.locator('#pi-compliance-open').click();
            try { await page.locator('#pi-compliance-drawer').waitFor({ state: 'visible', timeout: 3000 }); break; }
            catch (error) { if (i >= 10) throw error; }
        }
        // hash 导航不重载页面：抽屉可能带选中项目直达材料视图；若重载则显示项目列表（新 P-001 在列表末位）
        const chooseP5 = page.locator('.compliance-project-list').getByRole('button').filter({ hasText: '示例工程甲 · P-001' }).last();
        if (await chooseP5.count()) await chooseP5.click();
        else await page.locator('#compliance-upload').waitFor({ state: 'visible' });
        const callsBeforeScan = providerCalls.length;
        await runBatch([['notice-0301', 'award-notice'], ['scan-a', 'contract']]);
        assert.match(await page.locator('#compliance-results').textContent(), /合同签订期限：通过/);
        assert.ok(providerCalls.slice(callsBeforeScan).some(body => JSON.stringify(body.messages).includes('data:image/png;base64,')), 'recognition request carried the page raster');
        d2BatchId = /批次：([a-f0-9-]+)/.exec(await page.locator('#compliance-results').textContent())[1];
        record('D2-ui', 'passed', 'configured recognition run completed in UI; node-side evidence deferred after last UI write');
        }
        }
        // 布局断言（full/min 共同收尾）
        assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false);
        assert.equal(await page.locator('#pi-compliance-drawer').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
        assert.ok(await page.locator('#compliance-project-name').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 16));
        assert.equal(await page.locator('#pi-compliance-drawer script').count(), 0);
        await screenshot('final');
        assert.deepEqual(errors, []);
        record('layout-' + label, 'passed', 'no horizontal overflow, 16px inputs, sanitized drawer, zero pageerror');
        console.log(`fullchain ${label}: layout and pageerror checks passed`);
        if (mode === 'full' && first) {
            // G1 在途识别被停用截停：当前步骤保存，未启动步骤不自动续跑，显式继续才补跑。
            // 批次含两个扫描页（通知单+合同各一）：停用落在第一个识别在途时，第二个是未启动步骤；
            // 若批次只剩一个识别步骤，步骤完成后无未启动步骤，按语义直接完成而非暂停。
            scanCanvas.getContext('2d').fillStyle = '#7a1c3d'; scanCanvas.getContext('2d').fillRect(90, 60, 48, 30);
            const scanB = path.join(temporary, 'scan-b.png'); fs.writeFileSync(scanB, scanCanvas.toBuffer('image/png'));
            scanCanvas.getContext('2d').fillStyle = '#2a7a1c'; scanCanvas.getContext('2d').fillRect(20, 80, 56, 24);
            const scanC = path.join(temporary, 'scan-c.png'); fs.writeFileSync(scanC, scanCanvas.toBuffer('image/png'));
            await page.locator('#compliance-upload').setInputFiles([scanB, scanC]);
            await page.locator('#compliance-import-upload').click();
            await page.waitForFunction(() => document.querySelectorAll('[data-compliance-document]').length === 4);
            holdRecognitions = 1;
            const beforeG1 = providerCalls.length;
            const g1Previous = /批次：([a-f0-9-]+)/.exec(await page.locator('#compliance-results').textContent().catch(() => ''))?.[1] ?? '';
            await selectBatch([['scan-c', 'award-notice'], ['scan-b', 'contract']]);
            for (let i = 0; providerCalls.length === beforeG1; i += 1) { assert.ok(i < 300, 'held recognition request arrived'); await new Promise(resolve => setTimeout(resolve, 100)); }
            // D2 节点侧证据（推迟到此处：材料读操作记录操作回执并推进账本修订，会令后续 UI 写入过期）
            const d2Batch = (await api('GET', '/compliance/batches/' + d2BatchId, undefined, origin)).data.batch;
            assert.equal(d2Batch.fields.find(f => f.key === 'date').location.page, 1);
            record('D2', 'passed', 'configured recognition bound the candidate to page-1 evidence');
            await api('GET', '/compliance', undefined, origin);
            const disablePut = await write('/compliance/settings', { enabled: false }, 'PUT', origin);
            console.log(`fullchain ${label}: G1 disable PUT ${disablePut.status} ${JSON.stringify(disablePut.data).slice(0, 120)}`);
            releaseHeldRecognitions.pop()();
            let g1Batch = '', g1Last = 'no id change';
            for (let i = 0; i < 300 && !g1Batch; i += 1) {
                const text = await page.locator('#compliance-results').textContent().catch(() => '');
                const id = /批次：([a-f0-9-]+)/.exec(text)?.[1];
                if (id && id !== g1Previous) {
                    const view = (await api('GET', '/compliance/batches/' + id, undefined, origin)).data.batch;
                    g1Last = `${id.slice(0, 8)} ${view.execution.status}/${view.execution.reason}`;
                    if (view.execution.status === 'paused') g1Batch = id;
                    else await new Promise(resolve => setTimeout(resolve, 100));
                } else await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.ok(g1Batch, `batch paused after disable (last: ${g1Last})`);
            assert.equal((await api('GET', '/compliance/batches/' + g1Batch, undefined, origin)).data.batch.execution.reason, 'disabled');
            assert.equal(providerCalls.length, beforeG1 + 1, 'no further model calls after disable');
            record('G1a', 'passed', 'disable mid-batch saved the current step and paused with reason disabled');
            await api('GET', '/compliance', undefined, origin);
            await write('/compliance/settings', { enabled: true, mainModel: { provider: 'fixture', modelId: 'text' }, extractionModel: { provider: 'fixture', modelId: 'vision' } }, 'PUT', origin);
            await new Promise(resolve => setTimeout(resolve, 2000));
            assert.equal(providerCalls.length, beforeG1 + 1, 're-enabling must not auto-replay unstarted steps');
            await api('GET', '/compliance', undefined, origin);
            const continued = await write('/compliance/batches/' + g1Batch + '/continue', { budget: { pages: 200, modelCalls: 10, runMs: 600000 } }, 'POST', origin);
            assert.equal(continued.status, 200, JSON.stringify(continued.data));
            let g1Done = continued.data.batch;
            for (let i = 0; g1Done.execution.status !== 'completed' && i < 300; i += 1) { await new Promise(resolve => setTimeout(resolve, 100)); g1Done = (await api('GET', '/compliance/batches/' + g1Batch, undefined, origin)).data.batch; }
            assert.equal(g1Done.execution.status, 'completed');
            assert.equal(providerCalls.length, beforeG1 + 2, 'continue ran exactly the unstarted recognition');
            assert.equal(g1Done.results.find(item => item.id === 'contract-deadline').conclusion, 'passed');
            record('G1b', 'passed', 'explicit continue replayed only the unstarted step');
        }
        if (mode === 'full') {
            // B5 原件字节改变不影响已归档快照（收尾执行：材料读操作其后无 UI 写入）
            const p1Projects = (await api('GET', '/compliance/projects', undefined, origin)).data.projects.filter(p => p.number === 'P-001');
            let archived = null;
            for (const project of p1Projects) {
                const list = (await api('GET', '/compliance/projects/' + project.id + '/documents', undefined, origin)).data;
                archived = (list.documents ?? list).find(d => d.name === 'contract-0301.csv');
                if (archived) break;
            }
            assert.ok(archived, 'archived contract-0301 present in the main P-001 project');
            const snapshotHash = (await api('GET', '/compliance/documents/' + archived.id + '/content', undefined, origin)).data.hash;
            contractCsv('contract-0301.csv', '2026-09-09');
            assert.equal((await api('GET', '/compliance/documents/' + archived.id + '/content', undefined, origin)).data.hash, snapshotHash, 'archived snapshot unchanged after source mutation');
            record('B5', 'passed', `archived snapshot ${snapshotHash.slice(0, 12)}… unchanged after source file mutation`);
        }
    } catch (error) {
        await screenshot('failed').catch(() => {});
        console.error({ label, errors, providerCalls: providerCalls.length, url: page.url(), message: error.message });
        throw error;
    } finally { await context.close(); }
}

(async () => {
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    const modelsJson = JSON.parse(fs.readFileSync(path.join(agent, 'models.json'), 'utf8'));
    modelsJson.providers.fixture.baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify(modelsJson));
    const app = express();
    for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', directory)));
    app.use(express.static(path.join(root, 'public')));
    access.mount(app); app.use(express.json({ limit: '32mb' })); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    gateway.attachWebSocket(server); // 真实聊天 WS：本脚本相对既有专项的核心增量
    const origin = `http://127.0.0.1:${server.address().port}`;
    process.env.PI_WORKSPACE_INTERNAL_ORIGIN = origin;
    const ordinarySession = await gateway.store.createSession(cwd, '普通会话', { agentProfileId: null });
    fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR || os.tmpdir(), { recursive: true });
    // 组合矩阵（票 04 决议 2.a）：全链主跑 zh 1440+393；zh-320 与 en×3 跑最小链路＋布局断言
    const combos = selectBrowserTargets((process.env.COMPLIANCE_FULLCHAIN_COMBOS || '1440:full:zh').split(',').map(text => { const [width, mode, lang] = text.split(':'); return { width: Number(width), mode, lang }; }));
    assert.ok(combos.length, 'at least one browser scenario must match the selected target');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
    try {
        for (const [index, combo] of combos.entries()) await runCombo(browser, origin, { ...combo, first: index === 0, ordinarySessionId: ordinarySession.id });
        console.log(`full-chain done: provider calls ${providerCalls.length}`);
    } finally {
        const evidencePath = process.env.COMPLIANCE_FULLCHAIN_EVIDENCE;
        if (evidencePath) { try { fs.mkdirSync(path.dirname(evidencePath), { recursive: true }); fs.writeFileSync(evidencePath, JSON.stringify({ finishedAt: new Date().toISOString(), providerCalls: providerCalls.length, records }, null, 2)); } catch (error) { console.error('evidence write failed: ' + error.message); } }
        await browser.close(); await gateway.dispose(); access.dispose();
        server.closeAllConnections(); provider.closeAllConnections();
        await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
        fs.rmSync(temporary, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
