'use strict';
// Pi owns this stdio process. It owns exactly one OfficeCLI child and relays shutdown.
const { spawn } = require('node:child_process');
const { verify } = require('./inventory');
const ENV = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY'];
function environment(source = process.env) {
    const result = Object.fromEntries(ENV.filter(key => typeof source[key] === 'string').map(key => [key, source[key]]));
    return { ...result, OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_NO_AUTO_RESIDENT: '1', OFFICECLI_BATCH_ALLOW_STDIN_REDIRECT: '1' };
}
function main() {
    const asset = verify();
    const child = spawn(asset.path, ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env: environment(), windowsHide: true });
    process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.stdin.on('error', error => { if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)) process.stderr.write(error.message + '\n'); });
    let stopping = false, timer;
    const stop = () => {
        if (stopping) return; stopping = true;
        process.stdin.unpipe(child.stdin); child.stdin.end();
        timer = setTimeout(() => child.kill('SIGKILL'), 2000); timer.unref();
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop); process.stdin.on('end', stop);
    child.once('error', error => { process.stderr.write(`OfficeCLI could not start: ${error.message}\n`); process.exitCode = 1; });
    child.once('close', code => { clearTimeout(timer); process.stdin.destroy(); process.exitCode = code === 0 ? 0 : 1; });
}
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; } }
module.exports = { environment };
