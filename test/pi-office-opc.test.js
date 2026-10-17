const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { createHash } = require('node:crypto');
const fixture = require('./office-workbook-fixtures.cjs');
const { validateOfficeFormat } = require('../server/pi-office-format');
const { parseWorkbook } = require('../public/office-preview/parse');
const { parseDocument } = require('../server/pi-document-parser');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-office-opc-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(cwd); Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, PI_PROJECT_ROOTS: root, PI_OFFLINE: '1' });
const { PiSessionStore } = require('../server/pi-session-store'), { PiFileService } = require('../server/pi-file-service'), { DocumentUploads } = require('../server/pi-document-uploads');
const { OfficePreviewSources } = require('../server/pi-office-preview-sources');
const store = new PiSessionStore(), documents = new DocumentUploads({ store, supervisor: { removing: new Set(), moving: new Set(), getActiveWorker: () => null } });
const sources = new OfficePreviewSources({ files: new PiFileService(store), documents });
test.after(async () => { await documents.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
test('the shared format boundary accepts the Worker-supported OPC custom main part', () => {
    assert.deepEqual(validateOfficeFormat(fixture.workbook(), 'xlsx'), { format: 'xlsx' });
});
test('a real project source delivers a custom-main workbook unchanged to the bounded parser', async () => {
    const bytes = fixture.workbook(); fs.writeFileSync(path.join(cwd, 'custom.xlsx'), bytes);
    const original = await sources.read({ type: 'project', cwd, path: 'custom.xlsx' });
    assert.deepEqual(original.bytes, bytes); assert.equal(original.revision, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(parseWorkbook(original.bytes, 'xlsx').sheets[0].name, '销售');
});
function encodedFiles(strict, encoding) {
    const files = fixture.files({ strict });
    for (const name of Object.keys(files)) if (/\.(xml|rels)$/.test(name)) {
        const declaration = encoding === 'utf-8' ? 'UTF-8' : encoding === 'utf-16le' ? 'UTF-16LE' : 'UTF-16BE';
        const text = '<?xml version="1.0" encoding="' + declaration + '"?>' + files[name];
        const bytes = Buffer.from(text, encoding === 'utf-8' ? 'utf8' : 'utf16le');
        if (encoding === 'utf-16be') bytes.swap16();
        files[name] = encoding === 'utf-8' ? bytes : Buffer.concat([Buffer.from(encoding === 'utf-16le' ? [255,254] : [254,255]), bytes]);
    }
    return files;
}
test('Strict and Transitional UTF8 UTF16LE UTF16BE workbooks pass real project and upload source boundaries', async () => {
    const session = await store.createSession(cwd, 'OPC encoding fixtures');
    for (const strict of [false, true]) for (const encoding of ['utf-8', 'utf-16le', 'utf-16be']) {
        const bytes = fixture.zip(encodedFiles(strict, encoding)), name = `${strict}-${encoding}.xlsx`;
        assert.deepEqual(validateOfficeFormat(bytes, 'xlsx'), { format: 'xlsx' });
        fs.writeFileSync(path.join(cwd, name), bytes);
        const project = await sources.read({ type: 'project', cwd, path: name });
        const upload = await documents.upload({ cwd, sessionId: session.id, requestId: name, name }, bytes);
        const attachment = await sources.read({ type: 'upload', cwd, sessionId: session.id, id: upload.reference.id });
        for (const source of [project, attachment]) {
            assert.deepEqual(source.bytes, bytes); assert.equal(source.revision, createHash('sha256').update(bytes).digest('hex'));
            const model = parseWorkbook(source.bytes, 'xlsx'); assert.equal(model.sheets[0].cells[0].text, '中文 <img src=x onerror=alert(1)>');
        }
        assert.deepEqual(await parseDocument(bytes, 'xlsx', {}, true), { format: 'xlsx', valid: true });
    }
});
test('OPC main identity rejects duplicate roots, duplicate types, escape, external main and unknown URI', () => {
    const mutations = [
        files => files['_rels/.rels'] = files['_rels/.rels'].replace('</Relationships>', '<Relationship Id="second" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/book.xml"/></Relationships>'),
        files => files['_rels/.rels'] = files['_rels/.rels'].replace('Target="xl/book.xml"', 'Target="../xl/book.xml"'),
        files => files['_rels/.rels'] = files['_rels/.rels'].replace('Target="xl/book.xml"', 'Target="%78l/book.xml"'),
        files => files['_rels/.rels'] = files['_rels/.rels'].replace('Target="xl/book.xml"', 'TargetMode="External" Target="xl/book.xml"'),
        files => files['_rels/.rels'] = files['_rels/.rels'].replace('http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', 'urn:imposter/officeDocument'),
        files => files['[Content_Types].xml'] = files['[Content_Types].xml'].replace('</Types>', '<Override PartName="/xl/book.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'),
        files => files['xl/book.xml'] = files['xl/book.xml'].replace('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'urn:imposter')
    ];
    for (const mutate of mutations) { const files = fixture.files(); mutate(files); assert.throws(() => validateOfficeFormat(fixture.zip(files), 'xlsx'), { code: 'OFFICE_INVALID' }); }
});
test('XML byte encoding, declaration and dangerous entities remain strict through preview and modern upload validation', async () => {
    const { xml } = require('../server/pi-document-parser');
    const invalidParts = [
        Buffer.from('<?xml version="1.0" encoding="UTF-16"?><x/>'),
        Buffer.from('<?xml version="1.0" encoding="windows-1252"?><x/>'),
        Buffer.concat([Buffer.from([255,254]), Buffer.from('<?xml version="1.0" encoding="UTF-16BE"?><x/>', 'utf16le')]),
        Buffer.from([255,254,0x3c,0]),
        Buffer.from([255,254,0,0xd8]),
        Buffer.from([0x3c,0x78,0x3e,0xc0,0xaf,0x3c,0x2f,0x78,0x3e]),
        Buffer.from('<!DOCTYPE x [<!ENTITY e SYSTEM "https://invalid.example/private">]><x>&e;</x>'),
        Buffer.concat([Buffer.from([255,254]), Buffer.from('<!DOCTYPE x><x/>', 'utf16le')]),
        Buffer.from('<x>&#1;</x>')
    ];
    for (const part of invalidParts) assert.throws(() => xml(part), { code: 'DOCUMENT_FORMAT' });
    for (const part of invalidParts) {
        const files = fixture.files(); files['xl/book.xml'] = part; const bytes = fixture.zip(files);
        assert.throws(() => validateOfficeFormat(bytes, 'xlsx'), { code: 'OFFICE_INVALID' });
        await assert.rejects(parseDocument(bytes, 'xlsx', {}, true), { code: 'DOCUMENT_FORMAT' });
    }
});
test('Word and PPT external relations stay rejected while ordinary XLSX external links are inert and warned', () => {
    const external = '<Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="https://invalid.example/never-fetch"/>';
    const { docxFiles, pptxFiles } = require('./document-fixtures.cjs');
    for (const [format, factory] of [['docx', docxFiles], ['pptx', pptxFiles]]) {
        const files = factory(); files['_rels/.rels'] = files['_rels/.rels'].replace('</Relationships>', external + '</Relationships>');
        assert.throws(() => validateOfficeFormat(fixture.zip(files), format), { code: 'OFFICE_INVALID' });
    }
    const files = fixture.files(); files['_rels/.rels'] = files['_rels/.rels'].replace('</Relationships>', external + '</Relationships>');
    const bytes = fixture.zip(files); assert.deepEqual(validateOfficeFormat(bytes, 'xlsx'), { format: 'xlsx' });
    assert.ok(parseWorkbook(bytes, 'xlsx').warnings.some(w => w.includes('外部关系')));
});
test('modern Word reads and Excel/PPT inspection follow a relocated main part with the same internal relation checks', async () => {
    const { docxFiles, xlsxFiles, pptxFiles } = require('./document-fixtures.cjs');
    for (const [format, factory, oldMain, newMain] of [['docx', docxFiles, 'word/document.xml', 'word/main.xml'], ['xlsx', xlsxFiles, 'xl/workbook.xml', 'xl/book.xml'], ['pptx', pptxFiles, 'ppt/presentation.xml', 'ppt/main.xml']]) {
        const files = factory(); files[newMain] = files[oldMain]; delete files[oldMain];
        files['_rels/.rels'] = files['_rels/.rels'].replace(oldMain, newMain);
        files['[Content_Types].xml'] = files['[Content_Types].xml'].replace(oldMain, newMain);
        const oldRel = oldMain.replace(/([^/]+)$/, '_rels/$1.rels'), newRel = newMain.replace(/([^/]+)$/, '_rels/$1.rels');
        if (files[oldRel]) { files[newRel] = files[oldRel]; delete files[oldRel]; }
        const bytes = fixture.zip(files); assert.deepEqual(validateOfficeFormat(bytes, format), { format });
        const result = await parseDocument(bytes, format, format === 'docx' ? { action: 'read', count: 1 } : { action: 'inspect' });
        assert.equal(result.format, format); assert.ok(format === 'xlsx' ? result.sheets.length > 0 : result.total > 0);
    }
});
