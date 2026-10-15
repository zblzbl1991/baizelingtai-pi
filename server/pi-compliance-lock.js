const fs = require('node:fs'), net = require('node:net'), { createHash } = require('node:crypto');
const { fail } = require('./pi-file-scope');
// Kernel ownership expires on process exit. No PID guessing or stale-directory
// deletion, including after an interrupted JSON publication.
async function acquire(root, purpose) {
    const digest = createHash('sha256').update(purpose + ':' + fs.realpathSync.native(root)).digest();
    const address = process.platform === 'win32' ? { path: `\\\\.\\pipe\\pivane-compliance-${digest.toString('hex')}` }
        : { port: 40000 + digest.readUInt32BE(0) % 20000, host: '127.0.0.1', exclusive: true };
    const server = net.createServer(socket => socket.destroy());
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); }); }
    catch { throw fail('合规身份正在另一个进程中处理，请核对原操作', 409, 'COMPLIANCE_BUSY'); }
    let closing;
    return { close() { return closing ||= new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
module.exports = { acquire };
