const test = require('node:test');
const assert = require('node:assert/strict');
const { MaintenanceClient } = require('../server/pi-maintenance-client');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { ManagedLauncher } = require('../server/pi-managed-launcher');

test('a release without an actual pending job cannot unlock startup admission', () => {
    const client = new MaintenanceClient({ managed: true, nonce: 'private-channel', send: () => {} });
    client.receive({ nonce: 'private-channel', type: 'maintenance-release' });
    assert.equal(client.locked, true);
});

test('validation admits only update diagnostics and a stale release cannot open business', () => {
    const client = new MaintenanceClient({ managed: true, nonce: 'private-channel', send: () => {} });
    client.receive({ nonce: 'private-channel', type: 'maintenance-status', status: { supported: true, activation: { id: 'pending', phase: 'validating' }, job: { id: 'job' } } });
    for (const [method, route, allowed] of [['GET', 'maintenance', true], ['GET', '', true], ['GET', 'notifications', false], ['POST', 'notifications', false], ['POST', 'automatic', false]]) {
        let passed = false, status;
        const res = { status(value) { status = value; return this; }, json() {} };
        client.http({ method, originalUrl: '/api/pi/settings/updates' + (route ? '/' + route : '') }, res, () => { passed = true; });
        assert.equal(passed, allowed, `${method} ${route}`);
        if (!allowed) assert.equal(status, 503);
    }
    client.receive({ nonce: 'private-channel', type: 'maintenance-release', id: 'job' });
    client.receive({ nonce: 'private-channel', type: 'maintenance-activate' });
    assert.equal(client.locked, true, 'validation requires the matching persisted commit');
    client.receive({ nonce: 'private-channel', type: 'maintenance-status', status: { supported: true, activation: { id: 'pending', phase: 'committed' } } });
    client.receive({ nonce: 'private-channel', type: 'maintenance-activate', activationId: 'pending' });
    assert.equal(client.locked, false);
});

test('interrupted candidate startup retains recovery ownership instead of booting old code over changed data', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-interrupted-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.pivane-runtime'));
    fs.writeFileSync(path.join(root, '.pivane-runtime/state.json'), JSON.stringify({ version: 1, active: null, previous: null, job: { id: 'candidate', phase: 'starting', backup: { directory: 'stopped-backup' } } }));
    let spawned = false;
    const launcher = new ManagedLauncher({ root, forkServer: () => { spawned = true; throw Error('Unapproved old service start'); } });
    t.after(() => launcher.close().catch(() => {}));
    await assert.rejects(launcher.start(), /recovery/i);
    assert.equal(spawned, false);
    await launcher.close();
});

test('reopened desktop retains the original pinned identity when the helper clears inherited environment', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-pinned-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.pivane-runtime'));
    const identity = path.join(root, 'original-external-identity'), projects = path.join(root, 'restricted-projects'), sessions = path.join(root, 'original-sessions');
    fs.writeFileSync(path.join(root, '.pivane-runtime/state.json'), JSON.stringify({ version: 1, active: null,
        runtimePaths: { PI_CODING_AGENT_DIR: identity, PI_PROJECT_ROOTS: projects, PI_CODING_AGENT_SESSION_DIR: sessions } }));
    const env = require('../server/pivane-desktop-launcher').desktopEnvironment(root, {});
    assert.equal(env.PI_CODING_AGENT_DIR, identity);
    assert.equal(env.PI_PROJECT_ROOTS, projects, 'clearing inherited environment must not expand project access to every drive');
    assert.equal(env.PI_CODING_AGENT_SESSION_DIR, sessions);
});

test('an interrupted candidate validation is not replayed by opening the original shortcut again', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-validation-owner-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.pivane-runtime'));
    fs.writeFileSync(path.join(root, '.pivane-runtime/state.json'), JSON.stringify({ version: 1, active: null, previous: null,
        activation: { id: 'candidate', root, phase: 'validating', validationOwner: 'previous-runner' } }));
    let spawned = false;
    const launcher = new ManagedLauncher({ root, forkServer: () => { spawned = true; throw Error('Candidate validation replayed'); } });
    t.after(() => launcher.close().catch(() => {}));
    await assert.rejects(launcher.start(), /interrupted.*validation|validation.*recovery/i);
    assert.equal(spawned, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.pivane-runtime/state.json'))).needsRecovery, true);
});
