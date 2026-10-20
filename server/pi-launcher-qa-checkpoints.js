// Explicit synthetic-installation controls. Normal installations have no QA
// context and never read a checkpoint file or create QA receipts.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readSafe, atomicJson, hashFileSafe } = require('./pi-maintenance-files');
let creationTime;
function processCreationTime(environment) {
    if (creationTime) return creationTime;
    if (process.platform !== 'win32') return null;
    const script = "([Diagnostics.Process]::GetProcessById([int]$env:PIVANE_QA_RECEIPT_PID)).StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)";
    const result = require('node:child_process').execFileSync(path.join(environment.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 15000, encoding: 'utf8', env: { SystemRoot: environment.SystemRoot, TEMP: environment.TEMP, TMP: environment.TMP,
            HOME: environment.HOME, USERPROFILE: environment.USERPROFILE, APPDATA: environment.APPDATA, LOCALAPPDATA: environment.LOCALAPPDATA,
            PIVANE_QA_RECEIPT_PID: String(process.pid) } }).trim();
    if (!/^[0-9]{16,19}$/.test(result)) throw Error('Actual QA process FILETIME is unavailable');
    creationTime = result; return creationTime;
}
const ALLOWED = Object.freeze({
    normal: { 'candidate-before-validation': 'pause' },
    'repair-entry': { 'candidate-before-validation': 'pause' },
    'repair-changed-entry': { 'candidate-before-validation': 'pause' },
    'postcommit-preservation': { 'candidate-before-validation': 'pause' },
    'staged-mutation': { 'candidate-staged': 'pause' },
    'occupied-entry': { 'helper-before-apply': 'pause' },
    'old-tray-held': { 'handoff-outer-exit': 'pause' },
    'unknown-cleanup': { 'service-before-cleanup-proof': 'omit-proof' },
    'interrupt-prepared': { 'helper-before-apply': 'pause' },
    'interrupt-activating': { 'activation-replacing': 'pause' },
    'interrupt-rollback': { 'candidate-before-validation': 'fail', 'rollback-restoring': 'pause' },
    'validation-failure': { 'candidate-before-validation': 'fail' },
    'validation-timeout': { 'candidate-before-validation': 'timeout' },
    'recovery-failure': { 'candidate-before-validation': 'fail', 'rollback-restoring': 'pause' }
});
function context(root, environment) {
    if (!Object.keys(environment).some(key => key.toUpperCase().startsWith('PIVANE_NATIVE_QA'))) return null;
    const env = require('./pi-launcher-qa-context').continuationEnvironment(root, environment);
    if (env.PIVANE_NATIVE_QA !== '1') throw Error('An explicitly authorized native QA context is required');
    return { env, runId: env.PIVANE_NATIVE_QA_RUN_ID, scenario: env.PIVANE_NATIVE_QA_SCENARIO };
}
function writeReceipt(root, point, details = {}, environment = process.env) {
    const qa = context(root, environment); if (!qa) return null;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(point)) throw Error('Invalid QA checkpoint name');
    const safe = {};
    for (const key of ['activationId', 'releaseId', 'generation', 'programRoot', 'url', 'mode', 'candidateDirectory', 'backupDirectory', 'outcome']) {
        if (typeof details[key] === 'string' && details[key].length <= 4096) safe[key] = details[key];
    }
    if (Number.isSafeInteger(details.validationDeadline)) safe.validationDeadline = details.validationDeadline;
    const receipt = { schemaVersion: 1, runId: qa.runId, root, scenario: qa.scenario, point, receiptId: randomUUID(),
        pid: process.pid, parentPid: process.ppid, creationTime: processCreationTime({ ...qa.env, SystemRoot: environment.SystemRoot }), execPath: fs.realpathSync.native(process.execPath),
        at: new Date().toISOString(), state: 'observed', details: safe };
    const file = path.join(qa.env.PIVANE_NATIVE_QA_RECEIPTS, receipt.receiptId + '.json');
    atomicJson(file, receipt); return { qa, receipt, file };
}
async function checkpoint(root, point, details = {}, { environment = process.env, deadline } = {}) {
    const entry = writeReceipt(root, point, details, environment); if (!entry) return {};
    const { qa, receipt, file } = entry;
    const commandFile = path.join(qa.env.PIVANE_NATIVE_QA_CHECKPOINTS, point + '.json');
    let command;
    try { command = JSON.parse(readSafe(commandFile, 4096)); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    if (command?.schemaVersion !== 1 || command.runId !== qa.runId || command.root !== root || command.point !== point
        || !/^[a-f0-9-]{36}$/.test(command.commandId || '')
        || Object.keys(command).some(key => !['schemaVersion', 'runId', 'root', 'point', 'commandId', 'action'].includes(key))
        || ALLOWED[qa.scenario]?.[point] !== command.action) throw Error('QA checkpoint command is not authorized for this isolated scenario');
    // A command is consumed once. Resume is bound to the fresh receipt nonce,
    // so another tray/helper generation cannot replay old fixture input.
    const consumed = path.join(qa.env.PIVANE_NATIVE_QA_CHECKPOINTS, command.commandId + '.consumed.json');
    if (fs.existsSync(consumed)) throw Error('QA checkpoint command has already been consumed');
    fs.renameSync(commandFile, consumed);
    receipt.commandId = command.commandId; receipt.action = command.action;
    if (point === 'candidate-before-validation' && ['fail', 'timeout'].includes(command.action)) {
        const candidateDataFile = path.join(qa.env.PI_CODING_AGENT_DIR, 'qa-candidate-increment.txt');
        const bytes = Buffer.from('Synthetic candidate validation data: ' + qa.runId + '\n');
        require('./pi-private-files').writePrivateFileSync(candidateDataFile, bytes, true);
        receipt.details.candidateDataFile = candidateDataFile;
        receipt.details.candidateDataProof = hashFileSafe(candidateDataFile, 4096);
        receipt.details.dataInjection = 'guarded synthetic runner write before private validation failure';
    }
    receipt.state = command.action === 'pause' ? 'paused' : 'injected'; atomicJson(file, receipt);
    if (command.action === 'fail') throw Error('Synthetic QA validation failure at ' + point);
    if (command.action === 'omit-proof') return { omitProof: true };
    if (command.action === 'timeout') {
        if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw Error('QA timeout requires the unchanged product deadline');
        await new Promise(resolve => setTimeout(resolve, deadline - Date.now() + 25));
        throw Error('Synthetic QA validation remained unavailable until the product deadline');
    }
    const until = Math.min(deadline || Date.now() + 10 * 60 * 1000, Date.now() + 10 * 60 * 1000);
    const resumeFile = path.join(qa.env.PIVANE_NATIVE_QA_CHECKPOINTS, receipt.receiptId + '.resume.json');
    while (Date.now() < until) {
        let resume;
        try { resume = JSON.parse(readSafe(resumeFile, 4096)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (resume) {
            if (resume.schemaVersion !== 1 || resume.runId !== qa.runId || resume.root !== root || resume.receiptId !== receipt.receiptId
                || resume.action !== 'resume' || Object.keys(resume).some(key => !['schemaVersion', 'runId', 'root', 'receiptId', 'action'].includes(key))) throw Error('QA resume belongs to another checkpoint or generation');
            fs.unlinkSync(resumeFile); receipt.state = 'resumed'; receipt.resumedAt = new Date().toISOString(); atomicJson(file, receipt); return {};
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, until - Date.now()))));
    }
    receipt.state = 'expired'; atomicJson(file, receipt);
    throw Error('Synthetic QA pause expired without changing the product deadline');
}
module.exports = { checkpoint, writeReceipt };
