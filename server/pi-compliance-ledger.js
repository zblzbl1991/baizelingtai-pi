const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getSdk } = require('./pi-session-store');
const { safeFile } = require('./pi-native-service');
const { privateDir, atomicJson, readSafe } = require('./pi-maintenance-files');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const fail = (message, status = 400, code = 'COMPLIANCE_INVALID') => Object.assign(new Error(message), { status, code });
const LIMIT = 8 * 1024 * 1024;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const empty = () => ({ version: 1, revision: 0, settings: { enabled: false, profileId: null, mainModel: null, extractionModel: null }, setup: null, projects: [], receipts: {} });
const fingerprint = (kind, input) => { const { expectedRevision, ...values } = input; return hash({ kind, ...values }); };
function request(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.requestId !== 'string'
        || !/^[A-Za-z0-9_.:-]{1,160}$/.test(input.requestId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
        throw fail('需要稳定操作编号及当前修订');
}

// A single private ledger is the transaction boundary. All mutation callbacks are
// synchronous: revision comparison, receipt and replacement cannot interleave.
class ComplianceLedger {
    constructor({ getAgentDir } = {}) { this.getAgentDir = getAgentDir || (async () => (await getSdk()).getAgentDir()); this.busy = false; }
    async paths(create = false) {
        const agentDir = await this.getAgentDir();
        const file = safeFile(agentDir, ['pivane-compliance', 'ledger.json'], create), root = path.dirname(file);
        if (create) privateDir(root);
        return { root, file };
    }
    read(file) {
        let parentFd;
        try {
            const root = path.dirname(file);
            parentFd = io.openReadSync(root);
            const parent = fs.fstatSync(parentFd, { bigint: true }), identity = io.identity(parentFd);
            const check = () => {
                const current = fs.lstatSync(root, { bigint: true });
                if (!parent.isDirectory() || !current.isDirectory() || current.isSymbolicLink() || parent.dev !== current.dev || parent.ino !== current.ino
                    || parent.mode !== current.mode || descriptorPathSync(parentFd) !== root || !io.sameIdentityAtPath(root, identity))
                    throw fail('合规目录已变化', 409, 'COMPLIANCE_STORAGE_CHANGED');
            };
            check();
            const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readSafe(file, LIMIT)));
            check();
            if (state?.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !state.settings
                || typeof state.settings.enabled !== 'boolean' || !Array.isArray(state.projects) || state.projects.length > 500
                || !state.receipts || typeof state.receipts !== 'object' || Array.isArray(state.receipts)) throw fail('合规账本无效', 503, 'COMPLIANCE_STORAGE');
            return state;
        } catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
        finally { if (parentFd !== undefined) fs.closeSync(parentFd); }
    }
    async snapshot() { const { file } = await this.paths(); return this.read(file); }
    async transact(update) {
        if (this.busy) throw fail('合规账本正在保存，请查询原操作', 409, 'COMPLIANCE_BUSY');
        this.busy = true;
        let directoryFd, lock, check;
        try {
            const { root, file } = await this.paths(true);
            directoryFd = io.openReadSync(root);
            const parent = fs.fstatSync(directoryFd, { bigint: true }), identity = io.identity(directoryFd);
            check = () => {
                const current = fs.lstatSync(root, { bigint: true });
                if (!current.isDirectory() || current.isSymbolicLink() || parent.dev !== current.dev || parent.ino !== current.ino
                    || parent.mode !== current.mode || descriptorPathSync(directoryFd) !== root || fs.realpathSync.native(root) !== root
                    || !io.sameIdentityAtPath(root, identity)) throw fail('合规目录已变化', 409, 'COMPLIANCE_STORAGE_CHANGED');
            };
            check(); lock = path.join(root, 'ledger.lock');
            try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { lock = null; throw fail('合规账本已锁定，请核对未完成操作', 409, 'COMPLIANCE_BUSY'); }
            check(); const state = this.read(file), before = JSON.stringify(state);
            const value = update(state);
            if (value && typeof value.then === 'function') throw fail('合规事务必须同步', 500);
            if (JSON.stringify(state) !== before) {
                state.revision++;
                if (Buffer.byteLength(JSON.stringify(state)) > LIMIT) throw fail('合规账本达到容量限制，未保存本次更改', 413, 'COMPLIANCE_CAPACITY');
                check(); if (JSON.stringify(this.read(file)) !== before) throw fail('合规账本已变化', 409, 'COMPLIANCE_STORAGE_CHANGED');
                atomicJson(file, state); check();
            }
            return { state, value };
        } finally {
            try { if (lock) { check(); fs.rmdirSync(lock); } }
            finally { if (directoryFd !== undefined) fs.closeSync(directoryFd); this.busy = false; }
        }
    }
    receipt(state, kind, input) {
        request(input);
        const found = Object.hasOwn(state.receipts, input.requestId) ? state.receipts[input.requestId] : null;
        if (found && found.fingerprint !== fingerprint(kind, input)) throw fail('操作编号已用于不同内容', 409, 'COMPLIANCE_CONFLICT');
        return found?.result;
    }
    record(state, kind, input, result) {
        if (Object.keys(state.receipts).length >= 10000) throw fail('合规操作记录达到容量限制', 413, 'COMPLIANCE_CAPACITY');
        const saved = { ...result, revision: state.revision + 1 };
        Object.defineProperty(state.receipts, input.requestId, { value: { fingerprint: fingerprint(kind, input), result: saved }, enumerable: true, writable: true, configurable: true });
        return saved;
    }
    assertRevision(state, input) { if (input.expectedRevision !== state.revision) throw fail('合规记录已变化，请重新核对', 409, 'COMPLIANCE_STALE'); }
    async commit(kind, input, update) {
        request(input);
        return (await this.transact(state => {
            const prior = this.receipt(state, kind, input); if (prior) return prior;
            this.assertRevision(state, input);
            return this.record(state, kind, input, update(state));
        })).value;
    }
}
module.exports = { ComplianceLedger, fail, hash, fingerprint, request, LIMIT };
