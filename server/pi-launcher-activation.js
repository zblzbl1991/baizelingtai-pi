const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readSafe, hashFileSafe, hash, privateDir, atomicJson, copySafe, inside, backupRoots, recordInstallation } = require('./pi-maintenance-files');
const { acquireInstallationLock } = require('./pi-installation-lock');
const { inspectBackupContents } = require('./pi-maintenance-backup');
const io = require('./pi-file-io');
const { replaceFileSync } = require('./pi-win32-native');
const { continuationEnvironment } = require('./pi-launcher-qa-context');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const exitWitness = Symbol('held process handles have signalled');
const MAX_EVIDENCE = 64 * 1024 ** 2;
const budget = () => ({ bytes: 0, files: 0, maxBytes: 4 * 1024 ** 3, maxFiles: 100000 });
const stateFile = root => path.join(root, '.pivane-runtime/state.json');
function readState(root) { return JSON.parse(readSafe(stateFile(root))); }
function relativeName(name) {
    if (typeof name !== 'string' || name.includes('\\') || name.includes(':') || path.isAbsolute(name)
        || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$|[<>"|?*\x00-\x1f]/.test(p))) throw Error('Invalid activation inventory path');
    return name;
}
function releaseRoot(root, id) {
    if (id === null || id === undefined) return root;
    if (!uuid.test(id)) throw Error('Invalid release identity');
    const dir = path.join(root, '.pivane-runtime/releases', id);
    if (fs.realpathSync.native(dir) !== dir) throw Error('Release directory changed');
    return dir;
}
function identity(file) {
    const fd = io.openReadSync(file);
    try {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (!stat.isFile()) throw Error('Activation object must be a file');
        return [io.identity(fd), ...['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key]))];
    } finally { fs.closeSync(fd); }
}
function snapshot(file, limit = 512 * 1024 ** 2) {
    const before = identity(file), proof = hashFileSafe(file, limit);
    if (JSON.stringify(before) !== JSON.stringify(identity(file))) throw Error('Activation object changed');
    return { ...proof, identity: before };
}
function unchanged(file, expected) {
    const actual = snapshot(file);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Activation file identity or hash changed');
}
function inventory(directory, version) {
    const manifestFile = path.join(directory, 'PORTABLE_MANIFEST.json');
    const manifest = JSON.parse(readSafe(manifestFile, 64 * 1024 ** 2));
    if (manifest.version !== 1 || manifest.appVersion !== version || manifest.platform !== 'win32' || manifest.arch !== 'x64'
        || !Array.isArray(manifest.files) || manifest.files.length > 100000) throw Error('Activation portable manifest mismatch');
    const expected = new Map(); let total = 0;
    for (const entry of manifest.files) {
        const name = relativeName(entry.path), key = name.toLowerCase();
        if (expected.has(key) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 512 * 1024 ** 2 || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) throw Error('Invalid activation inventory');
        total += entry.bytes; if (total > 4 * 1024 ** 3) throw Error('Activation inventory exceeds budget');
        expected.set(key, entry);
    }
    const result = [];
    function visit(relative = '') {
        for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
            const name = relativeName(relative ? relative + '/' + entry.name : entry.name);
            if (entry.isDirectory()) { if (fs.realpathSync.native(path.join(directory, name)) !== path.join(directory, name)) throw Error('Activation directory alias'); visit(name); }
            else if (entry.isFile()) {
                const proof = snapshot(path.join(directory, name)), declared = expected.get(name.toLowerCase());
                if (name !== 'PORTABLE_MANIFEST.json' && name !== 'PI_INSTALL_COMPLETE.json') {
                    if (!declared || declared.path !== name || declared.bytes !== proof.bytes || declared.sha256 !== proof.sha256) throw Error('Activation inventory hash mismatch');
                    expected.delete(name.toLowerCase());
                }
                result.push({ path: name, ...proof });
                if (result.length > 100002) throw Error('Activation entry budget exceeded');
            } else throw Error('Activation links and special files are forbidden');
        }
    }
    visit();
    if (expected.size) throw Error('Activation inventory files missing');
    return result;
}
function verifyEntries(directory, entries) {
    for (const entry of entries) { relativeName(entry.path); unchanged(path.join(directory, entry.path), { bytes: entry.bytes, sha256: entry.sha256, identity: entry.identity }); }
}
function verifyNativeEntry(directory, version) {
    const build = JSON.parse(readSafe(path.join(directory, 'native/pivane-desktop-launcher-build.json')));
    const checks = { sourceSha256: 'native/pivane-desktop-launcher.cs', manifestSha256: 'native/pivane-desktop-launcher.manifest', iconSha256: 'public/brand/favicon.ico', binarySha256: '白泽灵台.exe' };
    if (build.version !== 1 || build.appVersion !== version || Object.entries(checks).some(([key, name]) => hashFileSafe(path.join(directory, name), 128 * 1024 ** 2).sha256 !== build[key])) throw Error('Native launcher differs from its reviewed source/build baseline');
}
function activationDirectory(root, id) {
    if (!uuid.test(id || '')) throw Error('Invalid activation identity');
    return path.join(root, '.pivane-runtime/activation', id);
}
// File inventories are immutable evidence, not mutable installation state. Their
// descriptor identity and digest bind this exact file to the sole state owner.
function readEvidence(root, activation) {
    const file = path.join(activationDirectory(root, activation.id), 'entries.json');
    const expected = activation.evidence;
    if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1 || expected.bytes > MAX_EVIDENCE) throw Error('Activation evidence is unavailable or exceeds budget');
    const before = identity(file), bytes = readSafe(file, MAX_EVIDENCE), after = identity(file);
    if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(after) !== JSON.stringify(expected.identity)
        || bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) throw Error('Activation evidence identity or hash changed');
    const evidence = JSON.parse(bytes);
    if (evidence.version !== 1 || evidence.id !== activation.id || evidence.root !== root
        || !Array.isArray(evidence.original) || evidence.original.length > 20000
        || !Array.isArray(evidence.candidate) || evidence.candidate.length > 100002
        || !Array.isArray(evidence.closure) || evidence.closure.length > 128) throw Error('Invalid activation evidence');
    return evidence;
}

function inspectActivation(root, id) {
    root = fs.realpathSync.native(root);
    if (!uuid.test(id || '')) throw Error('Invalid activation identity');
    const state = readState(root);
    if (state.version !== 1 || state.activation?.id !== id || state.activation.root !== root) throw Error('Activation installation or transaction identity mismatch');
    return state.activation;
}
function requireCleanup(proof) {
    if (!proof || proof.complete !== true || typeof proof.generation !== 'string' || !proof.generation) throw Error('Verified cleanup completion is required');
}
function helperFiles(programRoot, entryPoints = ['server/pi-launcher-update-helper.js']) {
    const result = new Set();
    function add(name) {
        name = relativeName(name); if (result.has(name)) return; result.add(name);
        if (!/\.(?:js|cjs)$/.test(name)) return;
        const source = readSafe(path.join(programRoot, name), 4 * 1024 ** 2).toString('utf8');
        for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
            if (match[1].startsWith('node:')) continue;
            if (!match[1].startsWith('.')) throw Error('Independent helper cannot depend on external packages');
            let child = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
            if (!path.posix.extname(child)) child += '.js';
            add(child);
        }
    }
    for (const entry of entryPoints) add(entry);
    add('scripts/launcher-process-wait.ps1');
    for (const name of ['native/pi-win32-fd.c', 'native/pi-win32-x64-fd.node', 'native/win32-x64-manifest.json']) add(name);
    return [...result];
}
function prepareActivation({ root, state, releaseId, release, backupId, shutdownProof }) {
    requireCleanup(shutdownProof);
    root = fs.realpathSync.native(root);
    require('./pi-desktop-owner').assertStopped(root);
    require('./pi-desktop-owner').assertStopped(root, state);
    if (state.version !== 1 || state.needsRecovery || state.activation && !['committed', 'rolled-back'].includes(state.activation.phase)) throw Error('An activation already requires recovery');
    const originalRoot = releaseRoot(root, state.active), candidate = releaseRoot(root, releaseId);
    const capabilityFiles = require('./pi-desktop-owner').portableCapability(originalRoot);
    require('./pi-desktop-owner').portableCapability(candidate);
    const signature = require('./pi-update-signatures').verifyReleaseSignature(release, root);
    if (candidate === root) throw Error('Candidate must use an independent release directory');
    const entries = inventory(candidate, release.version);
    verifyNativeEntry(candidate, release.version);
    const marker = JSON.parse(readSafe(path.join(candidate, 'PI_INSTALL_COMPLETE.json')));
    if (marker.archiveSha256 !== release.sha256 || marker.appVersion !== release.version || marker.version !== release.piVersion
        || marker.lockSha256 !== hash(readSafe(path.join(candidate, 'package-lock.json'), 16 * 1024 ** 2))) throw Error('Activation target identity mismatch');
    verifyNativeEntry(originalRoot, JSON.parse(readSafe(path.join(originalRoot, 'package.json'))).version);
    const fixedEntry = hashFileSafe(path.join(root, '白泽灵台.exe'));
    const activeEntry = hashFileSafe(path.join(originalRoot, '白泽灵台.exe'));
    if (fixedEntry.bytes !== activeEntry.bytes || fixedEntry.sha256 !== activeEntry.sha256) throw Error('Fixed desktop entry has unpublished changes');
    const sourceManifest = JSON.parse(readSafe(path.join(originalRoot, 'TRIAL_MANIFEST.json'), 16 * 1024 ** 2));
    if (!Array.isArray(sourceManifest.files) || sourceManifest.files.length > 20000) throw Error('Current source baseline unavailable');
    const original = sourceManifest.files.map(entry => {
        const name = relativeName(entry.path), proof = snapshot(path.join(originalRoot, name), 128 * 1024 ** 2);
        if (proof.bytes !== entry.bytes || proof.sha256 !== entry.sha256) throw Error('Current source has unpublished changes');
        return { path: name, ...proof };
    });
    for (const name of capabilityFiles) if (!original.some(entry => entry.path === name)) original.push({ path: name, ...snapshot(path.join(originalRoot, name), 64 * 1024 ** 2) });
    if (!uuid.test(backupId || '')) throw Error('Invalid stopped backup identity');
    const backupDirectory = path.join(root, '.pivane-runtime/backups', backupId);
    const backup = inspectBackupContents(backupDirectory);
    if (backup.installation.release !== state.active || backup.installation.package.version !== JSON.parse(readSafe(path.join(originalRoot, 'package.json'))).version) throw Error('Backup belongs to another active release');
    const id = randomUUID(), directory = privateDir(activationDirectory(root, id));
    const entry = snapshot(path.join(root, '白泽灵台.exe'));
    copySafe(path.join(root, '白泽灵台.exe'), path.join(directory, 'original-entry.exe'), budget());
    const helper = privateDir(path.join(directory, 'helper')), programRoot = path.resolve(__dirname, '..');
    const closure = [];
    for (const name of helperFiles(programRoot)) {
        privateDir(path.dirname(path.join(helper, name)));
        copySafe(path.join(programRoot, name), path.join(helper, name), budget());
        closure.push({ path: name, ...snapshot(path.join(helper, name)) });
    }
    const nodeFile = path.join(helper, 'runtime/node.exe'); privateDir(path.dirname(nodeFile));
    copySafe(fs.realpathSync.native(process.execPath), nodeFile, budget()); closure.push({ path: 'runtime/node.exe', ...snapshot(nodeFile) });
    const evidenceFile = path.join(directory, 'entries.json');
    const evidence = { version: 1, id, root, original, candidate: entries, closure };
    if (Buffer.byteLength(JSON.stringify(evidence, null, 2)) + 1 > MAX_EVIDENCE) throw Error('Activation evidence exceeds budget');
    atomicJson(evidenceFile, evidence);
    return { version: 1, id, root, phase: 'prepared', createdAt: new Date().toISOString(), releaseId, release, signature,
        originalActive: state.active, originalPrevious: state.previous ?? null, originalEntry: entry, retainedEntry: snapshot(path.join(directory, 'original-entry.exe')),
        evidence: snapshot(evidenceFile, MAX_EVIDENCE), backupId, backupComplete: snapshot(path.join(backupDirectory, 'complete.json')), shutdownProof, rollbackAttempts: 0 };
}
function helperCommand(root, id) {
    const activation = inspectActivation(root, id), directory = path.join(activationDirectory(activation.root, id), 'helper');
    verifyEntries(directory, readEvidence(activation.root, activation).closure);
    return { executable: path.join(directory, 'runtime/node.exe'), args: [path.join(directory, 'server/pi-launcher-update-helper.js'), 'handoff', activation.root, id] };
}
function verifyActivation(root, activation) {
    if (activation.root !== root) throw Error('Activation installation identity changed');
    requireCleanup(activation.shutdownProof);
    require('./pi-desktop-owner').portableCapability(releaseRoot(root, activation.originalActive));
    require('./pi-desktop-owner').portableCapability(releaseRoot(root, activation.releaseId));
    const signature = require('./pi-update-signatures').verifyReleaseSignature(activation.release, root);
    if (JSON.stringify(signature) !== JSON.stringify(activation.signature)) throw Error('Activation signer changed');
    const evidence = readEvidence(root, activation), candidate = releaseRoot(root, activation.releaseId);
    const current = inventory(candidate, activation.release.version);
    if (JSON.stringify(current) !== JSON.stringify(evidence.candidate)) throw Error('Activation candidate changed');
    verifyEntries(releaseRoot(root, activation.originalActive), evidence.original);
    unchanged(path.join(root, '白泽灵台.exe'), activation.originalEntry);
    unchanged(path.join(activationDirectory(root, activation.id), 'original-entry.exe'), activation.retainedEntry);
    const backupDirectory = path.join(root, '.pivane-runtime/backups', activation.backupId);
    unchanged(path.join(backupDirectory, 'complete.json'), activation.backupComplete);
    inspectBackupContents(backupDirectory);
    return evidence;
}
async function applyActivation(root, id, witness, processProof) {
    root = fs.realpathSync.native(root);
    const guard = await acquireInstallationLock(root);
    try {
        require('./pi-desktop-owner').assertStopped(root);
        const state = readState(root), activation = inspectActivation(root, id);
        if (activation.phase !== 'prepared' || state.active !== activation.originalActive) throw Error('Activation requires manual recovery');
        const evidence = verifyActivation(root, activation);
        if (witness !== exitWitness) throw Error('Held process handles must prove outer exit');
        if (JSON.stringify(activation.handoffProcesses) !== JSON.stringify(processProof?.processes)) throw Error('Activation handoff process identities changed');
        activation.processProof = processProof;
        activation.phase = 'activating'; state.activation = activation; atomicJson(stateFile(root), state);
        await require('./pi-launcher-qa-checkpoints').checkpoint(root, 'activation-replacing', { activationId: id, releaseId: activation.releaseId });
        const target = path.join(root, '白泽灵台.exe'), temp = path.join(root, '.' + id + '.entry');
        const candidateEntry = evidence.candidate.find(entry => entry.path === '白泽灵台.exe');
        const copied = copySafe(path.join(releaseRoot(root, activation.releaseId), '白泽灵台.exe'), temp, budget());
        if (!candidateEntry || copied.bytes !== candidateEntry.bytes || copied.sha256 !== candidateEntry.sha256) throw Error('Candidate entry changed during activation');
        verifyEntries(releaseRoot(root, activation.releaseId), evidence.candidate);
        unchanged(target, activation.originalEntry);
        replaceFileSync(temp, target);
        activation.activeEntry = snapshot(target);
        state.previous = activation.originalActive; state.active = activation.releaseId;
        activation.phase = 'validating'; activation.activatedAt = new Date().toISOString();
        atomicJson(stateFile(root), state);
        return activation;
    } finally { await guard.close(); }
}
async function recoverActivation({ root, id, shutdownProof, witness, processProof }) {
    requireCleanup(shutdownProof);
    root = fs.realpathSync.native(root);
    const guard = await acquireInstallationLock(root);
    try {
        require('./pi-desktop-owner').assertStopped(root);
        const activation = inspectActivation(root, id), state = readState(root);
        require('./pi-desktop-owner').portableCapability(releaseRoot(root, activation.originalActive));
        require('./pi-desktop-owner').portableCapability(releaseRoot(root, activation.releaseId));
        if (activation.phase === 'committed') throw Error('Committed activation preserves current data');
        if (activation.phase !== 'validating' || activation.rollbackAttempts !== 0) throw Error('Activation requires manual recovery; unknown steps must not be replayed');
        if (witness !== exitWitness || shutdownProof.activationId !== id || shutdownProof.releaseId !== activation.releaseId
            || shutdownProof.generation === activation.shutdownProof.generation || JSON.stringify(shutdownProof) !== JSON.stringify(activation.failureShutdownProof)
            || JSON.stringify(activation.failureHandoffProcesses) !== JSON.stringify(processProof?.processes)) throw Error('Candidate cleanup and held exit proof required for recovery');
        require('./pi-update-signatures').verifyReleaseSignature(activation.release, root);
        const evidence = readEvidence(root, activation);
        const originalRoot = releaseRoot(root, activation.originalActive), target = path.join(root, '白泽灵台.exe');
        verifyEntries(originalRoot, evidence.original.filter(entry => originalRoot !== root || entry.path !== '白泽灵台.exe'));
        unchanged(target, activation.activeEntry);
        const originalEntry = path.join(activationDirectory(root, id), 'original-entry.exe'); unchanged(originalEntry, activation.retainedEntry);
        const backupDirectory = path.join(root, '.pivane-runtime/backups', activation.backupId);
        unchanged(path.join(backupDirectory, 'complete.json'), activation.backupComplete);
        const plan = inspectBackupContents(backupDirectory);
        if (plan.installation.release !== activation.originalActive || state.active !== activation.releaseId
            || plan.manifest.entries.some(entry => entry.type !== 'file')) throw Error('Recovery installation or native data scope mismatch');
        activation.rollbackAttempts = 1; activation.phase = 'rolling-back'; activation.failureProcessProof = processProof;
        state.activation = activation; state.needsRecovery = true; atomicJson(stateFile(root), state);
        const safetyDirectory = path.join(root, '.pivane-runtime/backups', randomUUID());
        const safety = backupRoots(plan.manifest.roots, safetyDirectory);
        recordInstallation(safetyDirectory, { release: state.active,
            package: JSON.parse(readSafe(path.join(releaseRoot(root, state.active), 'package.json'))),
            lock: JSON.parse(readSafe(path.join(releaseRoot(root, state.active), 'package-lock.json'), 16 * 1024 ** 2)) });
        activation.safetyBackup = safety; atomicJson(stateFile(root), state);
        await require('./pi-launcher-qa-checkpoints').checkpoint(root, 'rollback-restoring', { activationId: id, releaseId: activation.releaseId, backupDirectory });
        const current = JSON.parse(readSafe(path.join(safetyDirectory, 'manifest.json'), 128 * 1024 ** 2));
        const parent = file => { if (fs.realpathSync.native(path.dirname(file)) !== path.dirname(file)) throw Error('Recovery destination parent changed'); };
        const wanted = new Set(plan.manifest.entries.map(entry => entry.path));
        for (const entry of current.entries) if (!wanted.has(entry.path)) { parent(entry.path); fs.unlinkSync(entry.path); }
        for (const dir of [...plan.manifest.directories].sort((a, b) => a.length - b.length)) {
            if (fs.existsSync(dir) && !fs.lstatSync(dir).isDirectory()) throw Error('Recovery destination type changed');
            privateDir(dir);
        }
        const copyBudget = { bytes: 0, files: 0, maxBytes: 50 * 1024 ** 3, maxFiles: 100000 };
        for (const entry of plan.manifest.entries) {
            parent(entry.path);
            const temp = entry.path + '.' + id + '.restore';
            const actual = copySafe(path.join(backupDirectory, 'files', entry.object), temp, copyBudget);
            if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw Error('Recovery object changed');
            replaceFileSync(temp, entry.path);
        }
        const temp = path.join(root, '.' + id + '.rollback-entry');
        const retained = copySafe(originalEntry, temp, budget());
        if (retained.bytes !== activation.retainedEntry.bytes || retained.sha256 !== activation.retainedEntry.sha256) throw Error('Retained entry changed during recovery');
        unchanged(originalEntry, activation.retainedEntry); unchanged(target, activation.activeEntry); replaceFileSync(temp, target);
        activation.restoredEntry = snapshot(target);
        state.active = activation.originalActive; state.previous = activation.originalPrevious;
        state.needsRecovery = false; activation.phase = 'rolled-back'; activation.rolledBackAt = new Date().toISOString();
        atomicJson(stateFile(root), state);
        return activation;
    } finally { await guard.close(); }
}
// The current runner already owns the installation lock. Persist before it opens
// business admission; reading a committed result is idempotent after lost ack.
function checkValidationDeadline(validation) {
    if (validation.deadline === undefined) return;
    if (!Number.isSafeInteger(validation.deadline) || validation.deadline <= 0) throw Error('Invalid startup validation deadline');
    if (Date.now() > validation.deadline) throw Error('Startup validation deadline expired');
}
function commitActivation(root, id, validation) {
    root = fs.realpathSync.native(root);
    const activation = inspectActivation(root, id), state = readState(root);
    if (activation.phase === 'committed') { verifyActiveProgram(root, state.active); return activation; }
    if (activation.phase !== 'validating' || state.active !== activation.releaseId
        || ['control', 'versions', 'service', 'data', 'tray'].some(name => validation?.[name] !== true)
        || !Number.isSafeInteger(validation?.stableMs) || validation.stableMs < 15000) throw Error('Complete startup validation is required before commit');
    checkValidationDeadline(validation);
    verifyActiveProgram(root, state.active);
    checkValidationDeadline(validation);
    activation.phase = 'committed'; activation.validation = validation; activation.committedAt = new Date().toISOString();
    state.activation = activation; atomicJson(stateFile(root), state);
    return activation;
}
// Called by the locked runner before forking any service. Legacy installations
// without an activation transaction keep their existing source/marker contract.
function verifyActiveProgram(root, releaseId) {
    root = fs.realpathSync.native(root);
    try { fs.lstatSync(stateFile(root)); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (releaseId === null || releaseId === undefined) return { supported: false };
        throw Error('Active release requires installation state');
    }
    const state = readState(root), activation = state.activation;
    if (state.version !== 1 || state.needsRecovery || state.active !== releaseId) throw Error('Active installation identity or recovery state mismatch');
    if (!activation) return { supported: false };
    if (activation.root !== root) throw Error('Active installation root changed');
    if (['activating', 'rolling-back'].includes(activation.phase)) throw Error('Active program requires manual recovery');
    if (['validating', 'committed'].includes(activation.phase) && releaseId === activation.releaseId) {
        const evidence = readEvidence(root, activation);
        require('./pi-update-signatures').verifyReleaseSignature(activation.release, root);
        const current = inventory(releaseRoot(root, releaseId), activation.release.version);
        if (JSON.stringify(current) !== JSON.stringify(evidence.candidate)) throw Error('Active candidate changed before service start');
        return { supported: true, phase: activation.phase, id: activation.id };
    }
    if (activation.phase === 'rolled-back' && releaseId === activation.originalActive) {
        const evidence = readEvidence(root, activation), directory = releaseRoot(root, releaseId);
        verifyEntries(directory, evidence.original.filter(entry => directory !== root || entry.path !== '白泽灵台.exe'));
        unchanged(path.join(root, '白泽灵台.exe'), activation.restoredEntry);
        if (activation.restoredEntry.bytes !== activation.originalEntry.bytes || activation.restoredEntry.sha256 !== activation.originalEntry.sha256) throw Error('Restored entry differs from authorized original');
        return { supported: true, phase: activation.phase, id: activation.id };
    }
    if (activation.phase === 'prepared' && releaseId === activation.originalActive) { readEvidence(root, activation); return { supported: false }; }
    // A later engine-only update can legitimately select another snapshot. It
    // has its own installer baseline and does not inherit this record's proof.
    if (activation.phase === 'committed' || activation.phase === 'rolled-back') return { supported: false };
    throw Error('Active version is inconsistent with its activation transaction');
}
async function runHandoff({ root, id, processes, onReady, mode = 'activate' }) {
    if (!['activate', 'rollback'].includes(mode)) throw Error('Invalid handoff operation');
    root = fs.realpathSync.native(root);
    try {
        const continuation = continuationEnvironment(root, process.env);
        const before = inspectActivation(root, id);
        if (before.phase !== (mode === 'activate' ? 'prepared' : 'validating')) throw Error('Activation requires manual recovery');
        const expectedProcesses = mode === 'activate' ? before.handoffProcesses : before.failureHandoffProcesses;
        if (!Array.isArray(expectedProcesses) || JSON.stringify(expectedProcesses) !== JSON.stringify(processes)) throw Error('Handoff process identities do not match this transaction');
        const proof = await require('./pi-launcher-processes').awaitExactProcesses(processes, onReady);
        await require('./pi-launcher-qa-checkpoints').checkpoint(root, 'helper-before-apply', { activationId: id, mode });
        const activation = mode === 'activate' ? await applyActivation(root, id, exitWitness, proof)
            : await recoverActivation({ root, id, shutdownProof: inspectActivation(root, id).failureShutdownProof, witness: exitWitness, processProof: proof });
        const { spawn } = require('node:child_process');
        const entry = spawn(path.join(root, '白泽灵台.exe'), [], { cwd: root, windowsHide: true, detached: true, stdio: 'ignore',
            env: { SystemRoot: process.env.SystemRoot, SystemDrive: process.env.SystemDrive, TEMP: process.env.TEMP, TMP: process.env.TMP, ...continuation,
                PIVANE_ACTIVATION_ID: activation.phase === 'validating' ? id : '', PIVANE_INSTALLATION_ROOT: root } });
        await new Promise((resolve, reject) => { entry.once('spawn', resolve); entry.once('error', reject); });
        entry.unref(); return activation;
    } catch (error) {
        try { require('./pi-launcher-qa-checkpoints').writeReceipt(root, 'helper-failed', { activationId: id, mode, outcome: error.message }); } catch { /* Keep the original failure authoritative. */ }
        throw error;
    }
}
module.exports = { inspectActivation, prepareActivation, helperCommand, helperFiles, applyActivation, recoverActivation, commitActivation, runHandoff, verifyActiveProgram,
    activationFileProof: snapshot, verifyActivationFile: unchanged };
