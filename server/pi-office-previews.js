'use strict';
const { createHash } = require('node:crypto');
const { fail } = require('./pi-file-scope');
const hash = value => createHash('sha256').update(value).digest('hex');
const error = (code, status, message) => fail(message, status, code);
const busy = () => error('OFFICE_BUSY', 429, '办公文件预览繁忙，请稍后重试');
class OfficePreviewService {
    constructor({ sources, engine, limits, isSuspended = () => false } = {}) {
        this.sources = sources; this.engine = engine;
        if (limits) this.limits = limits;
        else { const config = require('../config/office-preview.json'); this.limits = { ...config.conversion, spreadsheetBytes: config.spreadsheet.maxInputBytes }; }
        this.isSuspended = isSuspended; this.readers = new Set(); this.tasks = new Map(); this.cache = new Map();
        this.sourceBytes = 0; this.running = 0; this.queued = []; this.cacheBytes = 0; this.closed = false;
        this.statusJobs = new Set(); this.generation = engine.generation;
    }
    get busy() { return this.readers.size > 0 || this.tasks.size > 0 || this.statusJobs.size > 0 || Boolean(this.refreshing) || Boolean(this.disposing && !this.disposed); }
    status(options) {
        if (this.closed || this.isSuspended()) return Promise.reject(error('OFFICE_UNAVAILABLE', 503, '办公文件预览正在维护'));
        if (this.refreshing || options?.refresh && this.busy) return Promise.reject(busy());
        if (options?.refresh) this.refreshing = true;
        return this.detect(options).finally(() => { if (options?.refresh) this.refreshing = false; });
    }
    detect(options) {
        const job = {}; this.statusJobs.add(job);
        job.done = Promise.resolve().then(() => this.engine.status(options)).then(result => {
            if (this.generation !== this.engine.generation) { this.generation = this.engine.generation; this.cache.clear(); this.cacheBytes = 0; }
            return result;
        }).finally(() => this.statusJobs.delete(job));
        return job.done;
    }
    preview(input, signal) {
        // Every request, including cache hits, reserves its worst-case source read
        // before the first await. Source services retain their own native budgets.
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['source', 'expectedRevision', 'refresh'].includes(k))
            || input.expectedRevision !== undefined && (typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision))
            || input.refresh !== undefined && typeof input.refresh !== 'boolean') return Promise.reject(error('OFFICE_INVALID', 415, '办公文件预览参数无效'));
        let size;
        try { size = this.sources.limit(input.source); } catch (e) { return Promise.reject(e); }
        if (this.closed || this.isSuspended()) return Promise.reject(error('OFFICE_UNAVAILABLE', 503, '办公文件预览正在维护'));
        if (this.refreshing || input.refresh && this.busy) return Promise.reject(busy());
        if (this.readers.size >= this.limits.maxReaders || this.sourceBytes + size > this.limits.maxSourceBytes) return Promise.reject(busy());
        if (input.refresh) this.refreshing = true;
        const reader = { signal, task: null, cancelled: signal?.aborted };
        this.readers.add(reader); this.sourceBytes += size;
        const cancel = () => {
            reader.cancelled = true;
            const task = reader.task;
            if (task) { task.readers.delete(reader); if (!task.readers.size) task.controller.abort(error('OFFICE_ABORTED', 499, '预览已取消')); }
        };
        signal?.addEventListener('abort', cancel, { once: true });
        const promise = this.run(input, reader).finally(() => {
            signal?.removeEventListener('abort', cancel); this.readers.delete(reader); this.sourceBytes -= size;
            if (input.refresh) this.refreshing = false;
        });
        reader.done = promise; return promise;
    }
    check(reader) {
        if (reader.cancelled || this.closed) throw error('OFFICE_ABORTED', 499, '预览已取消');
        if (this.isSuspended()) throw error('OFFICE_UNAVAILABLE', 503, '办公文件预览正在维护');
    }
    async run(input, reader) {
        this.check(reader);
        const source = await this.sources.read(input.source, reader.signal); this.check(reader);
        if (input.expectedRevision && input.expectedRevision !== source.revision) throw error('OFFICE_SOURCE_CHANGED', 409, '原件已变化，请重新打开');
        let result, generation;
        if (['xls', 'xlsx'].includes(source.format)) {
            if (source.size > this.limits.spreadsheetBytes) throw error('OFFICE_LIMIT', 413, '工作簿超过预览限制，请下载原件');
            result = { bytes: source.bytes, kind: 'workbook', mime: 'application/octet-stream', warnings: ['只读预览，公式使用已保存的结果，不重新计算'] }; generation = 'workbook-v1';
        } else {
            const status = await this.detect(input.refresh ? { refresh: true } : undefined); this.check(reader);
            if (!status.available) throw error('OFFICE_UNAVAILABLE', 503, '办公文件预览组件不可用，请检查安装');
            generation = this.engine.generation;
            const key = hash(JSON.stringify([source.revision, source.format, generation]));
            result = this.cache.get(key);
            if (result) { this.cache.delete(key); this.cache.set(key, result); }
            else {
                let task = this.tasks.get(key);
                if (task?.controller.signal.aborted) throw busy();
                if (!task) task = this.task(key, source, generation);
                reader.task = task; task.readers.add(reader);
                try { result = await task.done; } finally { task.readers.delete(reader); reader.task = null; }
            }
        }
        this.check(reader);
        // The initial verified input is no longer active source storage: PDF
        // conversion has settled, or the workbook bytes are now the bounded
        // response object. Revalidation reuses this reader's source reservation.
        source.bytes = null;
        // Re-run the real source service: content hashes cannot prove branch,
        // trash, draft or project permission. This is also required on cache hits.
        let current;
        try { current = await this.sources.read(input.source, reader.signal); }
        catch (e) { if ([403, 404, 409].includes(e.status)) throw error('OFFICE_SOURCE_CHANGED', 409, '原件或来源资格已变化，请重新打开'); throw e; }
        this.check(reader);
        if (current.revision !== source.revision || current.proof !== source.proof || current.name !== source.name
            || current.size !== source.size || current.format !== source.format
            || generation !== 'workbook-v1' && generation !== this.engine.generation) throw error('OFFICE_SOURCE_CHANGED', 409, '原件或来源资格已变化，请重新打开');
        return { source: { type: input.source.type, name: source.name, format: source.format, size: source.size, revision: source.revision },
            preview: { kind: result.kind, mime: result.mime, encoding: 'base64', base64: result.bytes.toString('base64'), size: result.bytes.length,
                revision: hash(Buffer.concat([Buffer.from(generation + ':' + result.kind + ':'), result.bytes])) }, warnings: result.warnings };
    }
    task(key, source) {
        if (this.running >= this.limits.maxConcurrent && this.queued.length >= this.limits.maxQueued) throw busy();
        const task = { key, controller: new AbortController(), readers: new Set() };
        this.tasks.set(key, task);
        const ready = new Promise((resolve, reject) => {
            const abort = () => { if (!task.started) reject(task.controller.signal.reason); };
            task.controller.signal.addEventListener('abort', abort, { once: true });
            task.start = () => { task.started = true; clearTimeout(task.queueTimer); task.controller.signal.removeEventListener('abort', abort); this.running++; resolve(); };
            if (this.running < this.limits.maxConcurrent) task.start();
            else { this.queued.push(task); task.queueTimer = setTimeout(() => task.controller.abort(error('OFFICE_TIMEOUT', 504, '预览排队超时，请重试')), this.limits.queueTimeoutMs); }
        });
        task.done = (async () => {
            try {
                await ready;
                task.timer = setTimeout(() => task.controller.abort(error('OFFICE_TIMEOUT', 504, '办公文件转换超时，请重试')), this.limits.timeoutMs);
                const converted = await this.engine.convert(source.bytes, source.format, { signal: task.controller.signal });
                // convert settles only after the native process and private directory
                // are gone. A timeout never releases a slot before that settlement.
                task.controller.signal.throwIfAborted();
                if (!Buffer.isBuffer(converted.bytes) || converted.bytes.length > this.limits.maxOutputBytes) throw error('OFFICE_LIMIT', 413, '预览 PDF 超过输出限制');
                if (!/^%PDF-\d\.\d(?:\s|$)/.test(converted.bytes.toString('ascii', 0, 9)) || !converted.bytes.subarray(-1024).includes(Buffer.from('%%EOF'))) throw error('OFFICE_INVALID', 415, '转换结果不是有效的 PDF');
                const warnings = ['近似预览，字体与分页可能不同'];
                for (const font of (converted.missingFonts || []).slice(0, 64)) if (typeof font === 'string') warnings.push('缺少字体：' + font.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160));
                const result = { bytes: converted.bytes, kind: 'pdf', mime: 'application/pdf', warnings };
                if (result.bytes.length <= this.limits.maxCachedBytes && this.limits.maxCachedEntries > 0) {
                    while (this.cache.size && (this.cache.size >= this.limits.maxCachedEntries || this.cacheBytes + result.bytes.length > this.limits.maxCachedBytes)) {
                        const old = this.cache.keys().next().value; this.cacheBytes -= this.cache.get(old).bytes.length; this.cache.delete(old);
                    }
                    this.cache.set(key, result); this.cacheBytes += result.bytes.length;
                }
                return result;
            } catch (e) { if (task.controller.signal.aborted) throw task.controller.signal.reason; throw e; }
            finally {
                clearTimeout(task.timer); clearTimeout(task.queueTimer); this.tasks.delete(key);
                this.queued = this.queued.filter(t => t !== task); if (task.started) this.running--;
                while (this.running < this.limits.maxConcurrent && this.queued.length) { const next = this.queued.shift(); if (!next.controller.signal.aborted) next.start(); }
            }
        })();
        return task;
    }
    dispose() {
        if (this.disposing) return this.disposing;
        this.closed = true;
        for (const reader of this.readers) reader.cancelled = true;
        for (const task of this.tasks.values()) task.controller.abort(error('OFFICE_ABORTED', 499, '预览服务正在关闭'));
        this.disposing = (async () => {
            await Promise.allSettled([...this.readers].map(r => r.done));
            await Promise.allSettled([...this.tasks.values()].map(t => t.done));
            await Promise.allSettled([...this.statusJobs].map(job => job.done));
            await this.engine.dispose(); this.cache.clear(); this.cacheBytes = 0; this.disposed = true;
        })(); return this.disposing;
    }
}
module.exports = { OfficePreviewService };
