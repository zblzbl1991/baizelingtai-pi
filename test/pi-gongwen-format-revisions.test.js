const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { GongwenProcess } = require('../server/gongwen/process');
const { officeZip } = require('../server/pi-document-parser');
const { paragraphsOf } = require('../vendor/gongwen-kit/lib/fix/comments');
const { rejectAll } = require('../vendor/gongwen-kit/lib/fix/revisions');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-format-revisions-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const request = layout => ({ requestId: 'format-revision', id: 'b'.repeat(64), action: 'revise', layout });
const read = (bytes, part = 'word/document.xml') => officeZip(bytes).read(part).toString('utf8');
async function fixture(paragraphs) {
    const filename = path.join(root, 'original.docx');
    await require('../vendor/gongwen-kit/tests/messy-docx').build(filename);
    const zip = await require('jszip').loadAsync(fs.readFileSync(filename));
    const document = await zip.file('word/document.xml').async('string');
    zip.file('word/document.xml', document.replace('<w:body>', `<w:body>${paragraphs}`));
    return zip.generateAsync({ type: 'nodebuffer' });
}

test('preserve-layout editing keeps italic, bold, font, size and color on both unchanged and tracked replacement text', async () => {
    const properties = '<w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="楷体"/><w:b/><w:i/><w:color w:val="123456"/><w:sz w:val="26"/></w:rPr>';
    const bytes = await fixture(`<w:p><w:r>${properties}<w:t>保留字形，筹画工作。</w:t></w:r></w:p>`);
    const before = Buffer.from(bytes), pool = new GongwenProcess();
    try {
        const output = await pool.run(request(false), undefined, { bytes });
        assert.equal(output.report.editing, 'complete', JSON.stringify(output.report));
        const after = read(output.bytes);
        assert.ok(after.includes('筹划'), 'text rules still produce a tracked replacement');
        const revised = [...after.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].find(match => match[0].includes('保留字形'))[0];
        const runProperties = [...revised.matchAll(/<w:rPr>[\s\S]*?<\/w:rPr>/g)].map(match => match[0]);
        assert.ok(runProperties.length >= 3);
        assert.ok(runProperties.every(value => value === properties), 'each split/replacement run retains exact character properties');
        assert.ok(!output.report.corrections.some(item => item.rules.includes('斜体改正体')));
        assert.deepEqual(output.report.formatChanges, []);
        assert.equal(output.report.formatChangesTotal, 0);
        assert.deepEqual(read(output.bytes, 'word/styles.xml'), read(bytes, 'word/styles.xml'));
        assert.deepEqual(paragraphsOf(rejectAll(after, output.report.revisionAuthor)).map(p => p.text), paragraphsOf(read(bytes)).map(p => p.text));
        assert.deepEqual(bytes, before);
    } finally { await pool.dispose(); }
});

test('large format audits disclose exact totals and bounded excerpts without dropping the revised document', async () => {
    const longFont = '示例字体'.repeat(80);
    const paragraphs = Array.from({ length: 210 }, () => `<w:p><w:r><w:rPr><w:rFonts w:ascii="${longFont}" w:eastAsia="${longFont}"/><w:sz w:val="24"/></w:rPr><w:t>普通正文。</w:t></w:r></w:p>`).join('');
    const bytes = await fixture(paragraphs), pool = new GongwenProcess();
    try {
        const output = await pool.run(request(true), undefined, { bytes });
        assert.equal(output.report.editing, 'complete', JSON.stringify(output.report));
        assert.equal(output.report.formatChangesTruncated, true);
        assert.ok(output.report.formatChanges.length > 0 && output.report.formatChanges.length <= 200);
        assert.equal(output.formatAudit.changes.length, 200, 'producer excerpt remains in the separately persisted audit');
        assert.equal(output.formatAudit.truncated, true);
        assert.ok(output.report.formatChangesTotal > 420, 'all changed properties are counted after excerpt budget is reached');
        assert.ok(output.report.formatChanges.some(item => item.beforeTruncated));
        for (const item of output.report.formatChanges) for (const value of Object.values(item)) if (typeof value === 'string') assert.ok(value.length <= 240);
        assert.ok(Buffer.byteLength(JSON.stringify(output.report)) <= 256 * 1024);
        assert.ok(read(output.bytes).includes('普通正文。'));
    } finally { await pool.dispose(); }
});

