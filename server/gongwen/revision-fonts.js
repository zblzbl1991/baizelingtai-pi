const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { xml } = require('../pi-document-parser');
async function titleAlternative(zip, rels, types) {
    if (!rels) rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    const relationships = xml(Buffer.from(rels)).children.filter(c => typeof c === 'object');
    const fonts = relationships.filter(c => /\/fontTable$/.test(c.attrs.Type || ''));
    if (fonts.length > 1 || fonts[0]?.attrs.TargetMode === 'External') throw Error('公文字体关系不支持修订');
    const part = fonts.length ? path.posix.normalize(path.posix.join('word', fonts[0].attrs.Target)) : 'word/pivane-fontTable.xml';
    if (!part.startsWith('word/') || part.includes('..') || fonts.length && !zip.file(part)) throw Error('公文字体部件无效');
    let table = fonts.length ? await zip.file(part).async('string') : '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>';
    if (!/<w:fonts\b/.test(table)) throw Error('公文字体命名空间不支持修订');
    const record = '<w:font w:name="方正小标宋简体"><w:altName w:val="SimSun"/><w:charset w:val="86"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font>';
    if (!/<w:font\b[^>]*w:name="方正小标宋简体"/.test(table)) {
        if (/<w:fonts\b[^>]*\/>/.test(table)) table = table.replace(/<w:fonts\b([^>]*?)\/>/, `<w:fonts$1>${record}</w:fonts>`);
        else table = table.replace('</w:fonts>', record + '</w:fonts>');
    }
    table = table.replace(/<w:font\b[^>]*w:name="方正小标宋简体"[^>]*(?:\/>|>[\s\S]*?<\/w:font>)/g, entry => {
        if (/<w:altName\b/.test(entry)) return entry;
        return entry.endsWith('/>') ? entry.slice(0, -2) + '><w:altName w:val="SimSun"/></w:font>'
            : entry.replace(/^(<w:font\b[^>]*>)/, '$1<w:altName w:val="SimSun"/>');
    });
    xml(Buffer.from(table)); zip.file(part, table);
    if (!fonts.length) {
        if (/<Relationships\b[^>]*\/>/.test(rels)) rels = rels.replace(/<Relationships\b([^>]*?)\/>/, '<Relationships$1></Relationships>');
        if (!rels.includes('</Relationships>') || !types.includes('</Types>')) throw Error('公文字体关系无法保存');
        rels = rels.replace('</Relationships>', `<Relationship Id="pivaneFonts${randomUUID().replace(/-/g, '')}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="pivane-fontTable.xml"/></Relationships>`);
        types = types.replace('</Types>', `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/></Types>`);
    }
    return { rels, types };
}
module.exports = { titleAlternative };
