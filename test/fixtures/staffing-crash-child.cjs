// External I/O fault barrier: real public operations and real files, no production hook.
const fs = require('node:fs'), path = require('node:path');
const [agent, mode] = process.argv.slice(2);
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_PROJECT_ROOTS = agent;
process.env.PI_OFFLINE = '1';
const privateFiles = require('../../server/pi-private-files');
const marker = value => fs.writeSync(1, 'STAFFING_FIXTURE:' + JSON.stringify(value) + '\n');
const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
const write = privateFiles.writePrivateFileSync;
privateFiles.writePrivateFileSync = function (file, ...args) {
    const result = write.call(this, file, ...args);
    const scope = file.includes(path.sep + 'pivane-staffing' + path.sep) ? 'ledger' : file.includes(path.sep + 'pivane-profiles' + path.sep) ? 'profiles' : null;
    if (mode === scope + '-before' && file.endsWith('.tmp')) { marker({ stage: mode }); wait(); }
    return result;
};
const applyPrivateMode = privateFiles.privateFileMode;
let ledgerPublications = 0, faulted = false;
privateFiles.privateFileMode = function (file, ...args) {
    const result = applyPrivateMode.call(this, file, ...args);
    const scope = path.basename(file) === 'ledger.json' ? 'ledger' : path.basename(file) === 'profiles.json' ? 'profiles' : null;
    if (scope === 'ledger') ledgerPublications++;
    if (!faulted && scope && mode.startsWith(scope + '-after') && (scope !== 'ledger' || ledgerPublications === 2)) {
        faulted = true;
        if (mode.endsWith('-error')) throw Object.assign(new Error('synthetic failure after actual publication'), { code: 'EIO' });
        marker({ stage: mode }); wait();
    }
    return result;
};
const { StaffingService } = require('../../server/staffing/service');
const { PiProfileRegistry } = require('../../server/pi-profile-registry');
const profiles = new PiProfileRegistry({ resolveProject: value => value });
const service = new StaffingService({ profiles });
async function startHttp() {
    const express = require('express');
    const { WorkspaceAccessService } = require('../../server/workspace-access-service');
    const { mountStaffingRoutes } = require('../../server/staffing/routes');
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => 'synthetic-staffing-recovery' });
    const app = express(), router = express.Router();
    app.use(express.json()); access.mount(app); router.use(access.middleware()); mountStaffingRoutes(router, service); app.use('/api/pi', router);
    await service.status();
    const server = app.listen(0, '127.0.0.1', () => marker({ origin: `http://127.0.0.1:${server.address().port}` }));
}
if (mode.endsWith('-error')) void startHttp().catch(error => { marker({ error: error.message }); process.exitCode = 1; });
else service.enable({ requestId: 'crashed-enable', expectedRevision: 0 }).then(result => {
    marker({ unexpected: result }); return service.dispose();
}).catch(error => { marker({ error: error.message, status: error.status }); process.exitCode = 1; });
