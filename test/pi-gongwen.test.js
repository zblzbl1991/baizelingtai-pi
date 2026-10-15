const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepare, validate, KINDS } = require('../server/gongwen/input');
const { decimal, equalSum, checkTables } = require('../server/gongwen/numbers');
const { GongwenProcess } = require('../server/gongwen/process');
const { GongwenService } = require('../server/gongwen/service');
const { inspect, correct } = require('../server/gongwen/checks');
const { structure } = require('../server/gongwen/render');
const { officeZip } = require('../server/pi-document-parser');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-gongwen-test-')));
const agent = path.join(root, 'agent'), cwd = path.join(root, 'project'); fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
const base = overrides => ({ requestId: 'fixture', kind: 'notice', title: '培训通知', recipient: '各部门', unit: '示例单位',
    date: '2026年10月15日', body: [{ type: 'paragraph', text: '现将有关事项通知如下。' }], ...overrides });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('input rejects unknown paths/code, ragged tables and excessive content; missing facts remain explicit drafts', () => {
    assert.throws(() => validate(base({ output: '../elsewhere.docx' })), /参数无效/);
    assert.throws(() => validate(base({ body: [{ type: 'code', text: 'process.exit()' }] })), /参数无效/);
    assert.throws(() => validate(base({ body: [{ type: 'table', head: ['项目', '金额'], rows: [['项目']] }] })), /参数无效/);
    assert.throws(() => validate(base({ body: [{ type: 'paragraph', text: '字'.repeat(6001) }] })), /参数无效/);
    const draft = prepare({ requestId: 'missing', kind: 'request', title: '培训请示', redhead: true, body: base().body });
    assert.equal(draft.unit, '【待补充落款单位】'); assert.equal(draft.date, '【待补充成文日期】');
    assert.ok(draft.missing.includes('签发人')); assert.ok(draft.signers[0].includes('待补充'));
    assert.equal(draft.docNo, '【待补充发文字号】');
});

test('strict arithmetic catches 0.4% discrepancies and uses exact decimals; percentages use printed rounding and complete scope', () => {
    assert.equal(equalSum(['0.1', '0.2'].map(decimal), decimal('0.3')), true);
    const table = { type: 'table', head: ['项目', '金额（元）'], rows: [['一', '400'], ['二', '600'], ['合计', '1004']] };
    assert.equal(checkTables([table]).errors.length, 1);
    assert.equal(table.rows[2][1], '1004');
    table.rows[2][1] = '1000'; assert.equal(checkTables([table]).errors.length, 0);
    const percent = { type: 'table', head: ['项目', '占比'], rows: [['甲', '33.3%'], ['乙', '33.3%'], ['丙', '33.3%']], numeric: [{ column: 2, kind: 'percent', complete: true }] };
    assert.equal(checkTables([percent]).errors.length, 0);
    percent.rows = [['甲', '40.0%'], ['乙', '50.0%']]; assert.equal(checkTables([percent]).errors.length, 1);
    percent.numeric[0].complete = false; assert.equal(checkTables([percent]).errors.length, 0);
    table.rows[0][1] = '【待补充】'; assert.equal(checkTables([table]).hints.length, 1);
    const grouped = { type: 'table', head: ['项目', '金额（元）'], rows: [['甲1', '1'], ['甲2', '2'], ['小计', '3'], ['乙1', '4'], ['乙2', '5'], ['小计', '9'], ['合计', '12']] };
    assert.equal(checkTables([grouped]).errors.length, 0);
    grouped.rows[5][1] = '8'; assert.ok(checkTables([grouped]).errors.length > 0);
    const mixed = { type: 'table', head: ['项目', '金额', '平均年龄', '合计'], rows: [['甲', '10', '30', '10']] };
    assert.equal(checkTables([mixed]).errors.length, 0); assert.equal(checkTables([mixed]).hints.length, 1);
});

test('normalization preserves quoted wording and all numeric table cells', () => {
    const input = prepare(base({ body: [{ type: 'heading', level: 1, text: '一、筹画工作' },
        { type: 'paragraph', text: '引用“筹画项目”原话，详见https://example.com/a?x=1。' },
        { type: 'table', head: ['项目', '金额'], rows: [['甲', '１２'], ['合计', '13']], numeric: [{ column: 2, kind: 'money' }] }] }));
    const result = correct(input);
    assert.equal(result.input.body[0].text, '筹划工作');
    assert.equal(result.input.body[1].text, input.body[1].text);
    assert.deepEqual(result.input.body[2], input.body[2]);
});

