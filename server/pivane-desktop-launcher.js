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

async function checkReady(url, fetcher = fetch) {
    const response = await fetcher(new URL('api/access/status', url), { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const status = await response.json();
    if (!response.ok || typeof status.authenticated !== 'boolean') throw Error('The workspace access endpoint is not ready.');
}

// Only the owning tray's inherited stdin can request stop. No public stop API,
// PID file, process-name matching, or control token is created.
function listenForStop(input, stop, restart) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    input.on('data', bytes => {
        pending += decoder.write(bytes);
        if (Buffer.byteLength(pending) > 4096) { pending = ''; void stop(); return; }
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            try {
                const message = JSON.parse(line);
                if (message.type === 'stop') void stop();
                else if (message.type === 'restart' && restart) void restart();
            } catch { /* Ignore unknown input; never execute it. */ }
        }
    });
    input.on('end', () => { void stop(); });
    input.on('error', () => { void stop(); });
}

function prepareDesktopRestart(launcher, { supported = false, onWaiting = () => {}, timeoutMs = 10000 } = {}) {
    if (!supported) return Promise.reject(new Error('当前运行版本不支持托盘重启，请先正常退出并重新打开启动入口。'));
    const child = launcher.child, id = randomUUID();
    if (launcher.closed || launcher.operation || !child?.connected) return Promise.reject(new Error('服务尚未就绪或正在维护，请稍后重启。'));
    return new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', exited); child.off('disconnect', disconnected); };
        const receive = message => {
            if (message?.type !== 'desktop-restart-result' || message.nonce !== launcher.nonce || message.id !== id || launcher.child !== child) return;
            cleanup();
            if (message.accepted === true) resolve();
            else reject(new Error(message.message || '实例当前不能重启，请完成任务后重试。'));
        };
        const exited = () => { cleanup(); reject(new Error('服务已退出，重启检查未完成。')); };
        const disconnected = () => { cleanup(); reject(new Error('服务连接已断开，重启结果尚未确认。')); };
        // A slow response does not cancel the request or allow another submission.
        const timer = setTimeout(onWaiting, timeoutMs);
        child.on('message', receive); child.once('exit', exited); child.once('disconnect', disconnected);
        try { child.send({ type: 'desktop-restart', nonce: launcher.nonce, id }, error => { if (error) disconnected(); }); }
        catch (error) { cleanup(); reject(error); }
    });
}

async function startDesktop(options = {}) {
    const root = fs.realpathSync.native(options.root);
    const startupEnvironment = { ...(options.environment || process.env) };
    loadLocalEnv(path.join(root, '.env'), startupEnvironment);
    const startup = await require('./pivane-desktop-startup').createDesktopStartup({ root, reservedPorts: [Number(startupEnvironment.PORT || 11408)] });
    try {
        options.emit({ type: 'waiting', url: startup.url });
        return await startDesktopService({ ...options, root, startup });
    } catch (error) {
        startup.fail(error.desktopMessage || outputRedactor(options.environment || process.env)(error.message));
        await startup.close({ allowFailureView: true });
        throw error;
    }
}

async function startDesktopService({ root, environment = process.env, emit, log = text => process.stderr.write(text + '\n'),
    Manager = ManagedLauncher, Network = WorkspaceNetworkService, fetcher = fetch, forkServer = fork, startup } = {}) {
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
    const restartCapableChildren = new WeakSet();
    const launcher = new Manager({ root, env, networkEnvironment, forkServer: (file, args, options) => {
        const child = forkServer(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
        child.on('message', message => {
            if (message?.nonce === launcher.nonce && message.type === 'maintenance-ready' && message.desktopRestart === true) restartCapableChildren.add(child);
        });
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
            finally {
                try { await startup.close({ allowFailureView: true }); }
                finally { fs.closeSync(logFd); logFd = undefined; }
            }
        });
        return stopping;
    };
    const shutdown = require('./pi-process-shutdown').registerProcessShutdown(stop);
    let ready = false, restarting;
    const restart = () => {
        if (stopping || restarting) return restarting;
        if (!ready) { emit({ type: 'restart-blocked', message: '服务尚未就绪，请稍后重启。' }); return; }
        // Reserve before the first IPC await. The owning tray reopens a fresh Node
        // runner only after this one has shut down successfully and drained its pipes.
        restarting = prepareDesktopRestart(launcher, { supported: restartCapableChildren.has(launcher.child), onWaiting: () => emit({ type: 'restart-pending', message: '正在等待重启检查，请勿重复提交。' }) })
            .then(() => { if (!stopping) emit({ type: 'restarting' }); return shutdown(); })
            .catch(error => { if (!stopping) emit({ type: 'restart-blocked', message: redact(error.message) }); })
            .finally(() => { if (!stopping) restarting = null; });
        return restarting;
    };
    listenForStop(process.stdin, shutdown, restart);
    try {
        emit({ type: 'starting', logFile });
        await launcher.start();
        if (stopping) { await stopping; return; }
        const url = browserUrl(networkEnvironment.HOST, Number(launcher.env.PORT || env.PORT || 11408));
        await checkReady(url, fetcher);
        if (!stopping) {
            ready = true;
            startup.ready(url);
            emit({ type: 'ready', url, logFile, agentDir: env.PI_CODING_AGENT_DIR, mediaDir: env.PI_MEDIA_DATA_DIR });
        }
    } catch (error) {
        if (stopping) { await stopping; return; }
        error.desktopMessage = redact(error.message);
        startup.fail(error.desktopMessage);
        emit({ type: 'error', message: error.desktopMessage });
        error.desktopReported = true;
        try { await stop(); } catch (cleanup) { log(redact(cleanup.message)); }
        throw error;
    }
    return { launcher, stop, shutdown };
}

module.exports = { installationId, desktopEnvironment, browserUrl, checkReady, listenForStop, prepareDesktopRestart, startDesktop };
