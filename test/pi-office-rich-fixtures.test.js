const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { originals, expected } = require('./office-preview-fixtures.cjs');
const { validateOfficeFormat } = require('../server/pi-office-format');
const { parseWorkbook } = require('../public/office-preview/parse');
const directory = path.join(__dirname, 'fixtures/office');
const manifest = require('./fixtures/office/rich-manifest.json');

test('independently authored rich inputs have three explicit pages/slides and literal workbook facts', async () => {
    const sources = await originals();
    for (const [format, bytes] of Object.entries(sources)) assert.equal(validateOfficeFormat(bytes, format).format, format);
    assert.equal(expected.docx.pages.length, 3);
    assert.equal(expected.pptx.pages.length, 3);
    const book = parseWorkbook(sources.xlsx, 'xlsx');
    assert.deepEqual(book.sheets.map(sheet => [sheet.name, sheet.hidden]), [['销售', 'visible'], ['第二页', 'visible'], ['隐藏', 'hidden'], ['内部', 'veryHidden']]);
    for (const fact of expected.xlsx.cells) {
        const cell = book.sheets[0].cells.find(cell => cell.r === fact.r && cell.c === fact.c);
        assert.equal(cell.value, fact.value);
        if (fact.format) assert.equal(cell.format, fact.format);
    }
    assert.equal(book.sheets[0].merges.length, 1);
    assert.deepEqual(book.sheets[0].cells[0].style, { bold: true, italic: true, fontSize: 14, color: '#2255aa', fontFamily: 'Arial', backgroundColor: '#ddeeff', borderBottom: '#112233', horizontal: 'center', wrap: true });
    assert.equal(book.sheets[0].cells.find(cell => cell.r === 1 && cell.c === 0).text, '2024-01-01');
    const modern1904 = parseWorkbook(require('./office-preview-fixtures.cjs').workbook({ date1904: true }), 'xlsx');
    assert.equal(modern1904.date1904, true);
    assert.equal(modern1904.sheets[0].cells.find(cell => cell.r === 1 && cell.c === 0).text, '2028-01-02');
    assert.equal(book.sheets[0].cells.find(cell => cell.r === 2 && cell.c === 0).value, 0);
    assert.equal(book.sheets[0].cells.find(cell => cell.r === 2 && cell.c === 1).value, false);
    assert.equal(book.sheets[0].cells.find(cell => cell.r === 2 && cell.c === 2).value, '');
    assert.equal(book.sheets[0].cells.find(cell => cell.r === 3 && cell.c === 1).value, 99);
});

test('committed originals reproduce and retain independently exported legacy cell facts', async () => {
    for (const [name, fact] of Object.entries(manifest.files)) {
        const bytes = fs.readFileSync(path.join(directory, name));
        assert.equal(bytes.length, fact.bytes, name);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), fact.sha256, name);
        const format = path.extname(name).slice(1);
        if (format !== 'pdf') assert.equal(validateOfficeFormat(bytes, format).format, format);
    }
    for (const [format, bytes] of Object.entries(await originals())) assert.deepEqual(bytes, fs.readFileSync(path.join(directory, 'rich.' + format)), format);
    const book = parseWorkbook(fs.readFileSync(path.join(directory, 'rich.xls')), 'xls');
    assert.deepEqual(book.sheets.map(sheet => sheet.name), manifest.expected.xls.sheets);
    for (const fact of manifest.expected.xls.cells) {
        const cell = book.sheets[0].cells.find(cell => cell.r === fact.r && cell.c === fact.c);
        assert.equal(cell.value, fact.value);
        if (fact.text) assert.equal(cell.text, fact.text);
        if (fact.formula) assert.equal(cell.formula, fact.formula);
    }
    assert.equal(book.sheets[0].merges.length, 1);
    assert.equal(book.sheets[0].rowHeights[0].size, 30);
});

test('independent PDF goldens retain three ordered pages, table text, and an embedded image', async () => {
    const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
    for (const format of ['doc', 'docx', 'ppt', 'pptx']) {
        const task = pdf.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(directory, `golden-rich-${format}.pdf`))), useSystemFonts: true, isEvalSupported: false });
        try {
            const document = await task.promise;
            assert.equal(document.numPages, 3, format);
            for (let n = 1; n <= 3; n++) {
                const page = await document.getPage(n), text = (await page.getTextContent()).items.map(item => item.str).join(' ');
                const word = format.startsWith('doc');
                assert(text.includes((word ? expected.docx : expected.pptx).pages[n - 1]), `${format} page ${n}`);
                if (word && n === 1 || !word && n === 3) { assert(text.includes('Item')); assert(text.includes('42')); }
                if (n === 2) assert((await page.getOperatorList()).fnArray.includes(pdf.OPS.paintImageXObject), `${format} image`);
            }
        } finally { await task.destroy(); }
    }
});
