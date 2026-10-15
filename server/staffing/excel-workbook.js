'use strict';
const zlib = require('node:zlib');
const { crc32 } = require('../pi-document-parser');
const { validateInitial, fail } = require('./validation');
const SCHEMA = Object.freeze({
    '人员清单': ['id', 'name', 'department', 'direct'],
    '项目需求': ['id', 'name', 'department', 'owner', 'start', 'end', 'minimum', 'lifecycleState', 'lifecycleEffectiveDate'],
    '人员安排': ['id', 'personId', 'projectId', 'kind', 'state', 'start', 'end', 'reason'],
    '其他占用': ['id', 'personId', 'projectId', 'kind', 'state', 'start', 'end', 'reason'],
    '项目检查': ['projectId', 'start', 'end', 'count', 'direct', 'missing', 'missingDirect'],
    '导出说明': ['key', 'value']
});
const MAX_REPORT = 16 * 1024 ** 2;
function escape(value) {
    const text = String(value ?? '');
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail('Excel contains unsupported control characters');
    return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}
function zip(parts) {
    const records = [], central = []; let offset = 0;
    for (const [name, text] of Object.entries(parts)) {
        const bytes = Buffer.from(text); if (bytes.length > 8 * 1024 ** 2) fail('Excel XML part exceeds 8 MiB', 413);
        const filename = Buffer.from(name), compressed = zlib.deflateRawSync(bytes), crc = crc32(bytes);
        const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
        header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
        records.push(header, filename, compressed);
        const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10);
        directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
        central.push(directory, filename); offset += header.length + filename.length + compressed.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    const result = Buffer.concat([...records, directory, end]); if (result.length > MAX_REPORT) fail('Excel report exceeds 16 MiB', 413); return result;
}
const letter = n => n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(64 + Math.floor(n / 26)) + String.fromCharCode(65 + n % 26);
function workbook(data, metadata = {}) {
    validateInitial(data);
    const checks = data.projects.flatMap(project => require('./rules').coverage(data, project).segments.map(segment => ({ projectId: project.id, ...segment })));
    const values = [data.people, data.projects.map(p => ({ ...p, lifecycleState: p.lifecycle?.state || '', lifecycleEffectiveDate: p.lifecycle?.effectiveDate || '' })),
        data.occupancies.filter(row => row.kind === 'project'), data.occupancies.filter(row => row.kind !== 'project'), checks,
        Object.entries({ formatVersion: 1, ledgerId: metadata.ledgerId || '', ledgerRevision: metadata.revision ?? 0, generatedAt: metadata.generatedAt || new Date().toISOString(), historyComplete: data.historyComplete,
            scope: metadata.scope || 'all', dateRule: 'YYYY-MM-DD; inclusive start and end', history: 'Current business snapshot; operation audit remains in the ledger' }).map(([key, value]) => ({ key, value }))];
    const names = Object.keys(SCHEMA), parts = {};
    const decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    parts['[Content_Types].xml'] = decl + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>';
    parts['_rels/.rels'] = decl + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
    parts['xl/workbook.xml'] = decl + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${rel}"><sheets>` + names.map((name, i) => `<sheet name="${escape(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>';
    parts['xl/_rels/workbook.xml.rels'] = decl + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="styles" Type="${rel}/styles" Target="styles.xml"/></Relationships>`;
    parts['xl/styles.xml'] = decl + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf xfId="0"/><xf fontId="1" applyFont="1" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    names.forEach((name, i) => {
        const columns = SCHEMA[name], rows = [columns, ...values[i].map(row => columns.map(key => row[key] ?? ''))];
        // Match the complete reader's per-part XML token budget; do not publish a report that cannot be imported intact.
        if (rows.length > 60002 || rows.length * (2 + columns.length * 7) + 50 > 500000) fail('Excel worksheet exceeds complete-import budget', 413);
        const sheet = rows.map((cells, r) => `<row r="${r + 1}">` + cells.map((value, c) => `<c r="${letter(c)}${r + 1}" t="inlineStr"${r ? '' : ' s="1"'}><is><t xml:space="preserve">${escape(value)}</t></is></c>`).join('') + '</row>').join('');
        parts[`xl/worksheets/sheet${i + 1}.xml`] = decl + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="16" width="24" customWidth="1"/></cols><sheetData>' + sheet + `</sheetData><autoFilter ref="A1:${letter(columns.length - 1)}${rows.length}"/></worksheet>`;
    });
    return zip(parts);
}
module.exports = { workbook, SCHEMA, MAX_REPORT };
