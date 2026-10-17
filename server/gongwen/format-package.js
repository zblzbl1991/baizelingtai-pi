const { xml } = require('../pi-document-parser');
const children = node => (node?.children || []).filter(child => typeof child !== 'string');
const child = (node, name) => children(node).find(item => item.name === name);
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function serialize(node) {
    if (typeof node === 'string') return esc(node);
    const attrs = Object.entries(node.attrs).map(([key, value]) => ` ${key}="${esc(value)}"`).join('');
    return node.children.length ? `<${node.qualified}${attrs}>${node.children.map(serialize).join('')}</${node.qualified}>` : `<${node.qualified}${attrs}/>`;
}
const orders = {
    pPr: 'pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange'.split(' '),
    rPr: 'rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath rPrChange'.split(' ')
};
function properties(name, ...sources) {
    const result = { name, qualified: 'w:' + name, attrs: {}, children: [] }, map = new Map();
    for (const source of sources) for (const value of children(source)) {
        const previous = map.get(value.name);
        map.set(value.name, ['rFonts', 'spacing', 'ind'].includes(value.name) && previous
            ? { ...value, attrs: { ...previous.attrs, ...value.attrs } } : value);
    }
    result.children = [...map.values()].sort((a, b) => orders[name].indexOf(a.name) - orders[name].indexOf(b.name));
    return result;
}
function value(name, attrs) { return { name, qualified: 'w:' + name, attrs, children: [] }; }
function normalizeSettings(settings) {
    const update = settings.match(/<w:updateFields\b[^>]*\/>/g) || [];
    if (update.length > 1 || !settings.includes('<w:compat>')) throw Error('公文设置结构不兼容');
    return settings.replace(/<w:updateFields\b[^>]*\/>/, '').replace('<w:compat>', update.join('') + '<w:compat>');
}

// Adapt the reviewed generator's output at the package boundary. The docx
// library appends external styles after its defaults; replacing the generated
// part avoids duplicate IDs and puts docDefaults first, as OOXML requires.
async function normalizeGeneratedPackage(zip, styles) {
    const root = xml(Buffer.from(styles));
    const ids = new Set();
    for (const style of root.children.filter(node => node?.name === 'style')) {
        const id = style.attrs['w:styleId'];
        if (!id || ids.has(id)) throw Error('公文生成样式标识重复或缺失');
        ids.add(id);
    }
    const defaults = child(root, 'docDefaults'), runDefault = child(child(defaults, 'rPrDefault'), 'rPr');
    runDefault.children.push(value('color', { 'w:val': '000000' }));
    runDefault.children = properties('rPr', runDefault).children;
    const normal = children(root).find(node => node.name === 'style' && node.attrs['w:styleId'] === 'Normal');
    const normalParagraph = child(normal, 'pPr');
    normalParagraph.children = properties('pPr', normalParagraph, { children: [value('spacing', { 'w:before': '0', 'w:after': '0', 'w:line': '579', 'w:lineRule': 'exact' })] }).children;
    const stylesById = new Map(children(root).filter(node => node.name === 'style').map(node => [node.attrs['w:styleId'], node]));
    const resolved = new Map();
    function resolve(id, visiting = new Set()) {
        if (resolved.has(id)) return resolved.get(id);
        const style = stylesById.get(id);
        if (!style || visiting.has(id)) throw Error('公文生成样式继承无效');
        visiting.add(id);
        const parentId = child(style, 'basedOn')?.attrs['w:val'], parent = parentId ? resolve(parentId, visiting) : {};
        const result = { pPr: properties('pPr', parent.pPr, child(style, 'pPr')), rPr: properties('rPr', parent.rPr, child(style, 'rPr')) };
        visiting.delete(id); resolved.set(id, result); return result;
    }
    for (const style of stylesById.values()) {
        const fonts = child(child(style, 'rPr'), 'rFonts');
        if (fonts?.attrs['w:ascii'] && !fonts.attrs['w:hAnsi']) fonts.attrs['w:hAnsi'] = fonts.attrs['w:ascii'];
    }
    zip.file('word/styles.xml', serialize(root));
    // Materialize inherited properties only in fresh generator output, so
    // converters cannot substitute their built-in heading/Normal defaults.
    // Direct component properties remain last: redheads, tables and banji keep
    // their deliberate font sizes, colors, alignment and spacing.
    for (const file of Object.keys(zip.files).filter(name => /^word\/(?:document|header\d+|footer\d+)\.xml$/.test(name))) {
        const part = xml(await zip.file(file).async('nodebuffer'));
        function visit(node) {
            if (node.name === 'p') {
                const direct = child(node, 'pPr'), styleId = child(direct, 'pStyle')?.attrs['w:val'] || 'Normal';
                const inherited = resolve(styleId);
                const pPr = properties('pPr', inherited.pPr, direct);
                node.children = [pPr, ...node.children.filter(item => item !== direct)];
                for (const run of children(node).filter(item => item.name === 'r')) {
                    const directRun = child(run, 'rPr'), charId = child(directRun, 'rStyle')?.attrs['w:val'];
                    const rPr = properties('rPr', runDefault, inherited.rPr, charId ? resolve(charId).rPr : undefined, directRun);
                    run.children = [rPr, ...run.children.filter(item => item !== directRun)];
                }
            }
            for (const item of children(node)) visit(item);
        }
        visit(part); zip.file(file, serialize(part));
    }
    const settings = await zip.file('word/settings.xml').async('string');
    // updateFields follows characterSpacingControl in CT_Settings. The
    // upstream settings patch inserts spacing immediately before compat.
    zip.file('word/settings.xml', normalizeSettings(settings));
}
module.exports = { normalizeGeneratedPackage, normalizeSettings };
