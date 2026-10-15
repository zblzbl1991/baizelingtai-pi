const fs = require('node:fs'), path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { readVerifiedFile } = require('./pi-file-bytes');
const { fileScope } = require('./pi-file-scope');
const { openPrivateFileSync } = require('./pi-private-files');
const { readSafe } = require('./pi-maintenance-files');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const { fail, request } = require('./pi-compliance-ledger');
const FILE_LIMIT = 20 * 1024 ** 2, PROJECT_LIMIT = 256 * 1024 ** 2, STORAGE_LIMIT = 2 * 1024 ** 3;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const id = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const only = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('资料参数无效'); };
class ComplianceMaterials {
    constructor(service, documents) { this.service = service; this.documents = documents; }
    project(state, projectId) { if (!id(projectId)) throw fail('工程项目编号无效'); const project = state.projects.find(p => p.id === projectId); if (!project) throw fail('工程项目不存在', 404); return project; }
    async list(projectId) { const state = await this.service.ledger.snapshot(); this.project(state, projectId); return { revision: state.revision, documents: (state.documents || []).filter(d => d.projectId === projectId) }; }
    content(documentId) { return this.service.operations.run('read:' + randomUUID(), () => this.readContent(documentId)); }
    async readContent(documentId) {
        const state = await this.service.ledger.snapshot(), document = (state.documents || []).find(d => d.id === documentId);
        if (!document) throw fail('资料不存在', 404); const { root } = await this.service.ledger.paths();
        const file = await readVerifiedFile(path.join(root, document.hash + '.bin'), { maxBytes: FILE_LIMIT, check: actual => { if (path.dirname(actual) !== root) throw fail('资料位置变化', 409); } });
        if (file.revision !== document.hash || file.size !== document.size) throw fail('资料快照已变化', 409, 'COMPLIANCE_STORAGE_CHANGED');
        return { documentId, name: document.name, hash: document.hash, base64: file.bytes.toString('base64') };
    }
    import(projectId, input, worker) {
        only(input, ['requestId', 'expectedRevision', 'sources', 'cwd', 'sessionId']); request(input);
        if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 32) throw fail('每次选择 1 至 32 份资料', 413);
        return this.service.operations.run('import:' + projectId, async operation => {
            const ledger = this.service.ledger, initial = await ledger.snapshot();
            const previous = ledger.receipt(initial, 'documents:' + projectId, input); if (previous) return previous;
            this.service.assertEnabled(initial); this.project(initial, projectId); ledger.assertRevision(initial, input);
            const files = [], attachments = []; let total = 0;
            for (const source of input.sources) {
                this.service.operations.check(operation); this.service.assertEnabled(await ledger.snapshot());
                let bytes, name, provenance, authorized;
                if (source.kind === 'upload') {
                    only(source, ['kind', 'name', 'base64']); name = source.name;
                    if (worker) throw fail('工具不能伪造上传', 403);
                    if (typeof source.base64 !== 'string' || source.base64.length > Math.ceil(FILE_LIMIT / 3) * 4 || /[^A-Za-z0-9+/=]/.test(source.base64)) throw fail('上传内容无效或超过 20 MiB', 413);
                    bytes = Buffer.from(source.base64, 'base64'); if (bytes.toString('base64') !== source.base64) throw fail('上传内容编码无效'); provenance = { kind: 'upload' };
                } else if (source.kind === 'file') {
                    only(source, ['kind', 'path']);
                    if (typeof source.path !== 'string' || source.path.length > 4096 || !source.path || path.isAbsolute(source.path)) throw fail('请选择授权工作目录内的相对文件路径');
                    const scope = await fileScope(this.service.store, worker ? worker.cwd : input.cwd);
                    const file = await readVerifiedFile(path.resolve(scope.cwd, source.path), { check: scope.check, maxBytes: FILE_LIMIT });
                    bytes = file.bytes; name = path.basename(file.absolutePath); provenance = { kind: 'file', cwd: scope.cwd, path: source.path, revision: file.revision, modifiedAt: file.modifiedAt };
                } else if (source.kind === 'attachment') {
                    only(source, ['kind', 'id']); if (!this.documents) throw fail('附件服务不可用', 503);
                    const context = { cwd: worker ? worker.cwd : input.cwd, sessionId: worker ? worker.sessionId : input.sessionId, id: source.id };
                    authorized = await this.documents.authorized(context, { draft: !worker }); bytes = authorized.bytes; name = authorized.reference.name;
                    await this.documents.checkCurrent(context, authorized); provenance = { kind: 'attachment', id: source.id, cwd: context.cwd, sessionId: context.sessionId, revision: authorized.reference.revision };
                    attachments.push({ context, authorized });
                } else throw fail('资料来源无效');
                if (typeof name !== 'string' || !name || name.length > 240 || /[\x00-\x1f\x7f/\\]/.test(name)) throw fail('资料名称无效');
                if (!bytes.length || bytes.length > FILE_LIMIT) throw fail('单份资料须非空且不超过 20 MiB', 413);
                total += bytes.length; if (total > PROJECT_LIMIT) throw fail('工程资料合计超过 256 MiB', 413);
                const format = name.split('.').at(-1).toLowerCase();
                if (!['pdf', 'png', 'jpg', 'jpeg', 'webp', 'xlsx', 'csv'].includes(format)) throw fail('请转换为 PDF、PNG/JPEG/WebP、XLSX 或 UTF-8 CSV', 415, 'COMPLIANCE_FORMAT');
                if (['pdf', 'xlsx', 'csv'].includes(format)) {
                    if (!this.documents?.pool) throw fail('共享文档解析服务不可用', 503);
                    await this.documents.pool.run(bytes, format, {}, { validateOnly: true });
                } else {
                    const image = require('./pi-file-types').classify(bytes, name), expected = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[format];
                    if (image.kind !== 'image' || image.mime !== expected) throw fail('图片签名或像素预算无效', 415, 'COMPLIANCE_FORMAT');
                }
                files.push({ id: randomUUID(), projectId, name, format, hash: digest(bytes), size: bytes.length, source: provenance, assignment: null, createdAt: new Date().toISOString(), bytes });
            }
            this.service.operations.check(operation);
            if (worker) await this.service.authorizeWorker(worker);
            return this.service.reserve(async () => (await ledger.transact((state, { root, check }) => {
                const prior = ledger.receipt(state, 'documents:' + projectId, input); if (prior) return prior;
                this.service.operations.check(operation);
                ledger.assertRevision(state, input); this.service.assertEnabled(state); this.project(state, projectId); state.documents ||= [];
                const current = state.documents.filter(d => d.projectId === projectId), added = files.filter((file, index) => !current.some(d => d.hash === file.hash) && !files.slice(0, index).some(d => d.hash === file.hash));
                if (current.length + added.length > 32 || current.reduce((n, d) => n + d.size, 0) + added.reduce((n, d) => n + d.size, 0) > PROJECT_LIMIT) throw fail('工程项目最多 32 份资料、256 MiB', 413, 'COMPLIANCE_CAPACITY');
                let stored = 0, count = 0; const names = fs.readdirSync(root);
                if (names.length > 10010) throw fail('合规对象数量达到上限', 413, 'COMPLIANCE_CAPACITY');
                for (const name of names.filter(n => /^[a-f0-9]{64}\.bin$/.test(n))) {
                    const file = path.join(root, name); let fd;
                    try {
                        check(); const before = fs.lstatSync(file, { bigint: true });
                        if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(FILE_LIMIT)) throw fail('合规对象类型或容量异常', 409, 'COMPLIANCE_STORAGE_CHANGED');
                        fd = io.openReadSync(file); const current = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
                        if (descriptorPathSync(fd) !== file || !io.sameIdentityAtPath(file, identity) || ['dev','ino','mode','size','mtimeNs','ctimeNs'].some(k => before[k] !== current[k])) throw fail('合规对象已变化', 409, 'COMPLIANCE_STORAGE_CHANGED');
                        const after = fs.lstatSync(file, { bigint: true });
                        if (!io.sameIdentityAtPath(file, identity) || ['dev','ino','mode','size','mtimeNs','ctimeNs'].some(k => current[k] !== after[k])) throw fail('合规对象已变化', 409, 'COMPLIANCE_STORAGE_CHANGED');
                        stored += Number(current.size); count++; check();
                    } finally { if (fd !== undefined) fs.closeSync(fd); }
                }
                if (JSON.stringify(fs.readdirSync(root).sort()) !== JSON.stringify(names.sort())) throw fail('合规对象目录已变化', 409, 'COMPLIANCE_STORAGE_CHANGED');
                const newObjects = added.filter((file, index) => !fs.existsSync(path.join(root, file.hash + '.bin')) && !added.slice(0, index).some(d => d.hash === file.hash));
                if (stored + newObjects.reduce((n, d) => n + d.size, 0) > STORAGE_LIMIT || count + newObjects.length > 10000) throw fail('合规原件存储已达 2 GiB 或一万对象上限，未写入资料', 413, 'COMPLIANCE_CAPACITY');
                for (const file of added) {
                    const target = path.join(root, file.hash + '.bin');
                    if (fs.existsSync(target)) { if (digest(readSafe(target, FILE_LIMIT)) !== file.hash) throw fail('资料对象损坏', 409); }
                    else {
                        let fd;
                        try {
                            check(); fd = openPrivateFileSync(target); const identity = io.identity(fd);
                            const verify = () => {
                                check(); const stat = fs.fstatSync(fd, { bigint: true });
                                if (!stat.isFile() || descriptorPathSync(fd) !== target || !io.sameIdentityAtPath(target, identity)) throw fail('资料写入对象已变化', 409, 'COMPLIANCE_STORAGE_CHANGED');
                            };
                            verify(); fs.writeFileSync(fd, file.bytes); fs.fsyncSync(fd); verify();
                            if (fs.fstatSync(fd).size !== file.size) throw fail('资料快照写入不完整', 500);
                        } finally { if (fd !== undefined) fs.closeSync(fd); }
                    }
                    const { bytes, ...document } = file; state.documents.push(document);
                }
                const imported = files.map(file => state.documents.find(d => d.projectId === projectId && d.hash === file.hash));
                return ledger.record(state, 'documents:' + projectId, input, { ok: true, documents: imported, reused: files.length - added.length });
            }, async () => {
                if (worker) await this.service.authorizeWorker(worker);
                for (const attachment of attachments) await this.documents.checkCurrent(attachment.context, attachment.authorized);
            })).value);
        });
    }
}
module.exports = { ComplianceMaterials, FILE_LIMIT, PROJECT_LIMIT, STORAGE_LIMIT };
