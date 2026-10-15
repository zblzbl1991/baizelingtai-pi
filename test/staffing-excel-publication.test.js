'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { once } = require('node:events');
const barrier = (entered, pending, signal) => Promise.race([entered,
    pending.then(() => { throw new Error('Request finished before reaching the publication barrier'); }),
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);

// A real artifact save/status boundary pauses the HTTP request while the actual
// storage directory is renamed. No file identity or kernel path API is mocked.
for (const [action, replacement] of [['export', 'directory'], ['export', 'junction'], ['operation', 'directory']]) {
    test(`Excel ${action} never publishes a receipt into a substituted ${replacement}`, { timeout: 60000 }, async t => {
        const agent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-publication-'))); process.env.PI_CODING_AGENT_DIR = agent;
        const express = require('express'), { StaffingService } = require('../server/staffing/service'), { PiProfileRegistry } = require('../server/pi-profile-registry');
        const { StaffingExcelService } = require('../server/staffing/excel-service'), { mountStaffingExcelRoutes } = require('../server/staffing/excel-routes');
        const { ArtifactsService } = require('../server/pi-artifacts'), { WorkspaceAccessService } = require('../server/workspace-access-service');
        const staffing = new StaffingService({ profiles: new PiProfileRegistry({ resolveProject: value => value }) });
        const artifacts = new ArtifactsService({ store: { resolveProject: value => value }, supervisor: {}, libraryRoot: path.join(agent, 'library') });
        const excel = new StaffingExcelService({ staffing, artifacts }), access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => '' });
        const app = express(); access.mount(app); app.use(express.json()); const router = express.Router(); router.use(access.middleware()); mountStaffingExcelRoutes(router, excel); app.use('/api/pi', router);
        const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = 'http://127.0.0.1:' + server.address().port;
        const entered = Promise.withResolvers(), release = Promise.withResolvers(); let pending, root, held, destination;
        const post = async () => { const response = await fetch(origin + '/api/pi/staffing/excel/export', { method: 'POST', signal: t.signal, headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ requestId: 'export-barrier', expectedRevision: (await staffing.status()).revision }) }); return { status: response.status, result: await response.json() }; };
        try {
            const enabled = await staffing.enable({ requestId: 'enable', expectedRevision: 0 });
            const initial = await staffing.initialize({ requestId: 'initial', expectedRevision: enabled.revision, people: [{ id: 'P1', name: 'Synthetic', department: 'A', direct: true }], projects: [], occupancies: [], historyComplete: false });
            await staffing.confirmInitial({ requestId: 'review', expectedRevision: initial.revision, reviewed: true });
            const batch = artifacts.management.batch.bind(artifacts.management);
            if (action === 'export') artifacts.management.batch = async input => { const result = await batch(input); entered.resolve(); await release.promise; return result; };
            else {
                artifacts.management.batch = async input => { await batch(input); throw new Error('Synthetic lost save response'); };
                const first = await post(); assert.equal(first.result.phase, 'available');
                artifacts.management.batch = batch;
                const result = artifacts.management.result.bind(artifacts.management);
                artifacts.management.result = async requestId => { const saved = await result(requestId); entered.resolve(); await release.promise; return saved; };
            }
            pending = action === 'export' ? post() : (async () => { const response = await fetch(origin + '/api/pi/staffing/excel/operations/export-barrier', { signal: t.signal }); return { status: response.status, result: await response.json() }; })();
            await barrier(entered.promise, pending, t.signal);
            root = path.join(agent, 'pivane-staffing', 'exports'); held = root + '-retained'; destination = replacement === 'junction' ? path.join(agent, 'outside') : root;
            fs.renameSync(root, held); fs.mkdirSync(destination);
            if (replacement === 'junction') fs.symlinkSync(destination, root, process.platform === 'win32' ? 'junction' : 'dir');
            release.resolve(); const response = await pending;
            assert.deepEqual(fs.readdirSync(destination), [], 'replacement storage must receive neither receipt nor temporary publication');
            assert.ok(response.status >= 400 || response.result.noReplay, 'a changed publication parent must report uncertainty or fail closed');
            assert.equal(fs.readdirSync(held).filter(name => name.endsWith('.xlsx')).length, 1, 'original export remains under the retained storage object');
            const saved = await artifacts.library.list(); assert.equal(saved.items.length, 1); assert.ok((await artifacts.preview(saved.items[0].key)).base64, 'independently saved artifact survives storage substitution');
        } finally {
            release.resolve(); await pending?.catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
            await excel.dispose(); await staffing.dispose(); await artifacts.dispose(); access.dispose();
            if (replacement === 'junction' && root && fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) fs.unlinkSync(root);
            fs.rmSync(agent, { recursive: true, force: true });
        }
    });
}

