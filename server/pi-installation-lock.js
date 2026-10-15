const fs = require('node:fs');
const net = require('node:net');
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

module.exports = { acquireInstallationLock };
