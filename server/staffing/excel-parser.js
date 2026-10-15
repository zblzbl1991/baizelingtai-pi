'use strict';
const path = require('node:path');
const { officeZip, xml } = require('../pi-document-parser');
const { SCHEMA } = require('./excel-workbook');
const { fail, validateInitial, LIMITS } = require('./validation');
const children = (n, name) => (n?.children || []).filter(v => typeof v !== 'string' && (!name || v.name === name));
const walk = (n, name) => children(n).flatMap(v => [...(v.name === name ? [v] : []), ...walk(v, name)]);
const plain = n => (n?.children || []).map(v => typeof v === 'string' ? v : plain(v)).join('');
function parseWorkbook(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 20 * 1024 ** 2) fail('Excel upload exceeds 20 MiB', 413);
    const zip = officeZip(bytes), docs = new Map(), get = file => { if (!docs.has(file)) docs.set(file, xml(zip.read(file))); return docs.get(file); };
    if (zip.names.some(name => /vbaProject|externalLinks|connections\.xml|embeddings/i.test(name))) fail('Excel macros, external data and embedded objects are not supported');
    const types = get('[Content_Types].xml');
    if (!children(types).some(n => n.attrs.PartName === '/xl/workbook.xml' && n.attrs.ContentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')
        || children(types).some(n => /macroEnabled|vbaProject/i.test(n.attrs.ContentType || ''))) fail('A standard non-macro XLSX workbook is required');
    for (const file of zip.names.filter(name => name.endsWith('.rels'))) if (children(get(file)).some(n => n.attrs.TargetMode === 'External')) fail('Excel external relationships are not supported');
    const rels = new Map();
    for (const n of children(get('xl/_rels/workbook.xml.rels'))) {
        if (!n.attrs.Id || rels.has(n.attrs.Id) || !n.attrs.Target || /[\\?#]|^[a-z]+:/i.test(n.attrs.Target)) fail('Invalid Excel relationship');
        const target = path.posix.normalize(n.attrs.Target.startsWith('/') ? n.attrs.Target.slice(1) : 'xl/' + n.attrs.Target);
        if (!zip.names.includes(target) || !target.startsWith('xl/')) fail('Invalid Excel relationship target'); rels.set(n.attrs.Id, target);
    }
    const strings = zip.names.includes('xl/sharedStrings.xml') ? children(get('xl/sharedStrings.xml'), 'si').map(plain) : [];
    const tables = {}; let totalCells = 0;
    for (const sheet of walk(get('xl/workbook.xml'), 'sheet')) {
        const name = sheet.attrs.name, columns = SCHEMA[name];
        if (!columns || tables[name]) fail('Unknown or duplicate Excel worksheet: ' + name);
        const file = rels.get(sheet.attrs['r:id']); if (!/^xl\/worksheets\/[^/]+\.xml$/.test(file || '')) fail('Invalid Excel worksheet');
        const rows = []; let previous = 0;
        for (const row of walk(get(file), 'row')) {
            const index = Number(row.attrs.r); if (!Number.isSafeInteger(index) || index <= previous || index > 60002) fail('Excel row exceeds budget or is out of order', 413); previous = index;
            const values = []; let lastColumn = 0;
            for (const cell of children(row, 'c')) {
                const address = /^([A-Z]{1,2})([1-9]\d*)$/.exec(cell.attrs.r || '');
                const column = address && [...address[1]].reduce((v, c) => v * 26 + c.charCodeAt(0) - 64, 0);
                if (!address || Number(address[2]) !== index || column <= lastColumn || column > columns.length) fail(`${name}!${cell.attrs.r}: invalid cell address`); lastColumn = column;
                if (++totalCells > 400000) fail('Excel exceeds cell budget', 413);
                if (children(cell, 'f').length) fail(`${name}!${cell.attrs.r}: formulas are not accepted`);
                const type = cell.attrs.t || 'n'; if (!['n', 's', 'inlineStr', 'b', 'str'].includes(type)) fail(`${name}!${cell.attrs.r}: unsupported cell type`);
                const raw = plain(children(cell, 'v')[0]);
                const value = type === 'inlineStr' ? plain(children(cell, 'is')[0]) : type === 's' ? /^\d+$/.test(raw) && strings[Number(raw)] : raw;
                if (typeof value !== 'string' || value.length > 4096) fail(`${name}!${cell.attrs.r}: invalid value or value exceeds budget`); values[column - 1] = value;
            }
            if (index === 1) { if (JSON.stringify(values) !== JSON.stringify(columns)) fail(name + ': unrecognized column headers'); }
            else if (values.some(v => v !== '')) rows.push(Object.fromEntries(columns.map((key, i) => [key, values[i] || ''])));
        }
        if (!previous) fail(name + ': missing header'); tables[name] = rows;
    }
    if (Object.keys(tables).length !== Object.keys(SCHEMA).length) fail('Excel must contain all six standard worksheets');
    const info = {}; for (const row of tables['导出说明']) { if (Object.hasOwn(info, row.key)) fail('Duplicate export metadata'); info[row.key] = row.value; }
    if (info.formatVersion !== '1' || info.scope !== 'all' || !/^\d+$/.test(info.ledgerRevision) || !Number.isSafeInteger(Number(info.ledgerRevision))
        || !Number.isFinite(Date.parse(info.generatedAt))) fail('Invalid Excel format, scope or revision');
    const boolean = (v, field) => { if (!['true', 'false', '1', '0'].includes(v)) fail('Invalid boolean: ' + field); return ['true', '1'].includes(v); };
    const data = { people: tables['人员清单'].map(r => ({ ...r, direct: boolean(r.direct, 'direct') })), projects: tables['项目需求'].map(r => {
        const { lifecycleState, lifecycleEffectiveDate, ...p } = r; p.minimum = Number(p.minimum);
        if (lifecycleState || lifecycleEffectiveDate) p.lifecycle = { state: lifecycleState, ...(lifecycleEffectiveDate ? { effectiveDate: lifecycleEffectiveDate } : {}) }; return p;
    }), occupancies: [...tables['人员安排'], ...tables['其他占用']].map(r => Object.fromEntries(Object.entries(r).filter(([k, v]) => v !== '' || !['reason', 'projectId'].includes(k)))), historyComplete: boolean(info.historyComplete, 'historyComplete') };
    if (data.people.length > LIMITS.people || data.projects.length > LIMITS.projects || data.occupancies.length > LIMITS.occupancies) fail('Excel record count exceeds ledger budget', 413);
    validateInitial(data);
    const result = { data, formatVersion: 1, sourceRevision: Number(info.ledgerRevision), ledgerId: info.ledgerId, generatedAt: info.generatedAt };
    if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 ** 2) fail('Excel import exceeds complete-data budget', 413); return result;
}
module.exports = { parseWorkbook };
