const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { fork } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { privateDir, atomicJson, readSafe, backupRoots, recordInstallation, inside } = require('./pi-maintenance-files');
const { stagePi, exactVersion } = require('./pi-update-installer');
const { stageApplication, validRelease } = require('./pi-application-installer');
const { outputRedactor, appendOutput } = require('./pi-update-output');
const portable = require('./pi-portable-installer');

class ManagedLauncher {
    constructor({ root, env = process.env, networkEnvironment = env, stage = stagePi, stageApp = stageApplication, backup = backupRoots, forkServer = fork } = {}) {
        this.root = fs.realpathSync.native(root);
        this.directory = privateDir(path.join(this.root, '.pivane-runtime'));
        this.stateFile = path.join(this.directory, 'state.json');
        this.env = { ...env };
        this.networkEnvironment = { ...networkEnvironment };
        this.redact = outputRedactor(this.networkEnvironment);
        this.stage = stage; this.stageApp = stageApp; this.backup = backup; this.forkServer = forkServer;
        this.child = null; this.operation = null; this.closed = false;
        this.nonce = randomUUID();
        this.state = { version: 1, active: null, previous: null, job: null };
    }
    loadState() {
        this.state = fs.existsSync(this.stateFile) ? JSON.parse(readSafe(this.stateFile)) : this.state;
        if (this.state.version !== 1 || this.state.needsRecovery) throw new Error('Invalid maintenance state or incomplete data restoration');
        this.releasePath(this.state.active); this.releasePath(this.state.previous);
        for (const [key, value] of Object.entries(this.state.runtimePaths || {})) {
            if (['PI_CODING_AGENT_DIR', 'PI_MEDIA_DATA_DIR', 'PI_MEDIA_CONFIG_DIR', 'PI_WEB_DEFERRED_FILE', 'BAIZELINGTAI_UPDATE_FEED_URL', 'BAIZELINGTAI_UPDATE_RELEASES_URL'].includes(key)
                && typeof value === 'string' && this.env[key] === undefined) this.env[key] = value;
        }
        if (this.state.job && !['succeeded', 'failed', 'interrupted'].includes(this.state.job.phase)) {
            this.state.job.phase = 'interrupted'; this.state.job.error = 'interrupted'; this.save();
        }
    }
    releasePath(id) {
        if (id === null || id === undefined) return this.root;
        if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid release identity');
        const dir = path.join(this.directory, 'releases', id);
        if (fs.realpathSync.native(dir) !== dir || !inside(this.directory, dir)) throw new Error('Invalid release directory');
        const marker = JSON.parse(readSafe(path.join(dir, 'PI_INSTALL_COMPLETE.json')));
        if (!exactVersion(marker.version) || marker.lockSha256 !== require('./pi-maintenance-files').hash(readSafe(path.join(dir, 'package-lock.json'), 16 * 1024 * 1024))) throw new Error('Managed installation is incomplete or changed');
        return dir;
    }
    log(job, stream, text) {
        appendOutput(job, stream, this.redact(text));
        if (!this.logTimer) this.logTimer = setTimeout(() => {
            this.logTimer = null;
            this.send({ type: 'maintenance-status', status: this.status() });
        }, 200);
    }
    save() { atomicJson(this.stateFile, this.state); this.send({ type: 'maintenance-status', status: this.status() }); }
    status() {
        return { supported: true, updateSupported: ['22', '24'].includes(process.versions.node.split('.')[0]) && !this.env.PI_WEB_CLI && !this.env.PI_PACKAGE_DIR,
            appUpdateSupported: ['22', '24'].includes(process.versions.node.split('.')[0]) && !this.env.PI_WEB_CLI && !this.env.PI_PACKAGE_DIR,
            portableUpdateSupported: portable.supported(this.releasePath(this.state.active)) && Boolean(require('./pi-update-feed').configuredFeed(this.root, this.env)),
            activeRelease: this.state.active, previousRelease: this.state.previous, busy: Boolean(this.operation), job: this.state.job,
            storage: this.directory, backupScope: 'agent-sessions-media-config-history', nodeVersion: process.versions.node };
    }
    send(message) { if (this.child?.connected) this.child.send({ ...message, nonce: this.nonce }, () => {}); }
    async start() {
        // The kernel owns this process lock. It disappears on crash and needs no stale PID deletion.
        const port = 40000 + createHash('sha256').update(this.root).digest().readUInt32BE(0) % 20000;
        this.guard = net.createServer(socket => socket.destroy());
        await new Promise((resolve, reject) => { this.guard.once('error', reject); this.guard.listen(port, '127.0.0.1', resolve); });
        this.loadState();
        await this.boot(this.state.active);
        this.send({ type: 'maintenance-activate' });
    }
    boot(release) {
        if (this.closed) throw new Error('Launcher is stopping');
        const root = this.releasePath(release);
        return new Promise((resolve, reject) => {
            const child = this.forkServer(path.join(root, 'server.js'), [], {
                cwd: this.root, execPath: release && portable.supported(root) ? path.join(root, 'runtime/node.exe') : process.execPath, execArgv: [],
                env: { ...this.env, PI_MANAGED_LAUNCHER: this.nonce, PI_MANAGED_BASE: this.root,
                    PI_CODING_AGENT_DIR: this.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'),
                    PI_MEDIA_DATA_DIR: this.env.PI_MEDIA_DATA_DIR || this.root },
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true
            });
            this.child = child; let ready = false, checking = false, expired = false;
            const timer = setTimeout(() => {
                if (!ready) { expired = true; this.send({ type: 'maintenance-shutdown' }); reject(new Error('Service startup timed out')); }
            }, 45000);
            child.on('message', async message => {
                if (message?.nonce !== this.nonce || this.child !== child) return;
                if (message.type === 'maintenance-ready' && !ready && !checking && !expired) {
                    if (message.appVersion && message.appVersion !== JSON.parse(readSafe(path.join(root, 'package.json'))).version) {
                        clearTimeout(timer); reject(new Error('Running application version mismatch')); return;
                    }
                    checking = true;
                    if (message.healthUrl) {
                        try {
                            const url = new URL(message.healthUrl);
                            if (url.protocol !== 'http:' || Number(url.port) !== message.port || url.pathname !== '/api/access/status' || url.username || url.password) throw Error();
                            const response = await require('node-fetch')(url.href, { redirect: 'error', timeout: 5000, size: 65536 });
                            if (!response.ok) throw Error(); await response.json();
                        } catch { clearTimeout(timer); reject(new Error('Service HTTP readiness failed')); return; }
                    }
                    if (expired || this.child !== child || child.exitCode !== null) return;
                    ready = true; clearTimeout(timer); this.backupInputs = message.backupInputs;
                    // Resolve defaults once in the original service and pin them for
                    // every candidate. Never let a new release choose a new identity.
                    for (const key of ['PI_CODING_AGENT_DIR', 'PI_MEDIA_DATA_DIR', 'PI_MEDIA_CONFIG_DIR', 'PI_WEB_DEFERRED_FILE', 'BAIZELINGTAI_UPDATE_FEED_URL', 'BAIZELINGTAI_UPDATE_RELEASES_URL']) {
                        if (typeof message.runtimePaths?.[key] === 'string') {
                            this.env[key] = message.runtimePaths[key];
                            this.state.runtimePaths ||= {}; this.state.runtimePaths[key] = message.runtimePaths[key];
                        }
                    }
                    if (Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) this.env.PORT = String(message.port);
                    this.send({ type: 'maintenance-status', status: this.status() });
                    resolve();
                } else if (message.type === 'maintenance-request' && ready) {
                    void this.execute(message).catch(() => {});
                }
            });
            child.once('error', () => { clearTimeout(timer); reject(new Error('Service could not start')); });
            child.once('exit', code => {
                clearTimeout(timer);
                if (this.child === child) this.child = null;
                if (!ready) reject(new Error('Service exited before becoming ready'));
                else if (!this.closed && !this.operation) { console.error('白泽灵台 child exited; launcher will not replay tasks'); void this.close().finally(() => process.exit(code || 1)); }
            });
        });
    }
    async stopChild() {
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error('Service shutdown did not complete cleanly'))));
        this.send({ type: 'maintenance-shutdown' });
        // No timeout is treated as cancellation. Never start another identity owner before exit.
        await exited;
    }
    execute(message) {
        if (this.operation || this.closed) { this.send({ type: 'maintenance-rejected', id: message.id }); return Promise.resolve(); }
        if (!['update', 'application', 'backup', 'restart'].includes(message.action) || message.action === 'application' && (!validRelease(message.release) || !this.status().appUpdateSupported
            || message.release.format && (!this.status().portableUpdateSupported || !portable.validPortable(message.release, require('./pi-update-feed').configuredFeed(this.root, this.env)))) || !/^[a-f0-9-]{36}$/.test(message.id || '') || message.action === 'update' && (!exactVersion(message.version) || !this.status().updateSupported)) {
            this.send({ type: 'maintenance-rejected', id: message.id }); return Promise.resolve();
        }
        const controller = new AbortController(); this.controller = controller;
        const previous = this.state.active;
        const job = { id: message.id, action: message.action, targetVersion: message.version || null, phase: 'preparing', startedAt: new Date().toISOString(), backup: null,
            output: '', outputTruncated: false, exitCode: null, fromVersion: null, installedVersion: null };
        this.state.job = job;
        // Reserve before awaiting installation, shutdown or backup work.
        this.operation = Promise.resolve().then(async () => {
            job.fromVersion = message.action === 'application' ? JSON.parse(readSafe(path.join(this.releasePath(previous), 'package.json'))).version : JSON.parse(readSafe(require('node:fs').realpathSync.native(path.join(this.releasePath(previous), 'node_modules/@earendil-works/pi-coding-agent/package.json')))).version;
            this.log(job, 'system', message.action === 'update' ? `Updating 白泽灵台's Pi: ${job.fromVersion} -> ${message.version}` : `白泽灵台 operation: ${message.action}`);
            this.save(); this.send({ type: 'maintenance-accepted', id: message.id });
            let next = previous;
            if (message.action === 'update' || message.action === 'application') {
                job.phase = 'installing'; this.save();
                const releases = privateDir(path.join(this.directory, 'releases'));
                const destination = path.join(releases, message.id);
                if (fs.existsSync(destination)) throw new Error('Release directory already exists');
                const stage = message.action === 'application' ? message.release.format === 'windows-portable-zip' ? portable.stagePortable : this.stageApp : this.stage;
                await stage({ root: this.releasePath(previous), directory: destination, version: message.version, release: message.release,
                    env: { ...this.networkEnvironment, BAIZELINGTAI_UPDATE_FEED_URL: this.env.BAIZELINGTAI_UPDATE_FEED_URL }, signal: controller.signal,
                    progress: phase => { job.phase = phase; this.save(); },
                    onOutput: (stream, text) => this.log(job, stream, text) });
                next = message.id;
            }
            if (this.closed) throw new Error('Launcher is stopping');
            job.phase = 'stopping'; this.log(job, 'system', 'Waiting for the current service and Pi workers to stop.'); this.save();
            await this.stopChild();
            if (this.closed) throw new Error('Launcher is stopping');
            if (message.action !== 'restart') {
                job.phase = 'backing-up'; this.save();
                if (!Array.isArray(this.backupInputs) || !this.backupInputs.length || this.backupInputs.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Backup scope is unavailable');
                const backupDir = path.join(privateDir(path.join(this.directory, 'backups')), message.id);
                const copied = this.backup(this.backupInputs, backupDir);
                recordInstallation(backupDir, { release: previous, package: JSON.parse(readSafe(path.join(this.releasePath(previous), 'package.json'))),
                    lock: JSON.parse(readSafe(path.join(this.releasePath(previous), 'package-lock.json'), 16 * 1024 * 1024)) });
                job.backup = copied;
                this.log(job, 'system', `Backup complete: ${copied.files} files, ${copied.bytes} bytes.`);
                this.save();
            }
            job.phase = 'starting'; this.save();
            await this.boot(next);
            this.state.previous = next === previous ? this.state.previous : previous;
            this.state.active = next;
            job.phase = 'succeeded'; job.finishedAt = new Date().toISOString(); job.exitCode = 0;
            job.installedVersion = message.action === 'application' ? message.release.version : message.action === 'update' ? message.version : job.fromVersion;
            this.log(job, 'system', `Completed. Running ${message.action === 'application' ? '白泽灵台' : 'Pi'} ${job.installedVersion}.`); this.save();
        }).catch(async error => {
            const failedPhase = job.phase;
            job.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : null;
            this.log(job, 'stderr', `Failed during ${failedPhase}: ${error?.message || 'Unknown error'}`);
            job.phase = 'failed'; job.error = failedPhase; job.finishedAt = new Date().toISOString();
            this.state.active = previous;
            this.save();
            if (!this.closed) {
                if (failedPhase === 'starting') {
                    // Candidate startup is gated before any browser work. Wait for its exit before fallback.
                    try { await this.stopChild(); } catch { /* The process has exited; record failure, do not reuse it. */ }
                    if (message.release?.format === 'windows-portable-zip' && job.backup) {
                        try {
                            const restored = require('./pi-maintenance-restore').restoreStoppedBackup(this.root, job.id);
                            job.recoveryBackup = restored.safetyBackup;
                            this.save();
                        } catch {
                            this.state.needsRecovery = true; job.recoveryFailed = true; this.save();
                            return;
                        }
                    }
                }
                if (!this.child) {
                    try { await this.boot(previous); } catch { console.error('白泽灵台 recovery startup failed; use the retained installation and backup'); }
                }
            }
        }).finally(() => {
            clearTimeout(this.logTimer); this.logTimer = null;
            this.operation = null; this.controller = null; this.save();
            if (!this.closed) this.send({ type: 'maintenance-release', id: job.id });
        });
        return this.operation;
    }
    async close() {
        this.closed = true; this.controller?.abort();
        await this.operation;
        await this.stopChild();
        if (this.guard?.listening) await new Promise(resolve => this.guard.close(resolve));
    }
}
module.exports = { ManagedLauncher };
