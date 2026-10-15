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
const { feedUrl, portableMetadataFile } = require('./pi-update-feed');

function installationId(root) {
    return createHash('sha256').update(fs.realpathSync.native(root)).digest('hex').slice(0, 16);
}

function desktopEnvironment(root, environment = process.env) {
    const env = { ...environment };
    loadLocalEnv(path.join(root, '.env'), env);
    const portableFile = portableMetadataFile(root);
    if (fs.existsSync(portableFile)) {
        const portable = JSON.parse(fs.readFileSync(portableFile, 'utf8'));
        if (portable.version !== 1 || portable.platform !== 'win32' || portable.arch !== 'x64' || process.platform !== 'win32' || process.arch !== 'x64')
            throw Error('Unsupported portable package.');
        // Resolve defaults on each launch so a fresh portable folder can be relocated.
        // Explicit deployment configuration always retains ownership and precedence.
        env.PI_CODING_AGENT_DIR ||= path.join(root, 'data/agent');
        env.PI_MEDIA_DATA_DIR ||= path.join(root, 'data/media');
        env.PI_MEDIA_CONFIG_DIR ||= path.join(root, 'data/media-lab');
        env.PI_WEB_DEFERRED_FILE ||= path.join(root, 'data/pivane-deferred-messages.json');
        env.HOST ||= '127.0.0.1';
        // Carry the installation's source into any managed application snapshot.
        if (env.BAIZELINGTAI_UPDATE_FEED_URL === undefined && env.PIVANE_UPDATE_FEED_URL === undefined && portable.updateFeedUrl)
            env.BAIZELINGTAI_UPDATE_FEED_URL = feedUrl(portable.updateFeedUrl);
    }
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

function desktopStartupTimeout(env) {
    const value = env.PIVANE_DESKTOP_START_TIMEOUT_MS;
    if (value === undefined || value === '') return 180000;
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 10000 || Number(value) > 900000)
        throw Error('PIVANE_DESKTOP_START_TIMEOUT_MS must be an integer from 10000 to 900000.');
    return Number(value);
}

async function withinStartup(promise, deadline) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(Error('Desktop startup timed out')), Math.max(0, deadline - Date.now()));
        })]);
    } finally { clearTimeout(timer); }
}

function listenForDesktopCommands(input, generation, dispatch, lost) {
    const decoder = new StringDecoder('utf8');
    let pending = '', discarding = false;
    input.on('data', bytes => {
        pending += decoder.write(bytes);
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            if (!discarding && Buffer.byteLength(line) <= 8192) {
                try {
                    const command = JSON.parse(line);
                    if (command?.generation === generation && typeof command.id === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(command.id)) void dispatch(command);
                } catch { /* Invalid private input grants no authority. */ }
            }
            discarding = false;
        }
        if (Buffer.byteLength(pending) > 8192) { pending = ''; discarding = true; }
    });
    input.on('end', lost); input.on('error', lost);
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

async function startDesktop(options = {}) {
    const root = fs.realpathSync.native(options.root);
    if (options.controlled) return startDesktopService({ ...options, root });
    const startupEnvironment = { ...(options.environment || process.env) };
    loadLocalEnv(path.join(root, '.env'), startupEnvironment);
    const startup = await require('./pivane-desktop-startup').createDesktopStartup({ root, reservedPorts: [Number(startupEnvironment.PORT || 11408)] });
    try {
        options.emit({ type: 'waiting', url: startup.url, instance: startup.instance, generation: startup.generation });
        return await startDesktopService({ ...options, root, startup });
    } catch (error) {
        startup.fail(error.desktopMessage || outputRedactor(options.environment || process.env)(error.message));
        await startup.close({ allowFailureView: true });
        throw error;
    }
}

