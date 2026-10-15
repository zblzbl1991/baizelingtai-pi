const { randomUUID } = require('node:crypto');
const { fixPackage } = require('../../vendor/gongwen-kit/lib/fix/layout');
const { elementAt } = require('../../vendor/gongwen-kit/lib/fix/runs');
function openRelationships(value) {
    if (!value) return '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    return value.replace(/<Relationships\b([^>]*?)\/>/, '<Relationships$1></Relationships>');
}
async function layoutPackage(zip, document, parts, notes) {
    let rels = openRelationships(parts.rels), types = parts.types;
    if (!rels.includes('</Relationships>') || !types.includes('</Types>')) throw Error('原稿排版关系命名空间不支持修订');
    const names = ['Odd', 'Even'], originals = await Promise.all(names.map(async side => {
        const file = zip.file(`word/footerGw${side}.xml`); return file ? file.async('nodebuffer') : null;
    }));
    const patched = fixPackage(zip, { rels: '<Relationships></Relationships>', types: '<Types></Types>', settings: parts.settings }, notes);
    const history = []; let match;
    const pattern = /<w:sectPrChange(?=[\s>])/g;
    while ((match = pattern.exec(document))) { const end = elementAt(document, match.index)[1]; history.push([match.index, end]); pattern.lastIndex = end; }
    for (const [i, side] of names.entries()) {
        const priorName = `word/footerGw${side}.xml`, target = `pivane-footer${side}-${randomUUID()}.xml`, id = `pivaneFooter${side}${randomUUID().replace(/-/g, '')}`;
        zip.file('word/' + target, await zip.file(priorName).async('nodebuffer'));
        if (originals[i]) zip.file(priorName, originals[i]); else zip.remove(priorName);
        rels = rels.replace('</Relationships>', `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="${target}"/></Relationships>`);
        types = types.replace('</Types>', `<Override PartName="/word/${target}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`);
        const footer = new RegExp(`<w:footerReference\\b[^>]*r:id="rIdGwFtr${side}"[^>]*/>`, 'g');
        document = document.replace(footer, (value, at) => history.some(([start, end]) => at >= start && at < end) ? value : value.replace(`rIdGwFtr${side}`, id));
        // Recompute offsets after replacing references of the first side.
        history.length = 0; pattern.lastIndex = 0;
        while ((match = pattern.exec(document))) { const end = elementAt(document, match.index)[1]; history.push([match.index, end]); pattern.lastIndex = end; }
    }
    return { document, rels, types, settings: patched.settings };
}
module.exports = { layoutPackage, openRelationships };
