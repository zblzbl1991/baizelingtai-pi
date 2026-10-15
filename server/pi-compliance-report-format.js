const { crc32 } = require('./pi-document-parser');
const { fail } = require('./pi-compliance-ledger');
const text = value => value === null || value === undefined ? '未知' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const conclusions = { passed: '通过', issue: '发现候选问题', insufficient: '证据不足', 'not-applicable': '不适用', uncompleted: '尚未形成结论' };
const executions = { pending: '尚未执行', running: '执行中', completed: '执行完成', failed: '执行失败', paused: '已暂停', 'needs-review': '请求结果待核对', uncertain: '请求结果不确定', unreadable: '资料尚不可读' };
const reviews = { unreviewed: '未人工复核', verified: '已人工核对', confirmed: '已人工确认', reviewed: '已人工复核', partial: '部分人工复核', rejected: '人工未确认' };
const state = (value, labels) => (labels[value] || '其他状态') + ' [' + text(value) + ']';
const xml = value => text(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '�').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function rows(batch, generatedAt) {
    const results = [...batch.results];
    for (const rule of batch.rulePackage.rules) if (!results.some(r => r.id === rule.id)) results.push({ id: rule.id, conclusion: 'uncompleted', execution: 'pending', reason: '本批次修订尚未形成该规则结果', review: { status: 'unreviewed' }, evidence: [], sources: [] });
    return [
        ['报告信息', [['字段', '值'], ['工程项目', batch.projectSnapshot.name], ['工程项目 ID', batch.projectId], ['项目快照', batch.projectSnapshot], ['批次', batch.id], ['批次修订', batch.revision], ['批次时间', batch.createdAt], ['生成时间', generatedAt], ['规则版本', batch.rulePackage.version], ['规则内容', batch.rulePackage], ['人工复核', batch.review], ['执行状态及未完成工作', batch.execution], ['模型与解析配置', batch.configurationSnapshot], ['历史修订与确认', batch.history], ['人工修正记录', batch.corrections], ['说明', '生成报告不表示全部检查通过或已经人工确认。所有未完成项、证据不足与执行失败均保留。']]],
        ['检查清单', [['规则', '系统结论', '执行', '原因', '人工复核与决定', '证据字段 ID', '资料来源', '完整结果及人工决定'], ...results.map(r => [r.id, state(r.conclusion, conclusions), state(r.execution, executions), r.reason, state(r.review?.status, reviews) + ' ' + text(r.review), r.evidence, r.sources, r])]],
        ['字段与证据', [['字段 ID', '资料 ID', '资料名称', '资料 SHA256', '字段', '原始提取原文', '原始值或日期区间', '原始日期精度', '原始提取状态', '原始出处', '人工核对值与出处（非原件）', '原始候选及人工修正依据'], ...batch.fields.map(f => { const d = batch.documents.find(d => d.id === f.documentId); return [f.id, f.documentId, d?.name, d?.hash, f.key, f.raw, f.value, f.precision, f.status, f.location, f.humanValue, { candidates: f.candidates, history: f.history, corrections: f.corrections, review: f.review, original: f.original }]; })]],
        ['资料及未完成项', [['资料 ID', '名称', 'SHA256', '角色与选用版本', '执行状态及未完成原因'], ...batch.documents.map(d => [d.id, d.name, d.hash, d.assignment, state(d.processing?.status, executions) + ' ' + text(d.processing)])]]
    ];
}
// A bounded stored ZIP containing only fixed OOXML parts, never user-selected paths.
function zip(files) {
    const chunks = [], central = []; let offset = 0;
    for (const [name, source] of files) {
        const data = Buffer.from(source), n = Buffer.from(name), crc = crc32(data), local = Buffer.alloc(30), entry = Buffer.alloc(46);
        local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
        entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(n.length, 28); entry.writeUInt32LE(offset, 42);
        chunks.push(local, n, data); central.push(entry, n); offset += local.length + n.length + data.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, directory, end]);
}
const column = index => { let s = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
function formats(batch, generatedAt) {
    const tables = rows(batch, generatedAt), html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>合规审查报告</title><style>body{font:16px system-ui;line-height:1.6;margin:24px;color:#253c36;background:#f5f8f6}table{border-collapse:collapse;width:100%;margin-bottom:28px}td,th{border:1px solid #9cafa5;padding:8px;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}h1{font-size:26px}section{overflow:auto;max-width:100%}section:first-of-type table{table-layout:fixed}section:first-of-type th:first-child,section:first-of-type td:first-child{width:8em}section:not(:first-of-type) table{min-width:1140px}section:not(:first-of-type) th,section:not(:first-of-type) td{min-width:7em}caption{text-align:left;font-weight:bold;font-size:20px}</style><h1>合规审查报告 · 未经复核的内容保留系统建议性质</h1>' + tables.map(([name, data]) => '<section><table><caption>' + xml(name) + '</caption>' + data.map((row, i) => '<tr>' + row.map(cell => '<' + (i ? 'td' : 'th') + '>' + xml(cell) + '</' + (i ? 'td' : 'th') + '>').join('') + '</tr>').join('') + '</table></section>').join('') + '</html>';
    if (Buffer.byteLength(html) > 2 * 1024 ** 2) throw fail('HTML 报告超过 2 MiB 安全预览预算，请缩小批次；未生成报告', 413, 'COMPLIANCE_REPORT_LIMIT');
    if (tables.some(([, data]) => data.some(row => row.some(cell => text(cell).length > 32767)))) throw fail('Excel 单元格超过 32767 字符，未截断报告，请缩小批次', 413, 'COMPLIANCE_REPORT_LIMIT');
    const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const files = [['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + tables.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'],
        ['_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
        ['xl/workbook.xml', `<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets>` + tables.map(([name], i) => `<sheet name="${xml(name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('') + '</sheets></workbook>'],
        ['xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + tables.map((_, i) => `<Relationship Id="rId${i+1}" Type="${rel}/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('') + '</Relationships>']];
    tables.forEach(([, data], i) => files.push([`xl/worksheets/sheet${i+1}.xml`, `<worksheet xmlns="${ns}"><sheetData>` + data.map((row, r) => `<row r="${r+1}">` + row.map((cell, c) => `<c r="${column(c)}${r+1}" t="inlineStr"><is><t xml:space="preserve">${xml(cell)}</t></is></c>`).join('') + '</row>').join('') + '</sheetData></worksheet>']));
    if (files.some(([, data]) => Buffer.byteLength(data) > 8 * 1024 ** 2)) throw fail('Excel 工作表超过读取预算', 413, 'COMPLIANCE_REPORT_LIMIT');
    const output = [{ format: 'html', bytes: Buffer.from(html) }, { format: 'xlsx', bytes: zip(files) }];
    if (output.some(f => f.bytes.length > 16 * 1024 ** 2) || output.reduce((n, f) => n + f.bytes.length, 0) > 64 * 1024 ** 2) throw fail('报告超过交付预算', 413, 'COMPLIANCE_REPORT_LIMIT');
    return output;
}
module.exports = { formats };
