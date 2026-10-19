const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseWorkbook, validateWorkbook } = require('../public/office-preview/parse');
const fixture = require('./office-workbook-fixtures.cjs');
test('independent LibreOffice XLS retains Chinese saved text and explicit approximation', () => {
    const bytes = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/office/preview.xls'));
    const model = parseWorkbook(bytes, 'xls');
    assert.equal(model.sheets[0].cells[0].value, 'Office preview 中文文档');
    assert.match(model.warnings.join(' '), /字体、边框/);
});
test('BIFF5 codepage 936 is decoded and a declared huge rectangle is rejected before returning cells', () => {
    const model = parseWorkbook(fixture.xlsBiff5(), 'xls');
    assert.equal(model.sheets[0].cells[0].value, '中文');
    assert.equal(model.sheets[0].cells[1].value, 42);
    assert.throws(() => parseWorkbook(fixture.xlsBiff5({ rows: 60000, columns: 256 }), 'xls'), /预算/);
    const damaged = fixture.xlsBiff5(); damaged.writeUInt32LE(0xffffffff, 512 + 512 + 128 + 120);
    assert.throws(() => parseWorkbook(damaged, 'xls'), { code: 'OFFICE_WORKBOOK_LIMIT' });
});
test('independent BIFF formula caches, multiple sheets, merges and hidden dimensions remain read-only', () => {
    const model = parseWorkbook(fixture.xlsBiff5({ rich: true }), 'xls'), sheet = model.sheets[0];
    assert.equal(model.sheets.length, 2);
    assert.equal(sheet.cells.find(c => c.r === 2).formula, '1+1');
    assert.equal(sheet.cells.find(c => c.r === 2).value, 0); // deliberately stale cache, never recomputed
    assert.equal(sheet.cells.find(c => c.r === 3).value, false);
    assert.equal(sheet.cells.find(c => c.r === 4).value, '');
    assert.deepEqual(sheet.merges[0], { r: 6, c: 0, rows: 2, columns: 2 });
    assert.equal(sheet.rowHeights[0].hidden, true); assert.equal(sheet.columnWidths[0].hidden, true);
});
test('real OPC workbook preserves cached zero, false, empty and absent results with safe literal text', () => {
    const model = parseWorkbook(fixture.workbook(), 'xlsx');
    validateWorkbook(model);
    assert.equal(model.sheets[0].name, '销售');
    const cells = model.sheets[0].cells;
    assert.equal(cells[0].text, '中文 <img src=x onerror=alert(1)>');
    assert.equal(cells[1].value, 0); assert.equal(cells[2].value, false); assert.equal(cells[3].value, '');
    assert.equal(Object.hasOwn(cells[4], 'value'), false);
    assert.equal(cells[4].formula, 'NOW()');
    assert.match(model.warnings.join(' '), /缓存/);
});
test('damaged containers, unsafe relationships, namespaces and expansion budgets refuse a complete-looking preview', () => {
    const badCrc = Buffer.from(fixture.workbook()); badCrc[14] ^= 1;
    assert.throws(() => parseWorkbook(badCrc, 'xlsx'), /CRC/);
    for (const change of [
        files => files['xl/_rels/book.xml.rels'] = files['xl/_rels/book.xml.rels'].replace('sheets/one.xml', '../../escape.xml'),
        files => files['xl/sheets/one.xml'] = files['xl/sheets/one.xml'].replace('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'urn:evil'),
        files => files['xl/sheets/one.xml'] = '<!DOCTYPE worksheet [<!ENTITY x "bad">]>' + files['xl/sheets/one.xml'],
        files => files['xl/sheets/one.xml'] = files['xl/sheets/one.xml'].replace('A1:D8', 'A1:XFD1048576'),
        files => files['xl/book.xml'] = files['xl/book.xml'].replaceAll('name="销售"', 'state="hidden" name="销售"').replaceAll('name="第二页"', 'state="hidden" name="第二页"')
    ]) { const files = fixture.files(); change(files); assert.throws(() => parseWorkbook(fixture.zip(files), 'xlsx')); }
    assert.throws(() => parseWorkbook(fixture.workbook(), 'xlsx', { maxCells: 31 }), /预算/);
    assert.throws(() => parseWorkbook(fixture.workbook(), 'xlsx', { maxModelBytes: 512 }), /预算/);
    const files = fixture.files(); files['bomb.bin'] = Buffer.alloc(100000, 65);
    const bomb = fixture.zip(files);
    // Lie consistently in central/local headers; the inflater must count real output.
    const local = bomb.indexOf(Buffer.from('bomb.bin')) - 30;
    bomb.writeUInt32LE(1, local + 22);
    let p = bomb.indexOf(Buffer.from('bomb.bin'), local + 31) - 46; bomb.writeUInt32LE(1, p + 24);
    assert.throws(() => parseWorkbook(bomb, 'xlsx', { maxPartBytes: 10000 }), /实际展开量/);
});
test('Strict namespace, UTF16 parts, cached dates, styles, merges and shared formula metadata remain truthful', () => {
    const files = fixture.files({ strict: true, date1904: true });
    files['xl/book.xml'] = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(files['xl/book.xml'], 'utf16le')]);
    const model = parseWorkbook(fixture.zip(files), 'xlsx'), sheet = model.sheets[0];
    assert.equal(model.date1904, true); assert.equal(sheet.cells[5].text, '1/2/04');
    assert.equal(sheet.cells[5].style.color, '#112233');
    assert.equal(sheet.cells[5].style.backgroundColor, '#ffcc00');
    assert.equal(sheet.cells[5].style.horizontal, 'center');
    assert.equal(sheet.cells[0].style.bold, true);
    assert.deepEqual(sheet.merges[0], { r: 6, c: 0, rows: 2, columns: 4 });
    assert.equal(sheet.rowHeights[0].size, 30); assert.equal(sheet.rowHeights[1].hidden, true);
    assert.equal(sheet.columnWidths[0].hidden, true);
    assert.equal(sheet.cells[8].formula, ''); assert.equal(sheet.cells[8].formulaSource, 'B3+1');
    assert.equal(sheet.cells[8].formulaRange, 'A3:A4'); assert.equal(model.sheets[2].hidden, 'veryHidden');
    const bad = structuredClone(model); bad.sheets[0].cells[0].formulaSource = 'x'.repeat(32769);
    assert.throws(() => validateWorkbook(bad), /预算/);
});
test('theme indexes and tint use Office theme semantics; UTF16BE and 1900 leap-day display stay literal', () => {
    const files = fixture.files();
    files['xl/theme.xml'] = '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Theme"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="112233"/></a:dk2><a:lt2><a:srgbClr val="DDEEFF"/></a:lt2></a:clrScheme></a:themeElements></a:theme>';
    files['xl/_rels/book.xml.rels'] = files['xl/_rels/book.xml.rels'].replace('</Relationships>', '<Relationship Id="theme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme.xml"/></Relationships>');
    files['xl/style.xml'] = files['xl/style.xml'].replace('rgb="FF112233"', 'theme="0" tint="-0.5"');
    files['xl/sheets/one.xml'] = files['xl/sheets/one.xml'].replace('<v>1</v>', '<v>60</v>');
    const be = Buffer.from(files['xl/sheets/one.xml'], 'utf16le'); be.swap16(); files['xl/sheets/one.xml'] = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    const model = parseWorkbook(fixture.zip(files), 'xlsx');
    assert.equal(model.sheets[0].cells[5].text, '2/29/00');
    assert.equal(model.sheets[0].cells[5].style.color, '#808080');
    files['xl/style.xml'] = files['xl/style.xml'].replace('theme="0" tint="-0.5"', 'rgb="FF336699" tint="0.5"');
    assert.equal(parseWorkbook(fixture.zip(files), 'xlsx').sheets[0].cells[0].style.color, '#8cb3d9');
});
test('the main-thread model boundary refuses overlapping merges, injected CSS and oversized payloads', () => {
    const model = parseWorkbook(fixture.workbook(), 'xlsx');
    for (const mutate of [
        m => m.sheets[0].cells[0].style = { backgroundImage: 'url(https://invalid.test)' },
        m => m.sheets[0].cells[0].style = { color: 'red;position:fixed' },
        m => m.sheets[0].cells[0].text = 'x'.repeat(32769),
        m => m.sheets[0].rows = 100000,
        m => m.sheets[0].merges.push({ r: 6, c: 0, rows: 1, columns: 1 })
    ]) { const copy = structuredClone(model); mutate(copy); assert.throws(() => validateWorkbook(copy)); }
});
test('XML, styles, input and ZIP limits are independently enforced and external targets stay inert', () => {
    for (const limits of [{ maxInputBytes: 16 }, { maxArchiveEntries: 1 }, { maxExpandedBytes: 128 }, { maxPartBytes: 128 }, { maxDepth: 2 }, { maxXmlEvents: 10 }, { maxSheets: 2 }, { maxRows: 4 }, { maxColumns: 2 }, { maxTextLength: 8 }, { maxMerges: 1, maxStyles: 1 }]) assert.throws(() => parseWorkbook(fixture.workbook(), 'xlsx', limits));
    const files = fixture.files();
    files['xl/sheets/one.xml'] = files['xl/sheets/one.xml'].replace('</worksheet>', '<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="external"/></worksheet>');
    files['xl/sheets/_rels/one.xml.rels'] = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="external" Target="https://invalid.test/private" TargetMode="External" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/></Relationships>';
    assert.match(parseWorkbook(fixture.zip(files), 'xlsx').warnings.join(' '), /外部关系/);
    files['xl/_rels/book.xml.rels'] = files['xl/_rels/book.xml.rels'].replace('Target="sheets/one.xml"', 'Target="https://invalid.test/evil" TargetMode="External"');
    assert.throws(() => parseWorkbook(fixture.zip(files), 'xlsx'), /工作表关系/);
    const corrupt = Buffer.from(fixture.workbook()); const local = 0, central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    corrupt.writeUInt32LE(1, local + 14); corrupt.writeUInt32LE(1, central + 16);
    assert.throws(() => parseWorkbook(corrupt, 'xlsx'), /CRC/);
});
test('the exact input byte boundary is separate from format validation and originals are unchanged', () => {
    const bytes = fixture.workbook(), before = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    parseWorkbook(bytes, 'xlsx', { maxInputBytes: bytes.length });
    assert.throws(() => parseWorkbook(bytes, 'xlsx', { maxInputBytes: bytes.length - 1 }), { code: 'OFFICE_WORKBOOK_LIMIT' });
    assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'), before);
    assert.throws(() => parseWorkbook(new Uint8Array(16777217), 'xlsx'), { code: 'OFFICE_WORKBOOK_LIMIT' });
    assert.throws(() => parseWorkbook(Buffer.from('<html>renamed.xls</html>'), 'xls'), /XLS 复合/);
});
