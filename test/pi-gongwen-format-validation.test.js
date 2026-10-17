const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function fixture({ run = '', styles = '', document = '' } = {}) {
    const zip = new JSZip();
    zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="f1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>');
    zip.file('word/footer1.xml', `<w:ftr xmlns:w="${W}"><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="SimSun" w:eastAsia="SimSun"/><w:sz w:val="28"/></w:rPr><w:instrText>PAGE</w:instrText><w:t>1</w:t></w:r></w:p></w:ftr>`);
    zip.file('word/styles.xml', `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:eastAsia="FangSong" w:ascii="FangSong"/><w:sz w:val="32"/><w:color w:val="000000"/></w:rPr></w:rPrDefault></w:docDefaults>
        <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:ind w:firstLineChars="200"/><w:jc w:val="both"/></w:pPr></w:style>
        <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:eastAsia="方正小标宋简体" w:ascii="方正小标宋简体"/><w:sz w:val="44"/></w:rPr></w:style>${styles}</w:styles>`);
    zip.file('word/document.xml', `<w:document xmlns:w="${W}"><w:body>${document || `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>培训通知</w:t></w:r></w:p><w:p><w:r>${run}<w:t>各部门按计划参加培训。</w:t></w:r></w:p>`}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="2098" w:bottom="1984" w:left="1587" w:right="1474"/><w:docGrid w:type="linesAndChars" w:linePitch="579" w:charSpace="-842"/></w:sectPr></w:body></w:document>`);
    zip.file('word/document.xml', (await zip.file('word/document.xml').async('string')).replace('xmlns:w=', 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w=').replace('<w:sectPr>', '<w:sectPr><w:footerReference w:type="default" r:id="f1"/>'));
    return zip.generateAsync({ type: 'nodebuffer' });
}
test('electronic format reads final inherited values and locates direct run overrides', async () => {
    const { validateFormat } = require('../server/gongwen/format-validation');
    const good = await validateFormat(await fixture(), { operation: 'generate', kind: 'notice' });
    assert.equal(good.properties.status, 'passed', JSON.stringify(good));
    const bad = await validateFormat(await fixture({ run: '<w:rPr><w:sz w:val="20"/><w:color w:val="0000FF"/></w:rPr>' }), { operation: 'generate', kind: 'notice' });
    assert.equal(bad.properties.status, 'failed');
    assert.ok(bad.checks.some(c => c.status === 'fail' && c.location.paragraph === 2 && c.location.run === 1 && c.actual.size === 10));
    assert.equal(bad.rendering, undefined);
});
test('all section geometry is checked and missing required properties remain incomplete', async () => {
    const { validateFormat } = require('../server/gongwen/format-validation');
    const zip = await JSZip.loadAsync(await fixture());
    const document = await zip.file('word/document.xml').async('string');
    zip.file('word/document.xml', document.replace('w:top="2098"', 'w:top="1000"'));
    const result = await validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'generate' });
    assert.ok(result.checks.some(c => c.id === 'page-margins' && c.status === 'fail' && c.location.section === 1));
    zip.file('word/document.xml', document.replace('<w:pgSz w:w="11906" w:h="16838"/>', ''));
    const missing = await validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'generate' });
    assert.equal(missing.properties.status, 'incomplete');
});
test('ambiguous inheritance and unresolved theme properties cannot pass; character styles override paragraph styles', async () => {
    const { validateFormat } = require('../server/gongwen/format-validation');
    const themed = await validateFormat(await fixture({ run: '<w:rPr><w:rFonts w:eastAsiaTheme="majorEastAsia"/></w:rPr>' }), { operation: 'generate' });
    assert.equal(themed.properties.status, 'incomplete');
    const mixed = await validateFormat(await fixture({ styles: '<w:style w:type="character" w:styleId="Small"><w:rPr><w:sz w:val="18"/></w:rPr></w:style>', run: '<w:rPr><w:rStyle w:val="Small"/></w:rPr>' }), { operation: 'generate' });
    assert.ok(mixed.checks.some(c => c.status === 'fail' && c.actual.size === 9));
    const duplicate = await validateFormat(await fixture({ styles: '<w:style w:type="paragraph" w:styleId="Title"/>' }), { operation: 'generate' });
    assert.equal(duplicate.properties.status, 'failed');
    const cycle = await validateFormat(await fixture({ styles: '<w:style w:type="character" w:styleId="Loop"><w:basedOn w:val="Loop"/></w:style>' }), { operation: 'generate' });
    assert.equal(cycle.properties.status, 'failed');
    const preserved = await validateFormat(await fixture({ run: '<w:rPr><w:sz w:val="20"/></w:rPr>' }), { operation: 'revise', layoutApplied: false });
    assert.equal(preserved.scope, 'reference');
    assert.ok(preserved.checks.every(c => c.status === 'not-applicable'));
    assert.notEqual(preserved.status, 'passed');
});
test('inherited toggled emphasis and alternate namespace bindings cannot hide nonconforming effective properties', async () => {
    const { validateFormat } = require('../server/gongwen/format-validation');
    const bold = await validateFormat(await fixture({ styles: '<w:style w:type="character" w:styleId="Strong"><w:rPr><w:b/><w:i/></w:rPr></w:style>', run: '<w:rPr><w:rStyle w:val="Strong"/></w:rPr>' }), { operation: 'generate' });
    assert.ok(bold.checks.some(c => c.status === 'fail' && c.actual.bold && c.actual.italic));
    const zip = await JSZip.loadAsync(await fixture());
    const document = await zip.file('word/document.xml').async('string');
    zip.file('word/document.xml', document.replaceAll('w:', 'z:').replace('xmlns:w=', 'xmlns:z='));
    const alias = await validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'generate' });
    assert.equal(alias.properties.status, 'passed');
    zip.file('word/document.xml', document.replace('<w:body>', '<w:body xmlns:w="urn:unrelated">'));
    const foreign = await validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'generate' });
    assert.equal(foreign.properties.status, 'incomplete');
});
test('font availability comes from a bounded local probe and distinguishes unavailable probes from missing families', async () => {
    const { probeFontAvailability } = require('../server/gongwen/font-availability');
    const unsupported = await probeFontAvailability({ platform: 'unsupported' });
    assert.equal(unsupported.status, 'unknown');
    assert.ok(unsupported.fonts.every(f => f.status === 'unknown'));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(probeFontAvailability({ signal: controller.signal }));
    if (process.platform === 'win32') {
        const actual = await probeFontAvailability();
        assert.notEqual(actual.status, 'unknown', JSON.stringify(actual));
        assert.ok(actual.fonts.some(f => f.requested === '仿宋'));
        assert.ok(actual.fonts.every(f => ['available', 'missing'].includes(f.status)));
    }
});
test('real generation reports electronic properties separately from local font absence and unrun Office rendering', async () => {
    const { GongwenProcess } = require('../server/gongwen/process');
    const { prepare } = require('../server/gongwen/input');
    const pool = new GongwenProcess();
    try {
        const result = await pool.run(prepare({ requestId: 'format-report', kind: 'notice', title: '培训通知', recipient: '各部门', unit: '示例单位', date: '2026年10月17日', body: [{ type: 'paragraph', text: '请各部门按计划参加培训。' }] }));
        assert.equal(result.report.format.properties.status, 'passed', JSON.stringify(result.report));
        assert.equal(result.report.machineChecks, 'passed');
        assert.equal(result.report.rendering, 'not-verified');
        assert.ok(result.report.format.fontAvailability.fonts.length);
    } finally { await pool.dispose(); }
});
test('combined format changes, checks and text findings share one bounded report and preserve totals', () => {
    const { finish, boundReport, markdown } = require('../server/gongwen/report');
    const large = Array.from({ length: 200 }, (_, i) => ({ where: `word/document.xml/p[${i}]` + '*'.repeat(240), property: '字体', before: '甲'.repeat(240), after: '乙'.repeat(240) }));
    const report = finish({ title: '示例', kind: 'existing' }, { errors: [], hints: [], styles: [], faults: [], stages: [] });
    report.formatChanges = large; report.formatChangesTotal = 900; report.formatChangesTruncated = true;
    report.format = { standard: 'GB/T 9704—2012', status: 'incomplete', properties: { status: 'passed' }, fontAvailability: { status: 'unknown', fonts: [] },
        checks: large.map(item => ({ id: 'body', status: 'fail', location: { part: item.where }, expected: { font: item.before }, actual: { font: item.after } })), total: 800, truncated: true, preview: { status: 'not-verified' } };
    const bounded = boundReport(report);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 128 * 1024);
    const text = markdown(bounded, 'fixture'); assert.ok(Buffer.byteLength(text) < 256 * 1024);
    assert.equal(bounded.formatChangesTotal, 900); assert.equal(bounded.format.total, 800);
    assert.ok(bounded.truncated); assert.match(text, /直接格式调整/); assert.match(text, /不能通过拒绝文字修订撤回/);
});
test('revision persists format audit alongside compatible sources and reuses exact delivered bytes', async () => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { createHash } = require('node:crypto');
    const { GongwenService } = require('../server/gongwen/service'), { PiSessionStore } = require('../server/pi-session-store');
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-format-audit-'))), file = path.join(root, 'original.docx');
    await require('../vendor/gongwen-kit/tests/messy-docx').build(file); const bytes = fs.readFileSync(file);
    const id = 'a'.repeat(64), source = { bytes, reference: { id, name: '示例.docx', format: 'docx', size: bytes.length, revision: createHash('sha256').update(bytes).digest('hex') } };
    const service = new GongwenService(new PiSessionStore()), context = { cwd: root, sessionId: 'synthetic-format-audit' }, request = { requestId: 'audit', id, layout: true };
    try {
        const saved = await service.revise(context, request, source);
        const audit = saved.supplements.find(item => item.name === '格式调整.json'); assert.ok(audit);
        assert.ok(JSON.parse(fs.readFileSync(audit.path, 'utf8')).changes.length);
        const reused = await service.revise(context, request, source); assert.equal(reused.reused, true);
        assert.deepEqual(fs.readFileSync(saved.files[0].path), fs.readFileSync(reused.files[0].path)); assert.equal(saved.files.length, 2);
    } finally { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('mixed Latin text and referenced page numbers are checked rather than inheriting Chinese font success', async () => {
    const { validateFormat } = require('../server/gongwen/format-validation');
    const zip = await JSZip.loadAsync(await fixture());
    let doc = await zip.file('word/document.xml').async('string');
    doc = doc.replace('各部门按计划参加培训。', 'Training 2026');
    zip.file('word/document.xml', doc.replace('<w:r><w:t>Training', '<w:r><w:rPr><w:rFonts w:ascii="Arial"/></w:rPr><w:t>Training'));
    zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="f1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>');
    zip.file('word/footer1.xml', `<w:ftr xmlns:w="${W}"><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Arial"/><w:sz w:val="20"/></w:rPr><w:instrText>PAGE</w:instrText><w:t>1</w:t></w:r></w:p></w:ftr>`);
    const result = await validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'generate' });
    assert.ok(result.checks.some(c => c.status === 'fail' && c.actual.asciiFont === 'Arial' && c.location.paragraph === 2));
    assert.ok(result.checks.some(c => c.id === 'page-number' && c.status === 'fail' && c.location.part === 'word/footer1.xml'));
});
test('generated special roles keep their own profiles across all seven document kinds', async () => {
    const { GongwenProcess } = require('../server/gongwen/process'), { prepare, KINDS } = require('../server/gongwen/input');
    const pool = new GongwenProcess();
    try {
        for (const kind of KINDS) {
            const result = await pool.run(prepare({ requestId: 'roles-' + kind, kind, title: '培训通知', recipient: '各部门', unit: '示例单位', date: '2026年10月17日',
                redhead: ['request', 'letter', 'minutes'].includes(kind), agency: '示例单位', docNo: '示发〔2026〕1号', signers: ['示例人员'], mark: '培训会议纪要', issue: '〔2026〕第1期',
                attendees: kind === 'minutes' ? [['出席', '示例人员']] : undefined, issuer: '示例单位', copyTo: ['示例管理部门'],
                body: [{ type: 'heading', level: 1, text: '有关安排' }, { type: 'heading', level: 2, text: '组织实施' }, { type: 'paragraph', text: '请各部门参加培训。' },
                    { type: 'table', caption: '参训安排', head: ['部门', '人数'], rows: [['部门甲', '20']] }], attachments: [{ title: '培训安排', body: [{ type: 'paragraph', text: '按确认时间执行。' }] }] }));
            assert.equal(result.report.format.properties.status, 'passed', kind + JSON.stringify(result.report.format.checks.filter(c => ['fail', 'incomplete'].includes(c.status))));
        }
    } finally { await pool.dispose(); }
});
test('format errors do not hide a prior required-check fault and literal footer text is not a PAGE field', async () => {
    const { finish, includeFormat } = require('../server/gongwen/report');
    const report = finish({ title: '示例' }, { errors: [], hints: [], styles: [], faults: [{ stage: '数字', code: 'GONGWEN_CHECK' }], stages: [] });
    includeFormat(report, { properties: { status: 'failed' }, fontAvailability: { status: 'available' } });
    assert.equal(report.machineChecks, 'incomplete'); assert.equal(report.status, 'unchecked'); assert.ok(report.errors.length);
    const zip = await JSZip.loadAsync(await fixture());
    zip.file('word/footer1.xml', (await zip.file('word/footer1.xml').async('string')).replace('<w:instrText>PAGE</w:instrText>', ''));
    const result = await require('../server/gongwen/format-validation').validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'generate' });
    assert.ok(result.checks.some(c => c.id === 'page-number-field' && c.status === 'fail'));
    assert.ok(result.checks.some(c => ['body-line-spacing', 'body-grid-spacing'].includes(c.id)));
});
test('numbering marker fonts are resolved independently of the heading text font', async () => {
    const zip = await JSZip.loadAsync(await fixture({ styles: '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:eastAsia="SimHei" w:ascii="SimHei"/></w:rPr></w:style>' }));
    zip.file('word/document.xml', (await zip.file('word/document.xml').async('string')).replace('<w:p><w:r><w:t>各部门', '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>各部门'));
    zip.file('word/numbering.xml', `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1、"/><w:rPr><w:rFonts w:eastAsia="Arial" w:ascii="Arial"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
    const result = await require('../server/gongwen/format-validation').validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'generate' });
    assert.ok(result.checks.some(c => c.id === 'numbering-marker' && c.status === 'fail' && c.actual.font === 'Arial'));
});
test('normative revision distinguishes a flush-left addressee from actual body indentation errors', async () => {
    const zip = await JSZip.loadAsync(await fixture());
    let document = await zip.file('word/document.xml').async('string');
    document = document.replace('<w:p><w:r><w:t>各部门按计划参加培训。</w:t></w:r></w:p>', '<w:p><w:pPr><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr><w:r><w:t>各部门：</w:t></w:r></w:p><w:p><w:pPr><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr><w:r><w:t>请按计划参加培训。</w:t></w:r></w:p>');
    zip.file('word/document.xml', document);
    const result = await require('../server/gongwen/format-validation').validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'revise', layoutApplied: true });
    assert.ok(!result.checks.some(c => c.id === 'body-indent' && c.location.paragraph === 2 && c.status === 'fail'), 'legal addressee is not body');
    assert.ok(result.checks.some(c => c.id === 'recipient' && c.location.paragraph === 2 && c.status === 'pass'));
    assert.ok(result.checks.some(c => c.id === 'body-indent' && c.location.paragraph === 3 && c.status === 'fail'), 'real body still requires two-character indentation');
    zip.file('word/document.xml', document.replace('各部门：', '有关工作安排如下：'));
    const uncertain = await require('../server/gongwen/format-validation').validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'revise', layoutApplied: true });
    assert.ok(uncertain.checks.some(c => c.id === 'role-coverage' && c.location.paragraph === 2 && c.status === 'incomplete'));
});
test('body grid checks use an enabled line grid in the paragraph own section and inherited snap setting', async () => {
    const { validateFormat } = require('../server/gongwen/format-validation');
    const zip = await JSZip.loadAsync(await fixture());
    const original = await zip.file('word/document.xml').async('string');
    const finalSection = original.match(/<w:sectPr>[\s\S]*?<\/w:sectPr>/)[0];
    const disabledSection = finalSection.replace('w:type="linesAndChars"', 'w:type="default"');
    const twoSections = original.replace('<w:p><w:r><w:t>各部门', `<w:p><w:pPr>${disabledSection}</w:pPr><w:r><w:t>各部门`)
        .replace(finalSection + '</w:body>', '<w:p><w:r><w:t>第二节正文。</w:t></w:r></w:p>' + finalSection + '</w:body>');
    zip.file('word/document.xml', twoSections);
    let result = await validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'generate' });
    assert.ok(result.checks.some(c => c.id === 'line-grid' && c.location.section === 1 && c.status === 'fail'));
    assert.ok(result.checks.some(c => c.id === 'body-grid-spacing' && c.location.paragraph === 2 && c.location.section === 1 && c.status === 'fail'));
    assert.ok(result.checks.some(c => c.id === 'body-grid-spacing' && c.location.paragraph === 3 && c.location.section === 2 && c.status === 'pass'));
    zip.file('word/document.xml', original.replace('w:type="linesAndChars"', 'w:type="lines"'));
    result = await validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'generate' });
    assert.ok(result.checks.some(c => c.id === 'body-grid-spacing' && c.status === 'pass'), 'lines also enables a line grid');
    const styles = await zip.file('word/styles.xml').async('string');
    zip.file('word/styles.xml', styles.replace('<w:ind w:firstLineChars="200"/>', '<w:snapToGrid w:val="off"/><w:ind w:firstLineChars="200"/>'));
    result = await validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'generate' });
    assert.ok(result.checks.some(c => c.id === 'body-grid-spacing' && c.status === 'fail' && c.actual.snapToGrid === false));
    zip.file('word/document.xml', original.replace('w:type="linesAndChars"', 'w:type="snapToChars"'));
    result = await validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'generate' });
    assert.ok(result.checks.some(c => c.id === 'line-grid' && c.status === 'fail'), 'character-only grid cannot prove line spacing');
});
test('page-number checks include final black color and normal emphasis with inherited toggle semantics', async () => {
    const { validateFormat } = require('../server/gongwen/format-validation');
    const zip = await JSZip.loadAsync(await fixture());
    const footer = await zip.file('word/footer1.xml').async('string');
    let result = await validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'generate' });
    assert.ok(result.checks.some(c => c.id === 'page-number' && c.status === 'pass' && c.actual.color === '000000' && c.actual.bold === false && c.actual.italic === false));
    zip.file('word/footer1.xml', footer.replace('<w:rPr>', '<w:rPr><w:color w:val="FF0000"/><w:b/><w:i/>'));
    result = await validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'generate' });
    assert.ok(result.checks.some(c => c.id === 'page-number' && c.status === 'fail' && c.actual.color === 'FF0000' && c.actual.bold && c.actual.italic));
    const styles = await zip.file('word/styles.xml').async('string');
    zip.file('word/styles.xml', styles.replace('</w:styles>', '<w:style w:type="paragraph" w:styleId="FooterBase"><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:i/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="FooterClear"><w:basedOn w:val="FooterBase"/><w:rPr><w:b/><w:i/></w:rPr></w:style></w:styles>'));
    zip.file('word/footer1.xml', footer.replace('<w:pPr>', '<w:pPr><w:pStyle w:val="FooterBase"/>'));
    result = await validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'generate' });
    assert.ok(result.checks.some(c => c.id === 'page-number' && c.status === 'fail' && c.actual.bold && c.actual.italic));
    zip.file('word/footer1.xml', footer.replace('<w:pPr>', '<w:pPr><w:pStyle w:val="FooterClear"/>'));
    result = await validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'generate' });
    assert.ok(result.checks.some(c => c.id === 'page-number' && c.status === 'pass' && !c.actual.bold && !c.actual.italic));
});
test('body, footer and header apply the same paragraph and character style type checks', async () => {
    const { validateFormat } = require('../server/gongwen/format-validation');
    for (const story of ['body', 'footer', 'header']) for (const invalidType of ['paragraph', 'character']) {
        const zip = await JSZip.loadAsync(await fixture({ styles: '<w:style w:type="character" w:styleId="CharacterOnly"><w:rPr><w:b/></w:rPr></w:style>' }));
        let part = 'word/document.xml', source = await zip.file(part).async('string');
        if (story === 'footer') { part = 'word/footer1.xml'; source = await zip.file(part).async('string'); }
        if (story === 'header') {
            zip.file('word/document.xml', source.replace('<w:sectPr>', '<w:sectPr><w:headerReference w:type="first" r:id="h1"/>'));
            zip.file('word/_rels/document.xml.rels', (await zip.file('word/_rels/document.xml.rels').async('string')).replace('</Relationships>', '<Relationship Id="h1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>'));
            part = 'word/header1.xml';
            source = `<w:hdr xmlns:w="${W}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:rFonts w:eastAsia="方正小标宋简体" w:ascii="方正小标宋简体"/><w:sz w:val="44"/><w:color w:val="FF0000"/></w:rPr><w:t>示例单位</w:t></w:r></w:p></w:hdr>`;
        }
        if (invalidType === 'paragraph') source = story === 'body'
            ? source.replace('<w:p><w:r><w:t>各部门', '<w:p><w:pPr><w:pStyle w:val="CharacterOnly"/></w:pPr><w:r><w:t>各部门')
            : source.replace('<w:pPr>', '<w:pPr><w:pStyle w:val="CharacterOnly"/>');
        else source = story === 'body'
            ? source.replace('<w:r><w:t>各部门', '<w:r><w:rPr><w:rStyle w:val="Normal"/></w:rPr><w:t>各部门')
            : source.replace('<w:rPr>', '<w:rPr><w:rStyle w:val="Normal"/>');
        zip.file(part, source);
        const result = await validateFormat(await zip.generateAsync({ type: 'nodebuffer' }), { operation: 'generate', kind: 'letter', redhead: true });
        assert.ok(result.checks.some(c => c.id === 'format-definition' && c.status === 'fail' && c.location.part === part), story + '/' + invalidType + JSON.stringify(result.checks));
    }
});