test('large reports stay bounded, retain totals and preserve complete original/revised source and correction records', async () => {
    const { finish, markdown } = require('../server/gongwen/report');
    const corrections = Array.from({ length: 500 }, (_, i) => ({ where: `构件 ${i}`, rules: ['规范文字'], before: '*'.repeat(6000), after: '_'.repeat(6000) }));
    const report = finish(prepare(base()), { errors: [], hints: [], styles: [], faults: [], stages: [] }, corrections, 1);
    assert.equal(report.truncated, true); assert.equal(report.status, 'needs-review');
    assert.equal(report.totals.corrections, 500); assert.ok(report.corrections.length < 500);
    assert.ok(Buffer.byteLength(JSON.stringify(report)) < 256 * 1024);
    assert.ok(Buffer.byteLength(markdown(report, 'fixture')) < 256 * 1024);
    const { PiSessionStore } = require('../server/pi-session-store');
    const service = new GongwenService(new PiSessionStore());
    const raw = base({ requestId: 'large-source', body: Array.from({ length: 10 }, () => ({ type: 'paragraph', text: '一,'.repeat(2900) })) });
    try {
        const saved = await service.generate({ cwd, sessionId: 'synthetic-session' }, raw);
        assert.equal(saved.files.length, 2); assert.equal(saved.report.truncated, true);
        assert.equal(saved.report.status, 'needs-review'); assert.equal(saved.report.machineChecks, 'passed');
        assert.equal(saved.report.totals.corrections, 10);
        const supplement = name => JSON.parse(fs.readFileSync(saved.supplements.find(file => file.name === name).path, 'utf8'));
        assert.deepEqual(supplement('原始草稿源.json'), raw);
        const audit = supplement('规范修正.json'); assert.equal(audit.length, 10);
        assert.equal(audit[0].before, raw.body[0].text); assert.ok(audit[0].after.includes('，'));
        assert.ok(fs.readFileSync(saved.files[1].path).length < 256 * 1024);
        assert.equal((await service.generate({ cwd, sessionId: 'synthetic-session' }, raw)).reused, true);
    } finally { await service.dispose(); }
});

test('isolated generation covers every kind, special redheads, tables and attachment pages', { timeout: 60000 }, async () => {
    const pool = new GongwenProcess();
    try {
        for (const kind of KINDS) {
            const result = await pool.run(prepare(base({ requestId: kind, kind, redhead: ['request', 'letter', 'minutes'].includes(kind),
                agency: '示例单位', docNo: '示发〔2026〕1号', signers: ['示例签发人'], mark: '工作会议纪要', issue: '〔2026〕第1期',
                attendees: kind === 'minutes' ? [['出席', '示例人员']] : undefined,
                body: [{ type: 'heading', level: 1, text: '有关事项' }, ...base().body,
                    { type: 'table', head: ['项目', '数量（项）'], rows: [['甲', '2'], ['乙', '3'], ['合计', '5']], numeric: [{ column: 2, kind: 'integer' }] }],
                attachments: [{ title: '安排表', body: [{ type: 'paragraph', text: '具体安排由各部门确认。' }] }] })));
            assert.ok(result.bytes?.length, JSON.stringify(result.report));
            await structure(result.bytes);
            assert.equal(result.report.machineChecks, 'passed', kind + JSON.stringify(result.report));
            assert.equal(result.report.rendering, 'not-verified');
            const xml = officeZip(result.bytes).read('word/document.xml').toString('utf8');
            assert.ok(xml.includes('安排表'));
        }
        const missing = await pool.run(prepare({ requestId: 'missing-runtime', kind: 'request', title: '培训请示', body: base().body }));
        assert.ok(missing.bytes); assert.equal(missing.report.status, 'needs-input');
        assert.ok(missing.report.missing.includes('落款单位'));
    } finally { await pool.dispose(); }
});

test('real check errors trigger at most two normalization rounds; numeric conflicts stay drafts and are never guessed away', async () => {
    const pool = new GongwenProcess();
    try {
        const result = await pool.run(prepare(base({ date: '2026年05月08日', body: [{ type: 'heading', level: 1, text: '一、筹画工作' },
            { type: 'paragraph', text: '现就有关事项作出安排。' }, { type: 'table', head: ['项目', '金额（元）'],
                rows: [['甲', '400'], ['乙', '600'], ['合计', '1004']], numeric: [{ column: 2, kind: 'money' }] }] })));
        assert.ok(result.report.rounds > 0 && result.report.rounds <= 2);
        assert.equal(result.input.date, '2026年5月8日'); assert.equal(result.input.body[0].text, '筹划工作');
        assert.equal(result.input.body[2].rows[2][1], '1004'); assert.equal(result.report.status, 'needs-review');
        assert.ok(result.report.errors.some(error => error.rule === '严格合计不符'));
        const file = path.join(root, 'checked.docx'); fs.writeFileSync(file, result.bytes);
        const checks = await inspect(file, result.input, { numbers: async () => { throw Error('synthetic fault'); } });
        assert.ok(checks.faults.some(fault => fault.stage === '数字')); assert.ok(checks.stages.some(stage => stage.stage === '文风' && stage.completed));
    } finally { await pool.dispose(); }
});

