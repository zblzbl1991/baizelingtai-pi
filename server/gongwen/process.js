const { fork } = require('node:child_process');
const path = require('node:path');
const { fail } = require('../pi-file-scope');
const { MAX_FILE } = require('./limits');
const { finish } = require('./report');
const { probeFontAvailability } = require('./font-availability');
class GongwenProcess {
    constructor({ timeout = 30000, maximum = 2, workerPath = path.join(__dirname, 'worker.js') } = {}) {
        this.timeout = timeout; this.maximum = maximum; this.workerPath = workerPath; this.jobs = new Set(); this.closed = false;
    }
    async run(input, signal, source) {
        if (source && (!Buffer.isBuffer(source.bytes) || !source.bytes.length || source.bytes.length > MAX_FILE)) throw fail('公文修订原件无效或超过预算', 413, 'GONGWEN_LIMIT');
        if (this.closed || this.jobs.size >= this.maximum) throw fail('公文生成正在进行或服务已关闭', 429, 'GONGWEN_BUSY');
        signal?.throwIfAborted();
        const job = {}; this.jobs.add(job);
        const probe = new AbortController(); let child, fault, checkpoint;
        const kill = error => { fault ||= error; probe.abort(fault); child?.kill(); };
        const abort = () => kill(fail('公文生成已取消', 499, 'GONGWEN_ABORTED'));
        const timer = setTimeout(() => kill(fail('公文处理超过 30 秒预算，检查未完成', 413, 'GONGWEN_TIMEOUT')), this.timeout);
        signal?.addEventListener('abort', abort, { once: true });
        const fallback = failure => {
            const draft = checkpoint?.input || (source ? { ...input, kind: 'existing', title: input.title || '已有公文', missing: [] } : input);
            const report = finish(draft, { errors: [], hints: [], styles: [], stages: [], faults: [{ stage: '生成／检查进程', code: failure.code, message: failure.message }] }, checkpoint?.corrections || [], checkpoint?.rounds || 0);
            if (!checkpoint) { report.status = 'failed'; report.label = '生成失败'; }
            if (source) Object.assign(report, { operation: input.action, editing: 'incomplete', originalSnapshot: Boolean(checkpoint?.original) });
            return { input: draft, bytes: checkpoint?.bytes || null, corrections: checkpoint?.corrections || [], report };
        };
        job.promise = (async () => {
            // Direct ownership means killing the DOCX worker cannot orphan the
            // font process. The probe settles only after its actual close.
            let fontAvailability;
            try { fontAvailability = await probeFontAvailability({ signal: probe.signal }); }
            catch (error) { if (!fault) throw error; }
            if (signal?.aborted) throw fault;
            if (fault) return fallback(fault);
            return new Promise((resolve, reject) => {
                let completed;
                try {
                    child = fork(this.workerPath, [], { execArgv: ['--max-old-space-size=192'], serialization: 'advanced',
                        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
                        env: { ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}), LANG: 'C.UTF-8' } });
                } catch { reject(fail('无法启动公文生成进程', 503, 'GONGWEN_PROCESS')); return; }
                child.on('message', message => {
                    if (message?.phase === 'error') {
                        const known = ['GONGWEN_NAMESPACE', 'GONGWEN_SIGNED', 'GONGWEN_LIMIT'].includes(message.code);
                        fault ||= fail(known ? String(message.message).slice(0, 240) : '公文生成或结构检查未完成', 502, known ? message.code : 'GONGWEN_GENERATION'); return;
                    }
                    const valid = message && ['document', 'complete'].includes(message.phase) && Buffer.isBuffer(message.bytes)
                        && message.bytes.length > 0 && message.bytes.length <= MAX_FILE && message.input && message.input.requestId === input.requestId;
                    if (!valid || message.phase === 'complete' && (!message.report || Buffer.byteLength(JSON.stringify(message.report)) > 256 * 1024)) { kill(fail('公文进程返回无效或超限结果', 502, 'GONGWEN_PROCESS')); return; }
                    if (message.phase === 'document') checkpoint = message; else completed = message;
                });
                child.once('error', () => kill(fail('公文进程失败', 503, 'GONGWEN_PROCESS')));
                // Close follows both exit and IPC drainage.
                child.once('close', (code, exitSignal) => {
                    if (signal?.aborted) { reject(fault || fail('公文生成已取消', 499, 'GONGWEN_ABORTED')); return; }
                    if (!fault && code === 0 && !exitSignal && completed) resolve(completed);
                    else resolve(fallback(fault || fail('公文进程意外退出', 502, 'GONGWEN_PROCESS')));
                });
                child.send({ input, fontAvailability, ...(source ? { operation: 'revise', bytes: source.bytes } : {}) }, error => { if (error) kill(fail('公文进程通信失败', 502, 'GONGWEN_PROCESS')); });
                if (signal?.aborted) abort();
            });
        })().finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.jobs.delete(job); });
        return job.promise;
    }
    async dispose() { this.closed = true; await Promise.allSettled([...this.jobs].map(job => job.promise)); }
}
module.exports = { GongwenProcess };
