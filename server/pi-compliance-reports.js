const fs = require('node:fs'), path = require('node:path');
const { fail, request, fingerprint, pendingCount } = require('./pi-compliance-ledger');
const { formats } = require('./pi-compliance-report-format');
const { readVerifiedFile } = require('./pi-file-bytes');
const { representation } = require('./pi-file-types');
const { openPrivateFileSync } = require('./pi-private-files');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const only = (input, keys) => { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) throw fail('报告参数无效'); };
const reportError = error => /^COMPLIANCE_/.test(error.code || '') ? error : fail('报告读取或写入未完成，请核对原操作回执', error.status || 500, 'COMPLIANCE_REPORT_FAILED');
const toolReport = report => {
    const { steps = [], ...execution } = report.execution || {};
    return { ...report, execution: { ...execution, pendingSteps: steps.filter(s => ['pending','running'].includes(s.status)).length, uncertainSteps: steps.filter(s => s.status === 'uncertain').length }, review: { status: report.review?.status || 'unreviewed' } };
};
class ComplianceReports {
    constructor(service) { this.service = service; this.jobs = new Set(); this.accepted = new Set(); this.deliverables = new (require('./pi-deliverables').DeliverableService)({ store: service.store, supervisor: service.supervisor }); }
    get busy() { return this.jobs.size > 0; }
    async job(action) {
        if (this.stopping || this.service.closed || this.service.isSuspended() || this.jobs.size >= 4) throw fail('报告正在处理或维护中', 409, 'COMPLIANCE_BUSY');
        let finish; const job = new Promise(resolve => { finish = resolve; }); this.jobs.add(job);
        try { return await action(); } finally { this.jobs.delete(job); finish(); }
    }
    async dispose() { this.stopping = true; await Promise.allSettled([...this.jobs]); }
    async tool(worker, input) {
        try {
            only(input, ['operation', 'action', 'batchId', 'batchRevision', 'reportId', 'requestId', 'expectedRevision', 'offset']);
            const mutation = { requestId: input.requestId, expectedRevision: input.expectedRevision };
            if (input.action === 'generate') { const value = await this.generate(input.batchId, { ...mutation, batchRevision: input.batchRevision }, worker); return { ...value, report: toolReport(value.report) }; }
            if (input.action === 'list') {
                const offset = input.offset ?? 0; if (!Number.isSafeInteger(offset) || offset < 0 || offset > 500) throw fail('报告分页无效');
                const value = await this.list(input.batchId), page = value.reports.slice(offset, offset + 50);
                return { revision: value.revision, total: value.reports.length, nextOffset: offset + page.length < value.reports.length ? offset + page.length : null, reports: page.map(({ id, batchRevision, generatedAt, status }) => ({ id, batchRevision, generatedAt, status })) };
            }
            if (input.action === 'get') { const value = await this.get(input.reportId); return { ...value, report: toolReport(value.report) }; }
            if (input.action === 'publish') return await this.publish(input.reportId, mutation, worker);
            if (input.action === 'acknowledge') { const value = await this.acknowledge(input.reportId, mutation, worker); return { ...value, report: toolReport(value.report) }; }
            throw fail('报告操作无效');
        } catch (error) { throw reportError(error); }
    }
    find(state, id) { const report = (state.reports || []).find(r => r.id === id); if (!report) throw fail('报告不存在', 404); return report; }
    async saved(report, catalog) {
        if (!report.delivery || !this.artifacts) return report;
        catalog ||= await this.artifacts.library.catalog(); const d = report.delivery;
        const savedFiles = report.files.map((file, index) => {
            const entry = catalog.entries.find(e => !e.trashedAt && !e.deletingAt && e.sha256 === file.sha256 && e.size === file.size && e.origin?.cwd === d.cwd && e.origin?.sessionId === d.sessionId && e.origin?.deliveryId === d.reference.id && e.origin?.index === index && e.origin?.revision === file.sha256);
            return entry ? { key: entry.id, revision: entry.revision, savedAt: entry.savedAt } : null;
        });
        return { ...report, savedFiles };
    }
    async read(id) { const state = await this.service.ledger.snapshot(); return { revision: state.revision, report: await this.saved(this.find(state, id)) }; }
    async get(id) { return this.job(() => this.read(id)); }
    async list(batchId) { return this.job(async () => { await this.service.checks.get(batchId); const state = await this.service.ledger.snapshot(), catalog = this.artifacts ? await this.artifacts.library.catalog() : null; return { revision: state.revision, reports: await Promise.all((state.reports || []).filter(r => r.batchId === batchId).map(r => this.saved(r, catalog))) }; }); }
    async bytes(report, index) {
        if (!Number.isInteger(index) || index < 0 || index >= report.files.length) throw fail('报告文件编号无效');
        const file = report.files[index], { root } = await this.service.ledger.paths();
        const target = path.join(root, `report-${report.id}-${index}.bin`), parent = io.openReadSync(root);
        try {
            const identity = io.identity(parent), before = fs.fstatSync(parent, { bigint: true });
            const check = actual => {
                const current = fs.lstatSync(root, { bigint: true });
                if (actual !== target || !current.isDirectory() || current.isSymbolicLink() || descriptorPathSync(parent) !== root || !io.sameIdentityAtPath(root, identity) || ['dev','ino','mode'].some(k => before[k] !== current[k])) throw fail('报告位置变化', 409, 'COMPLIANCE_STORAGE_CHANGED');
            };
            const data = await readVerifiedFile(target, { maxBytes: 16 * 1024 ** 2, check }); check(target);
            if (data.revision !== file.sha256 || data.size !== file.size) throw fail('报告字节已变化', 409, 'COMPLIANCE_STORAGE_CHANGED'); return data;
        } finally { fs.closeSync(parent); }
    }
    async content(id, index) { return this.job(async () => { const { report } = await this.read(id), { absolutePath, ...data } = representation(await this.bytes(report, index), report.files[index].name); return { ...data, name: report.files[index].name, reportId: id }; }); }
    deliveryInput(reportId, input, worker) {
        only(input, ['requestId', 'expectedRevision']); request(input);
        return { ...input, reportId, cwd: worker.cwd, sessionId: worker.sessionId };
    }
    acceptedKey(input) { return JSON.stringify([input.requestId, input.cwd, input.sessionId, input.reportId]); }
    async canSettle(worker, raw) {
        if (!worker || !['publish', 'acknowledge'].includes(raw?.action)) return false;
        const input = this.deliveryInput(raw.reportId, { requestId: raw.requestId, expectedRevision: raw.expectedRevision }, worker);
        if (!this.accepted.has(this.acceptedKey(input)) || this.service.supervisor.getActiveWorker(worker.sessionPath) !== worker || worker.disposed || worker.restarting) return false;
        const state = await this.service.ledger.snapshot(), pending = Object.hasOwn(state.reportDeliveries || {}, input.requestId) && state.reportDeliveries[input.requestId];
        return Boolean(pending && pending.fingerprint === fingerprint('report-delivery', input) && ['publishing', 'published'].includes(pending.phase));
    }
    async publish(reportId, raw, worker) {
        const input = this.deliveryInput(reportId, raw, worker), kind = 'report-delivery';
        const settling = await this.canSettle(worker, { ...raw, reportId, action: 'publish' });
        return this.service.reserve(async () => {
            await this.service.authorizeWorker(worker, settling); const ledger = this.service.ledger;
            let state = await ledger.snapshot(), report = this.find(state, reportId);
            const prior = ledger.receipt(state, kind, input); if (prior) return prior.report.delivery;
            let journal = Object.hasOwn(state.reportDeliveries || {}, input.requestId) ? state.reportDeliveries[input.requestId] : null;
            if (Object.hasOwn(state.reportGenerations || {}, input.requestId) || Object.hasOwn(state.sessionCreations || {}, input.requestId) || Object.hasOwn(state.checkOperations || {}, input.requestId)) throw fail('操作编号已有未完成变更', 409, 'COMPLIANCE_CONFLICT');
            if (journal && journal.fingerprint !== fingerprint(kind, input)) throw fail('报告交付操作编号冲突', 409, 'COMPLIANCE_CONFLICT');
            if (journal) {
                if (journal.receipt) {
                    const ref = journal.receipt.reference, branch = await this.deliverables.branch(input);
                    if (branch.refs.some(r => r.id === ref.id && r.manifestRevision === ref.manifestRevision)) return journal.receipt;
                }
                throw fail('原交付结果待核对，请查询原操作；未重放', 409, 'COMPLIANCE_REPORT_INCOMPLETE');
            }
            if (!journal) {
                state = (await ledger.transact(current => {
                    ledger.assertRevision(current, input); this.service.assertEnabled(current); this.find(current, reportId);
                    if (Object.keys(current.receipts).length + pendingCount(current, input.requestId) >= 10000) throw fail('操作回执和待核对预留达到一万项上限', 413, 'COMPLIANCE_CAPACITY');
                    if (Object.keys(current.reportDeliveries || {}).length >= 10000) throw fail('待核对交付已达一万项', 413, 'COMPLIANCE_REPORT_LIMIT');
                    current.reportDeliveries ||= {}; const value = { fingerprint: fingerprint(kind, input), input, phase: 'publishing', createdAt: new Date().toISOString() };
                    Object.defineProperty(current.reportDeliveries, input.requestId, { value, enumerable: true, configurable: true, writable: true });
                })).state; journal = state.reportDeliveries[input.requestId];
            }
            // Existing pending intent can only reconcile an already-published object.
            // It never regenerates or overwrites uncertain bytes.
            const files = []; for (let i = 0; i < report.files.length; i++) files.push(await this.bytes(report, i));
            const receipt = await require('./pi-compliance-report-publisher').publishReport(this.deliverables.objects, worker, report, input, files);
            await this.service.authorizeWorker(worker, await this.canSettle(worker, { ...raw, reportId, action: 'publish' }));
            await ledger.transact(current => {
                const pending = current.reportDeliveries?.[input.requestId]; if (pending?.fingerprint !== fingerprint(kind, input)) throw fail('报告交付记录变化', 409);
                pending.phase = 'published'; pending.receipt = receipt;
                const item = this.find(current, reportId); item.status = 'published'; item.delivery = { requestId: input.requestId, cwd: worker.cwd, sessionId: worker.sessionId, ...receipt };
            });
            return receipt;
        }, settling);
    }
    async acknowledge(reportId, raw, worker) {
        const input = this.deliveryInput(reportId, raw, worker), ledger = this.service.ledger;
        const settling = await this.canSettle(worker, { ...raw, reportId, action: 'acknowledge' });
        return this.service.reserve(async () => {
            await this.service.authorizeWorker(worker, settling); const state = await ledger.snapshot(), prior = ledger.receipt(state, 'report-delivery', input); if (prior) return prior;
            const journal = state.reportDeliveries?.[input.requestId]; if (!journal?.receipt || journal.fingerprint !== fingerprint('report-delivery', input)) throw fail('报告尚未交付', 409, 'COMPLIANCE_REPORT_INCOMPLETE');
            const ref = journal.receipt.reference, branch = await this.deliverables.branch(input);
            if (!branch.refs.some(r => r.id === ref.id && r.manifestRevision === ref.manifestRevision)) throw fail('尚未取得原生交付引用，请核对原操作', 409, 'COMPLIANCE_REPORT_INCOMPLETE');
            return (await ledger.transact(current => {
                this.service.assertEnabled(current, settling); const pending = current.reportDeliveries?.[input.requestId]; if (pending?.fingerprint !== journal.fingerprint) throw fail('交付记录变化', 409);
                const report = this.find(current, reportId); report.status = 'delivered'; report.delivery = { requestId: input.requestId, cwd: worker.cwd, sessionId: worker.sessionId, ...journal.receipt };
                delete current.reportDeliveries[input.requestId]; return ledger.record(current, 'report-delivery', input, { ok: true, report });
            })).value;
        }, settling);
    }
    async pending(id) {
        const state = await this.service.ledger.snapshot();
        const generation = state.reportGenerations && Object.hasOwn(state.reportGenerations, id) && state.reportGenerations[id];
        if (generation) return { status: 'generating', requestId: id, reportId: generation.report.id, noReplay: true, revision: state.revision };
        const journal = state.reportDeliveries && Object.hasOwn(state.reportDeliveries, id) && state.reportDeliveries[id]; if (!journal) return null;
        if (journal.receipt) {
            const ref = journal.receipt.reference, branch = await this.deliverables.branch(journal.input).catch(() => null);
            if (branch?.refs.some(r => r.id === ref.id && r.manifestRevision === ref.manifestRevision)) return this.reconcile(journal, this.find(state, journal.input.reportId));
        }
        return { status: journal.phase, requestId: id, noReplay: true, reportId: journal.input.reportId, revision: state.revision };
    }
    async reconcile(journal, snapshot) {
        // Reconcile an existing native fact, including a closed or now-disabled
        // session. This never starts a worker, publishes bytes or appends JSONL.
        const { input, receipt } = journal, ledger = this.service.ledger, ref = receipt.reference;
        return this.job(async () => {
            try {
                return (await ledger.transact(current => {
                    const prior = ledger.receipt(current, 'report-delivery', input); if (prior) return prior;
                    const pending = Object.hasOwn(current.reportDeliveries || {}, input.requestId) && current.reportDeliveries[input.requestId];
                    if (pending?.fingerprint !== journal.fingerprint || pending.receipt?.reference.id !== ref.id || pending.receipt?.reference.manifestRevision !== ref.manifestRevision) throw fail('原生交付记录已变化', 409, 'COMPLIANCE_CONFLICT');
                    const report = this.find(current, input.reportId); report.status = 'delivered'; report.delivery = { requestId: input.requestId, cwd: input.cwd, sessionId: input.sessionId, ...receipt };
                    delete current.reportDeliveries[input.requestId]; return ledger.record(current, 'report-delivery', input, { ok: true, report });
                }, async () => {
                    const object = await this.deliverables.objects.manifest(ref.id, ref.manifestRevision);
                    if (object.manifest.files.length !== snapshot.files.length || object.manifest.files.some(f => f.sourceKind !== 'compliance-report' || f.provenance?.reportId !== snapshot.id || f.provenance?.batchId !== snapshot.batchId || f.provenance?.batchRevision !== snapshot.batchRevision)) throw fail('报告交付出处已变化', 409, 'COMPLIANCE_REPORT_INCOMPLETE');
                    for (const file of snapshot.files) {
                        const data = await this.deliverables.request({ cwd: input.cwd, sessionId: input.sessionId, id: ref.id, index: String(file.index) });
                        if (data.name !== file.name || data.revision !== file.sha256 || data.size !== file.size || data.absolutePath !== null) throw fail('报告交付字节已变化', 409, 'COMPLIANCE_REPORT_INCOMPLETE');
                    }
                })).value;
            } catch (error) { throw reportError(error); }
        });
    }
    async deliver(reportId, input) {
        only(input, ['requestId', 'expectedRevision', 'cwd', 'sessionId']); request(input);
        if (this.jobs.size || this.stopping || this.service.closed || this.service.isSuspended()) throw fail('报告交付正在进行或维护中', 409, 'COMPLIANCE_BUSY');
        let finish; const job = new Promise(resolve => { finish = resolve; }); this.jobs.add(job);
        try {
            const session = await this.service.store.getSession(input.cwd, input.sessionId), worker = this.service.supervisor?.getActiveWorker(session.path);
            if (!worker) throw fail('请打开原生合规专用聊天后交付', 409, 'COMPLIANCE_SCOPE');
            await this.service.authorizeWorker(worker); const stable = this.deliveryInput(reportId, { requestId: input.requestId, expectedRevision: input.expectedRevision }, worker), state = await this.service.ledger.snapshot();
            const prior = this.service.ledger.receipt(state, 'report-delivery', stable); if (prior) return prior;
            if (Object.hasOwn(state.reportDeliveries || {}, input.requestId)) return this.pending(input.requestId);
            const accepted = this.acceptedKey(stable); this.accepted.add(accepted);
            try { return await worker.exclusive(rpc => worker.navigate(rpc, { mode: 'compliance-report', input: { ...stable, cwd: undefined, sessionId: undefined } })); }
            finally { this.accepted.delete(accepted); }
        } finally { this.jobs.delete(job); finish(); }
    }
    generate(batchId, input, worker) {
        only(input, ['requestId', 'expectedRevision', 'batchRevision']); request(input);
        if (this.stopping) throw fail('报告正在停机', 409, 'COMPLIANCE_BUSY');
        return this.service.reserve(async () => {
            if (worker) await this.service.authorizeWorker(worker);
            const ledger = this.service.ledger, kind = 'report:' + batchId;
            const prepared = (await ledger.transact(state => {
                const prior = ledger.receipt(state, kind, input); if (prior) return { prior };
                if (Object.hasOwn(state.reportDeliveries || {}, input.requestId) || Object.hasOwn(state.sessionCreations || {}, input.requestId) || Object.hasOwn(state.checkOperations || {}, input.requestId)) throw fail('操作编号已有未完成变更', 409, 'COMPLIANCE_CONFLICT');
                const previous = state.reportGenerations && Object.hasOwn(state.reportGenerations, input.requestId) && state.reportGenerations[input.requestId];
                if (previous) {
                    if (previous.fingerprint !== fingerprint(kind, input)) throw fail('报告操作编号冲突', 409, 'COMPLIANCE_CONFLICT');
                    throw fail('报告生成结果待核对，未重放', 409, 'COMPLIANCE_REPORT_INCOMPLETE');
                }
                this.service.assertEnabled(state); ledger.assertRevision(state, input);
                if (Object.keys(state.receipts).length + pendingCount(state, input.requestId) >= 10000) throw fail('操作回执和待核对预留达到一万项上限', 413, 'COMPLIANCE_CAPACITY');
                const batch = (state.batches || []).find(b => b.id === batchId); if (!batch) throw fail('批次不存在', 404);
                if (input.batchRevision !== batch.revision) throw fail('批次修订已变化，请重新核对', 409, 'COMPLIANCE_STALE');
                state.reports ||= []; const reserved = Object.values(state.reportGenerations || {}).map(g => g.report);
                if (state.reports.length + reserved.length >= 500) throw fail('报告及待核对预留达到五百份上限', 413, 'COMPLIANCE_REPORT_LIMIT');
                const id = fingerprint(kind, input), generatedAt = new Date().toISOString(), output = formats(batch, generatedAt);
                if ([...state.reports, ...reserved].reduce((n, r) => n + r.files.reduce((v, f) => v + f.size, 0), 0) + output.reduce((n, f) => n + f.bytes.length, 0) > 2 * 1024 ** 3) throw fail('报告及待核对预留达到 2 GiB 上限', 413, 'COMPLIANCE_REPORT_LIMIT');
                const report = { id, batchId, batchRevision: batch.revision, projectId: batch.projectId, projectName: batch.projectSnapshot.name, ruleVersion: batch.rulePackage.version, generatedAt, review: structuredClone(batch.review), execution: structuredClone(batch.execution), status: 'generated', files: output.map((f, i) => ({ index: i, format: f.format, name: `compliance-${batch.id.slice(0,8)}-r${batch.revision}-${id.slice(0,8)}.${f.format}`, size: f.bytes.length, sha256: require('node:crypto').createHash('sha256').update(f.bytes).digest('hex') })) };
                state.reportGenerations ||= {};
                Object.defineProperty(state.reportGenerations, input.requestId, { value: { fingerprint: fingerprint(kind, input), report }, enumerable: true, configurable: true, writable: true });
                return { report, output };
            })).value;
            if (prepared.prior) return prepared.prior;
            const { report, output } = prepared, id = report.id;
            // Durable intent precedes exclusive objects. An interrupted generation is
            // queryable without regenerating or overwriting its uncertain objects.
            return (await ledger.transact((state, { root, check }) => {
                const pending = state.reportGenerations?.[input.requestId];
                if (pending?.fingerprint !== fingerprint(kind, input)) throw fail('报告生成记录已变化', 409, 'COMPLIANCE_CONFLICT');
                this.service.assertEnabled(state);
                output.forEach((file, i) => {
                    const target = path.join(root, `report-${id}-${i}.bin`); let fd;
                    try {
                        check(); fd = openPrivateFileSync(target); const identity = io.identity(fd);
                        fs.writeFileSync(fd, file.bytes); fs.fsyncSync(fd); check();
                        const stat = fs.fstatSync(fd, { bigint: true });
                        if (!stat.isFile() || stat.size !== BigInt(file.bytes.length) || descriptorPathSync(fd) !== target || !io.sameIdentityAtPath(target, identity)) throw fail('报告写入身份已变化', 409, 'COMPLIANCE_STORAGE_CHANGED');
                        const read = require('./pi-maintenance-files').readSafe(target, 16 * 1024 ** 2);
                        if (require('node:crypto').createHash('sha256').update(read).digest('hex') !== report.files[i].sha256) throw fail('报告写入字节校验失败', 409, 'COMPLIANCE_STORAGE_CHANGED'); check();
                    } catch (error) { if (error.code === 'EEXIST') throw fail('报告生成结果待核对，未覆盖或重放', 409, 'COMPLIANCE_REPORT_INCOMPLETE'); throw error; }
                    finally { if (fd !== undefined) fs.closeSync(fd); }
                });
                state.reports.push(report); delete state.reportGenerations[input.requestId]; return ledger.record(state, kind, input, { ok: true, report });
            })).value;
        });
    }
}
function mountReports(router, service, route) {
    const safe = action => {
        const handler = route(async req => { try { return await action(req); } catch (error) { throw reportError(error); } });
        return (req, res) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" }); return handler(req, res); };
    };
    router.get('/compliance/batches/:id/reports', safe(req => service.reports.list(req.params.id)));
    router.post('/compliance/batches/:id/reports', safe(req => service.reports.generate(req.params.id, req.body)));
    router.get('/compliance/reports/:id', safe(req => service.reports.get(req.params.id)));
    router.get('/compliance/reports/:id/files/:index', safe(req => service.reports.content(req.params.id, /^\d$/.test(req.params.index) ? Number(req.params.index) : -1)));
    router.post('/compliance/reports/:id/delivery', safe(req => service.reports.deliver(req.params.id, req.body)));
}
module.exports = { ComplianceReports, mountReports, only };