async function startDesktopService({ root, environment = process.env, emit, log = text => process.stderr.write(text + '\n'),
    Manager = ManagedLauncher, Network = WorkspaceNetworkService, fetcher = fetch, forkServer = fork, startup, controlled = false, generation, input = process.stdin } = {}) {
    if (Number(process.versions.node.split('.')[0]) < 22) throw Error('The desktop launcher requires Node.js 22 or later.');
    root = fs.realpathSync.native(root);
    if (fs.existsSync(path.join(root, '.pivane-runtime/service/installation.json'))) {
        throw Error('This installation already has a background service. Use its desktop shortcut or stop and uninstall that service before enabling the tray.');
    }
    const env = desktopEnvironment(root, environment);
    const startupTimeoutMs = desktopStartupTimeout(env);
    const startupDeadline = Date.now() + startupTimeoutMs;
    // Resolve the native Pi identity with the same public API as normal installation.
    const { getAgentDir } = await withinStartup(import('@earendil-works/pi-coding-agent'), startupDeadline);
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
    const launcher = new Manager({ root, env, networkEnvironment, startupTimeoutMs, forkServer: (file, args, options) => {
        const child = forkServer(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
        for (const name of ['stdout', 'stderr']) {
            const lines = outputLines(name, (_stream, text) => writeLog(text), redact);
            child[name].on('data', bytes => lines.write(bytes)); child[name].on('end', () => lines.end());
        }
        return child;
    } });
    let stopping, ready = false, operationId, commandPending = false;
    const stop = () => {
        if (!stopping) stopping = Promise.resolve().then(async () => {
            emit({ type: 'stopping' });
            try { await launcher.close(); }
            finally {
                try { await startup?.close({ allowFailureView: true }); }
                finally { fs.closeSync(logFd); logFd = undefined; }
            }
            if (controlled) emit({ type: 'stopped', clean: true, ...(operationId ? { operationId } : {}) });
        });
        return stopping;
    };
    const shutdown = require('./pi-process-shutdown').registerProcessShutdown(stop);
    if (controlled) {
        listenForDesktopCommands(input, generation, async command => {
            const response = value => emit({ ...value, id: command.id });
            if (commandPending) { response({ type: 'error', code: 'DESKTOP_BUSY', message: 'A service control request is already pending.' }); return; }
            commandPending = true;
            try {
                if (command.type === 'stop') {
                    if (ready || !['stop', 'exit'].includes(command.action)) throw Object.assign(Error('Review service blockers before stopping.'), { code: 'DESKTOP_REVIEW_REQUIRED' });
                    await shutdown(); return;
                }
                if (!ready || stopping) throw Object.assign(Error('Service control is not ready.'), { code: 'DESKTOP_NOT_READY' });
                const method = { snapshot: 'snapshot', 'review-stop': 'review', 'execute-stop': 'execute' }[command.type];
                if (!method) throw Object.assign(Error('Unknown service control request.'), { code: 'DESKTOP_INVALID_REQUEST' });
                const request = method === 'review' ? { action: command.action } : method === 'execute' ? { ticket: command.ticket, draftsSaved: command.draftsSaved, externalWritersStopped: command.externalWritersStopped } : {};
                const result = await launcher.desktopRequest(method, request);
                if (!result || typeof result !== 'object') throw Error('Invalid service control response.');
                if (result.accepted === true && typeof result.operationId === 'string' && ['execute', 'snapshot'].includes(method)) {
                    operationId = result.operationId;
                    response({ type: 'stop-accepted', operationId });
                    await shutdown(); return;
                }
                response({ ...result, type: method === 'review' ? 'stop-review' : 'snapshot' });
            } catch (error) { response({ type: 'error', code: error.code || 'DESKTOP_FAILED', message: redact(error.message) }); }
            finally { commandPending = false; }
        }, () => { void shutdown(); });
    } else listenForStop(input, shutdown);
    try {
        emit({ type: 'starting', logFile });
        await withinStartup(launcher.start(), startupDeadline);
        if (stopping) { await stopping; return; }
        const url = browserUrl(networkEnvironment.HOST, Number(launcher.env.PORT || env.PORT || 11408));
        await withinStartup(checkReady(url, fetcher), startupDeadline);
        if (!stopping) {
            ready = true;
            startup?.ready(url);
            emit({ type: 'ready', url, logFile, agentDir: env.PI_CODING_AGENT_DIR, mediaDir: env.PI_MEDIA_DATA_DIR });
        }
    } catch (error) {
        if (stopping) { await stopping; return; }
        error.desktopMessage = redact(error.message);
        startup?.fail(error.desktopMessage);
        emit({ type: 'error', message: error.desktopMessage });
        error.desktopReported = true;
        try { await stop(); } catch (cleanup) { log(redact(cleanup.message)); }
        throw error;
    }
    return { launcher, stop, shutdown };
}

module.exports = { installationId, desktopEnvironment, desktopStartupTimeout, browserUrl, checkReady, listenForStop, listenForDesktopCommands, startDesktop };
