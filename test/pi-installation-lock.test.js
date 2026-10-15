const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { ManagedLauncher } = require('../server/pi-managed-launcher');
const { restoreBackup } = require('../server/pi-maintenance-restore');

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-lock-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function launcher(t, root) {
    const value = new ManagedLauncher({ root, env: {} });
    value.boot = async () => {};
    t.after(() => value.close());
    return value;
}

test('Windows installation ownership needs no TCP port when TCP binding is denied', { skip: process.platform !== 'win32' }, async t => {
    const root = fixture(t), listen = net.Server.prototype.listen;
    let tcpAttempts = 0;
    t.mock.method(net.Server.prototype, 'listen', function (...args) {
        const address = args[0];
        if (typeof address === 'number' || address?.port !== undefined) {
            tcpAttempts++;
            process.nextTick(() => this.emit('error', Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:55572'), { code: 'EACCES' })));
            return this;
        }
        return listen.apply(this, args);
    });
    const value = launcher(t, root);
    await value.start();
    assert.equal(tcpAttempts, 0);
    assert.equal(value.child, null, 'synthetic boot never starts a service or worker');
});

test('concurrent start and close retain one installation owner until the lock has been released', async t => {
    const root = fixture(t), value = launcher(t, root);
    let boots = 0;
    value.boot = async () => { boots++; };
    const starting = value.start();
    const concurrent = value.start();
    void concurrent.catch(() => {});
    assert.equal(concurrent, starting, 'reserve start before any asynchronous acquisition');
    await starting;
    assert.equal(boots, 1);
    const closing = value.close();
    assert.equal(value.close(), closing, 'reserve close before asynchronous release');
    await closing;
    await assert.rejects(value.start(), /stopping/i);
    await launcher(t, root).start();
});

test('shutdown during acquisition prevents boot and leaves the installation available', async t => {
    const root = fixture(t), value = launcher(t, root);
    let boots = 0;
    value.boot = async () => { boots++; };
    const started = value.start();
    await Promise.resolve(); // Let acquisition begin, before the listening event.
    const closed = value.close();
    await Promise.all([started, closed]);
    assert.equal(boots, 0);
    await launcher(t, root).start();
});

test('offline restore uses the running launcher lock and releases it after failed inspection', async t => {
    const root = fixture(t), value = launcher(t, root);
    await value.start();
    await assert.rejects(restoreBackup(root, 'invalid'), { code: 'EADDRINUSE' });
    assert.equal(fs.existsSync(path.join(root, '.pivane-runtime', 'backups')), false);
    await value.close();
    await assert.rejects(restoreBackup(root, 'invalid'), /backup ID/);
    await launcher(t, root).start();
});

test('a separate process owns canonical installation aliases, and a crash releases ownership', { timeout: 15000 }, async t => {
    const root = fixture(t);
    const source = `
        const { ManagedLauncher } = require(process.argv[1]);
        const launcher = new ManagedLauncher({ root: process.argv[2], env: {} });
        launcher.boot = async () => {};
        launcher.start().then(() => process.stdout.write('owned\\n')).catch(error => { console.error(error.code); process.exit(1); });
    `;
    const child = spawn(process.execPath, ['-e', source, require.resolve('../server/pi-managed-launcher'), root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'close');
    t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
    assert.equal(String((await once(child.stdout, 'data'))[0]), 'owned\n');
    const alias = root + '-alias';
    fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    t.after(() => fs.unlinkSync(alias));
    const duplicate = launcher(t, alias);
    let stateReads = 0;
    duplicate.loadState = () => { stateReads++; };
    await assert.rejects(duplicate.start(), { code: 'EADDRINUSE' });
    assert.equal(stateReads, 0);
    child.kill(); await exited;
    await launcher(t, root).start();
});
