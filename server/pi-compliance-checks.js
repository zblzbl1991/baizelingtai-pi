const { randomUUID } = require('node:crypto');
const { fail, request } = require('./pi-compliance-ledger');
const { RULE_PACKAGE, evaluate, date } = require('./pi-compliance-rules');
const ROLES = ['award-notice', 'contract', 'feasibility-report', 'feasibility-review', 'feasibility-approval', 'register', 'unknown'];
const LABELS = { projectName: ['项目名称', '工程项目名称', 'Project name'], projectNumber: ['项目编号', '工程项目编号', 'Project number'], organization: ['单位', '建设单位'], year: ['年度'], phase: ['期次'], date: ['日期', '签订日期', '合同签订日期', '中标通知书日期', '报告日期', '评审日期', '批复日期', 'Date'], documentNumber: ['文号', '发文字号', 'Document number'] };
const only = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw fail('检查参数无效'); };
const keyFor = label => Object.keys(LABELS).find(key => LABELS[key].includes(label.trim()));
const columnOf = (cell, index) => cell.column || (cell.address ? [...cell.address.match(/^[A-Z]+/)[0]].reduce((n,c) => n*26+c.charCodeAt(0)-64,0) : index+1);
function candidates(documentId, entries) {
    const output = [];
    for (const key of Object.keys(LABELS)) {
        const values = entries.filter(e => e.key === key), distinct = [...new Set(values.map(v => v.raw.trim()))];
        if (!values.length) continue;
        const raw = distinct.join(' / '), parsed = key === 'date' ? date(raw) : null;
        output.push({ id: randomUUID(), documentId, key, raw, value: key === 'date' ? parsed?.value || null : distinct.length === 1 ? raw : null,
            precision: parsed?.precision || null, status: distinct.length > 1 ? 'conflict' : key === 'date' && !parsed ? 'unknown' : 'known',
            location: values[0].location, candidates: values.map(v => ({ raw: v.raw, location: v.location })) });
    }
    return output;
}
class ComplianceChecks {
    constructor(service, documents) { this.service = service; this.documents = documents; }
    assign(documentId, input) {
        only(input, ['requestId', 'expectedRevision', 'role', 'identityConfirmed', 'selected', 'numberAbsentConfirmed']); request(input);
        if (!ROLES.includes(input.role) || typeof input.identityConfirmed !== 'boolean' || typeof input.selected !== 'boolean' || input.numberAbsentConfirmed !== undefined && typeof input.numberAbsentConfirmed !== 'boolean') throw fail('请明确核对资料角色、归属和选用版本');
        return this.service.reserve(() => this.service.ledger.commit('assignment:' + documentId, input, state => {
            this.service.assertEnabled(state); const document = (state.documents || []).find(d => d.id === documentId); if (!document) throw fail('资料不存在', 404);
            document.assignment = { role: input.role, identityConfirmed: input.identityConfirmed, selected: input.selected, numberAbsentConfirmed: input.numberAbsentConfirmed === true };
            return { ok: true, document };
        }));
    }
    async extract(document) {
        if (!this.documents?.pool) throw fail('共享文档解析服务不可用', 503);
        const { base64 } = await this.service.materials.content(document.id), bytes = Buffer.from(base64, 'base64'), entries = [], pool = this.documents.pool;
        if (!['pdf', 'xlsx', 'csv'].includes(document.format)) return { fields: [], processing: { status: 'unreadable', reason: '图片需要配置扫描识别；当前没有执行 OCR' } };
        const info = await pool.run(bytes, document.format, { action: 'inspect' }); let complete = true, pageCount = 0;
        if (document.format === 'pdf') {
            if (info.total > 200) return { fields: [], processing: { status: 'unreadable', reason: '文本检查最多二百页，请缩小范围' } };
            for (let start = 1; start <= info.total; start += 10) {
                const data = await pool.run(bytes, 'pdf', { action: 'read', start, count: 10, provenance: true }); complete &&= !data.truncated;
                for (const page of data.items) {
                    pageCount++; const location = { page: page.index, region: 'body', excerpt: page.text.slice(0, 2000) };
                    for (const line of page.text.split(/\r?\n/)) {
                        const matched = /^\s*([^:：]{1,40})\s*[:：]\s*(.{1,300}?)\s*$/.exec(line); const key = matched && keyFor(matched[1]);
                        if (key && key !== 'documentNumber') entries.push({ key, raw: matched[2], location });
                    }
                    if (page.index === 1 && !page.provenanceTruncated) {
                        const upper = (page.runs || []).filter(run => run.region === 'upper'), text = upper.map(run => run.text).join(' ');
                        const number = /(?:文号|发文字号)\s*[:：]\s*([^\s]{1,30}[〔\[（(]\d{4}[〕\]）)]\s*\d+\s*号)/.exec(text);
                        if (number) entries.push({ key: 'documentNumber', raw: number[1], location: { page: 1, region: 'upper', viewport: page.viewport, rects: upper.map(run => run.rect).slice(0, 100), excerpt: text.slice(0, 2000) } });
                    }
                }
            }
        } else {
            for (const sheet of info.sheets) {
                let headers;
                for (let start = 1; start <= 10000; start += 100) {
                    const data = await pool.run(bytes, document.format, { action: 'read', sheet: document.format === 'xlsx' ? sheet.name : undefined, start, count: 100, columns: 50 });
                    complete &&= !data.truncated;
                    for (const row of data.rows) {
                        if (row.index === 1) { headers = row.cells.map((cell, index) => ({ column: columnOf(cell,index), key: keyFor(cell.value), address: cell.address })); continue; }
                        if (!headers) { complete = false; continue; }
                        row.cells.forEach((cell, index) => {
                            const column = columnOf(cell,index), header = headers.find(h => h.column === column);
                            if (header?.key && cell.value?.trim() && !cell.formula && ['s', 'str', 'inlineStr'].includes(cell.type) && !cell.truncated)
                                entries.push({ key: header.key, raw: cell.value.trim(), location: { sheet: sheet.name, row: row.index, column, address: cell.address || null, excerpt: cell.value.slice(0, 2000) } });
                        });
                    }
                    if (!data.nextStart) break; if (start + 100 > 10000) complete = false;
                }
            }
        }
        const fields = candidates(document.id, entries);
        if (!complete) fields.forEach(field => { field.status = 'unknown'; field.value = null; });
        return { fields, processing: { status: complete ? 'completed' : 'unreadable', reason: complete ? '仅提取明确标签及固定表头，未匹配内容保留未知' : '文本超过完整读取预算，不能据截断内容确定结论', pages: pageCount } };
    }
    create(projectId, input, worker) {
        only(input, ['requestId', 'expectedRevision']); request(input);
        return this.service.reserve(async () => {
            const ledger = this.service.ledger, state = await ledger.snapshot(), prior = ledger.receipt(state, 'batch:' + projectId, input); if (prior) return prior;
            this.service.assertEnabled(state); ledger.assertRevision(state, input); const project = this.service.materials.project(state, projectId);
            const documents = structuredClone((state.documents || []).filter(d => d.projectId === projectId && d.assignment?.selected)), fields = [];
            const batch = { id: randomUUID(), revision: 1, projectId, projectSnapshot: structuredClone(project), documents, rulePackage: structuredClone(RULE_PACKAGE),
                configurationSnapshot: { mainModel: state.settings.mainModel, extractionModel: state.settings.extractionModel, parserVersion: 'local-labeled-1' },
                fields, results: [], execution: { status: 'running' }, review: { status: 'unreviewed' }, createdAt: new Date().toISOString() };
            for (const document of documents) {
                try { const extracted = await this.extract(document); document.processing = extracted.processing; fields.push(...extracted.fields); }
                catch (error) { document.processing = { status: 'failed', reason: String(error.message).slice(0, 500), code: error.code || 'COMPLIANCE_PARSE_FAILED' }; }
            }
            batch.results = evaluate(batch); batch.execution.status = documents.some(d => d.processing?.status === 'failed') ? 'failed' : 'completed';
            if (worker) await this.service.authorizeWorker(worker);
            return ledger.commit('batch:' + projectId, input, current => { this.service.assertEnabled(current); current.batches ||= []; if (current.batches.length >= 500) throw fail('检查批次数达到五百上限', 413, 'COMPLIANCE_CAPACITY'); current.batches.push(batch); return { ok: true, batch }; });
        });
    }
    async list(projectId) { const state = await this.service.ledger.snapshot(); this.service.materials.project(state, projectId); return { revision: state.revision, batches: (state.batches || []).filter(b => b.projectId === projectId).map(b => ({ id: b.id, revision: b.revision, createdAt: b.createdAt, execution: b.execution, review: b.review })) }; }
    async get(batchId) { const state = await this.service.ledger.snapshot(), batch = (state.batches || []).find(b => b.id === batchId); if (!batch) throw fail('检查批次不存在', 404); return { revision: state.revision, batch }; }
    async evidence(batchId, fieldId) { const { revision, batch } = await this.get(batchId), field = batch.fields.find(f => f.id === fieldId); if (!field) throw fail('证据不存在', 404); const doc = batch.documents.find(d => d.id === field.documentId); return { revision, field, document: { id: doc.id, name: doc.name, hash: doc.hash, size: doc.size } }; }
}
module.exports = { ComplianceChecks, ROLES };
