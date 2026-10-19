// 故障场景 E2E（票 05 故障表 #1-#9）：真实网关/受管 worker/账本/原生会话 + 本地 SSE 合成供应商。
// 每项故障：可重复触发、三计数断言（业务写入、供应商调用、原生登记）、门闩落在独立合成实例、退出前清理。
// 与 full-chain 的分工：本脚本聚焦故障注入与不重放语义；资格与规则矩阵在 pi-compliance-full-chain.cjs。
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), { randomUUID } = require('node:crypto'), { fork } = require('node:child_process');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');

const records = [], pageErrors = [];
const record = (caseId, status, detail) => { records.push({ caseId, status, detail: String(detail).slice(0, 300) }); console.log(`faults [${caseId}] ${status}: ${detail}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 合成供应商：识别请求可控（挂起/字段覆写）；文本请求按 fixture 触发工具调用。父进程持有，子进程重启不影响。
const providerCalls = [];
let holdRecognitions = 0, releaseHeld = [], recognitionFields = null, toolOperation = null;
const isRecognition = body => Array.isArray(body.messages?.at(-1)?.content) && body.messages.at(-1).content.some(part => part.type === 'image_url');
const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); providerCalls.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (isRecognition(body)) {
        if (holdRecognitions > 0) { holdRecognitions--; await new Promise(resolve => { releaseHeld.push(resolve); }); }
        const fields = recognitionFields ?? [{ key: 'date', raw: '2026-03-01', status: 'known', excerpt: '签订日期：2026-03-01', rect: [0, 0, 90, 20] }];
        var delta = { role: 'assistant', content: JSON.stringify({ fields }) }; var finish = 'stop';
    } else {
        const user = body.messages?.findLast?.(message => message.role === 'user');
        var delta = { role: 'assistant', content: 'Fixture done.' }; var finish = 'stop';
        if (user && toolOperation && JSON.stringify(user).includes('fixture operate')) {
            var delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'op-' + providerCalls.length, type: 'function', function: { name: toolOperation.name, arguments: JSON.stringify(toolOperation.input) } }] };
            var finish = 'tool_calls';
        }
    }
    res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    res.end('data: [DONE]\n\n');
});

const noticeCsv = '项目名称,项目编号,日期\n示例工程甲,P-001,2026-03-01\n';
const contractCsv = date => '项目名称,项目编号,日期\n示例工程甲,P-001,' + date + '\n';
let activeEnv = null;
// COMPLIANCE_FAULTS_ONLY=f8 之类，隔离单个场景定位问题；缺省全跑
const wantEnv = name => !process.env.COMPLIANCE_FAULTS_ONLY || process.env.COMPLIANCE_FAULTS_ONLY.split(',').includes(name);
const scanPng = (file, variant = 0) => { const canvas = require('@napi-rs/canvas').createCanvas(160, 120); canvas.getContext('2d').fillStyle = '#1c3d5a'; canvas.getContext('2d').fillRect(8 + variant * 6, 8, 64, 40); fs.writeFileSync(file, canvas.toBuffer('image/png')); return file; };

// 每场景独立身份服务（进程内）。interceptor 供 #8 注入交付 ack 故障。
async function assemble(label) {
    const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-compliance-faults-')));
    const agent = path.join(temporary, 'agent'), cwd = path.join(temporary, 'project'); fs.mkdirSync(agent); fs.mkdirSync(cwd);
    process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = temporary; process.env.PI_OFFLINE = '1';
    process.env.PI_WEB_DEFERRED_FILE = path.join(agent, 'deferred.json');
    process.env.PI_MEDIA_DATA_DIR = path.join(temporary, 'media-data');
    process.env.PI_MEDIA_CONFIG_DIR = path.join(temporary, 'media-config');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'text', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'text', input: ['text'], contextWindow: 32000, maxTokens: 1000 }, { id: 'vision', input: ['text', 'image'], contextWindow: 32000, maxTokens: 1000 }] } } }));
    const { WorkspaceAccessService } = require(path.join(root, 'server/workspace-access-service'));
    const token = 'synthetic-faults-' + randomUUID();
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => token });
    const gateway = require(path.join(root, 'server/pi-agent-routes')).createPiAgentGateway({ accessService: access, deferredFilePath: path.join(agent, 'deferred.json'), cronFilePath: path.join(agent, 'cron.sqlite') });
    const counters = { posts: 0, seen: [] };
    let interceptor = null;
    const app = express();
    for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', directory)));
    app.use(express.static(path.join(root, 'public')));
    app.use((req, res, next) => { if (req.method !== 'GET' && req.path.startsWith('/api/pi/compliance')) { counters.posts += 1; counters.seen.push(req.method + ' ' + req.path); } next(); });
    access.mount(app); app.use(express.json({ limit: '32mb' }));
    // 计入/拦截器需在 json 解析后（读取 req.body）；故障注入点与 reports-runtime 同序
    app.use((req, res, next) => { if (interceptor) return interceptor(req, res, next); next(); });
    gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    process.env.PI_WORKSPACE_INTERNAL_ORIGIN = origin;
    gateway.attachWebSocket(server);
    let revision = 0;
    const api = async (method, route, body) => {
        const res = await fetch(origin + '/api/pi' + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
        const data = await res.json().catch(() => ({}));
        if (Number.isSafeInteger(data.revision)) revision = data.revision;
        return { status: res.status, data };
    };
    const write = async (route, body = {}, method = 'POST') => api(method, route, { requestId: randomUUID(), expectedRevision: revision, ...body });
    const cleanup = async () => {
        await gateway.dispose(); access.dispose();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        fs.rmSync(temporary, { recursive: true, force: true });
        if (activeEnv === env) activeEnv = null;
    };
    const env = { label, temporary, agent, cwd, origin, token, api, write, cleanup, gateway, counters, set interceptor(value) { interceptor = value; }, get revision() { return revision; }, set revision(value) { revision = value; } };
    activeEnv = env;
    return env;
}

async function seededProject(env, { scan = false, scans = 0, selectedAll = false, selectFirst = true, date = '2026-03-01', contracts = [], name = '示例工程甲', number = 'P-001' } = {}) {
    const enabled = await env.write('/compliance/settings', { enabled: true, mainModel: { provider: 'fixture', modelId: 'text' }, extractionModel: { provider: 'fixture', modelId: 'vision' } }, 'PUT');
    assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
    const created = await env.write('/compliance/projects', { project: { name, number, identityConfirmed: true, applicability: { 'documents-identity': true, 'contract-deadline': true, 'feasibility-numbers': false, 'feasibility-order': false } } });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const project = created.data.project;
    const sources = [{ kind: 'upload', name: '通知书.csv', base64: Buffer.from(noticeCsv).toString('base64') }];
    if (scan || scans > 0) sources.push({ kind: 'upload', name: '合同扫描.png', base64: fs.readFileSync(scanPng(path.join(env.temporary, 'scan.png'), 0)).toString('base64') });
    for (let i = 1; i < scans; i += 1) sources.push({ kind: 'upload', name: `合同扫描-${i + 1}.png`, base64: fs.readFileSync(scanPng(path.join(env.temporary, `scan-${i + 1}.png`), i)).toString('base64') });
    for (const day of contracts) sources.push({ kind: 'upload', name: `合同-${day}.csv`, base64: Buffer.from(contractCsv(day)).toString('base64') });
    const docs = (await env.write(`/compliance/projects/${project.id}/documents`, { sources })).data.documents;
    assert.ok(docs.length === sources.length, 'all sources imported: ' + JSON.stringify(docs?.map?.(d => d.name)));
    const put1 = await env.write(`/compliance/documents/${docs[0].id}/assignment`, { role: 'award-notice', identityConfirmed: true, selected: true }, 'PUT');
    assert.equal(put1.status, 200, JSON.stringify(put1.data));
    const contractDocs = docs.slice(1);
    for (const [index, doc] of contractDocs.entries()) {
        const put = await env.write(`/compliance/documents/${doc.id}/assignment`, { role: 'contract', identityConfirmed: true, selected: selectedAll || (selectFirst && index === 0) }, 'PUT');
        assert.equal(put.status, 200, JSON.stringify(put.data));
    }
    return { project, docs, contractDocs };
}

const waitBatch = async (env, batchId, status) => {
    let view = (await env.api('GET', '/compliance/batches/' + batchId)).data.batch;
    for (let i = 0; view.execution.status !== status && i < 250; i += 1) { await sleep(100); view = (await env.api('GET', '/compliance/batches/' + batchId)).data.batch; }
    return view;
};
const waitRecognition = async (baseline = 0) => { for (let i = 0; i < 300 && providerCalls.filter(isRecognition).length <= baseline; i += 1) await sleep(100); return providerCalls.filter(isRecognition).length > baseline; };
// 批次 POST 在批次落定前不响应：挂起期间发起不等待，等“新增”识别请求到位（跨场景计数会残留，必须用基线），再轮询批次列表拿 id。
const waitBatchId = async (io, projectId) => {
    for (let i = 0; i < 300; i += 1) {
        const list = (await io.api('GET', `/compliance/projects/${projectId}/batches`)).data.batches;
        if (list?.length) return list.at(-1).id;
        await sleep(200);
    }
    throw new Error('batch never registered');
};
const startHeldBatch = async (io, projectId) => {
    const baseline = providerCalls.filter(isRecognition).length;
    const pending = io.write(`/compliance/projects/${projectId}/batches`);
    pending.catch(() => {});
    assert.ok(await waitRecognition(baseline), 'recognition held at the provider');
    return { pending, batchId: await waitBatchId(io, projectId) };
};
// 引擎更新提示会空闲重现并拦截点击：可见才去关（不可见时 isVisible 立即返回，省去点击超时）。
const dismissUpdate = async page => { if (!(await page.locator('#pi-update-notice').isVisible().catch(() => false))) return; await page.locator('#pi-update-notice-ignore').click({ timeout: 1500 }).catch(() => page.locator('#pi-update-notice-close').click({ timeout: 1000 }).catch(() => {})); };
const setSessionStorage = (env, page, sessionId) => page.addInitScript(({ cwd, token, sessionId }) => { if (window.top !== window.self) return; localStorage.setItem('pi.web.cwd', cwd); if (sessionId) localStorage.setItem('pi.web.session:' + cwd, sessionId); sessionStorage.setItem('pi.web.token', token); }, { cwd: env.cwd, token: env.token, sessionId });
const waitForInputReady = page => page.waitForFunction(() => document.getElementById('pi-input')?.disabled === false, null, { timeout: 180000 });
// 抽屉触发器只在专用合规会话（profileId 匹配）下可见：设置页点 open-chat 创建会话并冷启动 worker。
const openComplianceChat = async (env, page) => {
    // Model catalog initialization precedes settings rendering; keep its existing API startup budget separate.
    const settingsReady = page.waitForResponse(response => new URL(response.url()).pathname === '/api/pi/settings/models'
        && response.request().method() === 'GET', { timeout: 120000 });
    settingsReady.catch(() => {});
    await page.goto(env.origin + '/#/settings?tab=builtins', { waitUntil: 'domcontentloaded', timeout: 120000 });
    assert.equal((await settingsReady).status(), 200, 'the real model catalog is ready before checking settings rendering');
    await page.locator('#compliance-enabled').waitFor({ state: 'visible' });
    await dismissUpdate(page);
    await page.locator('#compliance-open-chat').click();
    // Visibility precedes the native open-session response; wait for actual input readiness.
    await waitForInputReady(page);
    await dismissUpdate(page);
    return page.evaluate(cwd => localStorage.getItem('pi.web.session:' + cwd), env.cwd);
};
const openDrawerOnProject = async (env, page, namePattern) => {
    for (let i = 0; ; i += 1) {
        await dismissUpdate(page);
        await page.locator('#pi-compliance-open').click({ timeout: 3000 }).catch(() => {});
        try { await page.locator('#pi-compliance-drawer').waitFor({ state: 'visible', timeout: 2000 }); break; }
        catch (error) { if (i >= 15) throw error; }
    }
    let entered = false;
    for (let i = 0; !entered && i < 16; i += 1) {
        await dismissUpdate(page);
        entered = await page.locator('.compliance-project-list').getByRole('button', { name: namePattern }).first().click({ timeout: 2500 }).then(() => true).catch(() => false);
        if (!entered && await page.locator('[data-compliance-document]').first().isVisible().catch(() => false)) entered = true;
    }
    if (!entered) throw new Error(`faults ${env.label}: project button never clickable`);
    await page.locator('[data-compliance-document]').first().waitFor({ state: 'visible' });
    return page;
};
const browserPage = async browser => {
    const page = await (await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })).newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.setDefaultTimeout(15000);
    page.on('crash', () => console.log('faults: page crashed'));
    page.on('close', () => console.log('faults: page closed'));
    return page;
};

(async () => {
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    console.log('faults: provider on ' + provider.address().port);
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
    console.log('faults: browser launched');
    browser.on('disconnected', () => console.log('faults: browser disconnected'));
    process.on('exit', code => console.log('faults: process exit ' + code));
    process.on('unhandledRejection', error => { console.error('faults: unhandledRejection ' + (error?.stack || error)); process.exitCode = 1; });
    const heartbeat = setInterval(() => console.log('faults: heartbeat ' + new Date().toISOString()), 45000);
    const evidencePath = process.env.COMPLIANCE_FAULTS_EVIDENCE;
    let forkedChild = null;
    try {
        // ---- #8 原生登记已写入确认未达：ack 503 → published；查原操作对账；原生条数恒 1 ----
        if (wantEnv("f8")) {
            const env = await assemble('f8'); const { project } = await seededProject(env, { contracts: ['2026-03-15'] });
            const dedicated = (await env.write('/compliance/sessions', { cwd: env.cwd }));
            assert.ok(dedicated.status === 200 || dedicated.status === 201, JSON.stringify(dedicated.data));
            console.log('faults f8: session ready, starting worker');
            const worker = await env.gateway.supervisor.getWorker({ cwd: env.cwd, sessionId: dedicated.data.id, sessionPath: dedicated.data.path });
            console.log('faults f8: worker ready');
            const batch = (await env.write(`/compliance/projects/${project.id}/batches`)).data.batch;
            console.log('faults f8: batch settled ' + batch.execution.status);
            const generated = await env.write(`/compliance/batches/${batch.id}/reports`, { batchRevision: batch.revision });
            console.log('faults f8: reports write returned ' + generated.status);
            const report = generated.data.report;
            assert.equal(report.status, 'generated', JSON.stringify(generated.data));
            let failAck = true;
            env.interceptor = (req, res, next) => {
                if (req.path === '/api/pi/compliance/tool' && req.body?.operation === 'reports' && req.body.action === 'acknowledge' && failAck) { failAck = false; return res.status(503).json({ error: 'Synthetic lost acknowledgement' }); }
                return next();
            };
            const callsBefore = providerCalls.length;
            const interrupted = await env.api('POST', `/compliance/reports/${report.id}/delivery`, { requestId: 'faults-ack-lost', expectedRevision: env.revision, cwd: env.cwd, sessionId: dedicated.data.id });
            assert.equal(interrupted.status, 500, 'delivery without acknowledgement reports uncertainty');
            const published = (await env.api('GET', `/compliance/reports/${report.id}`)).data.report;
            assert.equal(published.status, 'published', 'durable snapshot + native registration survive the lost ack');
            const entries = await worker.request('get_entries');
            assert.equal(entries.entries.filter(e => e.customType === 'pivane-deliverable' && e.data.id === published.delivery.reference.id).length, 1, 'native registration exists exactly once');
            assert.equal(providerCalls.length, callsBefore, 'no inference for publication or its observation');
            const reconciled = await env.api('GET', '/compliance/operations/faults-ack-lost');
            assert.equal(reconciled.data.report?.status, 'delivered', 'querying the original operation reconciles the receipt');
            const entriesAfter = await worker.request('get_entries');
            assert.equal(entriesAfter.entries.filter(e => e.customType === 'pivane-deliverable' && e.data.id === published.delivery.reference.id).length, 1, 'reconciliation does not duplicate the native entry');
            assert.equal(providerCalls.length, callsBefore, 'reconciliation uses no inference');
            record('F8', 'passed', 'lost acknowledgement: published + native entry once; original-operation query reconciles without worker or inference');
            await env.cleanup();
        }
        // ---- #9 同名报告来源混淆：旧交付的键不得满足当前来源；精确配对才保存 ----
        if (wantEnv("f9")) {
            const env = await assemble('f9'); const { project, contractDocs } = await seededProject(env, { contracts: ['2026-03-10', '2026-03-31'] });
            const dedicated = (await env.write('/compliance/sessions', { cwd: env.cwd }));
            assert.ok(dedicated.status === 200 || dedicated.status === 201, JSON.stringify(dedicated.data));
            const worker = await env.gateway.supervisor.getWorker({ cwd: env.cwd, sessionId: dedicated.data.id, sessionPath: dedicated.data.path });
            const batch1 = (await env.write(`/compliance/projects/${project.id}/batches`)).data.batch;
            const report1 = (await env.write(`/compliance/batches/${batch1.id}/reports`, { batchRevision: batch1.revision })).data.report;
            await env.write(`/compliance/reports/${report1.id}/delivery`, { requestId: 'faults-deliver-r1', expectedRevision: env.revision, cwd: env.cwd, sessionId: dedicated.data.id });
            const oldSources = (await env.api('GET', `/compliance/reports/${report1.id}/sources`)).data;
            // 切换选用合同，生成第二份同名报告并两次交付（第二次产生新原生引用）
            await env.write(`/compliance/documents/${contractDocs[0].id}/assignment`, { role: 'contract', identityConfirmed: true, selected: false }, 'PUT');
            await env.write(`/compliance/documents/${contractDocs[1].id}/assignment`, { role: 'contract', identityConfirmed: true, selected: true }, 'PUT');
            const batch2 = (await env.write(`/compliance/projects/${project.id}/batches`)).data.batch;
            const report2 = (await env.write(`/compliance/batches/${batch2.id}/reports`, { batchRevision: batch2.revision })).data.report;
            await env.write(`/compliance/reports/${report2.id}/delivery`, { requestId: 'faults-deliver-r2a', expectedRevision: env.revision, cwd: env.cwd, sessionId: dedicated.data.id });
            await env.write(`/compliance/reports/${report2.id}/delivery`, { requestId: 'faults-deliver-r2b', expectedRevision: env.revision, cwd: env.cwd, sessionId: dedicated.data.id });
            const exact = (await env.api('GET', `/compliance/reports/${report2.id}/sources`)).data;
            assert.notEqual(exact.reference.id, oldSources.reference.id, 'current origin binds its own native reference');
            assert.deepEqual(exact.files.map(f => f.sha256), report2.files.map(f => f.sha256), 'exact sources carry the report bytes');
            const olderSaved = await env.api('POST', '/artifacts/batch', { requestId: 'faults-save-old', action: 'save', files: oldSources.files.map(f => ({ key: f.key })) });
            assert.ok(olderSaved.data.results.every(r => r.ok), 'the older delivery saves as a generic artifact');
            const afterOld = (await env.api('GET', `/compliance/reports/${report2.id}`)).data.report;
            assert.ok(afterOld.savedFiles.every(f => f === null), 'an older same-name delivery never satisfies the current origin');
            const nativeCount = (await worker.request('get_entries')).entries.filter(e => e.customType === 'pivane-deliverable').length;
            assert.equal(nativeCount, 3, 'three deliveries registered natively (r1 + r2a + r2b), none reused');
            const exactSaved = await env.api('POST', '/artifacts/batch', { requestId: 'faults-save-exact', action: 'save', files: exact.files.map(f => ({ key: f.key })) });
            assert.ok(exactSaved.data.results.every(r => r.ok));
            const afterExact = (await env.api('GET', `/compliance/reports/${report2.id}`)).data.report;
            assert.ok(afterExact.savedFiles.every(Boolean), 'exact native delivery + file hashes satisfy the origin');
            record('F9', 'passed', 'same-name confusion rejected: older keys never satisfy; exact reference + sha256 pairing saved');
            await env.cleanup();
        }

        // ---- #1+#2 共用一个环境（专用会话冷启动一次）：未受理写入 busy-409；已受理响应丢失 ----
        if (wantEnv("f1") || wantEnv("f2")) {
            const env = await assemble('f12');
            let dedicatedSessionId = null;
            // ---- #1 未受理写入：浏览器 route busy-409 拒绝；账本零写入；重试作为新操作编号 ----
            if (wantEnv("f1")) {
                const { project } = await seededProject(env, { contracts: ['2026-03-15'], selectFirst: false });
                const page = await browserPage(browser);
                await setSessionStorage(env, page, null);
                await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.abort());
                dedicatedSessionId = await openComplianceChat(env, page);
                console.log('faults f1: compliance chat ready');
                await openDrawerOnProject(env, page, /示例工程甲/, '合同-2026-03-15');
                const row = page.locator('[data-compliance-document]').filter({ hasText: '合同-2026-03-15' });
                assert.equal(await row.getByLabel('选用于新批次').isChecked(), false, 'seeded unselected so the retry proves persistence');
                let rejected = 0;
                const postsBefore = env.counters.posts; const callsAtStart = providerCalls.length;
                await page.route('**/api/pi/compliance/**', async route => {
                    if (route.request().method() === 'PUT' && route.request().url().includes('/assignment')) { rejected += 1; return route.fulfill({ status: 409, json: { error: '合规操作正在处理或工作台维护中', code: 'COMPLIANCE_BUSY', operationAccepted: false } }); }
                    return route.continue();
                });
                await row.getByLabel('选用于新批次').check();
                const rejection = page.waitForResponse(response => response.request().method() === 'PUT'
                    && new URL(response.url()).pathname.endsWith('/assignment') && response.status() === 409);
                await row.getByRole('button', { name: '保存资料核对' }).click();
                await rejection;
                // The rejection handler refreshes the revision asynchronously before releasing its busy slot.
                await page.waitForFunction(() => document.getElementById('compliance-material-status')?.textContent.includes('合规操作正在处理或工作台维护中')
                    && document.querySelector('.compliance-materials > fieldset')?.disabled === false);
                assert.equal(rejected, 1, 'the write was rejected at the route boundary');
                // 节点侧读取也推进账本修订，必须在窗口外：窗口内零服务端接触即“账本无新增”的充分证据
                assert.equal(env.counters.posts, postsBefore, 'rejected writes never reached the compliance route');
                await page.unroute('**/api/pi/compliance/**');
                await row.getByRole('button', { name: '保存资料核对' }).click();
                try { await page.waitForFunction(() => document.querySelector('#compliance-material-status')?.textContent.includes('已保存资料核对')); }
                catch (error) {
                    console.log('faults f1: retry status — ' + JSON.stringify(await page.locator('#compliance-material-status').textContent().catch(() => '?')) + ', writes=' + JSON.stringify(env.counters.seen.slice(postsBefore)));
                    throw error;
                }
                const saved = (await env.api('GET', `/compliance/projects/${project.id}/documents`)).data.documents.find(d => d.name === '合同-2026-03-15.csv');
                assert.equal(saved.assignment.selected, true, 'retry persisted as a new operation');
                assert.equal(providerCalls.length, callsAtStart, 'zero provider calls across the fault and retry');
                record('F1', 'passed', 'busy-409 at route: ledger untouched, zero provider calls; retry persisted as a new operation');
                await page.context().close();
            }
            // ---- #2 已受理但响应丢失：route.fetch 后 abort；账本恰一次；重载视图以账本为准 ----
            if (wantEnv("f2")) {
                const { project } = await seededProject(env, { contracts: ['2026-03-20'], selectFirst: false, name: '示例工程丙', number: 'P-003' });
                const page = await browserPage(browser);
                const callsAtStart = providerCalls.length;
                if (dedicatedSessionId) {
                    await setSessionStorage(env, page, dedicatedSessionId);
                    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.abort());
                    await page.goto(env.origin + '/#/chat', { waitUntil: 'domcontentloaded', timeout: 120000 });
                    await waitForInputReady(page);
                    console.log('faults f2: warm compliance chat ready');
                } else {
                    await setSessionStorage(env, page, null);
                    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.abort());
                    dedicatedSessionId = await openComplianceChat(env, page);
                }
                await dismissUpdate(page);
                await openDrawerOnProject(env, page, /示例工程丙/, '合同-2026-03-20');
                const row = page.locator('[data-compliance-document]').filter({ hasText: '合同-2026-03-20' });
                await row.getByLabel('选用于新批次').check();
                let dropped = 0;
                await page.route('**/api/pi/compliance/**', async route => {
                    if (route.request().method() === 'PUT' && route.request().url().includes('/assignment') && dropped === 0) { dropped += 1; await route.fetch(); return route.abort(); }
                    return route.continue();
                });
                await row.getByRole('button', { name: '保存资料核对' }).click();
                await page.waitForTimeout(1200);
                const durable = (await env.api('GET', `/compliance/projects/${project.id}/documents`)).data.documents.find(d => d.name === '合同-2026-03-20.csv');
                assert.equal(durable.assignment.selected, true, 'the write landed exactly once despite the lost response');
                await page.unroute('**/api/pi/compliance/**');
                await page.locator('#pi-compliance-close').click();
                await page.locator('#pi-compliance-open').click();
                const projectButton = page.locator('.compliance-project-list').getByRole('button', { name: /示例工程丙/ }).first();
                if (await projectButton.isVisible().catch(() => false)) await projectButton.click();
                const reloaded = page.locator('[data-compliance-document]').filter({ hasText: '合同-2026-03-20' });
                await reloaded.locator('select').waitFor({ state: 'visible' });
                assert.equal(await reloaded.getByLabel('选用于新批次').isChecked(), true, 'reload shows the durable state, not the lost response');
                assert.equal(providerCalls.length, callsAtStart, 'no provider calls in a pure persistence fault');
                record('F2', 'passed', 'accepted-but-lost response: exactly one durable write; reload reflects the ledger');
                await page.context().close();
            }
            await env.cleanup();
        }
        // ---- #3 原操作仍在处理：识别门闩挂起 → pending；释放到真实终态；供应商恰一次 ----
        if (wantEnv("f3")) {
            const env = await assemble('f3'); const { project } = await seededProject(env, { scan: true });
            holdRecognitions = 1;
            const { pending: pendingBatch, batchId } = await startHeldBatch(env, project.id);
            const during = (await env.api('GET', '/compliance/batches/' + batchId)).data.batch;
            assert.equal(during.execution.status, 'running', 'operation still processing while held');
            releaseHeld.pop()();
            const done = await waitBatch(env, batchId, 'completed');
            assert.equal(done.fields.find(f => f.key === 'date').raw, '2026-03-01');
            assert.equal((await pendingBatch).status, 200, 'the settled batch POST reports the completed batch');
            assert.equal(providerCalls.filter(isRecognition).length, 1, 'exactly one provider call for the whole operation');
            record('F3', 'passed', 'held operation stayed pending, released to a real terminal state with one provider call');
            await env.cleanup();
        }
        // ---- #4 修订冲突：同修订并发写恰一方成功，败方被要求重新核对，修订只前进一次 ----
        if (wantEnv("f4")) {
            const env = await assemble('f4'); const { project } = await seededProject(env);
            const view = (await env.api('GET', '/compliance')).data;
            const payload = { requestId: randomUUID(), expectedRevision: view.revision, project: { name: '示例工程甲', number: 'P-001', identityConfirmed: true, applicability: { 'documents-identity': true, 'contract-deadline': true, 'feasibility-numbers': false, 'feasibility-order': false } } };
            const [first, second] = await Promise.all([
                fetch(env.origin + '/api/pi/compliance/projects/' + project.id, { method: 'PUT', headers: { Authorization: 'Bearer ' + env.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, project: { ...payload.project, organization: '甲方甲' } }) }),
                fetch(env.origin + '/api/pi/compliance/projects/' + project.id, { method: 'PUT', headers: { Authorization: 'Bearer ' + env.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, requestId: randomUUID(), project: { ...payload.project, organization: '乙方乙' } }) })
            ]);
            assert.deepEqual([first.status, second.status].sort(), [200, 409], 'exactly one concurrent writer wins');
            const loser = first.status === 409 ? first : second;
            assert.equal((await loser.json()).code, 'COMPLIANCE_STALE', 'loser is told to re-check');
            const after = (await env.api('GET', '/compliance/projects/' + project.id)).data.project;
            assert.equal(after.revision, 2, 'project revision advanced exactly once (create + one winner)');
            record('F4', 'passed', 'same-revision race: one winner, loser gets COMPLIANCE_STALE, revision advanced once');
            await env.cleanup();
        }
        // ---- #5 历史批次迟到：挂起 A（扫描件），B（文本）先完成；释放后结果各归其主 ----
        if (wantEnv("f5")) {
            const env = await assemble('f5');
            const a = await seededProject(env, { scan: true });
            // 批次运行与其他写入互斥：B 项目与批次先完成，再挂起 A 的识别步骤
            const projectB = (await env.write('/compliance/projects', { project: { name: '示例工程乙', number: 'P-002', identityConfirmed: true, applicability: { 'documents-identity': true, 'contract-deadline': true, 'feasibility-numbers': false, 'feasibility-order': false } } })).data.project;
            const docsB = (await env.write(`/compliance/projects/${projectB.id}/documents`, { sources: [
                { kind: 'upload', name: '通知书.csv', base64: Buffer.from('项目名称,项目编号,日期\n示例工程乙,P-002,2026-04-01\n').toString('base64') },
                { kind: 'upload', name: '合同.csv', base64: Buffer.from('项目名称,项目编号,日期\n示例工程乙,P-002,2026-04-05\n').toString('base64') }
            ] })).data.documents;
            assert.equal(docsB.length, 2, 'notice and contract must stay distinct');
            for (const [index, role] of ['award-notice', 'contract'].entries()) await env.write(`/compliance/documents/${docsB[index].id}/assignment`, { role, identityConfirmed: true, selected: true }, 'PUT');
            const batchB = (await env.write(`/compliance/projects/${projectB.id}/batches`)).data.batch;
            const doneB = await waitBatch(env, batchB.id, 'completed');
            const datesB = doneB.fields.filter(f => f.key === 'date').map(f => f.raw);
            assert.ok(datesB.includes('2026-04-01') && datesB.includes('2026-04-05'), 'batch B completed with its own parsed dates before A runs: ' + JSON.stringify(datesB));
            holdRecognitions = 1;
            const { batchId: batchA } = await startHeldBatch(env, a.project.id);
            recognitionFields = [{ key: 'date', raw: '2026-05-05', status: 'known', excerpt: '签订日期：2026-05-05', rect: [0, 0, 90, 20] }];
            releaseHeld.pop()();
            const doneA = await waitBatch(env, batchA, 'completed');
            recognitionFields = null;
            assert.ok(doneA.fields.some(f => f.key === 'date' && f.raw === '2026-05-05'), 'late result lands on batch A');
            const freshB = (await env.api('GET', '/compliance/batches/' + batchB.id)).data.batch;
            assert.deepEqual(freshB.fields.filter(f => f.key === 'date').map(f => f.raw), datesB, 'batch B view and revision untouched');
            record('F5', 'passed', 'late A result bound to A only; B kept its own fields and revision');
            await env.cleanup();
        }
            // ---- #6 停用期间在途：当前步骤保存，reason=disabled 暂停，停用后零调用 ----
        if (wantEnv("f6")) {
            const env = await assemble('f6'); const { project } = await seededProject(env, { scans: 2, selectedAll: true });
            holdRecognitions = 1;
            const { batchId } = await startHeldBatch(env, project.id);
            await env.write('/compliance/settings', { enabled: false }, 'PUT');
            releaseHeld.pop()();
            const view = await waitBatch(env, batchId, 'paused');
            assert.equal(view.execution.reason, 'disabled');
            const after = providerCalls.length;
            await sleep(1500);
            assert.equal(providerCalls.length, after, 'no provider calls while disabled');
            record('F6', 'passed', 'disable during flight: current step saved, paused with reason disabled, zero further calls');
            await env.cleanup();
        }
        // ---- #7 重启后未知步骤：SIGKILL 子进程 → 同身份重启 → 不自动重发，显式继续恰补一次 ----
        if (wantEnv("f7")) {
            const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-compliance-faults-fork-')));
            const agent = path.join(temporary, 'agent'), cwd7 = path.join(temporary, 'project'); fs.mkdirSync(agent); fs.mkdirSync(cwd7);
            process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = temporary; process.env.PI_OFFLINE = '1';
            fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'text', defaultProjectTrust: 'never', enableInstallTelemetry: false }));
            fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'vision', input: ['text', 'image'], contextWindow: 32000, maxTokens: 1000 }] } } }));
            const open = async () => {
                const child = fork(path.join(root, 'test/compliance-service-fixture.cjs'), [], { env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_PROJECT_ROOTS: temporary, PI_OFFLINE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
                child.stderr.on('data', () => {});
                forkedChild = child;
                const { origin: origin7 } = await new Promise((resolve, reject) => { child.once('message', message => resolve(message)); child.once('error', reject); });
                const api7 = async (method, route, body) => {
                    const res = await fetch(origin7 + '/api/pi' + route, { method, headers: { Authorization: 'Bearer synthetic-scans', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
                    const data = await res.json().catch(() => ({}));
                    return { status: res.status, data };
                };
                return { child, origin7, api7 };
            };
            let { child, api7 } = await open();
            let revision7 = (await api7('GET', '/compliance')).data.revision;
            const write7 = async (route, body = {}, method = 'POST') => {
                const result = await api7(method, route, { requestId: randomUUID(), expectedRevision: revision7, ...body });
                if (Number.isSafeInteger(result.data?.revision)) revision7 = result.data.revision;
                return result;
            };
            await write7('/compliance/settings', { enabled: true, mainModel: { provider: 'fixture', modelId: 'vision' }, extractionModel: { provider: 'fixture', modelId: 'vision' } }, 'PUT');
            const project7 = (await write7('/compliance/projects', { project: { name: '示例工程甲', number: 'P-001', identityConfirmed: true, applicability: { 'documents-identity': true, 'contract-deadline': true, 'feasibility-numbers': false, 'feasibility-order': false } } })).data.project;
            const docs7 = (await write7(`/compliance/projects/${project7.id}/documents`, { sources: [
                { kind: 'upload', name: '通知书.csv', base64: Buffer.from(noticeCsv).toString('base64') },
                { kind: 'upload', name: '合同扫描.png', base64: fs.readFileSync(scanPng(path.join(temporary, 'scan.png'))).toString('base64') }
            ] })).data.documents;
            await write7(`/compliance/documents/${docs7[0].id}/assignment`, { role: 'award-notice', identityConfirmed: true, selected: true }, 'PUT');
            await write7(`/compliance/documents/${docs7[1].id}/assignment`, { role: 'contract', identityConfirmed: true, selected: true }, 'PUT');
            holdRecognitions = 1;
            const { batchId: batch7 } = await startHeldBatch({ api: api7, write: write7 }, project7.id);
            child.kill('SIGKILL'); await once(child, 'exit'); forkedChild = null;
            releaseHeld.pop()(); // 释放旧挂起响应（写向已死连接，仅为清理 stub）
            const callsAtKill = providerCalls.length;
            ({ child, api7 } = await open());
            const restarted = await api7('GET', '/compliance/batches/' + batch7);
            assert.equal(restarted.status, 200, 'same identity dir restores the batch');
            const resumed = restarted.data.batch;
            // 被杀在途步骤标「请求待核对」（needs-review），检查点保留；显式继续只处理未启动步骤，不重发此请求
            assert.equal(resumed.execution.status, 'needs-review', 'killed in-flight step becomes needs-review, not a silent continuation');
            assert.equal(resumed.execution.steps.filter(s => s.status === 'uncertain').length, 1, 'the in-flight recognition step is marked uncertain');
            assert.ok(resumed.execution.steps.some(s => s.status === 'completed'), 'finished steps keep their checkpoints');
            await sleep(1500);
            assert.equal(providerCalls.length, callsAtKill, 'restart must not auto-reissue the model request');
            await api7('GET', '/compliance');
            const continued = await api7('POST', `/compliance/batches/${batch7}/continue`, { requestId: randomUUID(), expectedRevision: (await api7('GET', '/compliance')).data.revision, budget: { pages: 200, modelCalls: 10, runMs: 600000 } });
            assert.equal(continued.status, 200, JSON.stringify(continued.data));
            await sleep(1500);
            const settled7 = (await api7('GET', '/compliance/batches/' + batch7)).data.batch;
            assert.equal(settled7.execution.status, 'needs-review', 'continue only handles unstarted steps; the uncertain request is never replayed');
            assert.equal(providerCalls.length, callsAtKill, 'explicit continue does not re-issue the uncertain model request');
            record('F7', 'passed', 'hard restart preserved the checkpoint (needs-review with one uncertain step), no auto-replay, explicit continue issued zero calls');
            child.send({ type: 'close' }); await Promise.race([once(child, 'exit'), sleep(10000)]); try { child.kill('SIGKILL'); } catch { /* already gone */ } forkedChild = null;
            try { fs.rmSync(temporary, { recursive: true, force: true }); } catch (error) { console.log('faults f7: temp cleanup deferred (' + error.code + '), OS will reclaim'); }
        }
        assert.deepEqual(pageErrors, [], 'fault injection must not produce unhandled page errors');
    } catch (error) { console.error('[faults] failed: ' + (error?.stack || error)); process.exitCode = 1; }
    finally {
        clearInterval(heartbeat);
        if (forkedChild?.connected) { forkedChild.kill('SIGKILL'); }
        try { await Promise.race([activeEnv?.cleanup(), sleep(10000)]); } catch (error) { console.error('env cleanup: ' + error.message); }
        try { await Promise.race([browser.close(), sleep(10000)]); } catch (error) { console.error('browser close: ' + error.message); }
        if (evidencePath) { try { fs.mkdirSync(path.dirname(evidencePath), { recursive: true }); fs.writeFileSync(evidencePath, JSON.stringify({ finishedAt: new Date().toISOString(), providerCalls: providerCalls.length, records }, null, 2)); console.log('faults: evidence written to ' + evidencePath); } catch (error) { console.error('evidence write failed: ' + error.message); } }
        provider.closeAllConnections();
        // 僵尸 worker 的迟到重连可能让 close 永不返回：证据已落盘，超时即走
        await Promise.race([new Promise(resolve => provider.close(resolve)), sleep(5000)]);
        setTimeout(() => process.exit(process.exitCode || 0), 2000).unref();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
