const { randomUUID } = require('node:crypto');
const { fail, hash, request } = require('./pi-compliance-ledger');
const { date, evaluate } = require('./pi-compliance-rules');
const KEYS = ['projectName', 'projectNumber', 'organization', 'year', 'phase', 'type', 'stage', 'applicability', 'date', 'documentNumber'];
const only = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('复核参数无效'); };
const text = (value, maximum, name) => { if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) throw fail(name + '无效'); return value.trim(); };
const binding = batch => ({ projectId: batch.projectId, batchId: batch.id, batchRevision: batch.revision,
    sources: batch.documents.map(doc => ({ documentId: doc.id, hash: doc.hash })), ruleVersion: batch.rulePackage.version,
    ruleHash: hash(batch.rulePackage), snapshotHash: hash({ project: batch.projectSnapshot, documents: batch.documents, configuration: batch.configurationSnapshot, fields: batch.fields, results: batch.results, execution: batch.execution, review: batch.review }) });
class ComplianceReview {
    constructor(service) { this.service = service; }
    batch(state, id) { const batch = (state.batches || []).find(item => item.id === id); if (!batch) throw fail('检查批次不存在', 404); return batch; }
    idle(batch) { if (batch.execution.status === 'running' || this.service.checks.jobs.has(batch.projectId)) throw fail('请等待当前检查实际结束，再准备人工复核', 409, 'COMPLIANCE_BUSY'); }
    async origin(input, worker) {
        await this.service.checks.ready();
        if (worker) await this.service.authorizeWorker(worker);
        const cwd = this.service.store.resolveProject(worker ? worker.cwd : input.cwd), sessionId = worker ? worker.sessionId : input.sessionId;
        const session = await this.service.store.getSession(cwd, sessionId), state = await this.service.ledger.snapshot();
        if (!session || session.agentProfile?.id !== state.settings.profileId || !(await this.service.profiles.getProfile(state.settings.profileId))?.enabled)
            throw fail('需要已绑定的合规专用会话作为复核来源', 403, 'COMPLIANCE_SCOPE');
        this.registryFile = (await this.service.profiles.paths()).file;
        return { cwd, sessionId: session.id, profileId: state.settings.profileId, nativeKey: hash({ path: session.path, sessionId: session.id }) };
    }
    assertOrigin(state, origin, worker) {
        if (origin.profileId !== state.settings.profileId || !require('./pi-profile-registry').readRegistry(this.registryFile).state.profiles.some(profile => profile.id === origin.profileId && profile.enabled)
            || worker && (worker.disposed || worker.restarting || this.service.supervisor.getActiveWorker(worker.sessionPath) !== worker
                || !worker.loadedAgentProfileConfirmed || worker.loadedAgentProfileId !== origin.profileId || worker.sessionId !== origin.sessionId
                || hash({ path: worker.sessionPath, sessionId: worker.sessionId }) !== origin.nativeKey)) throw fail('复核来源资格已变化，请重新核对', 403, 'COMPLIANCE_SCOPE');
    }
    change(batch, input) {
        if (input?.kind === 'conclusion') {
            only(input, ['kind', 'resultId', 'conclusion', 'reason']);
            if (!batch.results.some(result => result.id === input.resultId) || !['passed', 'issue', 'insufficient', 'not-applicable'].includes(input.conclusion)) throw fail('请选择当前规则与人工结论');
            return { kind: 'conclusion', resultId: input.resultId, conclusion: input.conclusion, reason: text(input.reason, 1000, '人工结论理由') };
        }
        only(input, ['kind', 'documentId', 'key', 'raw', 'absent', 'location', 'reason']);
        if (input.kind !== 'field' || !KEYS.includes(input.key)) throw fail('请选择可修正字段');
        const doc = batch.documents.find(item => item.id === input.documentId); if (!doc) throw fail('修正资料不属于本批次');
        if (input.absent !== undefined && typeof input.absent !== 'boolean') throw fail('文号缺失确认无效');
        const absent = input.absent === true;
        if (absent && (input.key !== 'documentNumber' || input.raw !== null)) throw fail('只有明确核对的文号可标为缺失');
        const raw = absent ? null : text(input.raw, 300, '人工值'), reason = text(input.reason, 1000, '修正理由');
        const parsed = input.key === 'date' ? date(raw) : null; if (input.key === 'date' && !parsed) throw fail('日期须包含年份与月份，可保留到月的精度');
        only(input.location, ['page', 'region', 'sheet', 'row', 'column', 'excerpt']);
        const loc = input.location, location = { excerpt: text(loc.excerpt, 2000, '原件位置说明') };
        if (['xlsx', 'csv'].includes(doc.format)) {
            if (loc.page !== undefined || loc.region !== undefined || !Number.isSafeInteger(loc.row) || loc.row < 1 || loc.row > 10000 || !Number.isSafeInteger(loc.column) || loc.column < 1 || loc.column > 50) throw fail('请填写表格工作表、行与列');
            Object.assign(location, { sheet: text(loc.sheet, 200, '工作表'), row: loc.row, column: loc.column });
        } else {
            if (loc.sheet !== undefined || loc.row !== undefined || loc.column !== undefined || !Number.isSafeInteger(loc.page) || loc.page < 1 || loc.page > (doc.format === 'pdf' ? 2000 : 1) || !['upper', 'body'].includes(loc.region)) throw fail('请填写原件页码与区域');
            Object.assign(location, { page: loc.page, region: loc.region });
        }
        if (absent && (location.page !== 1 || location.region !== 'upper')) throw fail('确认文号缺失须核对发文首页上方');
        return { kind: 'field', documentId: doc.id, key: input.key, raw, ...(absent ? { absent: true } : {}), value: parsed?.value || raw, precision: parsed?.precision || null, location, reason };
    }
    prepare(batchId, input, worker) {
        only(input, ['requestId', 'expectedRevision', 'batchRevision', 'cwd', 'sessionId', 'change']); request(input);
        return this.service.reserve(async () => {
            const ledger = this.service.ledger, prior = ledger.receipt(await ledger.snapshot(), 'review-prepare:' + batchId, input); if (prior) return prior;
            const origin = await this.origin(input, worker);
            return ledger.commit('review-prepare:' + batchId, input, state => {
                this.service.assertEnabled(state); this.assertOrigin(state, origin, worker); const batch = this.batch(state, batchId); this.idle(batch);
                if (input.batchRevision !== batch.revision) throw fail('检查批次已变化，请重新准备确认卡', 409, 'COMPLIANCE_STALE');
                if ((state.reviewProposals || []).length >= 2000) throw fail('复核方案达到容量限制', 413, 'COMPLIANCE_CAPACITY');
                const change = this.change(batch, input.change), before = structuredClone(change.kind === 'field' ? batch.fields.find(f => f.documentId === change.documentId && f.key === change.key) || null : batch.results.find(result => result.id === change.resultId));
                const proposal = { id: randomUUID(), ...binding(batch), projectName: batch.projectSnapshot.name, settingsRevision: state.settingsRevision || 0,
                    change, before, origin, createdAt: new Date().toISOString() };
                proposal.contentHash = hash(proposal); state.reviewProposals ||= []; state.reviewProposals.push(proposal);
                return { ok: true, proposal: { ...proposal, status: 'ready' } };
            });
        });
    }
    status(state, proposal) {
        if (proposal.applied) return 'applied';
        const batch = this.batch(state, proposal.batchId);
        return !state.settings.enabled || (state.settingsRevision || 0) !== proposal.settingsRevision || hash(binding(batch)) !== hash(Object.fromEntries(Object.keys(binding(batch)).map(key => [key, proposal[key]]))) ? 'stale' : 'ready';
    }
    async get(id) { const state = await this.service.ledger.snapshot(), proposal = (state.reviewProposals || []).find(item => item.id === id); if (!proposal) throw fail('复核方案不存在', 404); return { revision: state.revision, proposal: { ...proposal, status: this.status(state, proposal) } }; }
    async list(batchId) { const state = await this.service.ledger.snapshot(); this.batch(state, batchId); return { revision: state.revision, proposals: (state.reviewProposals || []).filter(p => p.batchId === batchId).map(p => ({ ...p, status: this.status(state, p) })) }; }
    confirm(id, input) {
        only(input, ['requestId', 'expectedRevision', 'contentHash', 'cwd', 'sessionId']); request(input);
        return this.service.reserve(async () => {
            const ledger = this.service.ledger, prior = ledger.receipt(await ledger.snapshot(), 'review-confirm:' + id, input); if (prior) return prior;
            const origin = await this.origin(input);
            return ledger.commit('review-confirm:' + id, input, state => {
                this.service.assertEnabled(state); this.assertOrigin(state, origin); const proposal = (state.reviewProposals || []).find(p => p.id === id);
                if (!proposal) throw fail('复核方案不存在', 404);
                if (proposal.contentHash !== input.contentHash || hash(proposal.origin) !== hash(origin)) throw fail('确认内容或来源已变化，请重新准备', 409, 'COMPLIANCE_STALE');
                if (this.status(state, proposal) !== 'ready') throw fail('确认卡已失效，请查看新修订并重新准备', 409, 'COMPLIANCE_STALE');
                const batch = this.batch(state, proposal.batchId); this.idle(batch); const now = new Date().toISOString();
                batch.history ||= []; batch.history.push({ revision: batch.revision, fields: structuredClone(batch.fields), results: structuredClone(batch.results), review: structuredClone(batch.review), confirmedAt: now, proposalId: id });
                const change = proposal.change; batch.revision++;
                if (change.kind === 'conclusion') {
                    const result = batch.results.find(item => item.id === change.resultId);
                    result.humanDecision = { conclusion: change.conclusion, reason: change.reason, proposalId: id, origin, confirmedAt: now, revision: batch.revision };
                    result.review = { status: 'confirmed', proposalId: id, confirmedAt: now };
                    batch.review = { status: batch.results.every(item => item.review?.status === 'confirmed') ? 'confirmed' : 'partial' };
                } else {
                let field = batch.fields.find(f => f.documentId === change.documentId && f.key === change.key);
                if (!field) { field = { id: randomUUID(), documentId: change.documentId, key: change.key, raw: null, value: null, precision: null, status: 'unknown', location: null, original: { absent: true } }; batch.fields.push(field); }
                const before = structuredClone(field.humanValue || null); field.history ||= []; if (before) field.history.push(before);
                field.humanValue = { raw: change.raw, value: change.value, precision: change.precision, status: change.absent ? 'absent' : 'known', location: change.location, reason: change.reason, proposalId: id, confirmedAt: now, origin };
                field.review = { status: 'verified', proposalId: id, confirmedAt: now };
                batch.corrections ||= []; batch.corrections.push({ fieldId: field.id, documentId: field.documentId, key: field.key, before: proposal.before, after: structuredClone(field.humanValue), reason: change.reason, origin, proposalId: id, revision: batch.revision, confirmedAt: now });
                batch.results = evaluate(batch); batch.review = { status: 'unreviewed' };
                }
                proposal.applied = { requestId: input.requestId, batchRevision: batch.revision, confirmedAt: now };
                return { ok: true, proposalId: id, batch: structuredClone(batch) };
            });
        });
    }
}
module.exports = { ComplianceReview };
