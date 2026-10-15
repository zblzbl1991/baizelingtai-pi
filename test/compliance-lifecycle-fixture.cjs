// Physical fault gate in an isolated process. Real parser results and real fd
// reads are retained; IPC only delays their settlement, never substitutes data.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const childProcess = require('node:child_process'), fsp = require('node:fs/promises');
let parserMarker, readHash, gate, disposed = false;
const hold = kind => new Promise(resolve => { gate = resolve; process.send({ type: 'held', kind }); });
const originalFork = childProcess.fork;
childProcess.fork = function(file, args, options) {
    const child = originalFork.call(this, file, args, options);
    if (path.resolve(file) !== path.resolve(__dirname, '../server/pi-document-worker.js')) return child;
    let marked = false;
    const send = child.send; child.send = function(message, ...rest) {
        if (message.bytes && parserMarker && Buffer.from(message.bytes).includes(Buffer.from(parserMarker))) { marked = true; parserMarker = null; }
        if (message.bytes && Buffer.from(message.bytes).includes(Buffer.from('NEXT_IMPORT'))) process.send({type:'unexpected-next-parser'});
        return send.call(this, message, ...rest);
    };
    const once = child.once; child.once = function(event, listener) {
        if (event === 'exit') return once.call(this, event, async (...values) => { if (marked) await hold('parser'); listener(...values); });
        return once.call(this, event, listener);
    };
    return child;
};
const open = fsp.open; fsp.open = async function(file, ...args) {
    const handle = await open.call(this, file, ...args);
    if (readHash && path.basename(String(file)) === readHash + '.bin') {
        readHash = null; const read = handle.read;
        handle.read = async function(...values) { const result = await read.apply(this, values); if (result.bytesRead) { handle.read = read; await hold('read'); } return result; };
    }
    return handle;
};
const nativeRead = fs.read;
if (process.platform === 'win32') fs.read = function(fd, ...args) {
    const callback = args.pop();
    const marked = readHash && path.basename(require('../server/pi-file-descriptor').descriptorPathSync(fd)) === readHash + '.bin';
    if (marked) readHash = null;
    return nativeRead.call(this, fd, ...args, async (...result) => { if (marked && !result[0] && result[1]) await hold('read'); callback(...result); });
};
const agent = process.env.PI_CODING_AGENT_DIR;
const { WorkspaceAccessService } = require('../server/workspace-access-service');
const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => 'synthetic-lifecycle' });
const maintenance = new (require('../server/pi-maintenance-client').MaintenanceClient)({ managed: true, nonce: 'fixture' });
maintenance.receive({type:'maintenance-status',nonce:'fixture',status:{supported:true,busy:false}}); maintenance.receive({type:'maintenance-activate',nonce:'fixture'});
const gateway = require(path.join(process.env.PIVANE_TEST_UPGRADE_ROOT || path.resolve(__dirname,'..'), 'server/pi-agent-routes')).createPiAgentGateway({ accessService: access, maintenance, deferredFilePath: path.join(agent, 'deferred.json'), cronFilePath: path.join(agent, 'cron.sqlite') });
const app = require('express')(); access.mount(app); app.use(require('express').json({ limit: '32mb' })); gateway.mount(app);
const server = http.createServer(app); server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', origin: `http://127.0.0.1:${server.address().port}` }));
process.on('message', async message => {
    if (message.type === 'arm-parser') { parserMarker = message.marker; process.send({ type: 'armed' }); }
    if (message.type === 'arm-read') { readHash = message.hash; process.send({ type: 'armed' }); }
    if (message.type === 'release') { gate?.(); gate = null; }
    if (message.type === 'dispose') { await gateway.dispose(); disposed = true; process.send({ type: 'disposed' }); }
    if (message.type === 'close') { gate?.(); if (!disposed) await gateway.dispose(); access.dispose(); server.closeAllConnections(); server.close(() => process.exit(0)); }
});
