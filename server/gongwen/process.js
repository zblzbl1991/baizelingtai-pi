const { fork } = require('node:child_process');
const path = require('node:path');
const { fail } = require('../pi-file-scope');
const { MAX_FILE } = require('./limits');
const { finish } = require('./report');
class GongwenProcess {
    constructor({ timeout = 30000, maximum = 2, workerPath = path.join(__dirname, 'worker.js') } = {}) {
        this.timeout = timeout; this.maximum = maximum; this.workerPath = workerPath; this.jobs = new Set(); this.closed = false;
    }
    async run(input, signal, source) {
        if (source && (!Buffer.isBuffer(source.bytes) || !source.bytes.length || source.bytes.length > MAX_FILE)) throw fail('公文修订原件无效或超过预算', 413, 'GONGWEN_LIMIT');
        if (this.closed || this.jobs.size >= this.maximum) throw fail('公文生成正在进行或服务已关闭', 429, 'GONGWEN_BUSY');
        signal?.throwIfAborted();
        const job = {}; this.jobs.add(job);
        job.promise = new Promise((resolve, reject) => {
            let child, timer, checkpoint, completed, fault;
            const kill = error => { fault ||= error; child?.kill(); };
            const abort = () => kill(fail('公文生成已取消', 499, 'GONGWEN_ABORTED'));
            try {
                child = fork(this.workerPath, [], { execArgv: ['--max-old-space-size=192'], serialization: 'advanced',
                    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
                    env: { ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}), LANG: 'C.UTF-8' } });
            } catch { this.jobs.delete(job); reject(fail('无法启动公文生成进程', 503, 'GONGWEN_PROCESS')); return; }
            child.on('message', message => {
                if (message?.phase === 'error') {
                    const known = ['GONGWEN_NAMESPACE', 'GONGWEN_SIGNED', 'GONGWEN_LIMIT'].includes(message.code);
                    fault ||= fail(known ? String(message.message).slice(0, 240) : '公文生成或结构检查未完成', 502, known ? message.code : 'GONGWEN_GENERATION'); return;
                }
                const valid = message && ['document', 'complete'].includes(message.phase) && Buffer.isBuffer(message.bytes)
                    && message.bytes.length > 0 && message.bytes.length <= MAX_FILE && message.input && message.input.requestId === input.requestId;
                if (!valid || message.phase === 'complete' && (!message.report || Buffer.byteLength(JSON.stringify(message.report)) > 256 * 1024)) {
                    kill(fail('公文进程返回无效或超限结果', 502, 'GONGWEN_PROCESS')); return;
                }
                if (message.phase === 'document') checkpoint = message;
                else completed = message;
            });
            child.once('error', () => kill(fail('公文生成进程失败', 503, 'GONGWEN_PROCESS')));
            // Exit can precede the final IPC message. Close follows exit and
            // channel drainage, so do not classify a valid result prematurely.
            child.once('close', (code, exitSignal) => {
                clearTimeout(timer); signal?.removeEventListener('abort', abort); this.jobs.delete(job);
                if (signal?.aborted || fault?.code === 'GONGWEN_ABORTED') { reject(fault || fail('公文生成已取消', 499, 'GONGWEN_ABORTED')); return; }
                if (!fault && code === 0 && !exitSignal && completed) { resolve(completed); return; }
                const failure = fault || fail('公文进程意外退出', 502, 'GONGWEN_PROCESS');
                const draft = checkpoint?.input || (source ? { ...input, kind: 'existing', title: input.title || '已有公文', missing: [] } : input);
                const report = finish(draft, { errors: [], hints: [], styles: [], stages: [],
                    faults: [{ stage: '生成／检查进程', code: failure.code, message: failure.message }] }, checkpoint?.corrections || [], checkpoint?.rounds || 0);
                if (!checkpoint) { report.status = 'failed'; report.label = '生成失败'; }
                if (source) Object.assign(report, { operation: input.action, editing: 'incomplete', originalSnapshot: Boolean(checkpoint?.original) });
                resolve({ input: draft, bytes: checkpoint?.bytes || null, corrections: checkpoint?.corrections || [], report });
            });
            timer = setTimeout(() => kill(fail('公文处理超过 30 秒预算，检查未完成', 413, 'GONGWEN_TIMEOUT')), this.timeout);
            signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
            child.send({ input, ...(source ? { operation: 'revise', bytes: source.bytes } : {}) }, error => { if (error) kill(fail('公文进程通信失败', 502, 'GONGWEN_PROCESS')); });
        });
        return job.promise;
    }
    async dispose() { this.closed = true; await Promise.allSettled([...this.jobs].map(job => job.promise)); }
}
module.exports = { GongwenProcess };
