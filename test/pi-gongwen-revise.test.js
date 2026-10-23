const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const { GongwenProcess } = require('../server/gongwen/process');
const { GongwenService } = require('../server/gongwen/service');
const { validateRevision } = require('../server/gongwen/revision-input');
const { structure } = require('../server/gongwen/render');
const { officeZip } = require('../server/pi-document-parser');
const { paragraphsOf } = require('../vendor/gongwen-kit/lib/fix/comments');
const { rejectAll } = require('../vendor/gongwen-kit/lib/fix/revisions');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-gongwen-revise-test-')));
const agent = path.join(root, 'agent'), cwd = path.join(root, 'project'); fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const id = 'a'.repeat(64), request = extra => ({ requestId: 'revision', id, action: 'revise', layout: true, ...extra });
const text = bytes => officeZip(bytes).read('word/document.xml').toString('utf8');
const visible = value => paragraphsOf(value).map(p => p.text);
async function messy() { const file = path.join(root, 'messy.docx'); await require('../vendor/gongwen-kit/tests/messy-docx').build(file); return fs.readFileSync(file); }

test('revision parameters accept only attachment IDs and explicit options; paths, code, oversized and incomplete requests fail', () => {
    assert.deepEqual(validateRevision({ requestId: 'x', id }), { requestId: 'x', id, action: 'revise', layout: true });
    for (const invalid of [{ path: '../original.docx' }, { out: 'new.docx' }, { code: 'process.exit()' }, { action: 'delete' }, { layout: 'true' }, { title: '字'.repeat(161) }]) assert.throws(() => validateRevision({ ...request(), ...invalid }), { code: 'GONGWEN_INPUT' });
});

test('real handwritten DOCX receives tracked normalization and numeric comments; rejecting this round restores original text and preserves earlier revisions', async () => {
    const bytes = await messy(), before = Buffer.from(bytes), pool = new GongwenProcess();
    try {
        const output = await pool.run(request(), undefined, { bytes });
        assert.equal(output.report.editing, 'complete', JSON.stringify(output.report));
        assert.equal(output.report.layoutApplied, true); assert.equal(output.report.status, 'needs-review');
        assert.ok(output.report.corrections.length); assert.ok(output.report.comments.placed > 0);
        const original = text(bytes), revised = text(output.bytes);
        assert.deepEqual(visible(rejectAll(revised, output.report.revisionAuthor)), visible(original));
        for (const fragment of require('../server/gongwen/revise').revisionFragments(original)) assert.ok(revised.includes(fragment), 'existing revision remains byte-identical');
        assert.ok(revised.includes('w:author="审核人"')); assert.ok(revised.includes('筹划'));
        assert.ok(revised.includes('2100')); assert.deepEqual(bytes, before); await structure(output.bytes);
        const zip = officeZip(output.bytes); assert.ok(zip.names.includes('word/pivane-comments.xml'));
        assert.match(zip.read('word/pivane-comments.xml').toString('utf8'), /数字|严格数字/);
    } finally { await pool.dispose(); }
});

test('inspection keeps exact bytes; preserve-layout revision retains original page settings and tables', async () => {
    const bytes = await messy(), pool = new GongwenProcess();
    try {
        const inspected = await pool.run(request({ action: 'inspect' }), undefined, { bytes });
        assert.equal(inspected.report.editing, 'complete'); assert.deepEqual(inspected.bytes, bytes);
        assert.equal(inspected.report.layoutApplied, false); assert.equal(inspected.report.corrections.length, 0);
        const revised = await pool.run(request({ requestId: 'preserve', layout: false }), undefined, { bytes });
        assert.equal(revised.report.editing, 'complete'); assert.equal(revised.report.layoutApplied, false);
        const original = text(bytes), after = text(revised.bytes);
        assert.equal(after.match(/<w:sectPr>[\s\S]*<\/w:sectPr>/)[0], original.match(/<w:sectPr>[\s\S]*<\/w:sectPr>/)[0]);
        const withoutComments = value => value.replace(/<w:commentRange(?:Start|End)\b[^>]*\/>|<w:r><w:commentReference\b[^>]*\/><\/w:r>/g, '');
        assert.equal(withoutComments(after.match(/<w:tbl>[\s\S]*?<\/w:tbl>/)[0]), original.match(/<w:tbl>[\s\S]*?<\/w:tbl>/)[0]);
    } finally { await pool.dispose(); }
});

