const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const cli = path.resolve(__dirname, '../server/pi-launcher-update-helper.js');

test('independent update entry inspects one transaction without rewriting state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-activation-'));
    try {
        fs.mkdirSync(path.join(root, '.pivane-runtime'));
        const id = randomUUID();
        const state = JSON.stringify({ version: 1, active: null, previous: null, activation: { id, root, phase: 'committed' } });
        const file = path.join(root, '.pivane-runtime/state.json');
        fs.writeFileSync(file, state);
        for (let i = 0; i < 2; i++) {
            const result = spawnSync(process.execPath, [cli, 'inspect', root, id], { encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(JSON.parse(result.stdout).phase, 'committed');
            assert.equal(fs.readFileSync(file, 'utf8'), state);
        }
        const other = spawnSync(process.execPath, [cli, 'inspect', root, randomUUID()], { encoding: 'utf8' });
        assert.equal(other.status, 1);
        assert.match(other.stderr, /identity/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const { transactionFixture } = require('./launcher-activation-fixture.cjs');

test('realistic portable inventory keeps twenty thousand file proofs outside the bounded installation state', { timeout: 180000 }, t => {
    const activation = require('../server/pi-launcher-activation'), input = transactionFixture(t);
    const manifestFile = path.join(input.candidate, 'PORTABLE_MANIFEST.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile));
    const directory = path.join(input.candidate, 'node_modules/synthetic-package');
    fs.mkdirSync(directory, { recursive: true });
    for (let i = 0; i < 20000; i++) {
        const relative = `node_modules/synthetic-package/entry-${String(i).padStart(5, '0')}.js`;
        fs.writeFileSync(path.join(input.candidate, relative), 'x');
        manifest.files.push({ path: relative, bytes: 1, sha256: '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881' });
    }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    input.state.activation = activation.prepareActivation(input);
    const stateBytes = Buffer.byteLength(JSON.stringify(input.state, null, 2));
    assert.ok(stateBytes < 64 * 1024, `installation state grew to ${stateBytes} bytes`);
    assert.ok(input.state.activation.evidence.bytes > 4 * 1024 ** 2, 'actual large evidence exceeds the old state limit');
    t.diagnostic(`20,000 file inventory: state ${stateBytes} bytes; immutable evidence ${input.state.activation.evidence.bytes} bytes`);
    require('../server/pi-maintenance-files').atomicJson(path.join(input.root, '.pivane-runtime/state.json'), input.state);
    const inspected = spawnSync(process.execPath, [cli, 'inspect', input.root, input.state.activation.id], { encoding: 'utf8' });
    assert.equal(inspected.status, 0, inspected.stderr);
});

test('independent update entry rejects candidate changed after signed preparation', async t => {
    const activation = require('../server/pi-launcher-activation');
    const input = transactionFixture(t);
    input.state.activation = activation.prepareActivation(input);
    require('../server/pi-maintenance-files').atomicJson(path.join(input.root, '.pivane-runtime/state.json'), input.state);
    fs.writeFileSync(path.join(input.candidate, '白泽灵台.exe'), 'tampered');
    await assert.rejects(() => activation.applyActivation(input.root, input.state.activation.id), /changed|hash/);
    assert.equal(fs.readFileSync(path.join(input.root, '白泽灵台.exe'), 'utf8'), 'old fixed entry');
    assert.equal(activation.inspectActivation(input.root, input.state.activation.id).phase, 'prepared');
});

test('signed update cannot overwrite an unpublished fixed desktop entry', t => {
    const activation = require('../server/pi-launcher-activation'), input = transactionFixture(t);
    const manifest = path.join(input.root, 'TRIAL_MANIFEST.json');
    fs.writeFileSync(manifest, JSON.stringify({ files: JSON.parse(fs.readFileSync(manifest)).files.filter(file => file.path !== '白泽灵台.exe') }));
    fs.writeFileSync(path.join(input.root, '白泽灵台.exe'), 'local unpublished launcher fix');
    assert.throws(() => activation.prepareActivation(input), /native|unpublished|baseline/i);
});

test('independent helper rejects a busy installation and unbound process handoff without changing state', async t => {
    const activation = require('../server/pi-launcher-activation'), input = transactionFixture(t);
    const { atomicJson } = require('../server/pi-maintenance-files');
    input.state.activation = activation.prepareActivation(input);
    const id = input.state.activation.id, file = path.join(input.root, '.pivane-runtime/state.json');
    atomicJson(file, input.state);
    const before = fs.readFileSync(file, 'utf8');
    const owner = await require('../server/pi-installation-lock').acquireInstallationLock(input.root);
    try { await assert.rejects(() => activation.applyActivation(input.root, id), /EADDRINUSE|address already in use/); }
    finally { await owner.close(); }
    await assert.rejects(() => activation.runHandoff({ root: input.root, id, processes: [] }), /process identities/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('commit requires complete startup validation and persists before business admission', t => {
    const { commitActivation, inspectActivation, prepareActivation } = require('../server/pi-launcher-activation');
    const input = transactionFixture(t);
    input.state.activation = prepareActivation(input);
    const id = input.state.activation.id;
    input.state.active = input.releaseId;
    input.state.activation.phase = 'validating';
    const file = path.join(input.root, '.pivane-runtime/state.json');
    require('../server/pi-maintenance-files').atomicJson(file, input.state);
    assert.throws(() => commitActivation(input.root, id, { control: true }), /validation/);
    commitActivation(input.root, id, { control: true, versions: true, service: true, data: true, tray: true, stableMs: 15000 });
    assert.equal(inspectActivation(input.root, id).phase, 'committed');
    assert.equal(JSON.parse(fs.readFileSync(file)).runtimePaths.PI_CODING_AGENT_DIR, path.join(input.root, 'data'));
    commitActivation(input.root, id, { control: true, versions: true, service: true, data: true, tray: true, stableMs: 15000 });
});

test('service boot verifies the bound complete candidate inventory and refuses a deleted service entry', t => {
    const activation = require('../server/pi-launcher-activation'), input = transactionFixture(t);
    input.state.activation = activation.prepareActivation(input);
    input.state.activation.phase = 'validating'; input.state.active = input.releaseId;
    require('../server/pi-maintenance-files').atomicJson(path.join(input.root, '.pivane-runtime/state.json'), input.state);
    assert.equal(activation.verifyActiveProgram(input.root, input.releaseId).supported, true);
    fs.unlinkSync(path.join(input.candidate, 'server.js'));
    assert.throws(() => activation.verifyActiveProgram(input.root, input.releaseId), /missing|changed/);
    assert.throws(() => activation.commitActivation(input.root, input.state.activation.id, { control: true, versions: true, service: true, data: true, tray: true, stableMs: 15000 }), /missing|changed/);
    assert.equal(activation.inspectActivation(input.root, input.state.activation.id).phase, 'validating');
});

test('independent operations reject replacement of their immutable inventory evidence', async t => {
    const activation = require('../server/pi-launcher-activation'), input = transactionFixture(t);
    input.state.activation = activation.prepareActivation(input);
    const id = input.state.activation.id, file = path.join(input.root, '.pivane-runtime/state.json');
    require('../server/pi-maintenance-files').atomicJson(file, input.state);
    fs.appendFileSync(path.join(input.root, '.pivane-runtime/activation', id, 'entries.json'), ' ');
    assert.throws(() => activation.helperCommand(input.root, id), /evidence/);
    await assert.rejects(() => activation.applyActivation(input.root, id), /evidence/);
    input.state.active = input.releaseId; input.state.activation.phase = 'validating';
    require('../server/pi-maintenance-files').atomicJson(file, input.state);
    assert.throws(() => activation.commitActivation(input.root, id, { control: true, versions: true, service: true, data: true, tray: true, stableMs: 15000 }), /evidence/);
    assert.throws(() => activation.verifyActiveProgram(input.root, input.releaseId), /evidence/);
});

test('independent helper holds exact process handles, activates after exit and rolls back only once', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const activation = require('../server/pi-launcher-activation');
    const { atomicJson } = require('../server/pi-maintenance-files');
    const input = transactionFixture(t);
    input.state.activation = activation.prepareActivation(input);
    const id = input.state.activation.id, file = path.join(input.root, '.pivane-runtime/state.json');
    atomicJson(file, input.state);
    async function handoff(mode) {
        const target = spawn(process.execPath, ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
        const targetClosed = once(target, 'close');
        t.after(() => { if (target.exitCode === null) target.stdin.end(); });
        const creationTime = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Process -Id $env:TARGET_PID).StartTime.ToFileTimeUtc().ToString()'], {
            encoding: 'utf8', windowsHide: true, env: { SystemRoot: process.env.SystemRoot, TARGET_PID: String(target.pid) }
        }).stdout.trim();
        const command = activation.helperCommand(input.root, id);
        command.args[1] = mode;
        const identities = [{ pid: target.pid, creationTime }];
        const current = JSON.parse(fs.readFileSync(file));
        current.activation[mode === 'handoff' ? 'handoffProcesses' : 'failureHandoffProcesses'] = identities;
        atomicJson(file, current);
        const helper = spawn(command.executable, command.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '', errors = '';
        const closed = once(helper, 'close');
        helper.stderr.on('data', bytes => errors += bytes);
        helper.stdout.on('data', bytes => output += bytes);
        helper.stdin.end(JSON.stringify(identities) + '\n');
        const deadline = Date.now() + 12000;
        while (!output.includes('"ready"')) {
            if (helper.exitCode !== null || Date.now() > deadline) assert.fail('No ready: ' + errors);
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(activation.inspectActivation(input.root, id).phase, mode === 'handoff' ? 'prepared' : 'validating');
        target.stdin.end(); await targetClosed;
        await closed;
        // Synthetic EXE bytes deliberately cannot start; the durable activation
        // and recovery results are still observable, without substituting PIDs.
        assert.match(errors, /spawn|EINVAL|ENOEXEC/);
    }
    await handoff('handoff');
    assert.equal(activation.inspectActivation(input.root, id).phase, 'validating');
    assert.equal(fs.readFileSync(path.join(input.root, '白泽灵台.exe'), 'utf8'), 'new fixed entry');
    fs.writeFileSync(path.join(input.root, 'data/value.txt'), 'failed validation data');
    const state = JSON.parse(fs.readFileSync(file));
    state.activation.failureShutdownProof = { complete: true, generation: 'candidate-generation', activationId: id, releaseId: input.releaseId };
    atomicJson(file, state);
    await handoff('rollback-handoff');
    assert.equal(activation.inspectActivation(input.root, id).phase, 'rolled-back');
    assert.equal(activation.inspectActivation(input.root, id).rollbackAttempts, 1);
    assert.equal(fs.readFileSync(path.join(input.root, 'data/value.txt'), 'utf8'), 'before update');
    assert.equal(fs.readFileSync(path.join(input.root, '白泽灵台.exe'), 'utf8'), 'old fixed entry');
    assert.equal(activation.verifyActiveProgram(input.root, null).supported, true, 'authorized restoration uses the new entry identity');
    const result = spawnSync(commandExe(input.root, id), [activation.helperCommand(input.root, id).args[0], 'rollback-handoff', input.root, id], { encoding: 'utf8', input: '[]\n' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /manual recovery/);
    function commandExe(root, id) { return activation.helperCommand(root, id).executable; }
});

test('update helper refuses unproven cleanup before preparing any replacement', () => {
    const { prepareActivation } = require('../server/pi-launcher-activation');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-activation-'));
    try {
        assert.throws(() => prepareActivation({ root, state: { version: 1, active: null }, shutdownProof: { complete: false } }), /cleanup/i);
        assert.equal(fs.existsSync(path.join(root, '.pivane-runtime')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('update helper never retries an interrupted replacement or restores committed data', async () => {
    const { recoverActivation } = require('../server/pi-launcher-activation');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-activation-'));
    fs.mkdirSync(path.join(root, '.pivane-runtime'));
    const id = randomUUID(), file = path.join(root, '.pivane-runtime/state.json');
    try {
        for (const phase of ['activating', 'rolling-back', 'committed']) {
            const state = JSON.stringify({ version: 1, active: null, activation: { root, id, phase, rollbackAttempts: 0 } });
            fs.writeFileSync(file, state);
            await assert.rejects(() => recoverActivation({ root, id, shutdownProof: { complete: true, generation: 'stopped' } }), error => /manual|committed/i.test(error.message) || error.code === 'DESKTOP_OWNER_PROTOCOL_REQUIRED');
            assert.equal(fs.readFileSync(file, 'utf8'), state);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
