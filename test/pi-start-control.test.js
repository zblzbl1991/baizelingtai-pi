const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { openStartControl, replaceManaged } = require('../server/pi-start-control');
const { acquireInstallationLock } = require('../server/pi-installation-lock');
const { DesktopStop } = require('../server/pivane-desktop-stop');
const { MaintenanceClient } = require('../server/pi-maintenance-client');
const { assertPrivateFile } = require('./private-file-helper.cjs');
const cleanups = new Map();
const cleanup = (root, action) => cleanups.get(root).push(action);

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-start-')));
    cleanups.set(root, []);
    t.after(async () => {
        for (const action of cleanups.get(root).reverse()) await action();
        cleanups.delete(root);
        fs.rmSync(root, { recursive: true, force: true });
    });
    return root;
}
function start(t, root, mode = 'foreground') {
    const child = spawn(process.execPath, [path.join(__dirname, 'start-managed-fixture.cjs'), root, mode], {
        windowsHide: true, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_MEDIA_DATA_DIR: path.join(root, 'media') },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    cleanup(root, async () => {
        if (child.exitCode === null && child.signalCode === null) child.stdin.end('stop\n');
        await closed;
    });
    return { child, closed, output: () => stdout + stderr, async ready() {
        const deadline = Date.now() + 10000;
        while (!stdout.includes('ENTRY_READY')) {
            if (child.exitCode !== null || Date.now() >= deadline) throw Error(stdout + stderr || 'startup timeout');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    } };
}
function application(root, { busy = false, fail = false, unexpected = false, startupDelay = 0 } = {}) {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    const stopModule = require.resolve('../server/pivane-desktop-stop');
    const source = `
        const fs = require('node:fs');
        ${startupDelay ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${startupDelay});` : ''}
        const maintenance = { managed: true, nonce: process.env.PI_MANAGED_LAUNCHER, activityRevision: 0, activeMutations: 0 };
        const { DesktopStop, receiveDesktopRequest } = require(${JSON.stringify(stopModule)});
        const stop = new DesktopStop({ maintenance, sources: [{ type: 'fixture', label: 'fixture', read: () => ${busy ? 1 : 0} }] });
        let pending = false;
        process.on('message', message => {
            if (receiveDesktopRequest({ message, maintenance, stop, send: reply => process.send(reply) })) return;
            if (message.type !== 'maintenance-shutdown' || pending) return;
            pending = true;
            fs.appendFileSync('events', 'cleaning\\n');
            setTimeout(() => {
                fs.appendFileSync('events', 'disposed\\n');
                ${fail ? 'process.exit(1);' : "process.send({ type: 'maintenance-shutdown-complete', nonce: maintenance.nonce }, () => process.exit(0));"}
            }, 40);
        });
        fs.appendFileSync('events', 'boot\\n');
        ${startupDelay ? "console.log('baizelingtai backend running at http://localhost:synthetic');" : ''}
        process.send({ type: 'maintenance-ready', nonce: maintenance.nonce, appVersion: '1.0.0', capabilities: { shutdownProof: true } });
        ${unexpected ? "setTimeout(() => process.exit(1), 200);" : ''}
    `;
    fs.writeFileSync(path.join(root, 'server.js'), source);
}

test('foreground cold startup does not expire at the obsolete 45-second readiness budget', { timeout: 15000 }, async t => {
    const root = fixture(t); application(root, { startupDelay: 1200 });
    const run = start(t, root, 'slow-start');
    await run.ready();
    assert.doesNotMatch(run.output(), /startup timed out/);
    assert.equal(await replaceManaged(root), true);
    assert.equal((await run.closed).code, 0);
});

test('an actual startup timeout still waits for proven cleanup and publishes no replacement endpoint', { timeout: 15000 }, async t => {
    const root = fixture(t); application(root, { startupDelay: 200 });
    const run = start(t, root, 'short-budget');
    assert.equal((await run.closed).code, 1);
    assert.match(run.output(), /Service startup timed out/);
    assert.equal(fs.existsSync(path.join(root, '.pivane-runtime/start-control.json')), false);
    assert.equal(fs.readFileSync(path.join(root, 'events'), 'utf8'), 'boot\ncleaning\ndisposed\n');
    const lock = await acquireInstallationLock(root); await lock.close();
});

test('foreground entry replaces the old launcher only after proven child cleanup and releases the lock', { timeout: 20000 }, async t => {
    const root = fixture(t); application(root);
    const old = start(t, root); await old.ready();
    const record = path.join(root, '.pivane-runtime/start-control.json');
    assertPrivateFile(record);
    const firstToken = JSON.parse(fs.readFileSync(record)).token;
    const next = start(t, root); await next.ready();
    assert.deepEqual(await old.closed, { code: 0, signal: null });
    assert.notEqual(JSON.parse(fs.readFileSync(record)).token, firstToken);
    assert.equal(fs.readFileSync(path.join(root, 'events'), 'utf8'), 'boot\ncleaning\ndisposed\nboot\n');
    assert.equal(await replaceManaged(root), true);
    assert.deepEqual(await next.closed, { code: 0, signal: null });
    assert.equal(fs.existsSync(record), false);
    const lock = await acquireInstallationLock(root); await lock.close();
});

test('busy foreground instance survives replacement requests without a second boot', { timeout: 20000 }, async t => {
    const root = fixture(t); application(root, { busy: true });
    const old = start(t, root); await old.ready();
    const next = start(t, root);
    assert.equal((await next.closed).code, 1);
    assert.match(next.output(), /仍有任务/);
    await assert.rejects(replaceManaged(root), /仍有任务/);
    assert.equal(old.child.exitCode, null);
    assert.equal(fs.readFileSync(path.join(root, 'events'), 'utf8'), 'boot\n');
});

test('failed cleanup never authorizes a second boot', { timeout: 20000 }, async t => {
    const root = fixture(t); application(root, { fail: true });
    const old = start(t, root); await old.ready();
    const next = start(t, root);
    assert.equal((await next.closed).code, 1);
    await old.closed;
    assert.equal(fs.readFileSync(path.join(root, 'events'), 'utf8'), 'boot\ncleaning\ndisposed\n');
});

test('unexpected service exit removes the foreground control endpoint and fails the launcher', { timeout: 20000 }, async t => {
    const root = fixture(t); application(root, { unexpected: true });
    const old = start(t, root); await old.ready();
    assert.equal((await old.closed).code, 1);
    assert.equal(fs.existsSync(path.join(root, '.pivane-runtime/start-control.json')), false);
});

test('a stale endpoint does not bypass an offline owner or installation lock', { timeout: 20000 }, async t => {
    const root = fixture(t); application(root);
    const control = await openStartControl(root, () => assert.fail('not connected'));
    const record = fs.readFileSync(path.join(root, '.pivane-runtime/start-control.json'));
    control.retire();
    fs.writeFileSync(path.join(root, '.pivane-runtime/start-control.json'), record);
    const lock = await acquireInstallationLock(root);
    cleanup(root, () => lock.close());
    const next = start(t, root);
    assert.equal((await next.closed).code, 1);
    assert.match(next.output(), /此目录正由其他实例使用/);
    assert.equal(fs.existsSync(path.join(root, 'events')), false);
});

test('system service entry does not publish replacement control or get stopped by npm start', { timeout: 20000 }, async t => {
    const root = fixture(t); application(root);
    const old = start(t, root, 'service'); await old.ready();
    assert.equal(fs.existsSync(path.join(root, '.pivane-runtime/start-control.json')), false);
    const next = start(t, root);
    assert.equal((await next.closed).code, 1);
    assert.equal(old.child.exitCode, null);
    assert.equal(fs.readFileSync(path.join(root, 'events'), 'utf8'), 'boot\n');
});

test('concurrent replacements submit once, reject other roots and do not replay on timeout', { timeout: 10000 }, async t => {
    const root = fixture(t);
    let calls = 0, release;
    const waiting = new Promise(resolve => { release = resolve; });
    const control = await openStartControl(root, async () => { calls++; await waiting; });
    cleanup(root, () => control.retire());
    const record = JSON.parse(fs.readFileSync(path.join(root, '.pivane-runtime/start-control.json')));
    for (const request of [null, { root, token: 'wrong', action: 'replace' }, { root: root + '-other', token: record.token, action: 'replace' }]) {
        const socket = net.createConnection({ host: '127.0.0.1', port: record.port });
        await once(socket, 'connect');
        const closed = once(socket, 'close');
        socket.write(JSON.stringify(request) + '\n');
        await closed;
    }
    assert.equal(calls, 0);
    const timed = assert.rejects(replaceManaged(root, { timeoutMs: 60 }), /超时/);
    while (!calls) await new Promise(resolve => setTimeout(resolve, 2));
    await assert.rejects(replaceManaged(root), /正在重启/);
    await timed;
    assert.equal(calls, 1);
    release();
    await new Promise(resolve => setImmediate(resolve));
});

test('restart reserves the global stop gate synchronously and rejects unknown or busy work', () => {
    const maintenance = new MaintenanceClient({ managed: true, nonce: 'test' });
    maintenance.receive({ type: 'maintenance-activate', nonce: 'test' });
    let count = 1;
    const stop = new DesktopStop({ maintenance, sources: [{ type: 'fixture', label: 'fixture', read: () => count }] });
    assert.throws(() => stop.restart(), { code: 'DESKTOP_BLOCKED' });
    assert.equal(maintenance.desktopStopping, false);
    count = 0;
    assert.equal(stop.restart().accepted, true);
    assert.equal(maintenance.desktopStopping, true);
    assert.throws(() => maintenance.enter(), /维护/);
    assert.throws(() => stop.restart(), { code: 'DESKTOP_ALREADY_STOPPING' });
    const unknown = new DesktopStop({ maintenance: {}, sources: [{ read: () => { throw Error(); } }] });
    assert.throws(() => unknown.restart(), { code: 'DESKTOP_BLOCKED' });
});