test('strict checks catch a small declared-table sum discrepancy without modifying cells; merged and undeclared tables disclose coverage', async () => {
    const { inspectTables } = require('../server/gongwen/revision-tables');
    const cell = value => `<w:tc><w:p><w:r><w:t>${value}</w:t></w:r></w:p></w:tc>`;
    const row = (values, head = false) => `<w:tr>${head ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${values.map(cell).join('')}</w:tr>`;
    const table = `<w:tbl>${row(['项目', '金额（元）'], true)}${row(['甲', '400'])}${row(['乙', '600'])}${row(['合计', '1004'])}</w:tbl>`;
    const doc = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${table}</w:body></w:document>`;
    const result = inspectTables(doc); assert.ok(result.errors.some(hit => hit.rule === '严格合计不符'));
    assert.ok(result.errors[0].anchors.every(anchor => anchor.table === 0));
    assert.ok(inspectTables(doc.replace('<w:tblHeader/>', '')).hints.some(hit => hit.detail.includes('未声明表头')));
    assert.ok(inspectTables(doc.replace('<w:tc>', '<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>')).hints.some(hit => hit.detail.includes('合并')));
});

test('revision versions preserve original identity, reuse complete requests and reject changed options or source bytes', async () => {
    const bytes = await messy(), reference = { id, format: 'docx', name: '培训通知.docx', size: bytes.length, revision: createHash('sha256').update(bytes).digest('hex') };
    const { PiSessionStore } = require('../server/pi-session-store'), service = new GongwenService(new PiSessionStore());
    const context = { cwd, sessionId: 'synthetic-revision' }, source = { reference, bytes };
    try {
        const saved = await service.revise(context, request({ layout: false }), source);
        assert.equal(saved.files[0].name, `培训通知-${saved.id.slice(0, 12)}-修订.docx`); assert.equal((await service.revise(context, request({ layout: false }), source)).reused, true);
        await assert.rejects(service.revise(context, request({ layout: true }), source), { code: 'GONGWEN_CONFLICT' });
        const originalOutput = fs.readFileSync(saved.files[0].path);
        const newVersion = await service.revise(context, request({ requestId: 'next', layout: false }), source);
        assert.notEqual(saved.id, newVersion.id); assert.deepEqual(fs.readFileSync(saved.files[0].path), originalOutput);
        await assert.rejects(service.revise(context, request({ requestId: 'wrong-source' }), { reference, bytes: Buffer.from('changed') }), { code: 'DOCUMENT_CHANGED' });
        for (const file of [...saved.files, ...saved.supplements]) require('./private-file-helper.cjs').assertPrivateFile(file.path);
    } finally { await service.dispose(); }
});

test('existing comment parts, bookmarks, hyperlinks and table digits survive; theme-colored templates preserve layout', async () => {
    const zip = await require('jszip').loadAsync(await messy());
    const comment = '<w:comment w:id="1500" w:author="原审阅人"><w:p><w:r><w:t>原有批注保留</w:t></w:r></w:p></w:comment>';
    zip.file('word/comments42.xml', `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${comment}</w:comments>`);
    let document = await zip.file('word/document.xml').async('string');
    document = document.replace('<w:body>', '<w:body><w:p><w:bookmarkStart w:id="1600" w:name="原书签"/><w:r><w:t>保留书签</w:t></w:r><w:bookmarkEnd w:id="1600"/></w:p>')
        .replace('>2100<', '>２１００<').replace('<w:color w:val="FF0000"/>', '<w:color w:val="FF0000" w:themeColor="accent1"/>')
        .replace('××市人民政府办公室', '筹画办公室');
    zip.file('word/document.xml', document);
    zip.file('word/styles.xml', (await zip.file('word/styles.xml').async('string')).replace('<w:color w:val="FF0000"/>', '<w:color w:themeColor="accent1"/>'));
    zip.file('word/_rels/document.xml.rels', (await zip.file('word/_rels/document.xml.rels').async('string')).replace('</Relationships>', '<Relationship Id="priorComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments42.xml"/></Relationships>'));
    zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml').async('string')).replace('</Types>', '<Override PartName="/word/comments42.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>'));
    const bytes = await zip.generateAsync({ type: 'nodebuffer' }), pool = new GongwenProcess();
    try {
        const output = await pool.run(request(), undefined, { bytes }); assert.equal(output.report.editing, 'complete', JSON.stringify(output.report));
        assert.equal(output.report.layoutApplied, false); assert.ok(output.report.hints.some(hit => hit.rule === '版式保留'));
        const after = text(output.bytes), parts = officeZip(output.bytes);
        assert.ok(after.includes('>筹画办公室<'), 'theme-colored agency names stay unchanged even when a normalization rule matches');
        assert.ok(after.includes('>２１００<')); assert.ok(after.includes('w:name="原书签"'));
        assert.ok(after.includes(document.match(/<w:hyperlink[\s\S]*?<\/w:hyperlink>/)[0]));
        assert.ok(parts.read('word/comments42.xml').toString('utf8').includes(comment));
        assert.ok(parts.read('word/_rels/document.xml.rels').toString('utf8').includes('Target="comments42.xml"'));
        assert.ok(!parts.names.includes('word/pivane-comments.xml'));
    } finally { await pool.dispose(); }
});

test('unsupported signed inputs deliver an unchecked exact original; malformed packages deliver no DOCX and cancelled work exits', async () => {
    const original = await messy(), zip = await require('jszip').loadAsync(original); zip.file('_xmlsignatures/origin.sigs', Buffer.from('synthetic signature marker'));
    const bytes = await zip.generateAsync({ type: 'nodebuffer' }), pool = new GongwenProcess();
    try {
        const output = await pool.run(request(), undefined, { bytes }); assert.equal(output.report.status, 'unchecked');
        assert.equal(output.report.originalSnapshot, true); assert.deepEqual(output.bytes, bytes);
        const invalid = await pool.run(request({ requestId: 'invalid' }), undefined, { bytes: Buffer.from('not an Office file') });
        assert.equal(invalid.report.status, 'failed'); assert.equal(invalid.bytes, null);
        const controller = new AbortController(), pending = pool.run(request({ requestId: 'abort' }), controller.signal, { bytes: original });
        controller.abort(); await assert.rejects(pending, { code: 'GONGWEN_ABORTED' }); assert.equal(pool.jobs.size, 0);
    } finally { await pool.dispose(); }
});

test('layout creates distinct footer resources and preserves colliding original parts and historical section references', async () => {
    const zip = await require('jszip').loadAsync(await messy());
    const prior = '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>原页脚保留</w:t></w:r></w:p></w:ftr>';
    zip.file('word/footerGwOdd.xml', prior);
    const rel = '<Relationship Id="rIdGwFtrOdd" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footerGwOdd.xml"/>';
    zip.file('word/_rels/document.xml.rels', (await zip.file('word/_rels/document.xml.rels').async('string')).replace('</Relationships>', rel + '</Relationships>'));
    zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml').async('string')).replace('</Types>', '<Override PartName="/word/footerGwOdd.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>'));
    const derivedStyle = '<w:style w:type="paragraph" w:styleId="DerivedRedHead"><w:name w:val="heading 1"/><w:basedOn w:val="RedHead"/><w:rPr><w:rFonts w:ascii="宋体" w:eastAsia="宋体"/><w:sz w:val="52"/></w:rPr></w:style>';
    zip.file('word/styles.xml', (await zip.file('word/styles.xml').async('string')).replace('</w:styles>', derivedStyle + '</w:styles>'));
    const original = (await zip.file('word/document.xml').async('string')).replace('<w:sectPrChange w:id="903"', '<w:sectPrChange w:id="903"')
        .replace('<w:sectPr><w:pgMar', '<w:sectPr><w:footerReference w:type="default" r:id="rIdGwFtrOdd"/><w:pgMar')
        .replace('w:val="RedHead"', 'w:val="DerivedRedHead"').replace('××市人民政府办公室', '筹画办公室');
    zip.file('word/document.xml', original);
    const pool = new GongwenProcess();
    try {
        const result = await pool.run(request(), undefined, { bytes: await zip.generateAsync({ type: 'nodebuffer' }) });
        assert.equal(result.report.editing, 'complete', JSON.stringify(result.report));
        const output = officeZip(result.bytes); assert.equal(output.read('word/footerGwOdd.xml').toString('utf8'), prior);
        assert.ok(output.read('word/_rels/document.xml.rels').toString('utf8').includes(rel));
        assert.equal(output.names.filter(name => /^word\/pivane-footer/.test(name)).length, 2);
        assert.ok(output.read('word/styles.xml').toString('utf8').includes(derivedStyle), 'inherited redhead styles retain their exact formatting');
        assert.ok(text(result.bytes).includes('>筹画办公室<'));
        for (const fragment of require('../server/gongwen/revise').revisionFragments(original)) assert.ok(text(result.bytes).includes(fragment));
    } finally { await pool.dispose(); }
});
