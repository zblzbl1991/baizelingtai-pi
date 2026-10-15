'use strict';
const { DocumentParserPool } = require('../pi-document-pool');
const { workbook } = require('./excel-workbook');
const fs = require('node:fs'), path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual: same } = require('node:util');
const { getSdk } = require('../pi-session-store');
const { privateDir, atomicJson } = require('../pi-maintenance-files');
const { writePrivateFileSync } = require('../pi-private-files');
const { readVerifiedFile } = require('../pi-file-bytes');
const { keys, id, fail } = require('./validation');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = source => source?.kind === 'page' ? { kind: 'page', profileId: source.profileId } : { sessionId: source?.sessionId, sessionPath: source?.sessionPath, cwd: source?.cwd, profileId: source?.profileId };
class StaffingExcelService {
    constructor({ pool = new DocumentParserPool(), staffing, artifacts, authorizeSource, documents } = {}) {
        Object.assign(this, { pool, staffing, artifacts, authorizeSource, documents }); this.jobs = new Set(); this.stopping = false;
        if (staffing) staffing.imports = this;
        if (artifacts) artifacts.staffingSource = locator => this.source(locator);
    }
    get busy() { return this.jobs.size > 0 || this.pool.jobs.size > 0; }
    async track(action) {
        if (this.stopping || this.jobs.size >= 3) fail('Staffing Excel is busy or stopping', 503);
        let done; const job = new Promise(resolve => { done = resolve; }); this.jobs.add(job);
        try { return await action(); } finally { this.jobs.delete(job); done(); }
    }
    beginReceive() {
        if (this.stopping || this.jobs.size || this.staffing.busy || this.staffing.isSuspended()) fail('Staffing Excel is busy or stopping', 409);
        let done; const job = new Promise(resolve => { done = resolve; }); this.jobs.add(job);
        return () => { this.jobs.delete(job); done(); };
    }
    workbook(data, metadata) { return workbook(data, metadata); }
    inspect(bytes, signal) { return this.pool.run(bytes, 'xlsx', {}, { signal, mode: 'staffing-xlsx' }); }
    projection(...args) { return require('./import-domain').projection(...args); }
    check(...args) { return require('./import-domain').check(...args); }
    commit(...args) { return require('./import-domain').commit(...args); }
    async importRoot() { const root = path.join(await this.root(), 'imports'); if (privateDir(root) !== root || fs.realpathSync.native(root) !== root) fail('Import storage changed', 409); return root; }
    async upload(bytes, input, source) {
        bytes = Buffer.from(bytes); input = structuredClone(input); source = structuredClone(source); keys(input, ['requestId']);
        if (!id(input.requestId) || !bytes.length || bytes.length > 20 * 1024 ** 2) fail('Invalid Excel upload or upload exceeds 20 MiB', 413);
        if (this.stopping) fail('Staffing Excel is stopping', 503);
        return this.staffing.reserve(async () => {
            const state = await this.staffing.requireSource(source, { phase: source.kind === 'page' ? 'initial' : 'ready' });
            await this.inspect(bytes);
            const after = await this.staffing.requireSource(source, { phase: source.kind === 'page' ? 'initial' : 'ready' }); if (after.epoch !== state.epoch) fail('Upload source changed', 409);
            const root = await this.importRoot(), uploadId = hash(JSON.stringify(['staffing-import', input.requestId, stable(source)])), revision = hash(bytes), file = path.join(root, uploadId + '.xlsx');
            if (fs.existsSync(file)) { const existing = await this.uploadObject(uploadId, source); if (existing.record.revision !== revision) fail('Upload request ID has different bytes', 409); return { id: uploadId, revision }; }
            if (fs.readdirSync(root).length >= 1000 || fs.readdirSync(root).reduce((n, name) => n + fs.lstatSync(path.join(root, name)).size, 0) + bytes.length > 256 * 1024 ** 2) fail('Staffing upload quota reached', 413);
            writePrivateFileSync(file, bytes, true); atomicJson(path.join(root, uploadId + '.json'), { id: uploadId, revision, source: stable(source), epoch: state.epoch });
            return { id: uploadId, revision };
        });
    }
    async uploadObject(uploadId, source) {
        if (!/^[a-f0-9]{64}$/.test(uploadId)) fail('Invalid Excel upload ID');
        const root = await this.importRoot(), recordPath = path.join(root, uploadId + '.json');
        const proof = await readVerifiedFile(recordPath, { maxBytes: 32000, check: actual => { if (actual !== recordPath) fail('Import record changed', 409); } });
        const record = JSON.parse(proof.bytes.toString('utf8')), state = await this.staffing.requireSource(source, { phase: source.kind === 'page' ? 'initial' : 'ready' });
        if (record.id !== uploadId || !/^[a-f0-9]{64}$/.test(record.revision || '') || JSON.stringify(record.source) !== JSON.stringify(stable(source)) || record.epoch !== state.epoch) fail('Excel upload source does not match', 403);
        if (this.authorizeSource) await this.authorizeSource(source);
        const file = path.join(root, uploadId + '.xlsx'), data = await readVerifiedFile(file, { maxBytes: 20 * 1024 ** 2, check: actual => { if (actual !== file) fail('Import file changed', 409); } });
        if (data.revision !== record.revision) fail('Excel upload bytes changed', 409);
        const current = await this.staffing.requireSource(source, { phase: source.kind === 'page' ? 'initial' : 'ready' }); if (current.epoch !== record.epoch) fail('Import source changed while reading', 409);
        if (this.authorizeSource) await this.authorizeSource(source);
        const finalProof = await readVerifiedFile(recordPath, { maxBytes: 32000, check: actual => { if (actual !== recordPath) fail('Import record changed', 409); } });
        if (finalProof.revision !== proof.revision) fail('Import record changed while reading', 409);
        return { record, bytes: data.bytes };
    }
    async uploadStatus(requestId, source) {
        if (!id(requestId)) fail('Invalid Excel upload request ID');
        const uploadId = hash(JSON.stringify(['staffing-import', requestId, stable(source)]));
        try { const object = await this.uploadObject(uploadId, source); return { id: uploadId, revision: object.record.revision }; }
        catch (error) { if (error.code === 'ENOENT') return { state: 'unknown', noReplay: true }; throw error; }
    }
    async prepare(service, input, source) {
        service.validateRequest(input, ['uploadId']); if (!/^[a-f0-9]{64}$/.test(input.uploadId || '')) fail('A verified Excel upload is required');
        return service.planMutation(input, 'prepare-import', source, (next, parsed) => {
            const mode = next.initialized ? 'merge' : 'initialize', upserts = {};
            for (const name of ['people', 'projects', 'occupancies']) upserts[name] = parsed.data[name].filter(row => mode === 'initialize' || !same(next[name].find(old => old.id === row.id), row));
            const plan = { id: randomUUID(), kind: 'import', source: stable(source), epoch: next.epoch, revision: next.revision + 1, personIds: [], crossDepartment: false,
                import: { mode, formatVersion: 1, upload: { id: input.uploadId, revision: parsed.uploadRevision }, sourceRevision: parsed.sourceRevision, historyComplete: parsed.data.historyComplete, upserts } };
            plan.originId = plan.id; this.check(next, plan, { today: service.today() }); next.plans[plan.id] = plan;
            return this.projection({ ...next, revision: next.revision + 1 }, plan);
        }, { phase: source.kind === 'page' ? 'initial' : 'ready', preflight: async state => {
            const object = await this.uploadObject(input.uploadId, source), parsed = await this.inspect(object.bytes);
            if (parsed.ledgerId && parsed.ledgerId !== state.profileId) fail('Excel belongs to another staffing ledger', 409);
            return { ...parsed, uploadRevision: object.record.revision };
        } });
    }
    async preflight(_state, plan, source) {
        const object = await this.uploadObject(plan.import.upload.id, source);
        if (object.record.revision !== plan.import.upload.revision) fail('Import plan original changed', 409);
    }
    async root() {
        const root = path.join(fs.realpathSync.native((await getSdk()).getAgentDir()), 'pivane-staffing', 'exports');
        if (privateDir(root) !== root || fs.realpathSync.native(root) !== root) fail('Staffing export storage changed', 409); return root;
    }
    async record(exportId) {
        if (!/^[a-f0-9]{64}$/.test(exportId)) fail('Invalid export ID');
        const root = await this.root(), file = path.join(root, exportId + '.json');
        const data = await readVerifiedFile(file, { maxBytes: 128 * 1024, check: actual => { if (actual !== file) fail('Export record changed', 409); } });
        const record = JSON.parse(data.bytes.toString('utf8'));
        if (record.exportId !== exportId || !id(record.requestId) || !/^[a-f0-9]{64}$/.test(record.sha256 || '') || !Number.isSafeInteger(record.ledgerRevision)
            || !/^[a-f0-9]{64}$/.test(record.requestHash || '') || record.ledgerRevision < 0 || !Number.isSafeInteger(record.size) || record.size < 0 || record.size > 16 * 1024 ** 2
            || !['generated', 'available', 'saved'].includes(record.phase) || !record.source || !Number.isSafeInteger(record.epoch) || record.epoch < 0
            || typeof record.name !== 'string' || !/^staffing-\d+-[a-f0-9]{12}\.xlsx$/.test(record.name) || !Number.isFinite(Date.parse(record.generatedAt))) fail('Invalid export record', 409);
        return record;
    }
    exportId(requestId, source) { return hash(JSON.stringify(['staffing-export', requestId, stable(source)])); }
    receipt(record) { const { requestHash: _hash, source: _source, epoch: _epoch, ...result } = record; return { ...result, origin: null,
        ...(record.phase !== 'generated' ? { downloadHref: '/api/pi/staffing/excel/exports/' + record.exportId } : {}) }; }
    async operation(requestId, source) {
        if (!id(requestId)) fail('Invalid staffing export request');
        return this.track(async () => {
        try {
            const record = await this.record(this.exportId(requestId, source));
            if (record.phase !== 'saved' && record.saveRequestId && this.artifacts) {
                try {
                    const result = await this.artifacts.management.result(record.saveRequestId);
                    const item = result.results?.find(row => row.key === record.sourceKey && row.ok);
                    if (item) { record.phase = 'saved'; record.artifactKey = item.item.key; delete record.saveError; atomicJson(path.join(await this.root(), record.exportId + '.json'), record); }
                    else record.noReplay = true;
                } catch { record.noReplay = true; record.saveError ||= 'Artifact result requires review; do not replay'; }
            }
            return this.receipt(record);
        }
        catch (error) { if (error.code === 'ENOENT') return { requestId, state: 'unknown', noReplay: true }; throw error; }
        });
    }
    async source(locator) {
        const record = await this.record(locator.exportId), state = await this.staffing.requireSource(record.source);
        if (record.sha256 !== locator.revision || record.epoch !== state.epoch) fail('Export source capability changed', 403);
        if (this.authorizeSource) await this.authorizeSource(record.source);
        const root = await this.root(), file = path.join(root, record.exportId + '.xlsx');
        const data = await readVerifiedFile(file, { maxBytes: 16 * 1024 ** 2, check: actual => { if (actual !== file) fail('Export file changed', 409); } });
        if (data.revision !== record.sha256 || data.size !== record.size) fail('Export bytes changed', 409);
        const after = await this.staffing.requireSource(record.source); if (after.epoch !== record.epoch) fail('Export source changed while reading', 409);
        if (this.authorizeSource) await this.authorizeSource(record.source);
        const finalRecord = await this.record(locator.exportId);
        if (['sha256', 'size', 'epoch', 'ledgerRevision', 'generatedAt'].some(key => finalRecord[key] !== record[key]) || JSON.stringify(finalRecord.source) !== JSON.stringify(record.source)) fail('Export record changed while reading', 409);
        return { bytes: data.bytes, metadata: { name: record.name, kind: 'document', createdAt: record.generatedAt, project: record.source.cwd ? { cwd: record.source.cwd, name: path.basename(record.source.cwd) } : null,
            origin: null, provenance: { kind: 'staffing-export', exportId: record.exportId, ledgerRevision: record.ledgerRevision, generatedAt: record.generatedAt } } };
    }
    async export(input, source) {
        input = structuredClone(input); source = structuredClone(source); keys(input, ['requestId', 'expectedRevision']);
        if (!id(input.requestId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('Export requires request ID and revision');
        if (this.stopping || !this.staffing || !this.artifacts) fail('Staffing export is unavailable', 503);
        const exportId = this.exportId(input.requestId, source), requestHash = hash(JSON.stringify(input));
        if (this.jobs.size) fail('Staffing export is busy', 409);
        let done; const job = new Promise(resolve => { done = resolve; }); this.jobs.add(job);
        try { return await this.staffing.reserve(async () => {
            const state = await this.staffing.requireSource(source), root = await this.root(), recordPath = path.join(root, exportId + '.json');
            try { const prior = await this.record(exportId); if (prior.requestHash !== requestHash) fail('Export request ID has different parameters', 409); return this.receipt(prior); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (state.revision !== input.expectedRevision) fail('Staffing ledger changed before export', 409);
            const entries = fs.readdirSync(root).filter(name => name !== 'imports');
            if (entries.length >= 2000 || entries.reduce((n, name) => n + fs.lstatSync(path.join(root, name)).size, 0) >= 256 * 1024 ** 2) fail('Staffing export storage quota reached', 413);
            const generatedAt = new Date().toISOString(), bytes = this.workbook({ people: state.people, projects: state.projects, occupancies: state.occupancies, historyComplete: state.historyComplete }, { revision: state.revision, generatedAt, ledgerId: state.profileId });
            if (entries.reduce((n, name) => n + fs.lstatSync(path.join(root, name)).size, 0) + bytes.length > 256 * 1024 ** 2) fail('Staffing export storage quota reached', 413);
            // Exclusive original publication: unfinished objects remain evidence and are never overwritten.
            writePrivateFileSync(path.join(root, exportId + '.xlsx'), bytes, true);
            const record = { exportId, requestId: input.requestId, requestHash, source: stable(source), epoch: state.epoch, phase: 'generated', name: `staffing-${state.revision}-${exportId.slice(0, 12)}.xlsx`, ledgerRevision: state.revision, generatedAt, sha256: hash(bytes), size: bytes.length };
            atomicJson(recordPath, record);
            try {
                const key = this.artifacts.addLocator({ source: 'generated-staffing', exportId, revision: record.sha256 });
                await this.source({ exportId, revision: record.sha256 }); record.phase = 'available'; record.sourceKey = key; atomicJson(recordPath, record);
                const saveRequestId = 'staffing-' + exportId; record.saveRequestId = saveRequestId; atomicJson(recordPath, record);
                const result = await this.artifacts.management.batch({ requestId: saveRequestId, action: 'save', files: [{ key }] });
                const item = result.results?.find(row => row.key === key && row.ok);
                if (item) { record.phase = 'saved'; record.artifactKey = item.item.key; } else record.saveError = result.results?.[0]?.error || result.error || 'Artifact save outcome requires review';
                atomicJson(recordPath, record);
            } catch (error) { record.saveError = error.status ? error.message : 'Export save outcome requires review'; atomicJson(recordPath, record); }
            return this.receipt(record);
        }); } finally { this.jobs.delete(job); done(); }
    }
    async dispose() { this.stopping = true; await Promise.allSettled([...this.jobs]); await this.pool.dispose(); }
}
module.exports = { StaffingExcelService };
