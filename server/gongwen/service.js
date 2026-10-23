const fs = require('node:fs');
const path = require('node:path');
const { fileScope, fail } = require('../pi-file-scope');
const { prepare, validate } = require('./input');
const { GongwenProcess } = require('./process');
const outputs = require('./outputs');
const { markdown, boundReport } = require('./report');
const { MAX_SOURCE } = require('./limits');
const { validateRevision } = require('./revision-input');
// Stable for a request, readable across downloads, and safe on Windows as well
// as POSIX. The version suffix also prevents reserved bare device names.
function deliveryNames(input, id, originalDocument) {
    const title = input.title || originalDocument?.reference.name.replace(/\.docx$/i, '') || '公文';
    const clean = [].concat(title).join('').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
    const stem = [...clean].slice(0, 48).join('').replace(/[. ]+$/, '') || '公文';
    const base = `${stem}-${id.slice(0, 12)}`;
    return { documents: originalDocument ? [`${base}-修订.docx`, `${base}-受检原稿.docx`] : [`${base}.docx`], report: `${base}-检查报告.md` };
}
class GongwenService {
    constructor(store, { process: generator = new GongwenProcess() } = {}) { this.store = store; this.generator = generator; this.jobs = new Map(); this.closed = false; }
    async generate(context, raw, signal, checkCurrent = () => {}) {
        return this.start(context, validate(raw), signal, checkCurrent);
    }
    async revise(context, raw, source, signal, checkCurrent = () => {}) {
        const input = validateRevision(raw), ref = source?.reference;
        if (!ref || !require('../../public/pi-document-references').valid(ref) || ref.id !== input.id || ref.format !== 'docx'
            || !Buffer.isBuffer(source.bytes) || source.bytes.length > 16 * 1024 * 1024 || source.bytes.length !== ref.size
            || outputs.digest(source.bytes) !== ref.revision) throw fail('公文修订原件校验失败', 409, 'DOCUMENT_CHANGED');
        return this.start(context, { ...input, originalReference: ref }, signal, checkCurrent, source);
    }
    async start(context, input, signal, checkCurrent, source) {
        const cwd = this.store.resolveProject(context.cwd);
        if (typeof context.sessionId !== 'string' || !context.sessionId) throw fail('公文生成需要原生持久会话', 400, 'GONGWEN_CONTEXT');
        const id = outputs.digest(JSON.stringify([cwd, context.sessionId, ...(source ? ['revise'] : []), input.requestId]));
        if (this.closed || this.jobs.has(id) || this.jobs.size >= 2) throw fail('此公文正在处理或服务正在关闭，请核对同一 requestId', 409, 'GONGWEN_BUSY');
        const job = {}; this.jobs.set(id, job); // Reserve before any await.
        job.promise = this.run({ cwd, sessionId: context.sessionId }, input, id, signal, checkCurrent, source);
        try { return await job.promise; } finally { this.jobs.delete(id); }
    }
    async run(context, original, id, signal, checkCurrent, originalDocument) {
        signal?.throwIfAborted(); checkCurrent();
        const scope = await fileScope(this.store, context.cwd); checkCurrent();
        const proofs = [outputs.openDirectory(scope.cwd, scope.check)];
        const current = () => { checkCurrent(); proofs.forEach(proof => proof.verify()); };
        try {
            const root = outputs.ensureRoot(scope.cwd, scope.check), folder = path.join(root, id);
            proofs.push(outputs.openDirectory(root, scope.check)); current();
            // A nested ignore rule protects task metadata in any enclosing Git
            // repository, independently of the application's distribution rules.
            try { outputs.writeNew(root, '.gitignore', Buffer.from('*\n'), scope.check); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
            const ignore = await outputs.read(root, '.gitignore', scope.check, 4096);
            if (ignore.bytes.toString('utf8') !== '*\n') throw fail('公文目录已有其他 Git 规则，请核对；未覆盖', 409, 'GONGWEN_CHANGED');
            current();
            const requestHash = outputs.digest(JSON.stringify(original));
            const names = deliveryNames(original, id, originalDocument);
            const allowedNames = new Set([...names.documents, names.report, '公文.docx', '修订公文.docx', '受检原稿.docx', '检查报告.md']);
            if (fs.existsSync(folder)) {
                proofs.push(outputs.openDirectory(folder, scope.check));
                const intent = JSON.parse((await outputs.read(folder, 'intent.json', scope.check)).bytes.toString('utf8'));
                current();
                if (intent.requestHash !== requestHash || intent.sessionId !== context.sessionId) throw fail('此 requestId 已用于不同公文，请核对原记录', 409, 'GONGWEN_CONFLICT');
                let saved;
                try { saved = JSON.parse((await outputs.read(folder, 'receipt.json', scope.check)).bytes.toString('utf8')); }
                catch (error) { if (error.code === 'ENOENT') throw fail('上次公文生成未完整保存，请检查该 requestId；未重放', 409, 'GONGWEN_INCOMPLETE'); throw error; }
                if (saved.id !== id || saved.requestHash !== requestHash || !Array.isArray(saved.files) || !saved.files.length || saved.files.length > 2
                    || saved.files.some(file => !allowedNames.has(file.name) || !/^[a-f0-9]{64}$/.test(file.revision))
                    || new Set(saved.files.map(file => file.name)).size !== saved.files.length || !saved.files.some(file => [names.report, '检查报告.md'].includes(file.name))
                    || saved.source?.name !== '草稿源.json'
                    || !Array.isArray(saved.supplements) || ![2, 3].includes(saved.supplements.length)
                    || new Set(saved.supplements.map(file => file.name)).size !== saved.supplements.length
                    || !['原始草稿源.json', '规范修正.json'].every(name => saved.supplements.some(file => file.name === name))) throw fail('公文保存记录无效', 409, 'GONGWEN_CHANGED');
                const source = await outputs.read(folder, '草稿源.json', scope.check, MAX_SOURCE);
                if (source.absolutePath !== saved.source.path || source.revision !== saved.source.revision || source.size !== saved.source.size) throw fail('原公文草稿源已改变；未重新生成', 409, 'GONGWEN_CHANGED');
                current();
                for (const file of saved.supplements) {
                    if (!['原始草稿源.json', '规范修正.json', '格式调整.json'].includes(file.name)) throw fail('公文记录无效', 409, 'GONGWEN_CHANGED');
                    const content = await outputs.read(folder, file.name, scope.check, MAX_SOURCE);
                    if (content.absolutePath !== file.path || content.size !== file.size || content.revision !== file.revision) throw fail('公文审阅记录已改变', 409, 'GONGWEN_CHANGED');
                    current();
                }
                for (const file of saved.files) {
                    const content = await outputs.read(folder, file.name, scope.check, 16 * 1024 * 1024);
                    if (content.size !== file.size || content.revision !== file.revision || content.absolutePath !== file.path) throw fail('原公文结果已改变；未重新生成', 409, 'GONGWEN_CHANGED');
                    current();
                }
                signal?.throwIfAborted(); current(); return { ...saved, reused: true };
            }
            outputs.createDirectory(root, id, scope.check);
            proofs.push(outputs.openDirectory(folder, scope.check)); current();
            outputs.writeNew(folder, 'intent.json', Buffer.from(JSON.stringify({ version: 1, id, requestHash, sessionId: context.sessionId })), scope.check);
            const input = originalDocument ? validateRevision(Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'originalReference'))) : prepare(original);
            const originalSource = outputs.writeNew(folder, '原始草稿源.json', Buffer.from(JSON.stringify(original, null, 2)), scope.check);
            const result = await this.generator.run(input, signal, originalDocument);
            if (originalDocument) result.input.originalReference = original.originalReference;
            signal?.throwIfAborted(); current();
            const sourceBytes = Buffer.from(JSON.stringify(result.input, null, 2)), changeBytes = Buffer.from(JSON.stringify(result.corrections || [], null, 2));
            if (sourceBytes.length > MAX_SOURCE || changeBytes.length > MAX_SOURCE) throw fail('草稿源或修正记录超过 1 MiB', 413, 'GONGWEN_LIMIT');
            const source = outputs.writeNew(folder, '草稿源.json', sourceBytes, scope.check);
            const audit = outputs.writeNew(folder, '规范修正.json', changeBytes, scope.check);
            const supplements = [originalSource, audit];
            if (result.formatAudit?.changes?.length) {
                const formatBytes = Buffer.from(JSON.stringify(result.formatAudit, null, 2));
                if (formatBytes.length > MAX_SOURCE) throw fail('格式调整记录超过 1 MiB', 413, 'GONGWEN_LIMIT');
                supplements.push(outputs.writeNew(folder, '格式调整.json', formatBytes, scope.check));
            }
            result.report = boundReport(result.report);
            const files = [];
            if (result.bytes) files.push(outputs.writeNew(folder, names.documents[originalDocument && result.report.originalSnapshot ? 1 : 0], result.bytes, scope.check));
            const revision = result.bytes ? outputs.digest(result.bytes) : id;
            const reportBytes = Buffer.from(markdown(result.report, revision));
            if (reportBytes.length > 256 * 1024) throw fail('公文检查报告超过输出预算', 413, 'GONGWEN_LIMIT');
            files.push(outputs.writeNew(folder, names.report, reportBytes, scope.check));
            const receipt = { version: 1, id, requestHash, report: result.report, source, supplements, files };
            outputs.writeNew(folder, 'receipt.json', Buffer.from(JSON.stringify(receipt)), scope.check);
            signal?.throwIfAborted(); current(); return receipt;
        } finally { for (const proof of proofs.reverse()) proof.close(); }
    }
    async dispose() { this.closed = true; await Promise.allSettled([...this.jobs.values()].map(job => job.promise)); await this.generator.dispose(); }
}
module.exports = { GongwenService };
