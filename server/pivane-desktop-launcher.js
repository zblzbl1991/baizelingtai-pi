const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { createHash, randomUUID } = require('node:crypto');
const { ManagedLauncher } = require('./pi-managed-launcher');
const { loadLocalEnv } = require('./pi-local-env');
const { WorkspaceNetworkService } = require('./workspace-network-service');
const { privateDir } = require('./pi-maintenance-files');
const { outputRedactor, outputLines } = require('./pi-update-output');

function installationId(root) {
    return createHash('sha256').update(fs.realpathSync.native(root)).digest('hex').slice(0, 16);
}

function desktopEnvironment(root, environment = process.env) {
    const env = { ...environment };
    loadLocalEnv(path.join(root, '.env'), env);
    // Match the managed entry point; changing launch method never migrates data.
    env.PI_MEDIA_DATA_DIR ||= root;
    // Native identity owns implicit media configuration and deferred queues.
    // Keep their normal resolver rather than creating a new empty data store.
    if (!env.PI_PROJECT_ROOTS) env.PI_PROJECT_ROOTS = process.platform === 'win32'
        ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `${letter}:\\`).filter(drive => fs.existsSync(drive)).join(';') : '/';
    for (const name of ['PI_MEDIA_DATA_DIR', 'PI_MEDIA_CONFIG_DIR', 'PI_WEB_DEFERRED_FILE']) {
        if (env[name] && !path.isAbsolute(env[name])) throw Error(`${name} must be an absolute path.`);
    }
    return env;
}

function browserUrl(host, port) {
    if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw Error('Invalid listening port.');
    const address = !host || ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
    return new URL(`http://${address.includes(':') ? `[${address}]` : address}:${port}/`).href;
}

async function checkReady(url, fetcher = fetch) {
    const response = await fetcher(new URL('api/access/status', url), { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const status = await response.json();
    if (!response.ok || typeof status.authenticated !== 'boolean') throw Error('The workspace access endpoint is not ready.');
}

// Only the owning tray's inherited stdin can request stop. No public stop API,
// PID file, process-name matching, or control token is created.
function listenForStop(input, stop) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    input.on('data', bytes => {
        pending += decoder.write(bytes);
        if (Buffer.byteLength(pending) > 4096) { pending = ''; void stop(); return; }
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            try { if (JSON.parse(line).type === 'stop') void stop(); } catch { /* Ignore unknown input; never execute it. */ }
        }
    });
    input.on('end', () => { void stop(); });
    input.on('error', () => { void stop(); });
}

async function startDesktop({ root, environment = process.env, emit, log = text => process.stderr.write(text + '\n'),
    Manager = ManagedLauncher, Network = WorkspaceNetworkService, fetcher = fetch, forkServer = fork } = {}) {
    if (Number(process.versions.node.split('.')[0]) < 22) throw Error('The desktop launcher requires Node.js 22 or later.');
    root = fs.realpathSync.native(root);
    if (fs.existsSync(path.join(root, '.pivane-runtime/service/installation.json'))) {
        throw Error('This installation already has a background service. Use its desktop shortcut or stop and uninstall that service before enabling the tray.');
    }
    const env = desktopEnvironment(root, environment);
    // Resolve the native Pi identity with the same public API as normal installation.
    const { getAgentDir } = await import('@earendil-works/pi-coding-agent');
    env.PI_CODING_AGENT_DIR ||= getAgentDir();
    if (!path.isAbsolute(env.PI_CODING_AGENT_DIR)) throw Error('PI_CODING_AGENT_DIR must be an absolute path.');
    const network = new Network({ root, env });
    const networkEnvironment = { ...env }; network.applyEnvironment(networkEnvironment);
    const redact = outputRedactor(networkEnvironment);
    const logDirectory = privateDir(path.join(root, '.pivane-runtime/desktop'));
    const logFile = path.join(logDirectory, `service-${randomUUID()}.log`);
    const privateFiles = require('./pi-private-files');
    let logFd = privateFiles.openPrivateFileSync(logFile);
    function writeLog(text) {
        const safe = redact(text);
        if (logFd !== undefined) fs.writeSync(logFd, new Date().toISOString() + ' ' + safe + '\n');
        log(safe);
    }
    const launcher = new Manager({ root, env, networkEnvironment, forkServer: (file, args, options) => {
        const child = forkServer(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
        for (const name of ['stdout', 'stderr']) {
            const lines = outputLines(name, (_stream, text) => writeLog(text), redact);
            child[name].on('data', bytes => lines.write(bytes)); child[name].on('end', () => lines.end());
        }
        return child;
    } });
    let stopping;
    const stop = () => {
        if (!stopping) stopping = Promise.resolve().then(async () => {
            emit({ type: 'stopping' });
            try { await launcher.close(); }
            finally { fs.closeSync(logFd); logFd = undefined; }
        });
        return stopping;
    };
    const shutdown = require('./pi-process-shutdown').registerProcessShutdown(stop);
    listenForStop(process.stdin, shutdown);
    try {
        emit({ type: 'starting', logFile });
        await launcher.start();
        if (stopping) { await stopping; return; }
        const url = browserUrl(networkEnvironment.HOST, Number(launcher.env.PORT || env.PORT || 11408));
        await checkReady(url, fetcher);
        if (!stopping) emit({ type: 'ready', url, logFile, agentDir: env.PI_CODING_AGENT_DIR, mediaDir: env.PI_MEDIA_DATA_DIR });
    } catch (error) {
        if (stopping) { await stopping; return; }
        emit({ type: 'error', message: redact(error.message) });
        error.desktopReported = true;
        try { await stop(); } catch (cleanup) { log(redact(cleanup.message)); }
        throw error;
    }
    return { launcher, stop, shutdown };
}

module.exports = { installationId, desktopEnvironment, browserUrl, checkReady, listenForStop, startDesktop };
