// Independently authored OPC fixture. ZIP serialization uses Node zlib, not the reader.
const { zip } = require('./document-fixtures.cjs');
const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function files(options = {}) {
    const ns = options.strict ? 'http://purl.oclc.org/ooxml/spreadsheetml/main' : main;
    const rn = options.strict ? 'http://purl.oclc.org/ooxml/officeDocument/relationships' : rel;
    const wrap = (name, text) => `<${name} xmlns="${ns}">${text}</${name}>`;
    return {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/book.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/sheets/one.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sheets/two.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sheets/three.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/style.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
        '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="office" Type="${rn}/officeDocument" Target="xl/book.xml"/></Relationships>`,
        'xl/book.xml': `<workbook xmlns="${ns}" xmlns:r="${rn}"><workbookPr date1904="${options.date1904 ? 1 : 0}"/><sheets><sheet name="销售" sheetId="1" r:id="one"/><sheet name="第二页" sheetId="2" r:id="two"/><sheet name="隐藏" sheetId="3" state="veryHidden" r:id="three"/></sheets></workbook>`,
        'xl/_rels/book.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="one" Type="${rn}/worksheet" Target="sheets/one.xml"/><Relationship Id="two" Type="${rn}/worksheet" Target="sheets/two.xml"/><Relationship Id="three" Type="${rn}/worksheet" Target="sheets/three.xml"/><Relationship Id="style" Type="${rn}/styles" Target="style.xml"/></Relationships>`,
        'xl/style.xml': wrap('styleSheet', '<fonts count="1"><font><b/><name val="Arial"/><color rgb="FF112233"/></font></fonts><fills count="1"><fill><patternFill patternType="solid"><fgColor rgb="FFFFCC00"/></patternFill></fill></fills><borders count="1"><border><bottom style="thin"><color rgb="FF000000"/></bottom></border></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0"><alignment horizontal="center"/></xf></cellXfs>'),
        'xl/sheets/one.xml': wrap('worksheet', '<dimension ref="A1:D8"/><cols><col min="2" max="2" width="22" hidden="1"/></cols><sheetData><row r="1" ht="30"><c r="A1" t="inlineStr"><is><t>中文 &lt;img src=x onerror=alert(1)&gt;</t></is></c><c r="B1"><f>1-1</f><v>0</v></c><c r="C1" t="b"><f>1=2</f><v>0</v></c><c r="D1" t="str"><f>""</f><v></v></c></row><row r="2" hidden="1"><c r="A2"><f>NOW()</f></c><c r="B2" s="1"><v>1</v></c><c r="C2" t="e"><f>1/0</f><v>#DIV/0!</v></c></row><row r="3"><c r="A3"><f t="shared" si="0" ref="A3:A4">B3+1</f><v>5</v></c></row><row r="4"><c r="A4"><f t="shared" si="0"/><v>6</v></c></row><row r="5"><c r="A5"><f t="array" ref="A5:A6">ROW(A5:A6)</f><v>5</v></c></row></sheetData><mergeCells><mergeCell ref="A7:D8"/></mergeCells>'),
        'xl/sheets/two.xml': wrap('worksheet', '<sheetData><row r="1"><c r="A1"><v>123.5</v></c></row></sheetData>'),
        'xl/sheets/three.xml': wrap('worksheet', '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hidden</t></is></c></row></sheetData>')
    };
}
// Small BIFF5/CFB document authored from MS-CFB and BIFF record layouts.
// GBK bytes D6 D0 CE C4 independently spell 中文 (codepage 936).
function xlsBiff5({ rows = 2, columns = 2, rich = false } = {}) {
    const record = (id, data) => { const head = Buffer.alloc(4); head.writeUInt16LE(id); head.writeUInt16LE(data.length, 2); return Buffer.concat([head, data]); };
    const bof = type => { const b = Buffer.alloc(8); b.writeUInt16LE(0x0500); b.writeUInt16LE(type, 2); return record(0x0809, b); };
    const eof = record(0x000a, Buffer.alloc(0)), cp = record(0x0042, Buffer.from([0xa8, 0x03]));
    const boundData = Buffer.alloc(12); boundData[6] = 5; boundData.write('Sheet', 7, 'ascii');
    const bound = record(0x0085, boundData), secondData = Buffer.from(boundData); secondData.write('Other', 7, 'ascii');
    const second = record(0x0085, secondData), headerLength = bof(5).length + cp.length + bound.length + eof.length + (rich ? second.length : 0);
    bound.writeUInt32LE(headerLength, 4);
    const dimensions = Buffer.alloc(10); dimensions.writeUInt16LE(rows, 2); dimensions.writeUInt16LE(columns, 6);
    const label = Buffer.alloc(12); label.writeUInt16LE(4, 6); Buffer.from([0xd6, 0xd0, 0xce, 0xc4]).copy(label, 8);
    const numeric = Buffer.alloc(14); numeric.writeUInt16LE(1); numeric.writeUInt16LE(1, 2); numeric.writeDoubleLE(42, 6);
    const extra = [];
    if (rich) {
        for (const [index, type] of [undefined, 1, 3].entries()) {
            const formula = Buffer.alloc(29); formula.writeUInt16LE(index + 2); // A3/A4/A5
            if (type !== undefined) { formula[6] = type; formula.writeUInt16LE(0xffff, 12); }
            formula.writeUInt16LE(7, 20); Buffer.from([0x1e, 1, 0, 0x1e, 1, 0, 3]).copy(formula, 22); extra.push(record(0x0006, formula));
        }
        const merge = Buffer.alloc(10); merge.writeUInt16LE(1); merge.writeUInt16LE(6, 2); merge.writeUInt16LE(7, 4); merge.writeUInt16LE(0, 6); merge.writeUInt16LE(1, 8); extra.push(record(0x00e5, merge));
        const row = Buffer.alloc(16); row.writeUInt16LE(1); row.writeUInt16LE(2, 4); row.writeUInt16LE(400, 6); row.writeUInt16LE(0x20, 12); extra.push(record(0x0208, row));
        const col = Buffer.alloc(12); col.writeUInt16LE(1); col.writeUInt16LE(1, 2); col.writeUInt16LE(20 * 256, 4); col.writeUInt16LE(1, 8); extra.push(record(0x007d, col));
    }
    const firstSheet = Buffer.concat([bof(0x10), record(0x0200, dimensions), record(0x0204, label), record(0x0203, numeric), ...extra, eof]);
    second.writeUInt32LE(headerLength + firstSheet.length, 4);
    const stream = Buffer.alloc(4096); Buffer.concat([bof(5), cp, bound, ...(rich ? [second] : []), eof, firstSheet, ...(rich ? [bof(0x10), record(0x0200, dimensions), record(0x0203, numeric), eof] : [])]).copy(stream);
    const header = Buffer.alloc(512); Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header); header.writeUInt16LE(0x3e, 24); header.writeUInt16LE(3, 26); header.writeUInt16LE(0xfffe, 28); header.writeUInt16LE(9, 30); header.writeUInt16LE(6, 32); header.writeUInt32LE(1, 44); header.writeUInt32LE(1, 48); header.writeUInt32LE(4096, 56); header.writeUInt32LE(0xfffffffe, 60); header.writeUInt32LE(0xfffffffe, 68); header.fill(0xff, 76); header.writeUInt32LE(0, 76);
    const fat = Buffer.alloc(512, 0xff); fat.writeUInt32LE(0xfffffffd); fat.writeUInt32LE(0xfffffffe, 4); for (let i = 2; i < 9; i++) fat.writeUInt32LE(i + 1, i * 4); fat.writeUInt32LE(0xfffffffe, 36);
    const dir = Buffer.alloc(512);
    function entry(index, name, type, start, size) { const p = index * 128, text = Buffer.from(name + '\0', 'utf16le'); text.copy(dir, p); dir.writeUInt16LE(text.length, p + 64); dir[p + 66] = type; dir[p + 67] = 1; dir.fill(0xff, p + 68, p + 80); dir.writeUInt32LE(start, p + 116); dir.writeUInt32LE(size, p + 120); }
    entry(0, 'Root Entry', 5, 0xfffffffe, 0); dir.writeUInt32LE(1, 76); entry(1, 'Book', 2, 2, stream.length);
    return Buffer.concat([header, fat, dir, stream]);
}
module.exports = { files, workbook: options => zip(files(options)), zip, xlsBiff5 };
