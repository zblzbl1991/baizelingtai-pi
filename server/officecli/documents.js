const fs = require('node:fs');
const path = require('node:path');
const { fileScope, fail } = require('../pi-file-scope');
const files = require('../gongwen/outputs');
const { MAX_FILE } = require('../pi-document-source');
const { valid: validReference } = require('../../public/pi-document-references');
function copies(branch, sessionId) {
    const found = new Map();
    for (const entry of branch) {
        const data = entry.type === 'custom' && entry.customType === 'pivane-office-document' && entry.data;
        if (data?.version !== 1 || data.sessionId !== sessionId || !/^[a-f0-9]{64}$/.test(data.id)
            || !/^[a-f0-9]{64}$/.test(data.revision) || typeof data.path !== 'string' || data.path.length > 4096
            || !Number.isSafeInteger(data.size) || data.size < 0 || data.size > MAX_FILE || !validReference(data.source)) continue;
        try { validate({ id: data.source.id, requestId: data.requestId }); } catch { continue; }
        const source = Object.fromEntries(['id', 'revision', 'name', 'format', 'size'].map(key => [key, data.source[key]]));
        found.set(data.id, { version: 1, id: data.id, sessionId, requestId: data.requestId, source, path: data.path, revision: data.revision, size: data.size });
    }
    const result = [...found.values()].slice(-20);
    while (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) result.shift();
    return result;
}
function validate(input) {
    if (!input || Object.keys(input).some(key => !['id', 'requestId'].includes(key)) || typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id)
        || typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.requestId)) throw fail('Office 工作副本参数无效', 400, 'OFFICE_INPUT');
    return { id: input.id, requestId: input.requestId };
}
class OfficeDocuments {
    constructor(store) { this.store = store; this.jobs = new Map(); this.closed = false; }
    async prepare(context, raw, source, signal, checkCurrent = () => {}) {
        const input = validate(raw), cwd = this.store.resolveProject(context.cwd), ref = source?.reference;
        if (typeof context.sessionId !== 'string' || !context.sessionId || !ref || ref.id !== input.id
            || !['docx', 'xlsx', 'pptx'].includes(ref.format) || !Buffer.isBuffer(source.bytes) || source.bytes.length > MAX_FILE
            || source.bytes.length !== ref.size || files.digest(source.bytes) !== ref.revision) throw fail('Office 原件校验失败', 409, 'DOCUMENT_CHANGED');
        const id = files.digest(JSON.stringify([cwd, context.sessionId, input.requestId]));
        if (this.closed || this.jobs.has(id) || this.jobs.size >= 2) throw fail('Office 工作副本正在准备或服务关闭，请核对同一 requestId', 409, 'OFFICE_BUSY');
        const job = {}; this.jobs.set(id, job);
        job.promise = this.run({ cwd, sessionId: context.sessionId }, input, id, source, signal, checkCurrent);
        try { return await job.promise; } finally { this.jobs.delete(id); }
    }
    async run(context, input, id, source, signal, checkCurrent) {
        const scope = await fileScope(this.store, context.cwd), proofs = [];
        const current = () => { signal?.throwIfAborted(); checkCurrent(); source.check(); proofs.forEach(proof => proof.verify()); };
        try {
            proofs.push(files.openDirectory(scope.cwd, scope.check)); current();
            const root = files.ensureRoot(scope.cwd, scope.check, '.pivane-office');
            proofs.push(files.openDirectory(root, scope.check));
            try { files.writeNew(root, '.gitignore', Buffer.from('*\n'), scope.check); } catch (error) { if (error.code !== 'EEXIST') throw error; }
            if ((await files.read(root, '.gitignore', scope.check, 4096)).bytes.toString('utf8') !== '*\n') throw fail('Office 工作目录已有其他 Git 规则；未覆盖', 409, 'OFFICE_CHANGED');
            current();
            const folder = path.join(root, id), name = `工作副本.${source.reference.format}`;
            const intent = { version: 1, id, sessionId: context.sessionId, requestId: input.requestId, source: source.reference };
            let reused = false;
            if (fs.existsSync(folder)) {
                proofs.push(files.openDirectory(folder, scope.check));
                const previous = JSON.parse((await files.read(folder, 'intent.json', scope.check)).bytes.toString('utf8'));
                if (JSON.stringify(previous) !== JSON.stringify(intent)) throw fail('此 requestId 已用于不同 Office 原件', 409, 'OFFICE_CONFLICT');
                try {
                    const ready = JSON.parse((await files.read(folder, 'ready.json', scope.check, 4096)).bytes.toString('utf8'));
                    if (ready.id !== id || ready.originalRevision !== source.reference.revision) throw fail('Office 副本记录已变化', 409, 'OFFICE_CHANGED');
                } catch (error) { if (error.code === 'ENOENT') throw fail('上次副本准备未完成，请核对已有文件；未重放', 409, 'OFFICE_INCOMPLETE'); throw error; }
                reused = true;
            } else {
                files.createDirectory(root, id, scope.check); proofs.push(files.openDirectory(folder, scope.check)); current();
                files.writeNew(folder, 'intent.json', Buffer.from(JSON.stringify(intent)), scope.check);
                files.writeNew(folder, name, source.bytes, scope.check);
                current(); files.writeNew(folder, 'ready.json', Buffer.from(JSON.stringify({ id, originalRevision: source.reference.revision })), scope.check);
            }
            const working = await files.read(folder, name, scope.check, MAX_FILE); current();
            return { version: 1, id, sessionId: context.sessionId, requestId: input.requestId, source: source.reference, path: working.absolutePath,
                revision: working.revision, size: working.size, reused };
        } finally { for (const proof of proofs.reverse()) proof.close(); }
    }
    async dispose() { this.closed = true; await Promise.allSettled([...this.jobs.values()].map(job => job.promise)); }
}
module.exports = { OfficeDocuments, validate, copies };
