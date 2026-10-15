const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { createHash } = require('node:crypto');

// All managed starts and offline writers must acquire this same kernel lock.
// Windows pipe names are machine-wide, including across logon sessions. libuv
// creates the first pipe instance exclusively; a second owner fails closed.
// No PID file, stale-lock deletion, port fallback or public control API is used.
async function acquireInstallationLock(root) {
    const canonical = fs.realpathSync.native(root);
    const digest = createHash('sha256').update(canonical).digest();
    const address = process.platform === 'win32'
        ? { path: `\\\\.\\pipe\\pivane-installation-${digest.toString('hex')}` }
        : { port: 40000 + digest.readUInt32BE(0) % 20000, host: '127.0.0.1', exclusive: true };
    const server = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => {
        const failed = error => { server.off('listening', listening); reject(error); };
        const listening = () => { server.off('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', listening);
        server.listen(address);
    });
    let closing;
    return {
        close() {
            if (!closing) closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            return closing;
        }
    };
}

// Storage writers use the same proven OS ownership, scoped to their private real
// directory. Legacy mkdir owners are unknown: never remove or age them out. A
// protocol upgrade requires stopping old writers; mixed lock versions are unsafe.
async function acquireStorageOwnership(root, legacyName) {
    if (!['ledger.lock', 'profiles.lock'].includes(legacyName)) throw new Error('Unknown storage lock scope');
    const checkLegacy = () => {
        try { fs.lstatSync(path.join(root, legacyName)); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        throw Object.assign(new Error('Unknown legacy storage lock; stop old writers and inspect it under maintenance'), {
            status: 409, code: 'STORAGE_LEGACY_LOCK'
        });
    };
    checkLegacy();
    let owner;
    try { owner = await acquireInstallationLock(root); }
    catch (error) {
        throw Object.assign(new Error(error.code === 'EADDRINUSE' ? 'Storage is being saved by another process' : 'Storage ownership is unavailable'), {
            status: error.code === 'EADDRINUSE' ? 409 : 503, code: 'STORAGE_OWNERSHIP', cause: error
        });
    }
    try { checkLegacy(); return owner; }
    catch (error) { await owner.close(); throw error; }
}

module.exports = { acquireInstallationLock, acquireStorageOwnership };
