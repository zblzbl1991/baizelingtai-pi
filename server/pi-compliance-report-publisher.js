// Server-owned adapter: the report service supplies verified immutable bytes.
// This is deliberately not an HTTP byte/path import or a deliver_files option.
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const { fail } = require('./pi-compliance-ledger');
const { privateDir, atomicJson } = require('./pi-maintenance-files');
const { writePrivateFileSync } = require('./pi-private-files');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const digest = value => createHash('sha256').update(value).digest('hex');
async function publishReport(objects, context, report, input, files) {
    if (!report || !/^[a-f0-9]{64}$/.test(report.id) || !/^[a-f0-9-]{36}$/.test(report.batchId) || !Number.isSafeInteger(report.batchRevision) || report.batchRevision < 1 || files.length !== report.files.length || !files.length || files.length > 20
        || files.some((f, i) => !Buffer.isBuffer(f.bytes) || f.bytes.length > 16 * 1024 ** 2 || digest(f.bytes) !== report.files[i].sha256 || f.bytes.length !== report.files[i].size || !/^[\w.-]+\.(html|xlsx)$/.test(report.files[i].name)) || files.reduce((n, f) => n + f.bytes.length, 0) > 64 * 1024 ** 2) throw fail('报告生成物验证失败', 409, 'COMPLIANCE_REPORT_LIMIT');
    const cwd = objects.store.resolveProject(context.cwd), id = digest(JSON.stringify([cwd, context.sessionId, 'compliance-report:' + input.requestId]));
    const provenance = { reportId: report.id, batchId: report.batchId, batchRevision: report.batchRevision }, requestHash = digest(JSON.stringify([provenance, report.files]));
    try {
        const existing = await objects.manifest(id);
        if (existing.manifest.requestHash !== requestHash) throw fail('报告交付编号冲突', 409, 'COMPLIANCE_CONFLICT');
        for (const file of existing.manifest.files) await objects.content({ id, manifestRevision: existing.revision }, file.index);
        return objects.receipt(existing);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const root = await objects.root(true), directory = path.join(root, id); const held = [];
    const hold = target => { const fd = io.openReadSync(target), identity = io.identity(fd), before = fs.fstatSync(fd, { bigint: true }); held.push({ fd, target, identity, before }); };
    const check = () => { for (const { fd, target, identity, before } of held) { const now = fs.lstatSync(target, { bigint: true }); if (!now.isDirectory() || now.isSymbolicLink() || descriptorPathSync(fd) !== target || !io.sameIdentityAtPath(target, identity) || ['dev','ino','mode'].some(k => before[k] !== now[k])) throw fail('报告交付目录变化', 409, 'COMPLIANCE_STORAGE_CHANGED'); } };
    try {
        hold(root); check();
        try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw fail('报告交付结果待核对，未重放', 409, 'COMPLIANCE_REPORT_INCOMPLETE'); throw error; }
        privateDir(directory); hold(directory); check();
        files.forEach((file, i) => { check(); writePrivateFileSync(path.join(directory, `${i}.bin`), file.bytes, true); check(); });
        const manifest = { version: 1, id, requestHash, title: '合规审查报告 · ' + report.batchId.slice(0,8) + ' r' + report.batchRevision, cwd, sessionId: context.sessionId, createdAt: report.generatedAt,
            files: report.files.map((f, index) => ({ index, name: f.name, size: f.size, revision: f.sha256, modifiedAt: report.generatedAt, sourceKind: 'compliance-report', sourcePath: null, requestedPath: null, provenance })) };
        check(); atomicJson(path.join(directory, 'manifest.json'), manifest); check(); const result = await objects.manifest(id); check();
        for (const file of result.manifest.files) await objects.content({ id, manifestRevision: result.revision }, file.index); check(); return objects.receipt(result);
    } finally { for (const { fd } of held.reverse()) fs.closeSync(fd); }
}
module.exports = { publishReport };