test('Excel upload retains its original directory while the real parser is awaited', { timeout: 60000 }, async t => {
    const agent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-import-publication-'))); process.env.PI_CODING_AGENT_DIR = agent;
    const { StaffingService } = require('../server/staffing/service'), { PiProfileRegistry } = require('../server/pi-profile-registry');
    const { StaffingExcelService } = require('../server/staffing/excel-service'), { DocumentParserPool } = require('../server/pi-document-pool');
    const staffing = new StaffingService({ profiles: new PiProfileRegistry({ resolveProject: value => value }) }), pool = new DocumentParserPool(), excel = new StaffingExcelService({ staffing, pool });
    const entered = Promise.withResolvers(), release = Promise.withResolvers(); let pending;
    try {
        await staffing.enable({ requestId: 'enable', expectedRevision: 0 }); const source = await staffing.pageSource({ phase: 'initial' });
        const bytes = excel.workbook({ people: [{ id: 'P1', name: 'Synthetic', department: 'A', direct: true }], projects: [], occupancies: [], historyComplete: false });
        await excel.upload(bytes, { requestId: 'seed' }, source);
        const run = pool.run.bind(pool); pool.run = async (...args) => { const parsed = await run(...args); entered.resolve(); await release.promise; return parsed; };
        pending = excel.upload(bytes, { requestId: 'substituted' }, source).then(value => ({ value }), error => ({ error }));
        await barrier(entered.promise, pending, t.signal);
        const root = path.join(agent, 'pivane-staffing', 'exports', 'imports'), held = root + '-retained'; fs.renameSync(root, held); fs.mkdirSync(root);
        release.resolve(); const outcome = await pending;
        assert.deepEqual(fs.readdirSync(root), [], 'substituted imports directory receives no workbook, receipt or temporary bytes');
        assert.equal(outcome.error?.status, 503); assert.equal(outcome.error?.outcomeUnknown, true); assert.equal(outcome.error?.noReplay, true);
        assert.equal(fs.readdirSync(held).length, 2, 'the original upload pair is retained without a second publication');
    } finally { release.resolve(); await pending; await excel.dispose(); await staffing.dispose(); fs.rmSync(agent, { recursive: true, force: true }); }
});

test('Excel root rejects a linked ancestor before changing outside permissions', async () => {
    const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-root-permissions-'))), agent = path.join(temporary, 'agent'); fs.mkdirSync(agent); process.env.PI_CODING_AGENT_DIR = agent;
    // Keep outside genuinely outside the identity: SDK initialization legitimately
    // secures agentDir and can change inherited ACLs of its real descendants.
    const outside = path.join(temporary, 'outside'), exports = path.join(outside, 'exports'), alias = path.join(agent, 'pivane-staffing');
    fs.mkdirSync(exports, { recursive: true, mode: 0o755 }); fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const permissions = () => process.platform === 'win32'
        ? require('node:crypto').createHash('sha256').update(require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(Get-Acl -LiteralPath '" + exports.replace(/'/g, "''") + "').Sddl"], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim()).digest('hex')
        : String(fs.statSync(exports).mode);
    const { StaffingExcelService } = require('../server/staffing/excel-service'), excel = new StaffingExcelService();
    try {
        const before = permissions(); await assert.rejects(excel.record('a'.repeat(64)));
        assert.equal(permissions(), before, 'rejecting a linked ancestor must not first secure the outside directory');
        assert.deepEqual(fs.readdirSync(exports), []);
    } finally { await excel.dispose(); fs.unlinkSync(alias); fs.rmSync(temporary, { recursive: true, force: true }); }
});
