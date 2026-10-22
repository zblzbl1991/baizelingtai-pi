const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { ManagedLauncher } = require('../server/pi-managed-launcher');
const { privateDir, atomicJson } = require('../server/pi-maintenance-files');
function fixture(t, initial = {}) {
    const root = privateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-owner-')));
    privateDir(path.join(root, '.pivane-runtime'));
    const file = path.join(root, '.pivane-runtime/state.json');
    atomicJson(file, { version: 1, active: null, previous: null, ...initial });
    t.after(async () => { await manager.guard?.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
    const children = [];
    const manager = new ManagedLauncher({ root, requireShutdownProof: true,
        env: { PIVANE_RETAIN_RELEASES: 'off', PIVANE_RETAIN_BACKUPS: 'off' }, forkServer(_file, _args, options) {
            const child = new EventEmitter(); child.connected = true; child.exitCode = null; child.signalCode = null;
            child.ownerAtFork = JSON.parse(fs.readFileSync(file));
            child.nonce = options.env.PI_MANAGED_LAUNCHER;
            child.autoStop = true;
            child.send = message => { child.sent.push(message); if (message.type === 'maintenance-shutdown' && child.autoStop) queueMicrotask(() => {
                child.emit('message', { nonce: child.nonce, type: 'maintenance-shutdown-complete' }); child.exitCode = 0; child.emit('exit', 0);
            }); }; child.sent = [];
            children.push(child);
            queueMicrotask(() => child.emit('message', { nonce: child.nonce, type: 'maintenance-ready', capabilities: { shutdownProof: true } }));
            return child;
        } });
    const read = () => JSON.parse(fs.readFileSync(file));
    const finish = child => { child.emit('message', { nonce: child.nonce, type: 'maintenance-shutdown-complete' }); child.exitCode = 0; child.emit('exit', 0); };
    return { root, file, manager, children, read, finish };
}
test('new desktop runner refuses a durable prior service owner without forking or changing current data', async t => {
    const input = fixture(t);
    const state = input.read(); state.desktopOwnerProtocol = 1; state.desktopOwner = { version: 1, root: input.root,
        runnerGeneration: randomUUID(), serviceGeneration: randomUUID(), releaseId: null };
    atomicJson(input.file, state); const before = fs.readFileSync(input.file, 'utf8');
    try { await assert.rejects(input.manager.start(), { code: 'DESKTOP_OWNER_UNPROVEN' }); assert.equal(input.children.length, 0); assert.equal(fs.readFileSync(input.file, 'utf8'), before); }
    finally { await input.manager.close().catch(() => {}); }
});
test('failed durable registration never forks a desktop service', async t => {
    const input = fixture(t), original = fs.fsyncSync;
    fs.fsyncSync = () => { throw Error('synthetic durable write failure'); };
    try { await assert.rejects(input.manager.start(), /durable write failure/); assert.equal(input.children.length, 0); }
    finally { fs.fsyncSync = original; await input.manager.close().catch(() => {}); }
});
test('missing or late cleanup proof preserves the owner after actual exit', async t => {
    const input = fixture(t); await input.manager.start(); const child = input.children[0]; child.autoStop = false;
    const owner = input.read().desktopOwner, closing = input.manager.close();
    child.exitCode = 0; child.emit('exit', 0);
    await assert.rejects(closing, { code: 'DESKTOP_CLEANUP_UNKNOWN' });
    child.emit('message', { nonce: child.nonce, type: 'maintenance-shutdown-complete' });
    assert.deepEqual(input.read().desktopOwner, owner);
});
test('nonzero service exit with an ack cannot clear owner or authorize restart', async t => {
    const input = fixture(t); await input.manager.start(); const child = input.children[0]; child.autoStop = false;
    const owner = input.read().desktopOwner, closing = input.manager.close();
    child.emit('message', { nonce: child.nonce, type: 'maintenance-shutdown-complete' }); child.exitCode = 1; child.emit('exit', 1);
    await assert.rejects(closing, { code: 'DESKTOP_CLEANUP_UNKNOWN' }); assert.deepEqual(input.read().desktopOwner, owner);
    await assert.rejects(input.manager.start()); assert.equal(input.children.length, 1);
});
test('failure persisting cleanup keeps the durable owner after ack and actual exit', async t => {
    const input = fixture(t); await input.manager.start(); const owner = input.read().desktopOwner, original = fs.fsyncSync;
    fs.fsyncSync = () => { throw Error('synthetic cleanup write failure'); };
    try { await assert.rejects(input.manager.close(), /cleanup write failure/); assert.deepEqual(input.read().desktopOwner, owner); }
    finally { fs.fsyncSync = original; }
});
test('same-runner restart uses a new service generation and ignores an old child ack', async t => {
    const input = fixture(t);
    privateDir(path.join(input.root, 'node_modules/@earendil-works/pi-coding-agent'));
    fs.writeFileSync(path.join(input.root, 'node_modules/@earendil-works/pi-coding-agent/package.json'), '{"version":"1.2.0"}');
    await input.manager.start(); const oldChild = input.children[0], oldOwner = input.read().desktopOwner;
    try {
        await input.manager.execute({ action: 'restart', id: randomUUID() });
        assert.equal(input.children.length, 2); const next = input.read().desktopOwner;
        assert.notEqual(next.serviceGeneration, oldOwner.serviceGeneration); assert.equal(next.runnerGeneration, oldOwner.runnerGeneration);
        oldChild.emit('message', { nonce: oldChild.nonce, type: 'maintenance-shutdown-complete' });
        assert.deepEqual(input.read().desktopOwner, next);
        assert.equal(JSON.stringify(input.manager.status()).includes(next.runnerGeneration), false);
    } finally { await input.manager.close(); }
});
test('desktop registers each service generation durably before fork and clears only after clean exit', async t => {
    const input = fixture(t);
    try {
        await input.manager.start();
        const state = input.children[0].ownerAtFork;
        assert.equal(state.desktopOwnerProtocol, 1); assert.equal(state.desktopOwner.root, input.root);
        assert.equal(state.desktopOwner.runnerGeneration, input.manager.nonce);
        assert.match(state.desktopOwner.serviceGeneration, /^[a-f0-9-]{36}$/);
        await input.manager.close(); assert.equal(input.read().desktopOwner, null);
    } finally { await input.manager.close().catch(() => {}); }
});
test('independent helper, repair and restore reject unknown service ownership before reading payloads', async t => {
    const input = fixture(t), state = input.read();
    state.desktopOwnerProtocol = 1; state.desktopOwner = { version: 1, root: input.root, runnerGeneration: randomUUID(), serviceGeneration: randomUUID(), releaseId: null };
    atomicJson(input.file, state); const before = fs.readFileSync(input.file, 'utf8');
    const activation = require('../server/pi-launcher-activation'), id = randomUUID();
    await assert.rejects(activation.applyActivation(input.root, id), { code: 'DESKTOP_OWNER_UNPROVEN' });
    await assert.rejects(activation.recoverActivation({ root: input.root, id, shutdownProof: { complete: true, generation: randomUUID() } }), { code: 'DESKTOP_OWNER_UNPROVEN' });
    const diagnosis = await require('../server/pi-launcher-repair').diagnoseInstallation(input.root);
    assert.equal(diagnosis.code, 'DESKTOP_OWNER_UNPROVEN'); assert.equal(diagnosis.canRepair, false);
    await assert.rejects(require('../server/pi-launcher-repair').restoreEntry(input.root, id, { replaceChanged: true }), { code: 'DESKTOP_OWNER_UNPROVEN' });
    await assert.rejects(require('../server/pi-maintenance-restore').restoreBackup(input.root, id), { code: 'DESKTOP_OWNER_UNPROVEN' });
    assert.equal(fs.readFileSync(input.file, 'utf8'), before);
});
test('whole-package preparation refuses a baseline without durable-owner capability before signature or inventory work', t => {
    const input = fixture(t), id = randomUUID();
    privateDir(path.join(input.root, '.pivane-runtime/releases', id));
    assert.throws(() => require('../server/pi-launcher-activation').prepareActivation({ root: input.root, state: input.read(), releaseId: id,
        release: {}, backupId: randomUUID(), shutdownProof: { complete: true, generation: randomUUID() } }), { code: 'DESKTOP_OWNER_PROTOCOL_REQUIRED' });
});
test('controlled desktop preserves a foreign validating owner and reports refusal without cleanup success or rollback', async t => {
    const input = fixture(t), state = input.read(), events = [];
    let observedManager;
    t.after(async () => { await observedManager?.guard?.close().catch(() => {}); });
    state.activation = { id: randomUUID(), phase: 'validating' }; state.desktopOwnerProtocol = 1;
    state.desktopOwner = { version: 1, root: input.root, runnerGeneration: randomUUID(), serviceGeneration: randomUUID(), releaseId: null };
    atomicJson(input.file, state); const before = fs.readFileSync(input.file, 'utf8'); let forks = 0;
    await assert.rejects(require('../server/pivane-desktop-launcher').startDesktop({ root: input.root, programRoot: input.root,
        controlled: true, generation: randomUUID(), input: new EventEmitter(), emit: event => events.push(event), log: () => {},
        environment: { PI_CODING_AGENT_DIR: input.root, PI_MEDIA_DATA_DIR: input.root },
        Manager: class extends ManagedLauncher { constructor(options) { super(options); observedManager = this; } },
        Network: class { applyEnvironment() {} }, forkServer() { forks++; throw Error('must not fork'); } }), { code: 'DESKTOP_OWNER_UNPROVEN' });
    assert.equal(forks, 0); assert.equal(fs.readFileSync(input.file, 'utf8'), before);
    assert.ok(events.some(event => event.type === 'error' && event.code === 'DESKTOP_OWNER_UNPROVEN'));
    assert.equal(events.some(event => event.clean === true), false);
});
test('dangling state aliases cannot be treated as a missing legacy state', async t => {
    const input = fixture(t); fs.unlinkSync(input.file);
    try { fs.symlinkSync(path.join(input.root, 'missing-state'), input.file, 'file'); }
    catch (error) { if (error.code === 'EPERM') { t.skip('Host does not permit file symlinks'); return; } throw error; }
    try { await assert.rejects(input.manager.start()); assert.equal(input.children.length, 0); }
    finally { await input.manager.close().catch(() => {}); }
});
test('whole-package capability must match both versions and its bounded manifest entry', t => {
    const input = fixture(t), id = randomUUID(), candidate = privateDir(path.join(input.root, '.pivane-runtime/releases', id));
    const writeCapability = (root, protocol) => {
        fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.8.0"}');
        const bytes = Buffer.from(JSON.stringify({ version: 1, platform: 'win32', arch: 'x64', launcherUpdateProtocol: 1, desktopOwnerProtocol: protocol }));
        fs.writeFileSync(path.join(root, 'baizelingtai-portable.json'), bytes);
        atomicJson(path.join(root, 'PORTABLE_MANIFEST.json'), { version: 1, appVersion: '1.8.0', platform: 'win32', arch: 'x64',
            files: [{ path: 'baizelingtai-portable.json', bytes: bytes.length, sha256: require('../server/pi-maintenance-files').hash(bytes) }] });
    };
    writeCapability(input.root, 1); writeCapability(candidate, 0);
    const prepare = () => require('../server/pi-launcher-activation').prepareActivation({ root: input.root, state: input.read(), releaseId: id,
        release: {}, backupId: randomUUID(), shutdownProof: { complete: true, generation: randomUUID() } });
    assert.throws(prepare, { code: 'DESKTOP_OWNER_PROTOCOL_REQUIRED' });
    writeCapability(candidate, 1); assert.throws(prepare, /Invalid signed update payload/);
    fs.appendFileSync(path.join(input.root, 'baizelingtai-portable.json'), ' ');
    assert.throws(prepare, { code: 'DESKTOP_OWNER_PROTOCOL_REQUIRED' });
});
test('offline trust mutation reports unknown service ownership before reading a rotation', t => {
    const input = fixture(t), state = input.read(); state.desktopOwnerProtocol = 1;
    state.desktopOwner = { version: 1, root: input.root, runnerGeneration: randomUUID(), serviceGeneration: randomUUID(), releaseId: null };
    atomicJson(input.file, state); const before = fs.readFileSync(input.file, 'utf8');
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/update-signing.cjs'), 'rotation-apply', '--installation-root', input.root,
        '--rotation', path.join(input.root, 'does-not-exist.json')], { encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot } });
    assert.equal(result.status, 1); assert.match(result.stderr, /桌面服务清理未获证明/);
    assert.equal(fs.readFileSync(input.file, 'utf8'), before);
});
test('a duplicate start cannot acquire a second service generation', async t => {
    const input = fixture(t); await input.manager.start(); const before = input.read().desktopOwner;
    try { await assert.rejects(input.manager.start(), { code: 'DESKTOP_OWNER_UNPROVEN' }); assert.equal(input.children.length, 1); assert.deepEqual(input.read().desktopOwner, before); }
    finally { await input.manager.close(); }
});
test('partial, unknown or foreign durable-owner records fail closed without rewriting state', async t => {
    for (const value of [{ desktopOwnerProtocol: 1 }, { desktopOwner: null }, { desktopOwnerProtocol: 2, desktopOwner: null },
        { desktopOwnerProtocol: 1, desktopOwner: {} }, { desktopOwnerProtocol: 1, desktopOwner: { version: 1, root: 'foreign',
            runnerGeneration: randomUUID(), serviceGeneration: randomUUID(), releaseId: null } }]) {
        const input = fixture(t, value), before = fs.readFileSync(input.file, 'utf8');
        try { await assert.rejects(input.manager.start(), { code: 'DESKTOP_OWNER_UNPROVEN' }); assert.equal(input.children.length, 0); assert.equal(fs.readFileSync(input.file, 'utf8'), before); }
        finally { await input.manager.close(); }
    }
});
test('a genuinely absent state remains compatible and registers before the first desktop fork', async t => {
    const input = fixture(t); fs.unlinkSync(input.file);
    try { await input.manager.start(); assert.equal(input.children[0].ownerAtFork.desktopOwnerProtocol, 1); }
    finally { await input.manager.close(); }
});
test('offline trust mutation rejects a runtime ancestor alias even when no state exists', t => {
    const input = fixture(t); fs.unlinkSync(input.file);
    const directory = path.dirname(input.file), actual = path.join(input.root, 'runtime-elsewhere'); fs.renameSync(directory, actual);
    fs.symlinkSync(actual, directory, process.platform === 'win32' ? 'junction' : 'dir');
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/update-signing.cjs'), 'rotation-apply', '--installation-root', input.root,
        '--rotation', path.join(input.root, 'does-not-exist.json')], { encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot } });
    assert.equal(result.status, 1); assert.match(result.stderr, /桌面服务清理未获证明/); assert.equal(fs.existsSync(input.file), false);
});
test('offline session relocation refuses an unknown owner before creating migration evidence', async t => {
    const input = fixture(t), state = input.read(), api = require('../server/pi-session-relocation');
    state.desktopOwnerProtocol = 1; state.desktopOwner = { version: 1, root: input.root, runnerGeneration: randomUUID(), serviceGeneration: randomUUID(), releaseId: null };
    atomicJson(input.file, state);
    const agentDir = privateDir(path.join(input.root, 'agent')), sourceCwd = path.join(input.root, 'source'), targetCwd = path.join(input.root, 'target');
    privateDir(api.sessionDirectory(agentDir, sourceCwd)); const evidenceDir = path.join(input.root, 'evidence');
    await assert.rejects(api.relocateProjectSessions({ installation: input.root, agentDir, sourceCwd, targetCwd, evidenceDir, externalWritersStopped: true }), { code: 'DESKTOP_OWNER_UNPROVEN' });
    assert.equal(fs.existsSync(evidenceDir), false);
});
test('reopening a committed installation with an old owner preserves the latest data and state', async t => {
    const input = fixture(t, { activation: { phase: 'committed', id: randomUUID(), committedAt: '2026-10-20T00:00:00Z' }, job: { phase: 'starting' } });
    const state = input.read(); state.desktopOwnerProtocol = 1;
    state.desktopOwner = { version: 1, root: input.root, runnerGeneration: randomUUID(), serviceGeneration: randomUUID(), releaseId: null };
    atomicJson(input.file, state); const before = fs.readFileSync(input.file, 'utf8'), data = path.join(input.root, 'latest-data.txt'); fs.writeFileSync(data, 'committed latest data');
    try {
        await assert.rejects(input.manager.start(), { code: 'DESKTOP_OWNER_UNPROVEN' });
        assert.equal(input.children.length, 0); assert.equal(fs.readFileSync(input.file, 'utf8'), before); assert.equal(fs.readFileSync(data, 'utf8'), 'committed latest data');
    } finally { await input.manager.close(); }
});
test('a previously existing runtime ancestor disappearing during validation cannot downgrade to legacy absence', async t => {
    const input = fixture(t); fs.unlinkSync(input.file); const original = fs.realpathSync.native;
    fs.realpathSync.native = function (file, ...args) {
        if (file === path.dirname(input.file)) throw Object.assign(Error('synthetic ancestor disappeared'), { code: 'ENOENT' });
        return original(file, ...args);
    };
    try { await assert.rejects(require('../server/pi-maintenance-restore').restoreBackup(input.root, randomUUID()), { code: 'DESKTOP_OWNER_UNPROVEN' }); }
    finally { fs.realpathSync.native = original; }
});
test('an unknown installation state version cannot authorize an offline writer as unmarked legacy', async t => {
    const input = fixture(t, { version: 2 });
    await assert.rejects(require('../server/pi-maintenance-restore').restoreBackup(input.root, randomUUID()), { code: 'DESKTOP_OWNER_UNPROVEN' });
});