test('checkpoint timeout delivers only a verified draft; cancellation waits for exit and children receive no ambient credentials', { timeout: 15000 }, async () => {
    const fixture = path.join(__dirname, 'gongwen-fixture-worker.cjs');
    process.env.GONGWEN_TEST_TOKEN = 'synthetic-only';
    const pool = new GongwenProcess({ workerPath: fixture, timeout: 3000 });
    try {
        const success = await pool.run(prepare(base())); assert.equal(success.report.environmentClean, true);
        const draft = await pool.run(prepare(base({ requestId: 'checkpoint' })));
        assert.ok(draft.bytes); await structure(draft.bytes); assert.equal(draft.report.status, 'unchecked');
        assert.equal(draft.report.faults[0].code, 'GONGWEN_TIMEOUT'); assert.equal(pool.jobs.size, 0);
        const controller = new AbortController(), pending = pool.run(prepare(base({ requestId: 'abort' })), controller.signal);
        assert.equal(pool.jobs.size, 1); controller.abort();
        await assert.rejects(pending, error => error.code === 'GONGWEN_ABORTED'); assert.equal(pool.jobs.size, 0);
    } finally { delete process.env.GONGWEN_TEST_TOKEN; await pool.dispose(); }
    const failed = new GongwenProcess({ workerPath: fixture, timeout: 10 });
    try { const result = await failed.run(prepare(base({ requestId: 'abort' }))); assert.equal(result.bytes, null); assert.equal(result.report.status, 'failed'); }
    finally { await failed.dispose(); }
});

test('version outputs preserve files, reject changed IDs and incomplete requests, and enforce canonical project/private boundaries', async () => {
    const { PiSessionStore } = require('../server/pi-session-store');
    const service = new GongwenService(new PiSessionStore()), context = { cwd, sessionId: 'synthetic-session' };
    try {
        const saved = await service.generate(context, base()); const original = fs.readFileSync(saved.files[0].path);
        assert.equal(fs.readFileSync(path.join(cwd, '.pivane-gongwen/.gitignore'), 'utf8'), '*\n');
        for (const file of [...saved.files, saved.source]) require('./private-file-helper.cjs').assertPrivateFile(file.path);
        assert.equal(saved.files.length, 2); assert.equal((await service.generate(context, base())).reused, true);
        await assert.rejects(service.generate(context, base({ title: '改变标题' })), error => error.code === 'GONGWEN_CONFLICT');
        const revised = await service.generate(context, base({ requestId: 'revision', date: '2026年10月16日' }));
        assert.notEqual(saved.id, revised.id); assert.deepEqual(fs.readFileSync(saved.files[0].path), original);
        const controller = new AbortController();
        await assert.rejects(service.generate(context, base({ requestId: 'interrupted' }), controller.signal, () => controller.abort()));
        fs.appendFileSync(saved.files[0].path, 'changed');
        await assert.rejects(service.generate(context, base()), error => error.code === 'GONGWEN_CHANGED');
        const forbidden = path.join(cwd, '.ssh'); fs.mkdirSync(forbidden);
        await assert.rejects(service.generate({ cwd: forbidden, sessionId: 'synthetic-session' }, base()), /不提供网页预览/);
        const linkedProject = path.join(root, 'linked-project'); fs.mkdirSync(linkedProject);
        fs.symlinkSync(path.join(cwd, '.pivane-gongwen'), path.join(linkedProject, '.pivane-gongwen'), process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(service.generate({ cwd: linkedProject, sessionId: 'synthetic-session' }, base()), error => error.code === 'GONGWEN_CHANGED');
    } finally { await service.dispose(); }
    const interruption = new GongwenService(new (require('../server/pi-session-store').PiSessionStore)(), {
        process: { run: async () => { throw Error('synthetic crash'); }, dispose: async () => {} }
    });
    try {
        await assert.rejects(interruption.generate(context, base({ requestId: 'incomplete' })), /synthetic crash/);
        await assert.rejects(interruption.generate(context, base({ requestId: 'incomplete' })), error => error.code === 'GONGWEN_INCOMPLETE');
    } finally { await interruption.dispose(); }
});

test('pinned upstream positive samples and negative rule specimens remain valid under the root dependency lock', { timeout: 120000 }, async () => {
    const upstream = path.resolve(__dirname, '../vendor/gongwen-kit');
    for (const name of ['complete', 'gongwen-qingshi', 'gongwen-guanli', 'notice', 'xinhan', 'jiyao', 'qiye']) {
        const file = path.join(root, name + '.docx');
        const result = spawnSync(process.execPath, [path.join(upstream, 'templates', name + '.js'), file], { encoding: 'utf8', timeout: 15000, windowsHide: true });
        assert.equal(result.status, 0, result.stderr + result.stdout); await structure(fs.readFileSync(file));
    }
    const negative = spawnSync(process.execPath, [path.join(upstream, 'tests/negative.js')], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(negative.status, 0, negative.stderr + negative.stdout);
});
