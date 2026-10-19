const { officeZip, xml } = require('../pi-document-parser');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const path = require('node:path');
const FONT_ALIASES = { FangSong: '仿宋', SimHei: '黑体', KaiTi: '楷体', SimSun: '宋体' };
const family = value => FONT_ALIASES[value] || value;
function invalid(message, location) { return Object.assign(Error(message), { invalid: true, location }); }
// Namespace bindings are resolved per element: an unrelated element named rPr
// must never become Word formatting just because its local name matches.
function wordTree(bytes) {
    const root = xml(bytes);
    function visit(node, inherited) {
        const ns = { ...inherited };
        for (const [name, value] of Object.entries(node.attrs)) if (name === 'xmlns') ns[''] = value; else if (name.startsWith('xmlns:')) ns[name.slice(6)] = value;
        const parts = node.qualified.split(':'), prefix = parts.length === 2 ? parts[0] : '';
        node.uri = ns[prefix]; node.word = node.uri === W;
        node.values = Object.create(null);
        node.relationships = Object.create(null);
        for (const [name, value] of Object.entries(node.attrs)) {
            const pair = name.split(':');
            if (pair.length === 2 && ns[pair[0]] === W) node.values[pair[1]] = value;
            if (pair.length === 2 && ns[pair[0]] === R) node.relationships[pair[1]] = value;
        }
        for (const child of node.children) if (typeof child === 'object') visit(child, ns);
    }
    visit(root, {}); return root;
}
const kids = (node, name) => (node?.children || []).filter(c => typeof c === 'object' && c.word && (!name || c.name === name));
function one(node, name) {
    const list = kids(node, name); if (list.length > 1) throw invalid(`重复的 ${name} 属性`); return list[0];
}
const val = (node, name) => one(node, name)?.values.val;
function properties(node) {
    if (!node) return {};
    if (node.children.some(child => typeof child === 'object' && !child.word)) throw Error('格式属性包含尚不支持的命名空间');
    const result = {}, fonts = one(node, 'rFonts'), size = val(node, 'sz'), color = one(node, 'color');
    if (fonts) {
        if (fonts.values.eastAsia || fonts.values.eastAsiaTheme) { result.font = family(fonts.values.eastAsia); result.fontIssue = Boolean(fonts.values.eastAsiaTheme); }
        if (fonts.values.ascii || fonts.values.asciiTheme) { result.asciiFont = family(fonts.values.ascii); result.asciiFontIssue = Boolean(fonts.values.asciiTheme); }
        if (fonts.values.hAnsi || fonts.values.hAnsiTheme) { result.highFont = family(fonts.values.hAnsi); result.highFontIssue = Boolean(fonts.values.hAnsiTheme); }
    }
    if (size !== undefined) result.size = Number(size) / 2;
    if (color) { result.color = color.values.val === 'auto' ? '000000' : color.values.val?.toUpperCase(); result.colorIssue = Boolean(color.values.themeColor); }
    const alignment = val(node, 'jc'); if (alignment) result.alignment = alignment;
    const indent = one(node, 'ind'); if (indent) result.indent = { ...indent.values };
    const spacing = one(node, 'spacing'); if (spacing) result.spacing = { ...spacing.values };
    const snap = one(node, 'snapToGrid'); if (snap) result[node.name === 'pPr' ? 'lineSnapToGrid' : 'charSnapToGrid'] = !['0', 'false', 'off'].includes(snap.values.val);
    const numbered = one(node, 'numPr');
    if (numbered) {
        result.numbering = {};
        for (const name of ['numId', 'ilvl']) { const number = val(numbered, name); if (number !== undefined) result.numbering[name] = number; }
    }
    for (const [tag, key] of [['b', 'bold'], ['i', 'italic']]) {
        const element = one(node, tag);
        if (element) {
            const value = element.values.val;
            if (value !== undefined && !['0', '1', 'true', 'false', 'on', 'off'].includes(value)) throw invalid('无效的粗斜体属性');
            result[key] = value === undefined || ['1', 'true', 'on'].includes(value);
        }
    }
    return result;
}
function styleProperties(target, source) {
    const values = { ...source };
    for (const key of ['bold', 'italic']) if (key in values) { const toggle = values[key]; delete values[key]; if (toggle) target[key] = !target[key]; }
    mergeProperties(target, values);
}
function mergeProperties(target, source) {
    for (const [key, value] of Object.entries(source)) target[key] = ['indent', 'spacing', 'numbering'].includes(key) ? { ...target[key], ...value } : value;
}
function gridProblem(grid) {
    if (!grid) return '缺少行网格';
    if (!['default', 'lines', 'linesAndChars', 'snapToChars'].includes(grid.type)) return '行网格类型未解析';
    if (!/^\d+$/.test(grid.linePitch || '')) return '行网格间距未解析';
    return null;
}
async function validateFormat(bytes, context = {}) {
    const normative = context.operation === 'generate' || context.operation === 'revise' && context.layoutApplied === true;
    const result = { standard: 'GB/T 9704—2012', scope: normative ? 'normative' : 'reference', status: 'incomplete', properties: { status: 'incomplete' },
        checks: [], total: 0, truncated: false, fontAvailability: context.fontAvailability || { status: 'unknown', fonts: [] }, preview: { status: 'not-verified' } };
    let failures = 0, incomplete = 0; const requiredFonts = new Set();
    const record = (id, location, expected, actual, reason, applicable = normative) => {
        let status = !applicable ? 'not-applicable' : reason ? 'incomplete' : Object.entries(expected).every(([k, v]) => actual[k] === v) ? 'pass' : 'fail';
        if (status === 'fail') failures++; if (status === 'incomplete') incomplete++;
        if (actual.font) requiredFonts.add(actual.font);
        if (applicable && expected.font) requiredFonts.add(expected.font);
        result.total++;
        if (result.checks.length < 200) result.checks.push({ id, status, location, expected, actual, ...(reason ? { reason: String(reason).slice(0, 240) } : {}) }); else result.truncated = true;
    };
    try {
        const zip = officeZip(bytes), document = wordTree(zip.read('word/document.xml')), styles = wordTree(zip.read('word/styles.xml'));
        if (!document.word || document.name !== 'document' || !styles.word || styles.name !== 'styles') throw Error('不支持的 Word XML 命名空间');
        const defaults = one(styles, 'docDefaults'), defaultRun = properties(one(one(defaults, 'rPrDefault'), 'rPr'));
        if (kids(styles, 'style').length > 4096) throw Error('样式数量超过核验预算');
        const defaultPara = properties(one(one(defaults, 'pPrDefault'), 'pPr')), index = new Map(); let defaultStyle;
        for (const style of kids(styles, 'style')) {
            const id = style.values.styleId; if (!id || index.has(id)) throw invalid('样式 ID 缺失或重复', { part: 'word/styles.xml', styleId: id?.slice(0, 160) }); index.set(id, style);
            if (style.values.type === 'paragraph' && ['1', 'true', 'on'].includes(style.values.default)) { if (defaultStyle) throw invalid('默认段落样式重复', { part: 'word/styles.xml', styleId: id.slice(0, 160) }); defaultStyle = id; }
        }
        function chain(id, active = new Set()) {
            if (!id) return [];
            if (active.size >= 128) throw Error('样式继承超过预算');
            if (active.has(id)) throw invalid('样式继承循环', { part: 'word/styles.xml', styleId: id.slice(0, 160) });
            const style = index.get(id); if (!style) throw invalid('引用了不存在的样式', { part: 'word/styles.xml', styleId: id.slice(0, 160) });
            active.add(id); const result = [...chain(val(style, 'basedOn'), active), style]; active.delete(id); return result;
        }
        for (const id of index.keys()) chain(id);
        function typedChain(id, type, location) {
            const ancestors = chain(id);
            if (ancestors.some(style => style.values.type !== type)) throw invalid(type === 'paragraph' ? '段落引用了非段落样式' : '字符引用了非字符样式', { ...location, styleId: id?.slice(0, 160) });
            return ancestors;
        }
        // All stories resolve exactly the same property cascade and style
        // types. Callers retain the role profile and expected-value checks.
        function resolveParagraph(node, location) {
            const ppr = one(node, 'pPr'), styleId = val(ppr, 'pStyle') || defaultStyle;
            const ancestors = typedChain(styleId, 'paragraph', location);
            const effective = { bold: false, italic: false, ...defaultRun, ...defaultPara, color: defaultRun.color || '000000' };
            for (const style of ancestors) {
                mergeProperties(effective, properties(one(style, 'pPr')));
                styleProperties(effective, properties(one(style, 'rPr')));
            }
            mergeProperties(effective, properties(ppr));
            return { ppr, styleId, ancestors, effective };
        }
        function resolveRun(node, paragraphProperties, location) {
            const rpr = one(node, 'rPr'), actual = { ...paragraphProperties };
            for (const style of typedChain(val(rpr, 'rStyle'), 'character', location)) styleProperties(actual, properties(one(style, 'rPr')));
            mergeProperties(actual, properties(rpr));
            return actual;
        }
        const numbered = zip.names.includes('word/numbering.xml') ? wordTree(zip.read('word/numbering.xml')) : null;
        function unique(nodes, attribute) {
            const values = new Map();
            for (const node of nodes) { const id = node.values[attribute]; if (id === undefined || values.has(id)) throw invalid('编号定义标识缺失或重复', { part: 'word/numbering.xml' }); values.set(id, node); }
            return values;
        }
        const numbers = unique(kids(numbered, 'num'), 'numId'), abstracts = unique(kids(numbered, 'abstractNum'), 'abstractNumId');
        let paragraph = 0, section = 0, mainTitleSeen = false, titleCount = 0, awaitingRecipient = false;
        const footerReferences = [], headerReferences = [], paragraphSections = new Map(); let pendingParagraphs = [];
        const allBlocks = [...(context.body || []), ...(context.attachments || []).flatMap(a => a.body || [])];
        const captions = new Set(allBlocks.filter(b => b.type === 'table').map(b => b.caption).filter(Boolean));
        const attachmentTitles = new Set((context.attachments || []).flatMap(a => [].concat(a.title)));
        const bodyTexts = new Set(allBlocks.filter(b => b.type === 'paragraph').map(b => b.text));
        function sections(node) {
            if (!node.word || ['sectPrChange', 'pPrChange', 'rPrChange', 'del', 'moveFrom'].includes(node.name)) return;
            if (node.name === 'p') pendingParagraphs.push(node);
            if (node.name === 'sectPr') {
                section++; const location = { part: 'word/document.xml', section };
                const page = one(node, 'pgSz'), margin = one(node, 'pgMar'), grid = one(node, 'docGrid');
                // sectPr closes the section ending at its containing paragraph;
                // body's final sectPr closes the remaining paragraphs.
                for (const p of pendingParagraphs) paragraphSections.set(p, { section, grid: grid?.values });
                pendingParagraphs = [];
                record('page-size', location, { width: 11906, height: 16838 }, { width: Number(page?.values.w), height: Number(page?.values.h) }, page ? null : '缺少页面尺寸');
                const expected = { top: 2098, bottom: 1984, left: 1587, right: 1474 };
                const actual = Object.fromEntries(Object.keys(expected).map(key => [key, Number(margin?.values[key])]));
                // Millimetre-to-twip rounding differs by one or two twips.
                for (const key of Object.keys(expected)) if (Math.abs(actual[key] - expected[key]) <= 2) actual[key] = expected[key];
                record('page-margins', location, expected, actual, margin ? null : '缺少页边距');
                record('line-grid', location, { enabled: true, linePitch: 579 }, { type: grid?.values.type, enabled: ['lines', 'linesAndChars'].includes(grid?.values.type), linePitch: Number(grid?.values.linePitch) }, gridProblem(grid?.values));
                footerReferences.push(...kids(node, 'footerReference').map(ref => ({ id: ref.relationships.id, type: ref.values.type, section })));
                headerReferences.push(...kids(node, 'headerReference').map(ref => ({ id: ref.relationships.id, type: ref.values.type, section })));
                return;
            }
            for (const child of kids(node)) sections(child);
        }
        sections(document);
        if (!section) record('page-sections', { part: 'word/document.xml' }, {}, {}, '缺少节属性');
        if (!footerReferences.length) record('page-number', { part: 'word/document.xml' }, {}, {}, '缺少页码页脚引用');
        function walk(node, protectedArea = false, header = false) {
            if (!node.word) return;
            if (['del', 'moveFrom', 'pPrChange', 'rPrChange', 'sectPrChange'].includes(node.name)) return;
            const special = protectedArea || ['tbl', 'txbxContent'].includes(node.name);
            if (node.name === 'tr') header = Boolean(one(one(node, 'trPr'), 'tblHeader'));
            if (node.name === 'p') {
                paragraph++; if (paragraph > 10000) throw Error('段落数量超过核验预算');
                const { ppr, styleId, ancestors, effective } = resolveParagraph(node, { part: 'word/document.xml', paragraph });
                const names = ancestors.map(s => s.values.styleId);
                const heading = ancestors.map(s => /^heading ([1-4])$/i.exec(val(s, 'name') || '')?.[1]).filter(Boolean).at(-1);
                const paraText = kids(node, 'r').flatMap(r => kids(r, 't').flatMap(t => t.children.filter(c => typeof c === 'string'))).join('');
                const inferredTitle = context.operation === 'revise' && normative && !mainTitleSeen && paragraph <= 8 && !special && effective.alignment === 'center' && paraText.trim() && paraText.length <= 60 && !/[〔【[]\d{4}[〕】\]]|\d\s*号$|\d{4}\s*年\s*\d/.test(paraText);
                const title = names.includes('Title') || inferredTitle;
                if (title && !special) { mainTitleSeen = true; titleCount++; awaitingRecipient = true; }
                const frame = one(ppr, 'framePr'), banji = frame?.values.yAlign === 'bottom';
                let role = title ? 'title' : heading ? `heading${heading}` : 'body';
                if (context.operation === 'generate' && !title && !heading) {
                    if (captions.has(paraText)) role = 'table-caption';
                    else if (attachmentTitles.has(paraText)) role = 'attachment-title';
                    else if (kids(ppr, 'pageBreakBefore').length && /附件\d*$/.test(paraText)) role = 'attachment-mark';
                    else if (banji) role = 'imprint';
                    else if (!mainTitleSeen && context.redhead) role = 'redhead';
                    else if (special) role = 'table';
                }
                if (!title && !special && paraText.trim()) {
                    const followsTitle = awaitingRecipient; awaitingRecipient = false;
                    const recipient = context.recipient && String(context.recipient).replace(/[：:]?$/, '：');
                    const namedRecipient = ancestors.some(style => /^主送机关(?:\s|$)/.test(val(style, 'name') || ''));
                    const zeroIndent = effective.indent?.firstLineChars === '0' || effective.indent?.firstLineChars === undefined && effective.indent?.firstLine === '0';
                    if (!bodyTexts.has(paraText) && (namedRecipient || recipient === paraText)) role = 'recipient';
                    else if (!bodyTexts.has(paraText) && followsTitle && !heading && zeroIndent && paraText.length <= 80 && /^[^。？！\n]+[：:]$/.test(paraText)) {
                        if (/^各(?:部门|单位|处室|科室|分公司|学院|学校|机构|地区|县|市)(?:[、，].*)?[：:]$/.test(paraText)) role = 'recipient';
                        else { role = 'uncertain'; record('role-coverage', { part: 'word/document.xml', paragraph, styleId }, {}, {}, '标题后顶格冒号段的主送／正文角色不能可靠确定'); }
                    }
                }
                if (title && !special) record('title-alignment', { part: 'word/document.xml', paragraph, styleId }, { alignment: 'center' }, { alignment: effective.alignment });
                if (role === 'recipient') record('recipient-indent', { part: 'word/document.xml', paragraph, styleId }, { firstLineChars: '0' },
                    { firstLineChars: effective.indent?.firstLineChars ?? (effective.indent?.firstLine === '0' ? '0' : undefined) });
                if (bodyTexts.has(paraText) || !context.body && role === 'body' && effective.alignment === 'both') {
                    const ownSection = paragraphSections.get(node), grid = ownSection?.grid;
                    const location = { part: 'word/document.xml', paragraph, styleId, section: ownSection?.section };
                    const actualIndent = effective.indent?.firstLineChars ?? (Number(effective.indent?.firstLine) === 632 ? '200' : undefined);
                    record('body-indent', location, { firstLineChars: '200' }, { firstLineChars: actualIndent }, actualIndent === undefined ? '未解析正文缩进' : null);
                    if (effective.spacing?.line) record('body-line-spacing', location, { line: '579', lineRule: 'exact' }, { line: effective.spacing.line, lineRule: effective.spacing.lineRule });
                    record('body-grid-spacing', location, { snapToGrid: true, enabled: true, linePitch: 579 },
                        { snapToGrid: effective.lineSnapToGrid !== false, type: grid?.type, enabled: ['lines', 'linesAndChars'].includes(grid?.type), linePitch: Number(grid?.linePitch) },
                        ownSection ? gridProblem(grid) : '段落所属节未解析');
                }
                if (effective.numbering?.numId && effective.numbering.numId !== '0') {
                    const { numId, ilvl = '0' } = effective.numbering, num = numbers.get(numId), abstract = abstracts.get(val(num, 'abstractNumId'));
                    if (!num || !abstract) throw invalid('段落引用了缺失的编号定义', { part: 'word/document.xml', paragraph });
                    const levels = unique(kids(abstract, 'lvl'), 'ilvl'), overrides = unique(kids(num, 'lvlOverride'), 'ilvl');
                    const level = one(overrides.get(ilvl), 'lvl') || levels.get(ilvl), actual = { ...effective };
                    if (!level) throw invalid('编号层级缺失', { part: 'word/numbering.xml', paragraph, numId, ilvl });
                    mergeProperties(actual, properties(one(level, 'rPr')));
                    const font = heading === '1' ? context.kind === 'rules' ? '方正小标宋简体' : '黑体' : heading === '2' ? context.kind === 'rules' ? '黑体' : '楷体' : '仿宋';
                    const unresolved = one(abstract, 'numStyleLink') || one(abstract, 'styleLink') || actual.fontIssue || !actual.font;
                    record('numbering-marker', { part: 'word/numbering.xml', paragraph, numId, ilvl }, { font, size: 16, color: '000000' }, { font: actual.font, size: actual.size, color: actual.color }, unresolved ? '编号链接或主题字体尚未完整解析' : null, normative && !special);
                }
                let run = 0;
                function runs(current) {
                    if (!current.word) { record('content-coverage', { part: 'word/document.xml', paragraph }, {}, {}, '段落含尚不支持的命名空间内容', normative); return; }
                    if (['del', 'moveFrom', 'rPrChange', 'pPr'].includes(current.name)) return;
                    if (current.name === 'r') {
                        run++;
                        if (!kids(current, 't').length) return;
                        const actual = resolveRun(current, effective, { part: 'word/document.xml', paragraph, run });
                        const text = kids(current, 't').flatMap(t => t.children.filter(c => typeof c === 'string')).join('');
                        const expected = { font: title ? '方正小标宋简体' : heading === '1' ? context.kind === 'rules' ? '方正小标宋简体' : '黑体' : heading === '2' && context.kind !== 'rules' ? '楷体' : '仿宋', size: title ? 22 : 16, color: '000000', bold: false, italic: false };
                        let applicable = normative && !special;
                        if (role === 'table') { expected.font = header ? '黑体' : '仿宋'; expected.size = 14; applicable = normative; }
                        if (role === 'table-caption') { expected.font = '黑体'; expected.size = 14; }
                        if (role === 'attachment-title') { expected.font = '方正小标宋简体'; expected.size = 16; }
                        if (role === 'attachment-mark') expected.font = '黑体';
                        if (role === 'imprint') expected.size = 14;
                        if (context.kind === 'minutes' && (context.attendees || []).some(([label]) => text === label + '：')) expected.font = '黑体';
                        if (role === 'redhead') {
                            applicable = normative;
                            const agencies = [].concat(context.agency || [], context.mark || []);
                            if (agencies.some(name => text === name || text === name + '文件') || text === '文件') { expected.font = '方正小标宋简体'; expected.color = 'FF0000'; delete expected.size; }
                            else if ((context.signers || []).includes(text)) expected.font = '楷体';
                            else if ([context.copyNo, context.secret, context.urgency].filter(Boolean).some(value => text === String(value) || text === String(value).padStart(6, '0'))) expected.font = '黑体';
                        }
                        const visible = { font: actual.font, size: actual.size, color: actual.color, bold: actual.bold, italic: actual.italic };
                        let unknown = actual.fontIssue || actual.colorIssue || !actual.font || !Number.isFinite(actual.size);
                        if (/[\x21-\x7e]/.test(text)) { expected.asciiFont = expected.font; visible.asciiFont = actual.asciiFont; unknown ||= actual.asciiFontIssue || !actual.asciiFont; }
                        if (/^[\x00-\x7f]+$/.test(text) && /[\x21-\x7e]/.test(text)) {
                            visible.font = actual.asciiFont;
                            unknown = actual.asciiFontIssue || actual.colorIssue || !actual.asciiFont || !Number.isFinite(actual.size);
                        }
                        if (/[\u00c0-\u024f]/.test(text)) { expected.highFont = expected.font; visible.highFont = actual.highFont; unknown ||= actual.highFontIssue || !actual.highFont; }
                        if (/[\u0590-\u08ff]/.test(text)) unknown = true;
                        record(role, { part: 'word/document.xml', paragraph, run, styleId }, expected, visible,
                            unknown ? '字体、字号、脚本或主题属性尚不能完整解析' : null, applicable);
                        return;
                    }
                    for (const child of current.children.filter(child => typeof child === 'object')) runs(child);
                }
                runs(node); return;
            }
            for (const child of kids(node)) walk(child, special, header);
        }
        walk(document);
        if (!paragraph) throw Error('未找到可核验的段落');
        if (normative && !titleCount) record('title-coverage', { part: 'word/document.xml' }, {}, {}, '未识别主标题');
        const rels = footerReferences.length ? wordTree(zip.read('word/_rels/document.xml.rels')) : null;
        const relationships = new Map();
        if (rels && rels.uri !== 'http://schemas.openxmlformats.org/package/2006/relationships') throw Error('不支持的关系命名空间');
        for (const node of (rels?.children || []).filter(n => typeof n === 'object')) {
            if (node.uri !== rels.uri || node.name !== 'Relationship') throw Error('不支持的关系结构');
            if (!node.attrs.Id || relationships.has(node.attrs.Id)) throw invalid('关系 ID 重复或缺失', { part: 'word/_rels/document.xml.rels' }); relationships.set(node.attrs.Id, node.attrs);
        }
        for (const ref of footerReferences) {
            const rel = relationships.get(ref.id);
            if (!rel || rel.Type !== R + '/footer' || rel.TargetMode === 'External' || !rel.Target || /[\\\x00-\x1f?#:]|(^|\/)\.\.(\/|$)/.test(rel.Target)) throw invalid('页脚关系不安全或缺失', { part: 'word/document.xml', section: ref.section });
            const part = path.posix.normalize(rel.Target.startsWith('/') ? rel.Target.slice(1) : path.posix.join('word', rel.Target));
            const footer = wordTree(zip.read(part)); let found = false, paragraphIndex = 0, pageField = false;
            function fields(node) {
                if (!node.word || ['del', 'moveFrom', 'rPrChange', 'pPrChange'].includes(node.name)) return;
                if (node.name === 'instrText' && /^\s*PAGE(?:\s|$)/i.test(node.children.filter(c => typeof c === 'string').join(''))) pageField = true;
                if (node.name === 'fldSimple' && /^\s*PAGE(?:\s|$)/i.test(node.values.instr || '')) pageField = true;
                for (const child of kids(node)) fields(child);
            }
            fields(footer);
            function checkFooter(node) {
                if (!node.word || ['del', 'moveFrom', 'rPrChange', 'pPrChange'].includes(node.name)) return;
                if (node.name === 'p') {
                    paragraphIndex++; const { effective: base } = resolveParagraph(node, { part, section: ref.section, paragraph: paragraphIndex });
                    let run = 0;
                    for (const r of kids(node, 'r')) {
                        run++; if (!kids(r, 't').length && !kids(r, 'instrText').length && !kids(r, 'fldChar').length) continue;
                        found = true; const actual = resolveRun(r, base, { part, section: ref.section, paragraph: paragraphIndex, run });
                        const alignment = ref.type === 'even' ? 'left' : 'right';
                        record('page-number', { part, section: ref.section, paragraph: paragraphIndex, run }, { font: '宋体', asciiFont: '宋体', size: 14, alignment, color: '000000', bold: false, italic: false },
                            { font: actual.font, asciiFont: actual.asciiFont, size: actual.size, alignment: base.alignment, color: actual.color, bold: actual.bold, italic: actual.italic },
                            actual.fontIssue || actual.asciiFontIssue || actual.colorIssue || !actual.font || !Number.isFinite(actual.size) ? '页码字体或颜色继承未完成' : null);
                    }
                    return;
                }
                for (const child of kids(node)) checkFooter(child);
            }
            checkFooter(footer);
            if (!(context.kind === 'letter' && ref.type === 'first')) record('page-number-field', { part, section: ref.section }, { PAGE: true }, { PAGE: pageField });
            if (!found && !(context.kind === 'letter' && ref.type === 'first')) record('page-number', { part, section: ref.section }, {}, {}, '未找到可核验页码');
        }
        for (const ref of headerReferences) {
            const rel = relationships.get(ref.id);
            if (!rel || rel.Type !== R + '/header' || rel.TargetMode === 'External' || !rel.Target || /[\\\x00-\x1f?#:]|(^|\/)\.\.(\/|$)/.test(rel.Target)) throw invalid('页眉关系不安全或缺失', { part: 'word/document.xml', section: ref.section });
            const part = path.posix.normalize(rel.Target.startsWith('/') ? rel.Target.slice(1) : path.posix.join('word', rel.Target)), header = wordTree(zip.read(part)); let paragraphIndex = 0;
            function checkHeader(node) {
                if (!node.word || ['del', 'moveFrom', 'rPrChange', 'pPrChange'].includes(node.name)) return;
                if (node.name === 'p') {
                    paragraphIndex++; const { effective: base } = resolveParagraph(node, { part, section: ref.section, paragraph: paragraphIndex }); let run = 0;
                    for (const r of kids(node, 'r')) {
                        run++; if (!kids(r, 't').length) continue;
                        const actual = resolveRun(r, base, { part, section: ref.section, paragraph: paragraphIndex, run });
                        const knownLetterhead = context.operation === 'generate' && context.kind === 'letter' && context.redhead;
                        record('header-marker', { part, section: ref.section, paragraph: paragraphIndex, run }, { font: '方正小标宋简体', color: 'FF0000', alignment: 'center' },
                            { font: actual.font, color: actual.color, alignment: base.alignment }, actual.fontIssue || actual.colorIssue ? '页眉主题属性未解析' : null, normative && knownLetterhead);
                    }
                    return;
                }
                for (const child of kids(node)) checkHeader(child);
            }
            checkHeader(header);
        }
    } catch (error) {
        if (error.invalid) record('format-definition', error.location || { part: 'word/styles.xml' }, { valid: true }, { valid: false, detail: error.message.slice(0, 240) }, null, true);
        else record('format-resolution', { part: 'word/document.xml' }, {}, {}, error.message, true);
    }
    const evidence = result.fontAvailability;
    const fonts = [...requiredFonts].slice(0, 64).map(requested => ({ requested: requested.slice(0, 240), status: evidence.fonts?.find(font => family(font.requested) === requested)?.status || 'unknown' }));
    result.fontAvailability = { status: fonts.some(f => f.status === 'missing') ? 'missing' : !fonts.length || fonts.some(f => f.status === 'unknown') ? 'unknown' : 'available', fonts, evidence: evidence.evidence };
    result.properties.status = failures ? 'failed' : incomplete ? 'incomplete' : 'passed';
    result.status = !normative || result.properties.status === 'passed' && result.fontAvailability.status !== 'available' ? 'incomplete' : result.properties.status;
    return result;
}
module.exports = { validateFormat };
