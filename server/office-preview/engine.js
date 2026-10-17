const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fork, spawn } = require('node:child_process');
const { privateDir, readSafe } = require('../pi-maintenance-files');
const { writePrivateFileSync } = require('../pi-private-files');
const { root: defaultRoot, verifyRuntime } = require('./inventory');
const fail = (code, message) => Object.assign(new Error(message), { code });
function probeDocument() {
    const { zipSync, strToU8 } = require('fflate');
    return Buffer.from(zipSync(Object.fromEntries(Object.entries({
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Pivane isolated Office health probe</w:t></w:r></w:p></w:body></w:document>'
    }).map(([name, text]) => [name, strToU8(text)]))));
}
function createOfficePreviewEngine(options = {}) {
    const root = options.root || defaultRoot;
    const limits = { ...require('../../config/office-preview.json').conversion, ...options.limits };
    let generation = randomUUID();
    const lifetime = new AbortController(), active = new Set();
    let initialization, installation, disposed = false, initializing = false;
    async function execute(bytes, format, signal) {
        if (lifetime.signal.aborted || signal?.aborted) throw fail('office_cancelled', 'Office preview cancelled');
        const directory = privateDir(path.join(options.tempRoot || os.tmpdir(), 'pivane-office-' + randomUUID()));
        const inputPath = path.join(directory, 'source.' + format), outputPath = path.join(directory, 'preview.pdf');
        try {
            writePrivateFileSync(inputPath, bytes, true);
            const env = {};
            for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'LANG']) if (process.env[name]) env[name] = process.env[name];
            Object.assign(env, { TMP: directory, TEMP: directory, TMPDIR: directory });
            const result = await new Promise((resolve, reject) => {
                const child = fork(path.join(__dirname, 'runner.js'), [], { env, cwd: directory, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
                let response, timedOut = false, cancelled = false, spawnError = false;
                let escalation;
                const cancel = () => {
                    if (child.connected) child.send({ cancel: true }, () => {});
                    escalation ||= setTimeout(() => {
                        if (process.platform === 'win32') {
                            const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
                            killer.on('error', () => child.kill('SIGKILL'));
                        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
                    }, 5000);
                };
                const stop = () => { cancelled = true; cancel(); };
                const timer = setTimeout(() => { timedOut = true; cancel(); }, limits.timeoutMs);
                signal?.addEventListener('abort', stop, { once: true }); lifetime.signal.addEventListener('abort', stop, { once: true });
                child.on('message', message => { if (message && typeof message.ok === 'boolean') response = message; });
                child.on('error', () => { spawnError = true; });
                child.on('close', code => {
                    clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', stop); lifetime.signal.removeEventListener('abort', stop);
                    if (timedOut) reject(fail('office_timeout', 'Office preview timed out'));
                    else if (cancelled) reject(fail('office_cancelled', 'Office preview cancelled'));
                    else if (spawnError || code !== 0 || !response?.ok) reject(fail(({ 'output-too-large': 'office_output_limit', 'input-too-large': 'office_source_limit', timeout: 'office_timeout', unavailable: 'office_unavailable' }[response?.code] || 'office_conversion_failed'), 'Office conversion failed'));
                    else resolve(response);
                });
                child.send({ kit: installation.kit, inputPath, outputPath, limits });
                if (signal?.aborted || lifetime.signal.aborted) stop();
            });
            if (signal?.aborted || lifetime.signal.aborted) throw fail('office_cancelled', 'Office preview cancelled');
            const output = readSafe(outputPath, limits.maxOutputBytes);
            if (output.length < 8 || !output.subarray(0, 5).equals(Buffer.from('%PDF-')) || !output.subarray(-1024).includes(Buffer.from('%%EOF'))) throw fail('office_conversion_failed', 'Office output is not a PDF');
            return { bytes: output, missingFonts: Array.isArray(result.missingFonts) ? result.missingFonts.filter(name => typeof name === 'string').slice(0, 256).map(name => name.slice(0, 256)) : [] };
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
    function status({ refresh = false } = {}) {
        if (disposed) return Promise.resolve({ available: false, code: 'office_unavailable', message: 'Office preview has stopped' });
        if (refresh) {
            if (active.size || initializing) return Promise.resolve({ available: false, code: 'office_busy', message: 'Wait for active Office previews before refreshing' });
            generation = randomUUID(); initialization = undefined;
        }
        if (disposed) return Promise.resolve({ available: false, code: 'office_unavailable', message: 'Office preview has stopped' });
        if (initialization) return initialization;
        initializing = true;
        return initialization = (async () => {
            try {
                installation = verifyRuntime(root);
                await execute(probeDocument(), 'docx');
                return { available: true, version: installation.version, platform: installation.platform };
            } catch { return { available: false, code: 'office_unavailable', message: 'Office preview unavailable. Run node scripts/install.cjs; Windows x64 requires Microsoft Visual C++ v14 runtime (https://aka.ms/vc14/vc_redist.x64.exe).' }; }
        })().finally(() => { initializing = false; });
    }
    async function convert(bytes, format, { signal } = {}) {
        if (disposed) throw fail('office_unavailable', 'Office preview has stopped');
        if (signal?.aborted) throw fail('office_cancelled', 'Office preview cancelled');
        const task = (async () => {
            const available = await status();
            if (disposed) throw fail('office_unavailable', 'Office preview has stopped');
            if (!available.available) throw fail(available.code, available.message);
            if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw fail('office_invalid_format', 'Office preview requires bytes');
            if (!['doc', 'docx', 'ppt', 'pptx'].includes(format)) throw fail('office_invalid_format', 'Unsupported Office preview format');
            if (bytes.length > limits.maxSourceBytes) throw fail('office_source_limit', 'Office preview source is too large');
            return execute(Buffer.from(bytes), format, signal);
        })();
        active.add(task);
        try { return await task; } finally { active.delete(task); }
    }
    async function dispose() {
        disposed = true; lifetime.abort();
        await Promise.allSettled([...(initialization ? [initialization] : []), ...active]);
    }
    return { get generation() { return generation; }, status, convert, dispose };
}
module.exports = { createOfficePreviewEngine };
