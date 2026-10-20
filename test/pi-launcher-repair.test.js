const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const cli = path.resolve(__dirname, '../scripts/repair-launcher.cjs');
const { transactionFixture } = require('./launcher-activation-fixture.cjs');

test('independent repair entry diagnoses unknown owner and incomplete mutations without changing installation state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-repair-'));
    fs.mkdirSync(path.join(root, '.pivane-runtime'));
    const file = path.join(root, '.pivane-runtime/state.json'), id = randomUUID();
    try {
        for (const record of [{ phase: 'validating', validationOwner: 'lost-owner' }, { phase: 'rolling-back' }, { phase: 'activating' }]) {
            const state = JSON.stringify({ version: 1, active: null, activation: { id, root, ...record } });
            fs.writeFileSync(file, state);
            const result = spawnSync(process.execPath, [cli, 'diagnose', root], { encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
            const diagnosis = JSON.parse(result.stdout);
            assert.equal(diagnosis.canRepair, false);
            assert.equal(diagnosis.status, 'manual-recovery');
            assert.equal(fs.readFileSync(file, 'utf8'), state);
            const attempt = spawnSync(process.execPath, [cli, 'restore-entry', root, id], { encoding: 'utf8' });
            assert.equal(attempt.status, 1);
            assert.equal(fs.readFileSync(file, 'utf8'), state);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('committed entry repair restores only the signed current entry and preserves latest data', t => {
    const input = transactionFixture(t);
    const { prepareActivation } = require('../server/pi-launcher-activation');
    const { atomicJson } = require('../server/pi-maintenance-files');
    input.state.activation = prepareActivation(input);
    const id = input.state.activation.id;
    input.state.activation.phase = 'committed'; input.state.activation.validationOwner = 'historical-committed-owner';
    input.state.active = input.releaseId;
    atomicJson(path.join(input.root, '.pivane-runtime/state.json'), input.state);
    fs.writeFileSync(path.join(input.root, 'data/value.txt'), 'latest business data');
    fs.unlinkSync(path.join(input.root, '白泽灵台.exe'));
    const diagnosis = spawnSync(process.execPath, [cli, 'diagnose', input.root], { encoding: 'utf8' });
    assert.equal(JSON.parse(diagnosis.stdout).canRepair, true, diagnosis.stderr);
    const repaired = spawnSync(process.execPath, [cli, 'restore-entry', input.root, id], { encoding: 'utf8' });
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(JSON.parse(repaired.stdout).restored, true);
    assert.equal(fs.readFileSync(path.join(input.root, '白泽灵台.exe'), 'utf8'), 'new fixed entry');
    assert.equal(fs.readFileSync(path.join(input.root, 'data/value.txt'), 'utf8'), 'latest business data');
    const state = JSON.parse(fs.readFileSync(path.join(input.root, '.pivane-runtime/state.json')));
    assert.equal(state.active, input.releaseId);
    assert.equal(state.activation.phase, 'committed');
    const duplicate = spawnSync(process.execPath, [cli, 'restore-entry', input.root, id], { encoding: 'utf8' });
    assert.equal(JSON.parse(duplicate.stdout).alreadyHealthy, true);
});

test('legacy migration plan names exact data and backup scope but never treats a vanished process as cleanup proof', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-legacy-'));
    const releaseId = randomUUID(), candidate = path.join(root, '.pivane-runtime/releases', releaseId);
    try {
        fs.mkdirSync(candidate, { recursive: true });
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pivane', version: '1.7.3' }));
        fs.writeFileSync(path.join(candidate, 'package.json'), JSON.stringify({ name: 'pivane', version: '1.8.0' }));
        fs.writeFileSync(path.join(root, '.pivane-runtime/state.json'), JSON.stringify({ version: 1, active: releaseId, job: { phase: 'succeeded', exitCode: 0, pid: null } }));
        const scope = { schemaVersion: 1, runtimePaths: { PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_MEDIA_DATA_DIR: path.join(root, 'media'), PI_MEDIA_CONFIG_DIR: path.join(root, 'config-data'), PI_WEB_DEFERRED_FILE: path.join(root, 'deferred.json') },
            backupRoots: [root], backupDirectory: root + '-offline-backup' };
        fs.mkdirSync(scope.runtimePaths.PI_CODING_AGENT_DIR);
        const session = path.join(scope.runtimePaths.PI_CODING_AGENT_DIR, 'session.jsonl');
        const original = '{"type":"session","id":"preserved-id","timestamp":"2026-10-20T00:00:00Z"}\n';
        fs.writeFileSync(session, original);
        const scopeFile = path.join(root, 'scope.json'); fs.writeFileSync(scopeFile, JSON.stringify(scope));
        const planned = spawnSync(process.execPath, [cli, 'legacy-plan', root, '--scope', scopeFile], { encoding: 'utf8' });
        assert.equal(planned.status, 0, planned.stderr);
        const plan = JSON.parse(planned.stdout);
        assert.equal(plan.outerVersion, '1.7.3'); assert.equal(plan.serviceVersion, '1.8.0');
        assert.equal(plan.canMigrateAutomatically, false);
        assert.equal(plan.blocker, 'LEGACY_CLEANUP_UNPROVEN');
        assert.deepEqual(plan.runtimePaths, scope.runtimePaths);
        assert.equal(plan.backup.required, true);
        assert.ok(plan.changes.some(change => change.path.endsWith('白泽灵台.exe')));
        const rejected = spawnSync(process.execPath, [cli, 'migrate-legacy', root, '--scope', scopeFile, '--assume-stopped'], { encoding: 'utf8' });
        assert.equal(rejected.status, 1);
        assert.match(rejected.stderr, /LEGACY_CLEANUP_UNPROVEN/);
        assert.equal(fs.readFileSync(session, 'utf8'), original);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('copied repair dependency closure operates without the main EXE or application Node dependencies', t => {
    const input = transactionFixture(t), { prepareActivation } = require('../server/pi-launcher-activation');
    const { repairFiles } = require('../server/pi-launcher-repair');
    const { atomicJson } = require('../server/pi-maintenance-files');
    input.state.activation = prepareActivation(input); input.state.activation.phase = 'committed'; input.state.active = input.releaseId;
    atomicJson(path.join(input.root, '.pivane-runtime/state.json'), input.state);
    fs.unlinkSync(path.join(input.root, '白泽灵台.exe'));
    const toolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-repair-closure-'));
    t.after(() => fs.rmSync(toolRoot, { recursive: true, force: true }));
    for (const name of repairFiles(path.resolve(__dirname, '..'))) {
        fs.mkdirSync(path.dirname(path.join(toolRoot, name)), { recursive: true });
        fs.copyFileSync(path.resolve(__dirname, '..', name), path.join(toolRoot, name));
    }
    fs.mkdirSync(path.join(toolRoot, 'runtime')); fs.copyFileSync(fs.realpathSync.native(process.execPath), path.join(toolRoot, 'runtime/node.exe'));
    const result = spawnSync(path.join(toolRoot, 'runtime/node.exe'), [path.join(toolRoot, 'scripts/repair-launcher.cjs'), 'restore-entry', input.root, input.state.activation.id], {
        cwd: toolRoot, encoding: 'utf8', windowsHide: true, env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).restored, true);
    assert.equal(fs.readFileSync(path.join(input.root, 'data/value.txt'), 'utf8'), 'before update');
});

test('changed existing entry requires explicit replacement, preserves the original and never repeats after new damage', t => {
    const input = transactionFixture(t), { prepareActivation } = require('../server/pi-launcher-activation');
    const { atomicJson } = require('../server/pi-maintenance-files');
    input.state.activation = prepareActivation(input); input.state.activation.phase = 'committed'; input.state.active = input.releaseId;
    const id = input.state.activation.id, stateFile = path.join(input.root, '.pivane-runtime/state.json');
    atomicJson(stateFile, input.state);
    const before = fs.readFileSync(stateFile, 'utf8');
    const denied = spawnSync(process.execPath, [cli, 'restore-entry', input.root, id], { encoding: 'utf8' });
    assert.equal(denied.status, 1); assert.match(denied.stderr, /replace-changed/);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
    const repaired = spawnSync(process.execPath, [cli, 'restore-entry', input.root, id, '--replace-changed'], { encoding: 'utf8' });
    assert.equal(repaired.status, 0, repaired.stderr);
    const repair = JSON.parse(repaired.stdout);
    const retained = path.join(input.root, '.pivane-runtime/activation', id, 'entry-repair', repair.repairId, 'previous-entry.exe');
    assert.equal(fs.readFileSync(retained, 'utf8'), 'old fixed entry');
    fs.unlinkSync(path.join(input.root, '白泽灵台.exe'));
    const repeated = spawnSync(process.execPath, [cli, 'restore-entry', input.root, id], { encoding: 'utf8' });
    assert.equal(repeated.status, 1); assert.match(repeated.stderr, /already attempted/);
});

test('repair refuses incomplete fresh-candidate cleanup, installation ownership and tampered signed source', async t => {
    const input = transactionFixture(t), { prepareActivation } = require('../server/pi-launcher-activation');
    const { atomicJson } = require('../server/pi-maintenance-files');
    input.state.activation = prepareActivation(input); input.state.activation.phase = 'validating'; input.state.active = input.releaseId;
    const file = path.join(input.root, '.pivane-runtime/state.json'), id = input.state.activation.id;
    atomicJson(file, input.state); fs.unlinkSync(path.join(input.root, '白泽灵台.exe'));
    const incomplete = spawnSync(process.execPath, [cli, 'restore-entry', input.root, id], { encoding: 'utf8' });
    assert.equal(incomplete.status, 1); assert.match(incomplete.stderr, /cleanup|proof/);
    input.state.activation.phase = 'committed'; atomicJson(file, input.state);
    const before = fs.readFileSync(file, 'utf8'), owner = await require('../server/pi-installation-lock').acquireInstallationLock(input.root);
    try {
        const busy = spawnSync(process.execPath, [cli, 'diagnose', input.root], { encoding: 'utf8' });
        assert.equal(JSON.parse(busy.stdout).status, 'installation-owned');
        assert.equal(fs.readFileSync(file, 'utf8'), before);
    } finally { await owner.close(); }
    fs.writeFileSync(path.join(input.candidate, '白泽灵台.exe'), 'tampered candidate');
    const tampered = spawnSync(process.execPath, [cli, 'restore-entry', input.root, id], { encoding: 'utf8' });
    assert.equal(tampered.status, 1); assert.match(tampered.stderr, /inventory|hash|changed/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('Windows occupied entry leaves unknown repair outcome and is not replayed after the file is released', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
    const input = transactionFixture(t), { prepareActivation } = require('../server/pi-launcher-activation');
    const { atomicJson } = require('../server/pi-maintenance-files');
    input.state.activation = prepareActivation(input); input.state.activation.phase = 'committed'; input.state.active = input.releaseId;
    const id = input.state.activation.id, file = path.join(input.root, '.pivane-runtime/state.json'), target = path.join(input.root, '白泽灵台.exe');
    atomicJson(file, input.state);
    const script = "$stream=[IO.File]::Open($env:REPAIR_ENTRY,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { [Console]::WriteLine('ready'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $stream.Dispose() }";
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: process.env.SystemRoot, REPAIR_ENTRY: target }
    });
    const closed = once(holder, 'close'); let output = '';
    holder.stdout.on('data', bytes => output += bytes); holder.stderr.on('data', bytes => output += bytes);
    t.after(async () => { holder.stdin.end(); await closed; });
    const until = Date.now() + 10000;
    while (!output.includes('ready')) { if (Date.now() > until || holder.exitCode !== null) assert.fail(output); await new Promise(resolve => setTimeout(resolve, 20)); }
    const failed = spawnSync(process.execPath, [cli, 'restore-entry', input.root, id, '--replace-changed'], { encoding: 'utf8' });
    assert.equal(failed.status, 1); assert.match(failed.stderr, /replacement failed|replace/i);
    assert.equal(JSON.parse(fs.readFileSync(file)).activation.entryRepair.phase, 'replacing');
    assert.equal(fs.readFileSync(target, 'utf8'), 'old fixed entry');
    holder.stdin.end(); await closed;
    const repeated = spawnSync(process.execPath, [cli, 'restore-entry', input.root, id, '--replace-changed'], { encoding: 'utf8' });
    assert.equal(repeated.status, 1); assert.match(repeated.stderr, /Unknown owner|incomplete mutation/);
});