test('normative revision reports locatable actual format changes separately and preserves original and historical revisions', async () => {
    const bytes = await fixture(''), pool = new GongwenProcess();
    try {
        const output = await pool.run(request(true), undefined, { bytes });
        assert.equal(output.report.editing, 'complete', JSON.stringify(output.report));
        assert.equal(output.report.layoutApplied, true);
        const changes = output.report.formatChanges;
        assert.ok(Array.isArray(changes) && changes.length > 0, 'format changes are a separate reviewable list');
        assert.equal(output.report.formatChangesTotal, changes.length);
        assert.equal(output.report.formatChangesTruncated, false);
        const font = changes.find(item => item.where.includes('word/styles.xml') && item.property === 'w:rFonts' && item.before.includes('Times New Roman'));
        assert.ok(font, 'default font change identifies the actual style part and property');
        assert.ok(font.after.includes('FangSong'));
        const margin = changes.find(item => item.property === 'w:pgMar' && item.after.includes('2098'));
        assert.ok(margin?.where.includes('word/document.xml'));
        const footer = changes.find(item => /word\/pivane-footer/.test(item.where) && item.property === 'w:rFonts');
        assert.ok(footer, 'new page-number footer font is identified by its actual part path');
        assert.ok(footer.after.includes('SimSun'));
        assert.deepEqual(paragraphsOf(rejectAll(read(output.bytes), output.report.revisionAuthor)).map(p => p.text), paragraphsOf(read(bytes)).map(p => p.text));
        for (const fragment of require('../server/gongwen/revise').revisionFragments(read(bytes))) assert.ok(read(output.bytes).includes(fragment));
        assert.ok(!changes.some(item => item.where.includes('sectPrChange')), 'historical properties are not presented as current adjustments');
    } finally { await pool.dispose(); }
});

test('normative revision corrects a blue default body style while preserve-layout keeps the same original style bytes', async () => {
    const zip = await require('jszip').loadAsync(await fixture(''));
    const styles = (await zip.file('word/styles.xml').async('string')).replace('<w:qFormat/><w:pPr><w:widowControl', '<w:qFormat/><w:rPr><w:color w:val="2E74B5"/><w:i/></w:rPr><w:pPr><w:widowControl');
    zip.file('word/styles.xml', styles);
    const bytes = await zip.generateAsync({ type: 'nodebuffer' }), pool = new GongwenProcess();
    try {
        const preserved = await pool.run(request(false), undefined, { bytes });
        assert.equal(read(preserved.bytes, 'word/styles.xml'), styles);
        const revised = await pool.run(request(true), undefined, { bytes });
        assert.equal(revised.report.editing, 'complete', JSON.stringify(revised.report));
        const bodyStyle = read(revised.bytes, 'word/styles.xml').match(/<w:style\b[^>]*w:styleId="a"[^>]*>[\s\S]*?<\/w:style>/)[0];
        assert.match(bodyStyle, /<w:color w:val="000000"\/>/);
        assert.doesNotMatch(bodyStyle, /<w:i\/>/);
        assert.ok(revised.report.formatChanges.some(item => item.property === 'w:color' && item.before.includes('2E74B5') && item.after.includes('000000')));
    } finally { await pool.dispose(); }
});

test('recognized Title style is normalized to centered black 22pt small-title font without replacing custom styles', async () => {
    const zip = await require('jszip').loadAsync(await fixture('<w:p><w:pPr><w:pStyle w:val="Title"/><w:jc w:val="center"/></w:pPr><w:r><w:t>示例公文标题</w:t></w:r></w:p>'));
    const title = '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="a"/><w:pPr><w:jc w:val="left"/></w:pPr><w:rPr><w:color w:val="2E74B5"/><w:sz w:val="56"/></w:rPr></w:style>';
    zip.file('word/styles.xml', (await zip.file('word/styles.xml').async('string')).replace('</w:styles>', title + '</w:styles>'));
    const pool = new GongwenProcess();
    try {
        const output = await pool.run(request(true), undefined, { bytes: await zip.generateAsync({ type: 'nodebuffer' }) });
        assert.equal(output.report.editing, 'complete', JSON.stringify(output.report));
        const style = read(output.bytes, 'word/styles.xml').match(/<w:style\b[^>]*w:styleId="Title"[^>]*>[\s\S]*?<\/w:style>/)[0];
        assert.match(style, /<w:rFonts [^>]*w:eastAsia="方正小标宋简体"/);
        assert.match(style, /<w:sz w:val="44"\/>/);
        assert.match(style, /<w:color w:val="000000"\/>/);
        assert.match(style, /<w:jc w:val="center"\/>/);
    } finally { await pool.dispose(); }
});

test('normative revision orders added punctuation settings before an existing updateFields declaration', async () => {
    const zip = await require('jszip').loadAsync(await fixture(''));
    zip.file('word/settings.xml', (await zip.file('word/settings.xml').async('string')).replace('<w:compat>', '<w:updateFields w:val="true"/><w:compat>'));
    const pool = new GongwenProcess();
    try {
        const output = await pool.run(request(true), undefined, { bytes: await zip.generateAsync({ type: 'nodebuffer' }) });
        assert.equal(output.report.editing, 'complete', JSON.stringify(output.report));
        const settings = read(output.bytes, 'word/settings.xml');
        assert.ok(settings.indexOf('<w:characterSpacingControl') < settings.indexOf('<w:updateFields'));
    } finally { await pool.dispose(); }
});
