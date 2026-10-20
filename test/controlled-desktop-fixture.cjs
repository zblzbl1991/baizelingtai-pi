const { spawn } = require('node:child_process');
const path = require('node:path');

// This seam crosses the real runner, ManagedLauncher, child IPC and gateway.
// It owns a synthetic installation/identity and never sends model requests.
function controlled(root, env, generation, diagnosticPhase = () => {}) {
    const child = spawn(process.execPath, [path.join(root, 'scripts/start-desktop.cjs'), '--controlled', '--generation', generation],
        { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const events = []; let pending = '', diagnostic = '';
    child.once('spawn', () => diagnosticPhase('runner-spawned', { pid: child.pid }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => {
        pending += text;
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            try { const event = JSON.parse(line); events.push(event); if (['starting', 'ready', 'stopped', 'error'].includes(event.type)) diagnosticPhase('runner-' + event.type, event.code ? { code: event.code } : {}); }
            catch { diagnostic += '\nInvalid private frame'; }
        }
    });
    child.stderr.on('data', text => { diagnostic = (diagnostic + text).slice(-4096); });
    const exited = new Promise(resolve => child.once('close', (code, signal) => { diagnosticPhase('runner-closed', { code, signal }); resolve({ code, signal }); }));
    const send = command => child.stdin.write(JSON.stringify({ generation, ...command }) + '\n');
    async function wait(predicate, description, timeout = 45000) {
        const until = Date.now() + timeout;
        while (Date.now() < until) {
            const event = events.find(predicate);
            if (event) return event;
            if (child.exitCode !== null || child.signalCode !== null) break;
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        throw Error(`Missing ${description}: ${JSON.stringify(events)} ${diagnostic}`);
    }
    return { child, events, send, wait, exited };
}

module.exports = { controlled };
