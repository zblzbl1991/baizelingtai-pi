'use strict';
const path = require('node:path');
const { fail } = require('./pi-file-scope');
const { validateOfficeFormat } = require('./pi-office-format');
const { VERIFIED_IDENTITY } = require('./pi-file-bytes');
const LIMITS = { project: 16 * 1024 ** 2, delivery: 16 * 1024 ** 2, artifact: 64 * 1024 ** 2, upload: 20 * 1024 ** 2 };
const KEYS = { project: ['cwd', 'path'], delivery: ['cwd', 'sessionId', 'id', 'index'], artifact: ['key'], upload: ['cwd', 'sessionId', 'id'] };
class OfficePreviewSources {
    constructor({ files, deliveries, artifacts, documents, limits }) { Object.assign(this, { files, deliveries, artifacts, documents, limits }); this.workers = new WeakMap(); this.workerSequence = 0; }
    workerIdentity(worker) { if (!worker) return null; if (!this.workers.has(worker)) this.workers.set(worker, ++this.workerSequence); return this.workers.get(worker); }
    limit(source) {
        if (!source || typeof source !== 'object' || Array.isArray(source) || !Object.hasOwn(KEYS, source.type)
            || Object.keys(source).some(k => k !== 'type' && !KEYS[source.type].includes(k))
            || KEYS[source.type].some(k => source[k] === undefined)) throw fail('预览来源参数无效', 400, 'OFFICE_INVALID');
        return LIMITS[source.type];
    }
    async read(source, signal) {
        const limit = this.limit(source), { type, ...input } = source; signal?.throwIfAborted();
        let data, name, proof;
        if (type === 'project') { data = await this.files.preview(input); name = path.basename(data.path); }
        else if (type === 'delivery') { data = await this.deliveries.request(input, true); name = data.name; proof = data.officeProof; }
        else if (type === 'artifact') { const result = await this.artifacts.officeSource(input.key, signal); ({ data, name, proof } = result); }
        else {
            const leave = this.documents.reserve();
            try {
                const authorized = await this.documents.authorized(input, { draft: true });
                await this.documents.checkCurrent(input, authorized);
                const current = await this.documents.object(input.id), verified = await this.documents.bytes(current, true), bytes = verified.bytes;
                if (JSON.stringify(current.manifest) !== JSON.stringify(authorized.object.manifest) || !bytes.equals(authorized.bytes) || verified[VERIFIED_IDENTITY] !== authorized.nativeProof) throw fail('文档原件已变化', 409, 'OFFICE_SOURCE_CHANGED');
                const ref = authorized.reference;
                data = { encoding: 'base64', base64: bytes.toString('base64'), size: ref.size, revision: ref.revision, [VERIFIED_IDENTITY]: verified[VERIFIED_IDENTITY] }; name = ref.name;
                proof = JSON.stringify([authorized.initial.session.path, this.workerIdentity(authorized.initial.worker), authorized.attached, ref]);
            } finally { leave(); }
        }
        signal?.throwIfAborted();
        if (data.encoding !== 'base64' || typeof data.base64 !== 'string' || data.base64.length > 4 * Math.ceil(limit / 3)) throw fail('办公文件超过读取预算或格式无效', 413, 'OFFICE_LIMIT');
        const bytes = Buffer.from(data.base64, 'base64'), format = path.extname(name).slice(1).toLowerCase();
        if (bytes.length > limit || bytes.length !== data.size) throw fail('办公文件超过读取预算', 413, 'OFFICE_LIMIT');
        validateOfficeFormat(bytes, format, this.limits);
        return { bytes, name, format, size: data.size, revision: data.revision, proof: JSON.stringify([proof || null, data[VERIFIED_IDENTITY]]) };
    }
}
module.exports = { OfficePreviewSources };
