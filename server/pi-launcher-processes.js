const path = require('node:path');
const { spawn } = require('node:child_process');

function awaitExactProcesses(processes, onReady) {
    if (process.platform !== 'win32' || !Array.isArray(processes) || processes.length < 1 || processes.length > 3
        || new Set(processes.map(item => item?.pid)).size !== processes.length
        || processes.some(item => !Number.isSafeInteger(item?.pid) || item.pid <= 0 || item.pid > 0xffffffff || !/^[0-9]{16,19}$/.test(item.creationTime || ''))) throw Error('Exact Windows process identities are required');
    const child = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../scripts/launcher-process-wait.ps1')],
        { windowsHide: true, env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP }, stdio: ['pipe', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => {
        let buffer = '', errorText = '', ready = false, exited = false, failure;
        child.stderr.on('data', bytes => { errorText = (errorText + bytes).slice(-8192); });
        child.stdin.on('error', error => { failure ||= error; });
        child.on('error', error => { failure ||= error; });
        child.stdout.on('data', bytes => {
            buffer += bytes;
            if (buffer.length > 1024) { failure ||= Error('Invalid process proof frame'); child.stdin.destroy(); return; }
            let at;
            while ((at = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, at).replace(/\r$/, ''); buffer = buffer.slice(at + 1);
                if (line === 'ready' && !ready) {
                    ready = true;
                    try { onReady?.(); } catch (error) { failure ||= error; }
                } else if (line === 'exited' && ready && !exited) exited = true;
                else failure ||= Error('Unexpected process proof frame');
            }
        });
        child.on('close', code => failure || code !== 0 || !ready || !exited || buffer
            ? reject(failure || Error('Exact process exit proof unavailable: ' + errorText.slice(0, 256)))
            : resolve({ processes, observedAt: new Date().toISOString() }));
        child.stdin.end(JSON.stringify(processes) + '\n');
    });
}
module.exports = { awaitExactProcesses };
