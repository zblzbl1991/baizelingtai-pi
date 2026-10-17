const fs = require('node:fs');
const path = require('node:path');
const core = require('../../vendor/gongwen-kit/lib/gongwen-core');
const { assertDocTree, checkXmlParts } = require('../../vendor/gongwen-kit/lib/doc-integrity');
const { officeZip, xml } = require('../pi-document-parser');
const { MAX_FILE } = require('./limits');
function components(G, blocks) {
    return blocks.flatMap(block => {
        if (block.type === 'paragraph') return [G.p(block.text)];
        if (block.type === 'heading') return [G[`h${block.level}`](block.text)];
        const n = block.head.length, width = Math.floor(8844 / n);
        return G.table({ ...block, widths: block.widths || block.head.map((_, i) => width + (i === n - 1 ? 8844 - width * n : 0)),
            align: block.head.map((_, i) => i === 0 ? G.AlignmentType.LEFT : G.AlignmentType.CENTER) });
    });
}
function build(input) {
    const form = input.kind === 'rules' ? 'zhang' : 'wen', G = core.form(form), { Document } = G.require_docx();
    const letter = input.redhead && input.kind === 'letter';
    const section = letter ? G.xinhanSection({ agency: Array.isArray(input.agency) ? input.agency.join('、') : input.agency }) : G.sectionProps();
    const head = !input.redhead ? [] : letter ? G.xinhanHead(input)
        : input.kind === 'minutes' ? G.jiyaoHead({ ...input, mark: input.mark, docNo: undefined }) : G.letterhead(input);
    const attachments = input.attachments || [];
    const children = [
        ...head, ...G.title(input.title), ...(input.recipient ? [G.zhusong(input.recipient)] : []),
        ...components(G, input.body), ...(input.attendees?.length ? G.attendees(input.attendees) : []),
        ...(attachments.length ? G.fujian(attachments.map(item => item.title)) : []),
        ...G.luokuan({ unit: input.unit, date: input.date, sealed: input.sealed ?? Boolean(input.redhead) }),
        ...(input.note ? [G.fuzhu(input.note)] : []),
        ...attachments.flatMap((item, i) => G.fujianPage({ n: attachments.length > 1 ? i + 1 : undefined,
            title: item.title, detached: item.detachedNo, body: components(G, item.body) })),
        ...(input.copyTo?.length || input.issuer ? G.banji({ letter, copyTo: input.copyTo,
            issuer: input.issuer, date: input.printDate || input.date }) : [])
    ];
    const document = new Document({ creator: '白泽灵台 / gongwen-kit', title: [].concat(input.title).join(''),
        features: { updateFields: true }, evenAndOddHeaderAndFooters: true,
        externalStyles: G.externalStyles(), numbering: G.numbering, sections: [{ ...section, children }] });
    assertDocTree(document);
    return { document, G, form };
}
async function structure(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE) throw Error('公文超过 16 MiB 输出预算');
    const zip = officeZip(bytes);
    if (!zip.names.includes('word/document.xml')) throw Error('公文缺少正文');
    // Bound every expanded XML part before the upstream JSZip-based checks.
    for (const name of zip.names.filter(name => /\.(?:xml|rels)$/i.test(name))) xml(zip.read(name));
    const problems = await checkXmlParts(bytes);
    if (problems.length) throw Error('公文 XML 结构检查失败');
}
async function render(input, directory) {
    const { document, G, form } = build(input), { Packer } = G.require_docx();
    const file = path.join(directory, 'document.docx');
    const initial = await Packer.toBuffer(document);
    if (initial.length > MAX_FILE) throw Error('公文超过输出预算');
    fs.writeFileSync(file, initial);
    await G.patchSettings(file);
    await core.patchNumbering(file, core.FORMS[form].noRestart);
    // Preserve the requested title face. On clients without it, describe a
    // serif alternative instead of letting WPS choose a similarly named script
    // font. This is font metadata, not embedding or a claim of font compliance.
    const zip = await require('jszip').loadAsync(fs.readFileSync(file));
    await require('./format-package').normalizeGeneratedPackage(zip, G.externalStyles());
    const fontTable = await zip.file('word/fontTable.xml').async('string');
    const titleFont = core.TITLE_FONT.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (!/<w:fonts\b[^>]*\/>/.test(fontTable)) throw Error('公文字体表结构不兼容');
    zip.file('word/fontTable.xml', fontTable.replace(/<w:fonts\b([^>]*?)\/>/,
        `<w:fonts$1><w:font w:name="${titleFont}"><w:altName w:val="SimSun"/><w:charset w:val="86"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font></w:fonts>`));
    fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    if (fs.statSync(file).size > MAX_FILE) throw Error('公文超过输出预算');
    const bytes = fs.readFileSync(file);
    await structure(bytes);
    return { bytes, file };
}
module.exports = { build, render, structure, MAX_FILE };
