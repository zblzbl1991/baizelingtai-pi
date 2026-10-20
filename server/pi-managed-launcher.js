const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { acquireInstallationLock } = require('./pi-installation-lock');
const { privateDir, atomicJson, readSafe, backupRoots, recordInstallation, inside } = require('./pi-maintenance-files');
const { stagePi, exactVersion } = require('./pi-update-installer');
const { stageApplication, validRelease } = require('./pi-application-installer');
const { outputRedactor, appendOutput } = require('./pi-update-output');
const portable = require('./pi-portable-installer');
const retention = require('./pi-managed-retention');

class ManagedLauncher {
    constructor({ root, env = process.env, networkEnvironment = env, stage = stagePi, stageApp = stageApplication, backup = backupRoots, forkServer = fork, startupTimeoutMs = 45000, requireShutdownProof = false, onCleanupUnknown = () => {}, onHandoff, programRoot, onDiagnostic = () => {} } = {}) {
        this.root = fs.realpathSync.native(root);
        this.directory = privateDir(path.join(this.root, '.pivane-runtime'));
        this.stateFile = path.join(this.directory, 'state.json');
        this.env = { ...env };
        this.networkEnvironment = { ...networkEnvironment };
        this.redact = outputRedactor(this.networkEnvironment);
        this.stage = stage; this.stageApp = stageApp; this.backup = backup; this.forkServer = forkServer;
        this.retention = retention.retentionLimits(this.env); this.cleaning = null; this.lastRetention = null;
        this.child = null; this.operation = null; this.closed = false;
        this.stoppingChildren = new WeakMap();
        this.nonce = randomUUID();
        if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0) throw Error('Invalid service startup budget');
        this.startupTimeoutMs = startupTimeoutMs;
        this.desktopPending = new Map();
        this.requireShutdownProof = requireShutdownProof; this.childFacts = new WeakMap(); this.onCleanupUnknown = onCleanupUnknown;
        this.programRoot = programRoot || path.resolve(__dirname, '..'); this.onHandoff = onHandoff;
        this.launcherVersion = require('../package.json').version;
        this.onDiagnostic = onDiagnostic;
        this.state = { version: 1, active: null, previous: null, job: null };
    }
    loadState() {
        this.state = fs.existsSync(this.stateFile) ? JSON.parse(readSafe(this.stateFile)) : this.state;
        if (this.state.version !== 1 || this.state.needsRecovery) throw new Error('Invalid maintenance state or incomplete data restoration');
        if (this.state.activation && !['validating', 'committed', 'rolled-back'].includes(this.state.activation.phase))
            throw Error('Launcher activation requires manual recovery');
        if (this.state.activation?.phase === 'validating') {
            if (this.state.activation.validationOwner && this.state.activation.validationOwner !== this.nonce) {
                this.state.needsRecovery = true; this.save();
                throw Error('Interrupted candidate validation requires manual recovery');
            }
            this.state.activation.validationOwner = this.nonce; this.save();
        }
        if (!this.state.activation && ['starting', 'retaining'].includes(this.state.job?.phase) && this.state.job.backup) {
            this.state.needsRecovery = true; this.save();
            throw Error('Interrupted candidate data requires offline recovery');
        }
        if (this.state.activation?.phase === 'rolled-back' && this.state.job && !['succeeded', 'failed', 'interrupted'].includes(this.state.job.phase)) {
            this.state.job.phase = 'failed'; this.state.job.error = 'candidate-validation'; this.state.job.finishedAt = new Date().toISOString(); this.save();
        }
        if (this.state.activation?.phase === 'committed' && this.state.job && !['succeeded', 'failed', 'interrupted'].includes(this.state.job.phase)) {
            this.state.job.phase = 'succeeded'; this.state.job.finishedAt = this.state.activation.committedAt; this.save();
        }
        this.releasePath(this.state.active); this.releasePath(this.state.previous);
        for (const [key, value] of Object.entries(this.state.runtimePaths || {})) {
            if (['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_PROJECT_ROOTS', 'PI_MEDIA_DATA_DIR', 'PI_MEDIA_CONFIG_DIR', 'PI_WEB_DEFERRED_FILE', 'BAIZELINGTAI_UPDATE_FEED_URL', 'BAIZELINGTAI_UPDATE_RELEASES_URL', 'HOST', 'PORT'].includes(key)
                && typeof value === 'string' && this.env[key] === undefined) this.env[key] = value;
        }
        if (this.state.job && !['succeeded', 'failed', 'interrupted'].includes(this.state.job.phase) && !this.state.activation) {
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
            wholePackageUpdateSupported: Boolean(this.onHandoff && this.desktopAttached && this.requireShutdownProof && process.platform === 'win32'),
            launcherVersion: this.launcherVersion, trayVersion: this.trayVersion, serviceVersion: this.runningVersions?.appVersion, programRoot: this.programRoot,
            activation: this.state.activation ? { id: this.state.activation.id, phase: this.state.activation.phase, releaseId: this.state.activation.releaseId } : null,
            activeRelease: this.state.active, previousRelease: this.state.previous, busy: Boolean(this.operation || this.cleaning || this.starting || this.handoff || this.state.activation?.phase === 'validating'), job: this.state.job,
            storage: this.directory, backupScope: 'agent-sessions-media-config-history', nodeVersion: process.versions.node,
            retention: { releases: this.retention.releases, backups: this.retention.backups, last: this.lastRetention } };
    }
    // Cleanup owns admission until actual completion. Failure is reported in its
    // own status; it does not roll back a service that has already started.
    cleanup(job = null) {
        if (this.cleaning) return this.cleaning;
        if (this.closed) return Promise.resolve();
        const controller = new AbortController(); this.cleanupController = controller;
        this.lastRetention = { at: new Date().toISOString(), phase: 'running' };
        this.cleaning = Promise.resolve().then(async () => {
            if (controller.signal.aborted) throw new Error('Retention cancelled');
            if (this.retention.releases === null && this.retention.backups === null) { this.lastRetention = { at: new Date().toISOString(), phase: 'disabled' }; return; }
            const expected = { active: this.state.active, previous: this.state.previous };
            const plan = retention.planRetention(this.directory, this.state, this.retention, { completedJobId: job?.phase === 'retaining' ? job.id : undefined });
            if (plan.skipped) {
                this.lastRetention = { at: new Date().toISOString(), phase: 'skipped', reason: plan.skipped }; return;
            }
            const moved = retention.moveToTrash(this.directory, plan, expected);
            const purged = await retention.purgeTrash(this.directory, this.retention, { signal: controller.signal, completedJobId: job?.phase === 'retaining' ? job.id : undefined });
            this.lastRetention = { at: new Date().toISOString(), phase: 'succeeded', quarantinedReleases: moved.releases.length, quarantinedBackups: moved.backups.length, purged,
                keptReleases: plan.keepReleases.length, keptBackups: plan.keepBackups.length, incomplete: plan.incompleteReleases.length + plan.incompleteBackups.length };
            if (job) this.log(job, 'system', `Retention: kept ${plan.keepReleases.length} releases and ${plan.keepBackups.length} backups; quarantined ${moved.releases.length} releases and ${moved.backups.length} backups; purged ${purged} items.`);
        }).catch(() => {
            this.lastRetention = { at: new Date().toISOString(), phase: controller.signal.aborted ? 'cancelled' : 'failed', error: 'cleanup-incomplete' };
            if (job) this.log(job, 'system', 'Retention did not complete; preserved remaining items.');
            else console.error('白泽灵台 retention did not complete; preserved remaining items.');
        }).finally(() => {
            this.cleaning = null; this.cleanupController = null;
            this.send({ type: 'maintenance-status', status: this.status() });
        });
        return this.cleaning;
    }
    send(message) {
        if (this.child?.connected) {
            if (message.type === 'maintenance-shutdown') { const facts = this.childFacts.get(this.child); if (facts) facts.requested = true; }
            this.child.send({ ...message, nonce: this.nonce }, () => {});
        }
    }
    desktopRequest(method, input = {}, { timeoutMs = 15000 } = {}) {
        const child = this.child;
        if (!['snapshot', 'review', 'execute', 'validate'].includes(method)) return Promise.reject(new Error('Invalid desktop request'));
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > (method === 'validate' ? 900000 : 15000)) return Promise.reject(new Error('Invalid private control budget'));
        if (this.closed || !child?.connected) return Promise.reject(Object.assign(new Error('Service control connection is unavailable; outcome is unknown'), { code: 'DESKTOP_TRANSPORT_UNKNOWN' }));
        if (this.desktopPending.size >= 8) return Promise.reject(Object.assign(new Error('A service control request is already pending'), { code: 'DESKTOP_BUSY' }));
        const id = randomUUID();
        const began = Date.now();
        return new Promise((resolve, reject) => {
            const fail = () => {
                this.desktopPending.delete(id); clearTimeout(timer);
                this.onDiagnostic(`Desktop control ${method} result unknown after ${Date.now() - began}ms.`);
                reject(Object.assign(new Error('Service control response is unavailable; outcome is unknown'), { code: 'DESKTOP_TRANSPORT_UNKNOWN' }));
            };
            const timer = setTimeout(fail, timeoutMs);
            this.desktopPending.set(id, { child, resolve, reject, timer, fail, method, began });
            try { child.send({ type: 'desktop-request', nonce: this.nonce, id, method, input }, error => { if (error) fail(); }); }
            catch { fail(); }
        });
    }
    receiveDesktop(child, message) {
        if (message.type !== 'desktop-response') return false;
        const pending = this.desktopPending.get(message.id);
        // Even late or unknown private responses are consumed here.
        if (pending?.child === child) {
            this.desktopPending.delete(message.id); clearTimeout(pending.timer);
            this.onDiagnostic(`Desktop control ${pending.method} responded after ${Date.now() - pending.began}ms.`);
            if (message.error) pending.reject(Object.assign(new Error(this.redact(String(message.error.message || 'Service control failed')).slice(0, 2048)), { code: String(message.error.code || 'DESKTOP_FAILED').slice(0, 80) }));
            else pending.resolve(message.result);
        }
        return true;
    }
    start() {
        if (this.starting) return this.starting;
        if (this.closed) return Promise.reject(new Error('Launcher is stopping'));
        this.starting = Promise.resolve().then(async () => {
            if (this.closed) return;
            this.lockAcquisition = acquireInstallationLock(this.root);
            this.guard = await this.lockAcquisition;
            if (this.closed) return;
            this.loadState();
            if (this.programRoot !== this.releasePath(this.state.active) && this.onHandoff) throw Error('Desktop program version does not match active release');
            if (this.state.activation) require('./pi-launcher-activation').verifyActiveProgram(this.root, this.state.active);
            if (this.state.activation?.phase !== 'validating') await this.cleanup();
            if (this.closed) throw new Error('Launcher is stopping');
            await this.boot(this.state.active);
            if (this.closed) throw new Error('Launcher is stopping');
            if (this.state.activation?.phase !== 'validating') this.send({ type: 'maintenance-activate', ...(this.state.activation ? { activationId: this.state.activation.id } : {}) });
        }).finally(() => { this.starting = null; this.send({ type: 'maintenance-status', status: this.status() }); });
        return this.starting;
    }
    boot(release) {
        if (this.closed) throw new Error('Launcher is stopping');
        if (this.requireShutdownProof && this.lastChildFacts && (!this.lastChildFacts.acknowledged || this.lastChildFacts.code !== 0))
            throw Object.assign(new Error('The previous service cleanup could not be confirmed; another service will not be started'), { code: 'DESKTOP_CLEANUP_UNKNOWN' });
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
            const facts = { requested: false, acknowledged: false, code: null }; this.childFacts.set(child, facts); this.lastChildFacts = facts;
            const timer = setTimeout(() => {
                if (!ready) { expired = true; void this.stopChild().catch(() => {}); reject(new Error('Service startup timed out')); }
            }, this.startupTimeoutMs);
            child.on('message', async message => {
                if (message?.nonce !== this.nonce || this.child !== child) return;
                if (message.type === 'maintenance-shutdown-complete') { if (facts.requested) facts.acknowledged = true; return; }
                if (this.receiveDesktop(child, message)) return;
                if (message.type === 'maintenance-ready' && !ready && !checking && !expired) {
                    this.onDiagnostic('Desktop service IPC readiness received.');
                    if (this.requireShutdownProof && message.capabilities?.shutdownProof !== true) {
                        clearTimeout(timer); reject(new Error('Running service does not support verified desktop cleanup; update it through the existing maintenance entry before using desktop management')); return;
                    }
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
                    this.onDiagnostic('Desktop service HTTP readiness verified.');
                    this.readyFacts = { control: message.capabilities?.validationProof === true, service: Boolean(message.healthUrl) };
                    const version = value => typeof value === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(value) && value.length <= 80 ? value : null;
                    this.runningVersions = { appVersion: version(message.appVersion), engineVersion: version(message.engineVersion) };
                    // Resolve defaults once in the original service and pin them for
                    // every candidate. Never let a new release choose a new identity.
                    for (const key of ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_PROJECT_ROOTS', 'PI_MEDIA_DATA_DIR', 'PI_MEDIA_CONFIG_DIR', 'PI_WEB_DEFERRED_FILE', 'BAIZELINGTAI_UPDATE_FEED_URL', 'BAIZELINGTAI_UPDATE_RELEASES_URL']) {
                        if (typeof message.runtimePaths?.[key] === 'string') {
                            this.env[key] = message.runtimePaths[key];
                            this.state.runtimePaths ||= {}; this.state.runtimePaths[key] = message.runtimePaths[key];
                        }
                    }
                    if (Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) {
                        this.env.PORT = String(message.port); this.state.runtimePaths ||= {};
                        this.state.runtimePaths.PORT = this.env.PORT;
                        this.state.runtimePaths.HOST = this.networkEnvironment.HOST || this.env.HOST || '127.0.0.1';
                    }
                    this.send({ type: 'maintenance-status', status: this.status() });
                    resolve();
                } else if (message.type === 'maintenance-request' && ready) {
                    void this.execute(message).catch(() => {});
                }
            });
            child.once('error', () => { clearTimeout(timer); reject(new Error('Service could not start')); });
            const loseDesktop = () => { for (const pending of [...this.desktopPending.values()]) if (pending.child === child) pending.fail(); };
            child.once('disconnect', loseDesktop);
            child.once('exit', code => {
                facts.code = code;
                loseDesktop();
                clearTimeout(timer);
                if (this.child === child) this.child = null;
                if (!ready) reject(new Error('Service exited before becoming ready'));
                else if (!this.closed && !this.operation && !facts.requested) {
                    console.error('白泽灵台 child exited; launcher will not replay tasks');
                    if (this.requireShutdownProof) void this.close().catch(error => this.onCleanupUnknown(error));
                    else void this.close().finally(() => process.exit(code || 1));
                }
            });
        });
    }
    stopChild() {
        const child = this.child;
        const facts = child ? this.childFacts.get(child) : this.lastChildFacts;
        const proven = () => !this.requireShutdownProof || !child && !facts || facts?.acknowledged && facts.code === 0;
        const unknown = () => this.requireShutdownProof
            ? Object.assign(new Error('Service cleanup could not be confirmed'), { code: 'DESKTOP_CLEANUP_UNKNOWN' })
            : new Error('Service shutdown did not complete cleanly');
        if (!child || child.exitCode !== null || child.signalCode !== null) return proven() ? Promise.resolve() : Promise.reject(unknown());
        const pending = this.stoppingChildren.get(child);
        if (pending) return pending;
        if (facts) facts.requested = true;
        let failure;
        const onError = () => { failure = unknown(); };
        const exited = new Promise((resolve, reject) => child.once('exit', code => {
            child.removeListener('error', onError);
            if (!failure && code === 0 && proven()) resolve();
            else reject(Object.assign(failure || unknown(), { exitCode: code }));
        }));
        child.once('error', onError);
        this.stoppingChildren.set(child, exited);
        void exited.catch(() => {});
        try { this.send({ type: 'maintenance-shutdown' }); } catch { onError(); }
        return exited;
    }
    execute(message) {
        if (this.operation || this.cleaning || this.starting || this.closed || this.handoff) { this.send({ type: 'maintenance-rejected', id: message.id }); return Promise.resolve(); }
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
                await stage({ root: this.releasePath(previous), installationRoot: this.root, directory: destination, version: message.version, release: message.release,
                    env: { ...this.networkEnvironment, BAIZELINGTAI_UPDATE_FEED_URL: this.env.BAIZELINGTAI_UPDATE_FEED_URL }, signal: controller.signal,
                    progress: phase => { job.phase = phase; this.save(); },
                    onOutput: (stream, text) => this.log(job, stream, text) });
                if (message.release?.format === 'windows-portable-zip' && this.status().wholePackageUpdateSupported) {
                    const metadata = JSON.parse(readSafe(require('./pi-update-feed').portableMetadataFile(destination)));
                    if (metadata.launcherUpdateProtocol !== 1) throw Error('Candidate does not support whole-package launcher validation; use independent migration');
                    await require('./pi-launcher-qa-checkpoints').checkpoint(this.root, 'candidate-staged', { candidateDirectory: destination, releaseId: message.id }, { environment: this.env });
                }
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
            if (message.release?.format === 'windows-portable-zip' && this.status().wholePackageUpdateSupported) {
                const proof = this.lastChildFacts;
                if (!proof?.requested || !proof.acknowledged || proof.code !== 0) throw Object.assign(Error('Verified service cleanup is required for launcher update'), { code: 'DESKTOP_CLEANUP_UNKNOWN' });
                this.state.activation = require('./pi-launcher-activation').prepareActivation({ root: this.root, state: this.state, releaseId: next,
                    release: message.release, backupId: job.id, shutdownProof: { complete: true, generation: this.nonce } });
                job.phase = 'waiting-exit'; this.handoff = { id: this.state.activation.id, mode: 'activate' }; this.save();
                return;
            }
            job.phase = 'starting'; this.save();
            await this.boot(next);
            this.state.previous = next === previous ? this.state.previous : previous;
            this.state.active = next;
            // Retaining is a nonterminal phase: admission remains owned until
            // cleanup finishes and the ready child still exists.
            job.phase = 'retaining'; this.save();
            await this.cleanup(job);
            if (!this.child || this.closed) throw Object.assign(new Error('Service stopped before maintenance completed'), { maintenancePhase: 'starting' });
            job.phase = 'succeeded'; job.finishedAt = new Date().toISOString(); job.exitCode = 0;
            job.installedVersion = message.action === 'application' ? message.release.version : message.action === 'update' ? message.version : job.fromVersion;
            this.log(job, 'system', `Completed. Running ${message.action === 'application' ? '白泽灵台' : 'Pi'} ${job.installedVersion}.`); this.save();
        }).catch(async error => {
            const failedPhase = error?.maintenancePhase || job.phase;
            job.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : null;
            this.log(job, 'stderr', `Failed during ${failedPhase}: ${error?.message || 'Unknown error'}`);
            job.phase = 'failed'; job.error = failedPhase; job.finishedAt = new Date().toISOString();
            this.state.active = previous;
            this.save();
            if (this.requireShutdownProof && error.code === 'DESKTOP_CLEANUP_UNKNOWN') {
                this.closed = true; this.state.needsRecovery = true; job.recoveryFailed = true;
                this.log(job, 'system', 'Service cleanup is unknown; ownership is retained and automatic recovery is disabled.'); this.save();
                this.onCleanupUnknown(error); return;
            }
            if (!this.closed) {
                if (failedPhase === 'starting') {
                    // Candidate startup is gated before any browser work. Wait for its exit before fallback.
                    try { await this.stopChild(); } catch (cleanup) {
                        if (this.requireShutdownProof) {
                            this.closed = true; this.state.needsRecovery = true; job.recoveryFailed = true; this.save(); this.onCleanupUnknown(cleanup); return;
                        }
                        // Legacy maintenance retains its existing recovery contract.
                    }
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
            this.operation = null; this.controller = null;
            try { this.save(); } catch (error) { this.retainRecovery(error); return; }
            if (!this.closed && !this.handoff) this.send({ type: 'maintenance-release', id: job.id });
            // execute must settle before a coordinator closes the manager.
            if (this.handoff) setImmediate(() => { void this.onHandoff(this.handoff).catch(error => this.retainRecovery(error)); });
        });
        return this.operation;
    }
    retainRecovery(error) {
        this.closed = true; this.ownershipUncertain = true;
        try {
            if (fs.existsSync(this.stateFile)) this.state = JSON.parse(readSafe(this.stateFile));
            this.state.needsRecovery = true;
            if (this.state.job) { this.state.job.phase = 'needs-recovery'; this.state.job.recoveryFailed = true; }
            atomicJson(this.stateFile, this.state);
            try { this.send({ type: 'maintenance-status', status: this.status() }); } catch { /* Broken files cannot release ownership. */ }
        } catch { /* A failed diagnostic write cannot authorize a new owner. */ }
        this.onCleanupUnknown(error);
    }
    async rollbackValidation() {
        // A durable commit wins even if its acknowledgement or subsequent
        // in-memory refresh failed. Never write stale validation state over it.
        this.state = JSON.parse(readSafe(this.stateFile));
        const activation = this.state.activation;
        if (!activation || activation.phase !== 'validating') throw Error('Candidate activation is not pending');
        if (this.closed || this.operation || this.handoff) throw Error('Candidate owner is already stopping');
        this.handoff = { id: activation.id, mode: 'rollback' };
        await this.stopChild();
        if (this.closed) throw Object.assign(Error('Candidate owner stopped during handoff preparation'), { code: 'DESKTOP_CLEANUP_UNKNOWN' });
        const facts = this.lastChildFacts;
        if (!facts?.requested || !facts.acknowledged || facts.code !== 0) throw Object.assign(Error('Candidate cleanup is unknown'), { code: 'DESKTOP_CLEANUP_UNKNOWN' });
        activation.failureShutdownProof = { complete: true, generation: this.nonce, activationId: activation.id, releaseId: activation.releaseId };
        if (this.state.job) this.state.job.phase = 'rollback-waiting-exit';
        this.save();
        return this.handoff;
    }
    commitValidation(validation) {
        const activation = this.state.activation;
        this.save();
        require('./pi-launcher-activation').commitActivation(this.root, activation.id, validation);
        this.state = JSON.parse(readSafe(this.stateFile));
        if (this.state.job) { this.state.job.phase = 'succeeded'; this.state.job.installedVersion = this.runningVersions.appVersion; this.state.job.finishedAt = new Date().toISOString(); this.state.job.exitCode = 0; }
        this.save(); this.send({ type: 'maintenance-activate', activationId: activation.id });
    }
    close() {
        if (this.closing) return this.closing;
        this.closed = true; this.controller?.abort(); this.cleanupController?.abort();
        // Observe all work immediately, before waiting for any single promise.
        const work = Promise.allSettled([this.starting, this.operation, this.cleaning]);
        const stopping = this.child ? this.stopChild() : null;
        const stopped = Promise.resolve(stopping).then(() => null, error => error);
        let cleanupFailure;
        this.closing = Promise.resolve().then(async () => {
            let failure;
            try {
                const results = await work;
                failure = cleanupFailure = await stopped;
                if (!stopping) {
                    try { await this.stopChild(); } catch (error) { cleanupFailure = error; failure ||= error; }
                }
                failure ||= results.find(result => result.status === 'rejected')?.reason;
                if (this.ownershipUncertain) failure ||= Object.assign(Error('Desktop update outcome is unknown; ownership is retained'), { code: 'DESKTOP_CLEANUP_UNKNOWN' });
            } finally {
                await this.lockAcquisition?.catch(() => {});
                if (!this.ownershipUncertain && (!cleanupFailure || !this.requireShutdownProof)) await this.guard?.close();
            }
            if (failure) throw failure;
        });
        return this.closing;
    }

}
module.exports = { ManagedLauncher };
