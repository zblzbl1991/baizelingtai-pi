'use strict';
const defaults = require('../../config/office-preview.json').spreadsheet;
const fail = (message, code = 'OFFICE_WORKBOOK_INVALID') => { const error = new Error(message); error.code = code; throw error; };
function limitsFor(overrides) {
    const limits = { ...defaults };
    for (const [key, value] of Object.entries(overrides || {})) {
        if (!(key in defaults) || !Number.isSafeInteger(value) || value < 1 || value > defaults[key]) fail('无效的表格预算');
        limits[key] = value;
    }
    return limits;
}
function budget(limits) {
    let bytes = 128, area = 0, merges = 0;
    return {
        add(value) { bytes += new TextEncoder().encode(JSON.stringify(value)).length + 1; if (bytes > limits.maxModelBytes) fail('表格模型超过预览预算', 'OFFICE_WORKBOOK_LIMIT'); },
        area(rows, columns) { if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || columns < 1 || rows > limits.maxRows || columns > limits.maxColumns || rows * columns > limits.maxCells || (area += rows * columns) > limits.maxCells) fail('表格矩形范围超过预览预算', 'OFFICE_WORKBOOK_LIMIT'); },
        merge() { if (++merges > limits.maxMerges) fail('合并区域超过预览预算', 'OFFICE_WORKBOOK_LIMIT'); }
    };
}
const styleKeys = new Set(['fontFamily', 'fontSize', 'bold', 'italic', 'color', 'backgroundColor', 'horizontal', 'vertical', 'wrap', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft']);
function validateStyle(style) {
    if (!style || typeof style !== 'object' || Array.isArray(style)) fail('无效的单元格样式');
    for (const [key, value] of Object.entries(style)) {
        if (!styleKeys.has(key)) fail('不支持的单元格样式');
        if (['bold', 'italic', 'wrap'].includes(key)) { if (typeof value !== 'boolean') fail('无效的样式标志'); }
        else if (key === 'fontSize') { if (!Number.isFinite(value) || value < 1 || value > 96) fail('无效的字号'); }
        else if (key === 'fontFamily') { if (typeof value !== 'string' || !/^[\p{L}\p{N} _.-]{1,80}$/u.test(value)) fail('无效的字体'); }
        else if (key === 'horizontal') { if (!['left', 'center', 'right', 'justify'].includes(value)) fail('无效的对齐'); }
        else if (key === 'vertical') { if (!['top', 'center', 'bottom'].includes(value)) fail('无效的对齐'); }
        else if (!/^#[0-9a-f]{6}$/i.test(value)) fail('无效的颜色');
    }
}
function validateWorkbook(model, overrides) {
    const limits = limitsFor(overrides), b = budget(limits);
    const text = value => { if (typeof value !== 'string' || value.length > limits.maxTextLength) fail('表格文字超过预览预算', 'OFFICE_WORKBOOK_LIMIT'); };
    const integer = (n, max) => Number.isSafeInteger(n) && n >= 0 && n < max;
    if (!model || !Array.isArray(model.sheets) || !model.sheets.length || model.sheets.length > limits.maxSheets || typeof model.date1904 !== 'boolean' || !Array.isArray(model.warnings)) fail('无效的工作簿模型');
    for (const warning of model.warnings) { text(warning); b.add(warning); }
    const ids = new Set();
    for (const sheet of model.sheets) {
        text(sheet.name); text(sheet.id);
        if (ids.has(sheet.id) || !['visible', 'hidden', 'veryHidden'].includes(sheet.hidden)) fail('无效的工作表身份');
        ids.add(sheet.id); b.area(sheet.rows, sheet.columns);
        b.add({ id: sheet.id, name: sheet.name, hidden: sheet.hidden, rows: sheet.rows, columns: sheet.columns, cells: [], merges: [], rowHeights: [], columnWidths: [] });
        if (!Array.isArray(sheet.cells) || sheet.cells.length > limits.maxCells || !Array.isArray(sheet.merges) || sheet.merges.length > limits.maxMerges) fail('无效的工作表记录');
        const positions = new Set();
        for (const cell of sheet.cells) {
            if (!integer(cell.r, sheet.rows) || !integer(cell.c, sheet.columns) || positions.has(`${cell.r}:${cell.c}`)) fail('无效的单元格坐标');
            positions.add(`${cell.r}:${cell.c}`); text(cell.text);
            if (!['string', 'number', 'boolean', 'error', 'date', 'blank'].includes(cell.type)) fail('无效的单元格类型');
            if (Object.hasOwn(cell, 'value') && !(cell.value === null || typeof cell.value === 'string' || typeof cell.value === 'boolean' || typeof cell.value === 'number' && Number.isFinite(cell.value))) fail('无效的已保存值');
            if (typeof cell.value === 'string') text(cell.value);
            if (cell.formula !== undefined) text(cell.formula);
            if (cell.formulaSource !== undefined) text(cell.formulaSource);
            if (cell.sharedFormulaId !== undefined && !integer(cell.sharedFormulaId, limits.maxCells)) fail('无效的共享公式标识');
            if (cell.format !== undefined) text(cell.format);
            if (cell.formulaRange !== undefined) text(cell.formulaRange);
            if (cell.formulaKind !== undefined && !['normal', 'shared', 'array'].includes(cell.formulaKind)) fail('无效的公式类型');
            if (cell.style !== undefined) validateStyle(cell.style);
            b.add(cell);
        }
        const mergedPositions = new Set();
        for (const merge of sheet.merges) {
            b.merge();
            if (!integer(merge.r, sheet.rows) || !integer(merge.c, sheet.columns) || !Number.isSafeInteger(merge.rows) || !Number.isSafeInteger(merge.columns) || merge.rows < 1 || merge.columns < 1 || merge.r + merge.rows > sheet.rows || merge.c + merge.columns > sheet.columns) fail('无效的合并区域');
            b.add(merge);
            for (let r = merge.r; r < merge.r + merge.rows; r++) for (let c = merge.c; c < merge.c + merge.columns; c++) {
                const position = r * sheet.columns + c; if (mergedPositions.has(position)) fail('合并区域重叠'); mergedPositions.add(position);
            }
        }
        for (const [name, max, cap] of [['rowHeights', sheet.rows, 4096], ['columnWidths', sheet.columns, 2048]]) {
            if (!Array.isArray(sheet[name]) || sheet[name].length > max) fail('无效的行列信息');
            const seen = new Set();
            for (const item of sheet[name]) {
                if (!integer(item.index, max) || seen.has(item.index) || typeof item.hidden !== 'boolean' || item.size !== undefined && (!Number.isFinite(item.size) || item.size <= 0 || item.size > cap)) fail('无效的行列尺寸');
                seen.add(item.index); b.add(item);
            }
        }
    }
    if (!model.sheets.some(sheet => sheet.hidden === 'visible')) fail('工作簿没有可见工作表');
    return model;
}
module.exports = { validateWorkbook, limitsFor, budget, fail, validateStyle };
