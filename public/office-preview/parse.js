'use strict';
const XLSX = require('xlsx');
const { archive, xmlReader, partPath } = require('./container');
const { validateWorkbook, limitsFor, budget, fail } = require('./model');
const { preflightXls } = require('./legacy');
const MAIN = ['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'];
const REL = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'];
const PKG = ['http://schemas.openxmlformats.org/package/2006/relationships'];
function coord(value, limits) {
    const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(value || ''); if (!match) fail('单元格地址无效');
    let c = 0; for (const letter of match[1]) c = c * 26 + letter.charCodeAt(0) - 64;
    const r = Number(match[2]) - 1; c--;
    if (r >= limits.maxRows || c >= limits.maxColumns) fail('单元格地址超过预览预算', 'OFFICE_WORKBOOK_LIMIT');
    return { r, c };
}
function range(value, limits) {
    const parts = (value || '').split(':'); if (parts.length > 2) fail('单元格区域无效');
    const a = coord(parts[0], limits), z = coord(parts[1] || parts[0], limits);
    if (z.r < a.r || z.c < a.c) fail('单元格区域反向');
    return { r: a.r, c: a.c, rows: z.r - a.r + 1, columns: z.c - a.c + 1 };
}
function number(value) { const n = Number(value); if (!value?.trim() || !Number.isFinite(n)) fail('单元格数字无效'); return n; }
function integer(value, max) { if (!/^\d+$/.test(value || '') || Number(value) >= max) fail('无效的索引'); return Number(value); }
function formatCell(cell, format, date1904) {
    cell.format = format;
    if (!Object.hasOwn(cell, 'value')) { cell.text = '（无已保存结果）'; return; }
    if (cell.type === 'number') {
        try { cell.text = XLSX.SSF.format(format || 'General', cell.value, { date1904 }); } catch { cell.text = String(cell.value); }
    } else cell.text = cell.value === null ? '' : String(cell.value);
}
function parseXlsx(bytes, limits) {
    const zip = archive(bytes, limits), xml = xmlReader(zip, limits), b = budget(limits);
    const model = { sheets: [], warnings: [], date1904: false }, warned = new Set();
    const warn = text => { if (!warned.has(text)) { b.add(text); model.warnings.push(text); warned.add(text); } };
    warn('近似只读预览；图表、图片、批注、条件格式及其他未支持内容可能省略。公式仅显示文件中已保存的缓存，可能过期，不重新计算。');
    const types = new Map();
    xml('[Content_Types].xml', ['http://schemas.openxmlformats.org/package/2006/content-types'], { root(t) { if (t.local !== 'Types') fail('OPC 内容类型无效'); }, open(n, a) { if (n === 'Override') { if (!a.PartName?.startsWith('/')) fail('无效的 OPC 内容类型路径'); const p = partPath(a.PartName.slice(1)); if (types.has(p)) fail('重复内容类型'); types.set(p, a.ContentType); } } });
    function relationships(owner) {
        const p = owner ? `${owner.slice(0, owner.lastIndexOf('/') + 1)}_rels/${owner.slice(owner.lastIndexOf('/') + 1)}.rels` : '_rels/.rels';
        const rels = new Map();
        if (!zip.entries.has(p)) return rels;
        xml(p, PKG, { root(t) { if (t.local !== 'Relationships') fail('OPC 关系无效'); }, open(n, a) {
            if (n !== 'Relationship') return;
            if (!a.Id || rels.has(a.Id) || !a.Type || !a.Target) fail('重复或无效的 OPC 关系');
            if (a.TargetMode && a.TargetMode !== 'Internal') { warn('文件包含外部关系；预览未读取任何外部目标。'); rels.set(a.Id, { type: a.Type, external: true }); return; }
            const target = a.Target.startsWith('/') ? partPath(a.Target.slice(1)) : partPath((owner ? owner.slice(0, owner.lastIndexOf('/') + 1) : '') + a.Target);
            if (!zip.entries.has(target)) fail('OPC 关系目标不存在');
            rels.set(a.Id, { type: a.Type, target });
        } }); return rels;
    }
    const isType = (type, suffix) => REL.some(ns => type === `${ns}/${suffix}`);
    const roots = [...relationships('').values()].filter(r => isType(r.type, 'officeDocument'));
    if (roots.length !== 1 || roots[0].external) fail('OPC 工作簿关系缺失或无效');
    const book = roots[0].target;
    if (types.get(book) !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml') fail('不是受支持的 XLSX 工作簿');
    const rels = relationships(book), sheets = [], ids = new Set();
    xml(book, MAIN, { root(t) { if (t.local !== 'workbook') fail('工作簿 XML 无效'); }, open(n, a, tag) {
        if (n === 'workbookPr') model.date1904 = ['1', 'true'].includes(a.date1904);
        if (n !== 'sheet') return;
        if (sheets.length >= limits.maxSheets) fail('工作表数量超过预览预算', 'OFFICE_WORKBOOK_LIMIT');
        if (!/^[1-9]\d*$/.test(a.sheetId || '') || ids.has(a.sheetId) || !a.name || a.name.length > limits.maxTextLength) fail('工作表身份无效');
        ids.add(a.sheetId);
        const idAttribute = Object.values(tag.attributes).find(x => x.local === 'id' && REL.includes(x.uri));
        const relation = rels.get(idAttribute?.value);
        if (!relation || relation.external || !isType(relation.type, 'worksheet')) fail('工作表关系无效');
        const hidden = a.state || 'visible'; if (!['visible', 'hidden', 'veryHidden'].includes(hidden)) fail('工作表状态无效');
        sheets.push({ id: a.sheetId, name: a.name, hidden, target: relation.target }); b.add(a);
    } });
    if (!sheets.some(s => s.hidden === 'visible')) fail('工作簿没有可见工作表');
    const uniquePart = suffix => { const matches = [...rels.values()].filter(r => isType(r.type, suffix)); if (matches.length > 1 || matches[0]?.external) fail('工作簿部件关系无效'); return matches[0]?.target; };
    const theme = [], themePart = uniquePart('theme');
    if (themePart) {
        const drawing = ['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'];
        const stack = [], order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
        xml(themePart, drawing, { open(n, a) { const parent = stack.at(-1); stack.push(n); if (stack.includes('clrScheme') && ['srgbClr', 'sysClr'].includes(n)) { const index = order.indexOf(parent); if (index < 0 || theme[index] !== undefined) fail('主题颜色数量或结构无效'); theme[index] = n === 'sysClr' ? a.lastClr : a.val; } }, close() { stack.pop(); } });
    }
    const color = a => {
        let raw = a.rgb || (a.theme !== undefined ? theme[integer(a.theme, 12)] : undefined);
        if (!raw || !/^(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) return undefined;
        raw = raw.slice(-6); const tint = a.tint === undefined ? 0 : number(a.tint);
        if (tint < -1 || tint > 1) fail('颜色色调无效');
        const rgb = [0, 2, 4].map(p => parseInt(raw.slice(p, p + 2), 16) / 255);
        const max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min, luminance = (max + min) / 2;
        const saturation = delta ? delta / (1 - Math.abs(2 * luminance - 1)) : 0;
        let hue = 0;
        if (delta) { if (max === rgb[0]) hue = ((rgb[1] - rgb[2]) / delta) % 6; else if (max === rgb[1]) hue = (rgb[2] - rgb[0]) / delta + 2; else hue = (rgb[0] - rgb[1]) / delta + 4; if (hue < 0) hue += 6; }
        const light = tint < 0 ? luminance * (1 + tint) : luminance * (1 - tint) + tint;
        const chroma = (1 - Math.abs(2 * light - 1)) * saturation, x = chroma * (1 - Math.abs(hue % 2 - 1)), m = light - chroma / 2;
        const adjusted = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x] : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
        return '#' + adjusted.map(v => Math.round((v + m) * 255 + 1e-8).toString(16).padStart(2, '0')).join('');
    };
    const styles = [], fonts = [], fills = [], borders = [], formats = new Map();
    const stylePart = uniquePart('styles');
    if (stylePart) {
        const stack = []; let font, fill, border, xf, count = 0;
        xml(stylePart, MAIN, { root(t) { if (t.local !== 'styleSheet') fail('样式部件无效'); }, open(n, a) {
            const parent = stack.at(-1); stack.push(n);
            if (['font', 'fill', 'border', 'xf', 'numFmt'].includes(n) && ++count > limits.maxStyles) fail('样式数量超过预览预算', 'OFFICE_WORKBOOK_LIMIT');
            if (n === 'numFmt') { const id = integer(a.numFmtId, 65536); formats.set(id, a.formatCode || 'General'); b.add(a); }
            if (n === 'font') font = {};
            if (font) {
                if (n === 'b') font.bold = a.val !== '0' && a.val !== 'false'; if (n === 'i') font.italic = a.val !== '0' && a.val !== 'false';
                if (n === 'name' && /^[\p{L}\p{N} _.-]{1,80}$/u.test(a.val || '')) font.fontFamily = a.val;
                if (n === 'sz') { const size = number(a.val); if (size >= 1 && size <= 96) font.fontSize = size; }
                if (n === 'color' && color(a)) font.color = color(a);
            }
            if (n === 'fill') fill = {}; if (fill && n === 'fgColor' && color(a)) fill.backgroundColor = color(a);
            if (n === 'border') border = {};
            if (border && n === 'color' && ['top', 'right', 'bottom', 'left'].includes(parent) && color(a)) border['border' + parent[0].toUpperCase() + parent.slice(1)] = color(a);
            if (n === 'xf' && parent === 'cellXfs') xf = { font: integer(a.fontId || '0', limits.maxStyles), fill: integer(a.fillId || '0', limits.maxStyles), border: integer(a.borderId || '0', limits.maxStyles), numFmt: integer(a.numFmtId || '0', 65536), style: {} };
            if (n === 'alignment' && xf) { if (['left', 'center', 'right', 'justify'].includes(a.horizontal)) xf.style.horizontal = a.horizontal; if (['top', 'center', 'bottom'].includes(a.vertical)) xf.style.vertical = a.vertical; if (a.wrapText) xf.style.wrap = ['1', 'true'].includes(a.wrapText); }
        }, close() {
            const n = stack.pop();
            if (n === 'font') { b.add(font); fonts.push(font); font = null; } if (n === 'fill') { b.add(fill); fills.push(fill); fill = null; } if (n === 'border') { b.add(border); borders.push(border); border = null; }
            if (n === 'xf' && xf) { b.add(xf); styles.push(xf); xf = null; }
        } });
    }
    const strings = [], stringsPart = uniquePart('sharedStrings');
    if (stringsPart) {
        let stack = [], current = null;
        xml(stringsPart, MAIN, { root(t) { if (t.local !== 'sst') fail('共享字符串部件无效'); }, open(n) { stack.push(n); if (n === 'si') current = ''; }, text(text) { if (current !== null && stack.at(-1) === 't') { if (current.length + text.length > limits.maxTextLength) fail('单元格文字超过预览预算', 'OFFICE_WORKBOOK_LIMIT'); current += text; } }, close() { if (stack.pop() === 'si') { if (strings.length >= limits.maxCells) fail('共享字符串超过预览预算', 'OFFICE_WORKBOOK_LIMIT'); b.add(current); strings.push(current); current = null; } } });
    }
    let totalArea = 0;
    for (const descriptor of sheets) {
        const sheet = { id: descriptor.id, name: descriptor.name, hidden: descriptor.hidden, rows: 1, columns: 1, cells: [], merges: [], rowHeights: [], columnWidths: [] };
        b.add({ ...sheet, rows: limits.maxRows, columns: limits.maxColumns });
        const stack = [], positions = new Set(), rowInfo = new Set(), colInfo = new Set(), shared = new Map(); let cell, value = '', formula = '', inline = '', hasValue = false, hasFormula = false, formulaAttrs;
        const grow = (rows, columns) => { const nr = Math.max(sheet.rows, rows), nc = Math.max(sheet.columns, columns); if (nr > limits.maxRows || nc > limits.maxColumns || totalArea + nr * nc > limits.maxCells) fail('表格矩形范围超过预览预算', 'OFFICE_WORKBOOK_LIMIT'); sheet.rows = nr; sheet.columns = nc; };
        xml(descriptor.target, MAIN, { root(t) { if (t.local !== 'worksheet') fail('工作表 XML 无效'); }, open(n, a) {
            stack.push(n);
            if (n === 'dimension') { const r = range(a.ref, limits); grow(r.r + r.rows, r.c + r.columns); }
            if (n === 'row') {
                const index = integer(a.r, limits.maxRows + 1) - 1; if (index < 0) fail('行号无效'); grow(index + 1, 1);
                if (a.ht !== undefined || a.hidden !== undefined) { if (rowInfo.has(index)) fail('重复行信息'); rowInfo.add(index); const info = { index, hidden: ['1', 'true'].includes(a.hidden) }; if (a.ht !== undefined) { info.size = number(a.ht); if (info.size <= 0 || info.size > 4096) fail('行高无效'); } b.add(info); sheet.rowHeights.push(info); }
            }
            if (n === 'col') {
                const min = integer(a.min, limits.maxColumns + 1), max = integer(a.max, limits.maxColumns + 1); if (min < 1 || max < min) fail('列范围无效'); grow(1, max);
                for (let index = min - 1; index < max; index++) { if (colInfo.has(index)) fail('重复列信息'); colInfo.add(index); const info = { index, hidden: ['1', 'true'].includes(a.hidden) }; if (a.width !== undefined) { info.size = number(a.width); if (info.size <= 0 || info.size > 2048) fail('列宽无效'); } b.add(info); sheet.columnWidths.push(info); }
            }
            if (n === 'c') { if (cell) fail('嵌套单元格'); const position = coord(a.r, limits); grow(position.r + 1, position.c + 1); const key = `${position.r}:${position.c}`; if (positions.has(key)) fail('重复单元格'); positions.add(key); cell = { ...position, type: a.t || 'n', styleIndex: a.s }; value = ''; formula = ''; inline = ''; hasValue = false; hasFormula = false; formulaAttrs = {}; }
            if (cell && n === 'v') hasValue = true;
            if (cell && n === 'f') { hasFormula = true; formulaAttrs = a; }
            if (n === 'mergeCell') { const merge = range(a.ref, limits); grow(merge.r + merge.rows, merge.c + merge.columns); b.merge(); b.add(merge); sheet.merges.push(merge); }
            if (['drawing', 'legacyDrawing', 'conditionalFormatting', 'hyperlink', 'tablePart', 'extLst'].includes(n)) warn('检测到未支持的工作表对象或链接；这些内容未在网格中还原。');
        }, text(text) {
            if (!cell) return; const current = stack.at(-1);
            const append = old => { if (old.length + text.length > limits.maxTextLength) fail('单元格或公式超过预览预算', 'OFFICE_WORKBOOK_LIMIT'); return old + text; };
            if (current === 'v') value = append(value); if (current === 'f') formula = append(formula); if (current === 't') inline = append(inline);
        }, close() {
            if (stack.pop() !== 'c') return;
            if (hasFormula) {
                cell.formula = formula; cell.formulaKind = formulaAttrs.t || 'normal';
                if (!['normal', 'shared', 'array'].includes(cell.formulaKind)) fail('不支持的公式类型');
                if (formulaAttrs.ref) { range(formulaAttrs.ref, limits); cell.formulaRange = formulaAttrs.ref; }
                if (cell.formulaKind === 'shared') {
                    const id = integer(formulaAttrs.si, limits.maxCells);
                    if (formula) { if (shared.has(id)) fail('重复共享公式主单元格'); shared.set(id, { formula, range: cell.formulaRange }); }
                    cell.sharedFormulaId = id;
                }
                if (cell.formulaKind !== 'normal') warn('共享/数组公式保留主原式及范围；不展开或猜测从属单元格的原式。');
                if (!hasValue) warn('部分公式没有已保存缓存；请用办公软件重新计算后保存。');
            }
            const type = cell.type;
            if (type === 'inlineStr') { cell.value = inline; cell.type = 'string'; }
            else if (type === 's') { const index = integer(value, strings.length); if (strings[index] === undefined) fail('共享字符串索引无效'); cell.value = strings[index]; cell.type = 'string'; }
            else if (['str', 'e', 'd', 'b', 'n'].includes(type)) {
                cell.type = { str: 'string', e: 'error', d: 'date', b: 'boolean', n: 'number' }[type];
                if (hasValue) { if (type === 'n') cell.value = number(value); else if (type === 'b') { if (!['0', '1', 'true', 'false'].includes(value)) fail('布尔缓存无效'); cell.value = ['1', 'true'].includes(value); } else cell.value = value; }
                else if (!hasFormula) { cell.type = 'blank'; cell.value = null; }
            } else fail('未知的单元格类型');
            let format = 'General';
            if (cell.styleIndex !== undefined || styles.length) { const index = integer(cell.styleIndex || '0', styles.length), style = styles[index]; if (!style) fail('样式索引无效'); format = formats.get(style.numFmt) || XLSX.SSF.get_table()[style.numFmt] || 'General'; cell.style = { ...fonts[style.font], ...fills[style.fill], ...borders[style.border], ...style.style }; }
            delete cell.styleIndex; formatCell(cell, format, model.date1904); b.add(cell); sheet.cells.push(cell); cell = null;
        } });
        for (const item of sheet.cells) if (item.formulaKind === 'shared' && !item.formula) { const master = shared.get(item.sharedFormulaId); if (master) { item.formulaSource = master.formula; item.formulaRange = master.range; b.add([item.formulaSource, item.formulaRange]); } else warn('部分共享公式缺失主原式；只展示已保存值。'); }
        totalArea += sheet.rows * sheet.columns; b.area(sheet.rows, sheet.columns); model.sheets.push(sheet);
        if (sheet.hidden !== 'visible') warn('隐藏和 veryHidden 工作表不会在预览中显示。');
        // Recognize relationship-only objects without resolving external targets.
        relationships(descriptor.target);
    }
    zip.finish(); return validateWorkbook(model, limits);
}
function parseXls(bytes, limits) {
    const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    if (!signature.every((v, i) => bytes[i] === v)) fail('不是有效的 XLS 复合文档');
    preflightXls(bytes, limits);
    // SheetJS only reads this bounded OLE input, never emits HTML or executes formulas.
    const book = XLSX.read(bytes, { type: 'array', cellFormula: true, cellNF: true, cellStyles: true, cellText: false, dense: false, WTF: true });
    if (book.SheetNames.length > limits.maxSheets) fail('工作表数量超过预览预算', 'OFFICE_WORKBOOK_LIMIT');
    const b = budget(limits), model = { sheets: [], warnings: ['XLS 近似只读预览：字体、边框、图形等未恢复；公式仅显示已保存的缓存，可能过期，不重新计算。'], date1904: Boolean(book.Workbook?.WBProps?.date1904) };
    for (let index = 0; index < book.SheetNames.length; index++) {
        const name = book.SheetNames[index], source = book.Sheets[name], ref = source['!ref'] ? range(source['!ref'], limits) : { r: 0, c: 0, rows: 1, columns: 1 };
        const sheet = { id: String(index + 1), name, hidden: ['visible', 'hidden', 'veryHidden'][book.Workbook?.Sheets?.[index]?.Hidden || 0], rows: ref.r + ref.rows, columns: ref.c + ref.columns, cells: [], merges: [], rowHeights: [], columnWidths: [] };
        b.add({ ...sheet, rows: limits.maxRows, columns: limits.maxColumns });
        for (const address of Object.keys(source)) {
            if (address[0] === '!') continue;
            const position = coord(address, limits), original = source[address];
            const cell = { ...position, type: ({ s: 'string', n: 'number', b: 'boolean', e: 'error', d: 'date', z: 'blank' })[original.t] || 'blank' };
            if (original.f !== undefined) cell.formula = original.f;
            if (original.F) { cell.formulaRange = original.F; cell.formulaKind = 'array'; }
            if (Object.hasOwn(original, 'v')) cell.value = original.v instanceof Date ? original.v.toISOString() : original.t === 'e' ? ({ 0: '#NULL!', 7: '#DIV/0!', 15: '#VALUE!', 23: '#REF!', 29: '#NAME?', 36: '#NUM!', 42: '#N/A', 43: '#GETTING_DATA' })[original.v] || `#ERROR ${original.v}` : original.v;
            if (original.f && !Object.hasOwn(original, 'v')) model.warnings.push('部分公式没有已保存缓存。');
            formatCell(cell, original.z || 'General', model.date1904); b.add(cell); sheet.cells.push(cell);
        }
        for (const item of source['!merges'] || []) { const merge = { r: item.s.r, c: item.s.c, rows: item.e.r - item.s.r + 1, columns: item.e.c - item.s.c + 1 }; b.merge(); b.add(merge); sheet.rows = Math.max(sheet.rows, item.e.r + 1); sheet.columns = Math.max(sheet.columns, item.e.c + 1); sheet.merges.push(merge); }
        for (const [key, out, sizeKey] of [['!rows', 'rowHeights', 'hpt'], ['!cols', 'columnWidths', 'wch']]) {
            const sourceInfo = source[key] || [];
            if (sourceInfo.length > (key === '!rows' ? limits.maxRows : limits.maxColumns)) fail('行列信息超过预览预算', 'OFFICE_WORKBOOK_LIMIT');
            sourceInfo.forEach((info, index) => { if (!info) return; const item = { index, hidden: Boolean(info.hidden) }; if (info[sizeKey] > 0) item.size = info[sizeKey]; b.add(item); sheet[out].push(item); if (key === '!rows') sheet.rows = Math.max(sheet.rows, index + 1); else sheet.columns = Math.max(sheet.columns, index + 1); });
        }
        if (sheet.hidden !== 'visible' && !model.warnings.includes('隐藏工作表不会在预览中显示。')) model.warnings.push('隐藏工作表不会在预览中显示。');
        b.area(sheet.rows, sheet.columns); model.sheets.push(sheet);
    }
    return validateWorkbook(model, limits);
}
function parseWorkbook(input, format, overrides) {
    const limits = limitsFor(overrides);
    if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > limits.maxInputBytes) fail('Excel 原件超过预览预算或为空', 'OFFICE_WORKBOOK_LIMIT');
    try {
        if (format === 'xlsx') return parseXlsx(input, limits);
        if (format === 'xls') return parseXls(input, limits);
        fail('不支持的工作簿格式');
    } catch (error) { if (error.code?.startsWith('OFFICE_WORKBOOK_')) throw error; fail('工作簿损坏、加密或包含不支持的内容'); }
}
module.exports = { parseWorkbook, validateWorkbook };
