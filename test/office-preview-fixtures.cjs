// Independent fixture authoring. No preview reader or SheetJS writer is used.
const fs = require('node:fs');
const path = require('node:path');
const { deflateSync } = require('node:zlib');
const { zip } = require('./document-fixtures.cjs');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, Footer, PageNumber, AlignmentType, WidthType } = require('docx');
const expected = {
    docx: { pages: ['WORD-PAGE-ONE', 'WORD-PAGE-TWO', 'WORD-PAGE-THREE'] },
    pptx: { pages: ['SLIDE-ONE', 'SLIDE-TWO', 'SLIDE-THREE'] },
    xlsx: { cells: [{ r: 1, c: 0, value: 45292, format: 'yyyy-mm-dd' }, { r: 1, c: 1, value: 1234.5, format: '"¥"#,##0.00' }, { r: 1, c: 2, value: 0.125, format: '0.00%' }] }
};
function crc32(bytes) { let crc = 0xffffffff; for (const b of bytes) { crc ^= b; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function image() {
    function chunk(type, data) { const t = Buffer.from(type), h = Buffer.alloc(4), c = Buffer.alloc(4); h.writeUInt32BE(data.length); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([h, t, data, c]); }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2;
    const pixels = Buffer.alloc(64 * (64 * 3 + 1));
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const p = y * 193 + 1 + x * 3, odd = ((x >> 3) + (y >> 3)) % 2; pixels[p] = odd ? 25 : 230; pixels[p + 1] = odd ? 110 : 190; pixels[p + 2] = odd ? 95 : 60; }
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
async function word({ missingFont = false } = {}) {
    const font = missingFont ? 'PivaneFixtureMissingFont2026' : 'Microsoft YaHei';
    const cell = text => new TableCell({ children: [new Paragraph(text)] });
    const children = [];
    for (let i = 0; i < 3; i++) {
        children.push(new Paragraph({ pageBreakBefore: i > 0, children: [new TextRun({ text: `白泽预览 第${['一', '二', '三'][i]}页 ${expected.docx.pages[i]}`, bold: true, size: 32, font })] }));
        children.push(new Paragraph({ children: [new TextRun({ text: '中文正文：只读预览保留原件。', font, size: 24 }), new TextRun({ text: ' Mixed bold and italic.', bold: true, italics: true, size: 20, font: 'Arial' })] }));
        if (i === 0) children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [4500, 4500], rows: [new TableRow({ children: [cell('项目 Item'), cell('数量 Count')] }), new TableRow({ children: [cell('白泽灵台'), cell('42')] })] }));
        if (i === 1) children.push(new Paragraph({ children: [new ImageRun({ type: 'png', data: image(), transformation: { width: 128, height: 128 } })] }));
        if (i === 2) children.push(new Paragraph('Final page / 结束：独立合成验收样本。'));
    }
    const packed = await Packer.toBuffer(new Document({ creator: 'Pivane synthetic fixtures', title: 'Office preview synthetic three pages', sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun('页码 Page '), new TextRun({ children: [PageNumber.CURRENT] })] })] }) }, children }] }));
    const parts = require('fflate').unzipSync(packed);
    parts['docProps/core.xml'] = Buffer.from(Buffer.from(parts['docProps/core.xml']).toString().replace(/20\d\d-\d\d-\d\dT[0-9:.]+Z/g, '2026-01-01T00:00:00.000Z'));
    return zip(parts);
}
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main', A = 'http://schemas.openxmlformats.org/drawingml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = body => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
function shape(id, text, y = 600000) { return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="500000" y="${y}"/><a:ext cx="8000000" cy="900000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="2800" b="1"><a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/></a:rPr><a:t>${text}</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>`; }
function slides() {
    const files = {
        '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${[1, 2, 3].map(i => `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`,
        '_rels/.rels': rels(`<Relationship Id="office" Type="${R}/officeDocument" Target="ppt/presentation.xml"/>`),
        'ppt/presentation.xml': `<p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:sldIdLst>${[1, 2, 3].map(i => `<p:sldId id="${255 + i}" r:id="r${i}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
        'ppt/_rels/presentation.xml.rels': rels([1, 2, 3].map(i => `<Relationship Id="r${i}" Type="${R}/slide" Target="slides/slide${i}.xml"/>`).join('')),
        'ppt/media/checker.png': image()
    };
    for (let i = 1; i <= 3; i++) {
        let body = shape(2, `白泽预览 第${['一', '二', '三'][i - 1]}张 ${expected.pptx.pages[i - 1]}`);
        if (i === 1) body += shape(3, '文字布局 / Independent text layout', 2000000);
        if (i === 2) body += `<p:pic><p:nvPicPr><p:cNvPr id="3" name="Checker image"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="image"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="700000" y="2000000"/><a:ext cx="1800000" cy="1800000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` + shape(4, '图片布局 / Checker image', 4000000);
        if (i === 3) body += `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Fixture table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="700000" y="2000000"/><a:ext cx="6000000" cy="1800000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="3000000"/><a:gridCol w="3000000"/></a:tblGrid>${[['项目 Item', '结果 Result'], ['中文 Table', '42']].map(row => `<a:tr h="900000">${row.map(text => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="2400"/><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`).join('')}</a:tr>`).join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
        files[`ppt/slides/slide${i}.xml`] = `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
        if (i === 2) files['ppt/slides/_rels/slide2.xml.rels'] = rels(`<Relationship Id="image" Type="${R}/image" Target="../media/checker.png"/>`);
    }
    return zip(files);
}
function workbook({ date1904 = false } = {}) {
    const files = require('./office-workbook-fixtures.cjs').files({ date1904 });
    files['xl/book.xml'] = files['xl/book.xml'].replace('state="veryHidden"', 'state="hidden"').replace('</sheets>', '<sheet name="内部" sheetId="4" state="veryHidden" r:id="four"/></sheets>');
    files['xl/_rels/book.xml.rels'] = files['xl/_rels/book.xml.rels'].replace('</Relationships>', `<Relationship Id="four" Type="${R}/worksheet" Target="sheets/four.xml"/><Relationship Id="theme" Type="${R}/theme" Target="theme/theme1.xml"/></Relationships>`);
    files['[Content_Types].xml'] = files['[Content_Types].xml'].replace('</Types>', '<Override PartName="/xl/sheets/four.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>');
    const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    files['xl/style.xml'] = `<styleSheet xmlns="${ns}"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="&quot;¥&quot;#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><i/><sz val="14"/><color theme="4"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="5"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><bottom style="thin"><color rgb="FF112233"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0"><alignment horizontal="center" wrapText="1"/></xf></cellXfs></styleSheet>`;
    files['xl/sheets/one.xml'] = `<worksheet xmlns="${ns}"><dimension ref="A1:D8"/><cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="18" customWidth="1"/></cols><sheetData><row r="1" ht="30" customHeight="1"><c r="A1" s="4" t="inlineStr"><is><t>中文 销售 Sales</t></is></c></row><row r="2"><c r="A2" s="1"><v>45292</v></c><c r="B2" s="2"><v>1234.5</v></c><c r="C2" s="3"><v>0.125</v></c></row><row r="3"><c r="A3"><f>1-1</f><v>0</v></c><c r="B3" t="b"><f>1=2</f><v>0</v></c><c r="C3" t="str"><f>IF(1=1,&quot;&quot;,&quot;x&quot;)</f><v></v></c><c r="D3" t="e"><f>1/0</f><v>#DIV/0!</v></c></row><row r="4"><c r="A4"><f>NOW()</f></c><c r="B4"><f>1+1</f><v>99</v></c></row><row r="5"><c r="A5"><f t="shared" si="0" ref="A5:A6">B5+1</f><v>5</v></c></row><row r="6"><c r="A6"><f t="shared" si="0"/><v>6</v></c></row><row r="7"><c r="A7" t="inlineStr"><is><t>Merged footer 合并</t></is></c></row></sheetData><mergeCells count="1"><mergeCell ref="A7:D8"/></mergeCells></worksheet>`;
    files['xl/sheets/four.xml'] = `<worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Very hidden synthetic internal</t></is></c></row></sheetData></worksheet>`;
    files['xl/theme/theme1.xml'] = `<a:theme xmlns:a="${A}" name="Pivane"><a:themeElements><a:clrScheme name="Synthetic">${[['dk1','000000'],['lt1','FFFFFF'],['dk2','112233'],['lt2','EEEEEE'],['accent1','2255AA'],['accent2','DDEEFF'],['accent3','00AA55'],['accent4','AABBCC'],['accent5','998877'],['accent6','665544'],['hlink','0000FF'],['folHlink','800080']].map(([tag,color]) => `<a:${tag}><a:srgbClr val="${color}"/></a:${tag}>`).join('')}</a:clrScheme><a:fontScheme name="Arial"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Synthetic"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>`;
    files['xl/workbook.xml'] = files['xl/book.xml']; delete files['xl/book.xml'];
    files['xl/_rels/workbook.xml.rels'] = files['xl/_rels/book.xml.rels']; delete files['xl/_rels/book.xml.rels'];
    files['_rels/.rels'] = files['_rels/.rels'].replace('xl/book.xml', 'xl/workbook.xml');
    files['[Content_Types].xml'] = files['[Content_Types].xml'].replace('/xl/book.xml', '/xl/workbook.xml');
    return zip(files);
}
async function originals() { return { docx: await word(), pptx: slides(), xlsx: workbook() }; }
async function write(directory) { fs.mkdirSync(directory, { recursive: true }); for (const [format, bytes] of Object.entries(await originals())) fs.writeFileSync(path.join(directory, `rich.${format}`), bytes); fs.writeFileSync(path.join(directory, 'rich-1904.xlsx'), workbook({ date1904: true })); fs.writeFileSync(path.join(directory, 'missing-font.docx'), await word({ missingFont: true })); }
if (require.main === module) write(process.argv[2] || path.join(__dirname, 'fixtures/office')).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { originals, expected, word, slides, workbook, write };
