const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readSafe, hash } = require('./pi-maintenance-files');
const { continuationEnvironment } = require('./pi-launcher-qa-context');

// Only the inherited private LF channel supplies tray evidence. Process names
// and the disappearance of a PID are never treated as exit evidence.
function createTrayLink({ programRoot, emit }) {
    let attached, attachedVersion, challenge, waiting;
    const nativePath = path.join(programRoot, '白泽灵台.exe');
    const manifest = () => JSON.parse(readSafe(path.join(programRoot, 'native/pivane-desktop-launcher-build.json')));
    function check(command) {
        const build = manifest();
        if (build.appVersion !== JSON.parse(readSafe(path.join(programRoot, 'package.json'))).version) throw Error('Native tray version does not match the selected application');
        const portableNode = path.join(programRoot, 'runtime/node.exe');
        if (require('./pi-portable-installer').supported(programRoot) && fs.realpathSync.native(process.execPath) !== fs.realpathSync.native(portableNode))
            throw Error('Portable runner must use the selected bundled Node runtime');
        if (fs.realpathSync.native(command.programRoot) !== programRoot || fs.realpathSync.native(command.nativePath) !== nativePath
            || command.nativeVersion !== build.appVersion + '.0' || command.nativeSha256 !== build.binarySha256
            || command.nativeSha256 !== hash(readSafe(nativePath, 16 * 1024 ** 2))
            || command.traySha256 !== hash(readSafe(path.join(programRoot, 'scripts/desktop-tray.ps1')))
            || fs.realpathSync.native(command.nodePath) !== fs.realpathSync.native(process.execPath)) throw Error('Loaded desktop components do not match the selected release');
        const processes = command.processes;
        if (!Array.isArray(processes) || processes.length !== 2 || processes[0]?.pid !== process.pid || processes[1]?.pid !== process.ppid
            || processes.some(item => !/^[0-9]{16,19}$/.test(item.creationTime || ''))) throw Error('Exact runner and tray identities are required');
        return processes.map(({ pid, creationTime }) => ({ pid, creationTime }));
    }
    return {
        get attached() { return Boolean(attached); },
        get version() { return attachedVersion; },
        get processes() { if (!attached) throw Error('Owning tray is not attached'); return attached; },
        receive(command) {
            if (!['tray-attached', 'tray-validated'].includes(command.type)) return false;
            const processes = check(command);
            if (command.type === 'tray-attached') {
                if (attached && JSON.stringify(attached) !== JSON.stringify(processes)) throw Error('Tray identities changed');
                attached = processes;
                attachedVersion = manifest().appVersion;
            } else if (waiting && command.challenge === challenge && JSON.stringify(processes) === JSON.stringify(attached)) {
                waiting.resolve(true); waiting = null;
            }
            return true;
        },
        validate() {
            if (!attached) return Promise.reject(Error('Owning tray was not verified'));
            if (waiting) return waiting.promise;
            challenge = randomUUID();
            let resolve; const promise = new Promise(done => { resolve = done; });
            waiting = { resolve, promise }; emit({ type: 'tray-validate', challenge });
            return promise;
        }
    };
}

async function handoffDesktop({ launcher, link, intent }) {
    const activation = launcher.state.activation;
    if (!launcher.guard || activation?.id !== intent.id || launcher.operation || launcher.child || launcher.closed || launcher.closing || launcher.starting) throw Error('Stopped installation owner is required for handoff');
    const continuation = continuationEnvironment(launcher.root, launcher.env);
    const processes = link.processes;
    activation[intent.mode === 'rollback' ? 'failureHandoffProcesses' : 'handoffProcesses'] = processes;
    launcher.save();
    const command = require('./pi-launcher-activation').helperCommand(launcher.root, intent.id);
    if (intent.mode === 'rollback') command.args[1] = 'rollback-handoff';
    const helper = spawn(command.executable, command.args, { cwd: launcher.root, detached: true, windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot, SystemDrive: process.env.SystemDrive, TEMP: process.env.TEMP, TMP: process.env.TMP, ...continuation },
        stdio: ['pipe', 'pipe', 'ignore'] });
    await new Promise((resolve, reject) => {
        let pending = '', done = false;
        const fail = error => { if (!done) { done = true; clearTimeout(timer); reject(error); } };
        const timer = setTimeout(() => fail(Error('Update helper handoff is unknown; ownership retained')), 20000);
        helper.on('error', fail); helper.stdin.on('error', fail);
        helper.once('exit', () => fail(Error('Update helper exited before holding the process handles')));
        helper.stdout.on('data', bytes => {
            pending += bytes;
            if (pending.length > 4096) { fail(Error('Invalid update helper frame')); return; }
            const at = pending.indexOf('\n'); if (at === -1 || done) return;
            try {
                const value = JSON.parse(pending.slice(0, at));
                if (value.event !== 'ready' || value.id !== intent.id) throw Error('Update helper transaction mismatch');
                done = true; clearTimeout(timer); resolve();
            } catch (error) { fail(error); }
        });
        helper.stdin.end(JSON.stringify(processes) + '\n');
    });
    // The independent helper must not inherit or keep either old tray pipe alive.
    helper.stdout.destroy(); helper.unref();
}

function validationBudget(environment) {
    const raw = environment.PIVANE_ACTIVATION_TIMEOUT_MS;
    if (raw === undefined || raw === '') return 120000;
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 15000 || Number(raw) > 900000) throw Error('Invalid activation validation budget');
    return Number(raw);
}

async function validateDesktop({ launcher, link, url, fetcher, deadline }) {
    const activation = launcher.state.activation;
    const remaining = promise => {
        let timer;
        return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('Candidate validation timed out')), Math.max(0, deadline - Date.now())); })])
            .finally(() => clearTimeout(timer));
    };
    if (launcher.readyFacts?.control !== true || launcher.readyFacts?.service !== true) throw Error('Candidate lacks private validation and HTTP proofs');
    const data = await remaining(launcher.desktopRequest('validate', { activationId: activation.id }, { timeoutMs: Math.max(1, deadline - Date.now()) }));
    const version = JSON.parse(readSafe(path.join(launcher.programRoot, 'package.json'))).version;
    const engine = JSON.parse(readSafe(fs.realpathSync.native(path.join(launcher.programRoot, 'node_modules/@earendil-works/pi-coding-agent/package.json')))).version;
    if (data?.activationId !== activation.id || data.control !== true || data.data !== true || data.appVersion !== version || data.engineVersion !== engine
        || launcher.launcherVersion !== version || launcher.runningVersions?.appVersion !== version || launcher.runningVersions?.engineVersion !== engine
        || version !== activation.release.version || engine !== activation.release.piVersion) throw Error('Candidate component versions or original data validation failed');
    await remaining(link.validate());
    const stableAt = performance.now();
    while (performance.now() - stableAt < 15000) {
        if (!launcher.child || launcher.child.exitCode !== null || launcher.child.signalCode !== null || launcher.closed) throw Error('Candidate did not remain stable');
        await remaining(require('./pivane-desktop-launcher').checkReady(url, fetcher));
        await remaining(new Promise(resolve => setTimeout(resolve, Math.min(1000, 15000 - (performance.now() - stableAt)))));
    }
    if (Date.now() > deadline) throw Error('Candidate validation timed out');
    launcher.commitValidation({ control: true, versions: true, service: true, data: true, tray: true, stableMs: Math.floor(performance.now() - stableAt), deadline });
}
module.exports = { createTrayLink, handoffDesktop, validationBudget, validateDesktop };
