const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readSafe, privateDir, atomicJson, copySafe } = require('./pi-maintenance-files');
const { acquireInstallationLock } = require('./pi-installation-lock');
const { replaceFileSync } = require('./pi-win32-native');
const activationApi = require('./pi-launcher-activation');
const { inspectBackupContents } = require('./pi-maintenance-backup');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function stateOf(root) { return JSON.parse(readSafe(path.join(root, '.pivane-runtime/state.json'))); }
function diagnoseStopped(root) {
    const state = stateOf(root), activation = state.activation;
    if (state.version !== 1 || state.needsRecovery || !activation || activation.root !== root
        || !['committed', 'validating'].includes(activation.phase)
        || activation.phase === 'validating' && activation.validationOwner
        || activation.entryRepair && activation.entryRepair.phase !== 'succeeded') return { status: 'manual-recovery', canRepair: false,
        reason: 'Unknown owner, incomplete mutation or no trusted activation; preserve state for independent maintenance' };
    try {
        if (!uuid.test(activation.id) || state.active !== activation.releaseId
            || !activationApi.verifyActiveProgram(root, state.active).supported) throw Error('No complete signed evidence for this active program');
        if (activation.phase === 'validating') {
            if (activation.shutdownProof?.complete !== true || !activation.shutdownProof.generation
                || !activation.processProof?.observedAt || !Array.isArray(activation.processProof.processes)
                || !activation.processProof.processes.length || JSON.stringify(activation.processProof.processes) !== JSON.stringify(activation.handoffProcesses)
                || !uuid.test(activation.backupId || '')) throw Error('Incomplete old cleanup, backup or exact exit proof');
            const backup = path.join(root, '.pivane-runtime/backups', activation.backupId);
            activationApi.verifyActivationFile(path.join(backup, 'complete.json'), activation.backupComplete);
            inspectBackupContents(backup);
            activationApi.verifyActivationFile(path.join(root, '.pivane-runtime/activation', activation.id, 'original-entry.exe'), activation.retainedEntry);
        }
        const source = path.join(root, '.pivane-runtime/releases', state.active, '白泽灵台.exe');
        const sourceProof = activationApi.activationFileProof(source);
        let current;
        try { fs.lstatSync(path.join(root, '白泽灵台.exe')); current = activationApi.activationFileProof(path.join(root, '白泽灵台.exe')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const healthy = current && current.bytes === sourceProof.bytes && current.sha256 === sourceProof.sha256;
        if (healthy) return { status: 'healthy', canRepair: false, alreadyHealthy: true, activationId: activation.id, version: activation.release.version };
        if (activation.entryRepair) throw Error('Entry repair already attempted once; preserve the new damage for manual maintenance');
        return { status: current ? 'entry-changed' : 'entry-missing', canRepair: !current, replaceChangedAllowed: Boolean(current), activationId: activation.id,
            version: activation.release.version, scope: ['白泽灵台.exe'], preserves: ['active', 'runtimePaths', 'all-user-data'], current, sourceProof };
    } catch (error) { return { status: 'manual-recovery', canRepair: false, reason: error.message }; }
}
async function diagnoseInstallation(root) {
    root = fs.realpathSync.native(root);
    let owner;
    try { owner = await acquireInstallationLock(root); }
    catch (error) { if (error.code === 'EADDRINUSE') return { status: 'installation-owned', canRepair: false, reason: 'Use the current desktop owner to stop normally' }; throw error; }
    try { return diagnoseStopped(root); } finally { await owner.close(); }
}
async function restoreEntry(root, id, { replaceChanged = false } = {}) {
    root = fs.realpathSync.native(root);
    if (!uuid.test(id || '')) throw Error('Invalid activation identity');
    const owner = await acquireInstallationLock(root);
    try {
        const diagnosis = diagnoseStopped(root), state = stateOf(root);
        if (state.activation?.id !== id || state.activation.root !== root) throw Error('Repair transaction identity changed');
        if (diagnosis.alreadyHealthy) return { restored: false, alreadyHealthy: true, activationId: id };
        if (!diagnosis.canRepair && !(replaceChanged && diagnosis.replaceChangedAllowed)) throw Error(diagnosis.reason || 'Existing entry changed; inspect it and explicitly use --replace-changed to preserve and replace only this file');
        const activation = state.activation, repairId = randomUUID();
        const directory = privateDir(path.join(root, '.pivane-runtime/activation', id, 'entry-repair', repairId));
        const target = path.join(root, '白泽灵台.exe'), source = path.join(root, '.pivane-runtime/releases', state.active, '白泽灵台.exe');
        activation.entryRepair = { id: repairId, attempts: 1, phase: 'replacing', previous: diagnosis.current || null, startedAt: new Date().toISOString(), scope: ['白泽灵台.exe'] };
        atomicJson(path.join(root, '.pivane-runtime/state.json'), state);
        const budget = { bytes: 0, files: 0, maxBytes: 1024 ** 3, maxFiles: 3 };
        if (diagnosis.current) {
            copySafe(target, path.join(directory, 'previous-entry.exe'), budget);
            activationApi.verifyActivationFile(target, diagnosis.current);
        }
        const temporary = path.join(root, '.pivane-entry-repair-' + repairId + '.tmp');
        const copied = copySafe(source, temporary, budget);
        if (copied.bytes !== diagnosis.sourceProof.bytes || copied.sha256 !== diagnosis.sourceProof.sha256) throw Error('Signed entry changed while copying');
        activationApi.verifyActivationFile(source, diagnosis.sourceProof);
        activationApi.verifyActiveProgram(root, state.active);
        if (diagnosis.current) activationApi.verifyActivationFile(target, diagnosis.current);
        else {
            try { fs.lstatSync(target); throw Error('Main entry appeared during repair'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        replaceFileSync(temporary, target);
        activation.activeEntry = activationApi.activationFileProof(target);
        activation.entryRepair.phase = 'succeeded'; activation.entryRepair.finishedAt = new Date().toISOString();
        activation.entryRepair.result = activation.activeEntry;
        atomicJson(path.join(root, '.pivane-runtime/state.json'), state);
        return { restored: true, activationId: id, repairId, version: activation.release.version, scope: ['白泽灵台.exe'], dataRestored: false };
    } finally { await owner.close(); }
}
function repairFiles(programRoot) { return activationApi.helperFiles(programRoot, ['scripts/repair-launcher.cjs']); }
module.exports = { diagnoseInstallation, restoreEntry, repairFiles };
