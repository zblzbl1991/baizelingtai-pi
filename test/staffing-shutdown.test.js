'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), express = require('express');
test('a disconnected export stays busy and drains through independent artifact save before gateway shutdown', { timeout: 90000 }, async t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-shutdown-'))), agent = path.join(root, 'agent'); fs.mkdirSync(agent);
    process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1'; process.env.PI_WEB_DEFERRED_FILE = path.join(agent, 'deferred.json');
    const { MaintenanceClient } = require('../server/pi-maintenance-client'), { WorkspaceAccessService } = require('../server/workspace-access-service');
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const maintenance = new MaintenanceClient({ managed: true, nonce: 'synthetic-shutdown', send() {} });
    maintenance.receive({ nonce: 'synthetic-shutdown', type: 'maintenance-status', status: { supported: true, updateSupported: true, busy: false } });
    maintenance.receive({ nonce: 'synthetic-shutdown', type: 'maintenance-activate' });
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => 'synthetic-shutdown-token' });
    const gateway = createPiAgentGateway({ accessService: access, maintenance, deferredFilePath: path.join(agent, 'deferred.json'), cronFilePath: path.join(agent, 'cron.sqlite') });
    const app = express(); access.mount(app); app.use(express.json()); app.use(maintenance.http.bind(maintenance)); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: 'Bearer synthetic-shutdown-token', Origin: origin, 'Content-Type': 'application/json' };
    const post = (url, body, signal) => fetch(origin + '/api/pi/' + url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    const held = Promise.withResolvers(), release = Promise.withResolvers(); let paused = false, stopping, restarted;
    t.after(async () => { release.resolve(); await (stopping || gateway.dispose()); await restarted?.dispose(); access.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    const enabled = await gateway.staffing.enable({ requestId: 'enable', expectedRevision: 0 });
    const initial = await gateway.staffing.initialize({ requestId: 'initial', expectedRevision: enabled.revision, people: [{ id: 'P1', name: 'Direct', department: 'A', direct: true }], projects: [], occupancies: [], historyComplete: true });
    const ready = await gateway.staffing.confirmInitial({ requestId: 'review', expectedRevision: initial.revision, reviewed: true });
    const reviewed = await post('settings/updates/review', { action: 'backup' }); assert.equal(reviewed.status, 200, await reviewed.clone().text()); const ticket = await reviewed.json();
    // Delay a real filesystem boundary, preserving the actual path/handle/hash
    // checks and artifact save. This faults I/O timing, not our service methods.
    const realpath = fs.promises.realpath;
    t.mock.method(fs.promises, 'realpath', async function (requested, ...args) {
        const actual = await realpath.call(this, requested, ...args);
        if (!paused && typeof requested === 'string' && requested.startsWith(agent + path.sep) && requested.endsWith('.xlsx')) {
            paused = true; held.resolve(); await release.promise;
        }
        return actual;
    });
    const controller = new AbortController();
    const exporting = post('staffing/excel/export', { requestId: 'draining-export', expectedRevision: ready.revision }, controller.signal).catch(error => error);
    await held.promise; controller.abort(); assert.equal((await exporting).name, 'AbortError');
    const activity = await fetch(origin + '/api/pi/activity', { headers }); assert.equal((await activity.json()).staffingBusy, true);
    const readiness = gateway.desktopStop.review({ action: 'stop' });
    assert.equal(readiness.complete, true);
    assert.ok(readiness.blockers.some(row => row.type === 'staffing' && row.count > 0));
    assert.equal(readiness.ticket, undefined);
    const blockedReview = await post('settings/updates/review', { action: 'backup' }); assert.equal(blockedReview.status, 409);
    const blockedExecute = await post('settings/updates/execute', { ticket: ticket.id, confirmed: true, externalWritersStopped: true, draftsSaved: true }); assert.equal(blockedExecute.status, 409);
    let finished = false; stopping = gateway.dispose().then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false, 'shutdown cannot pass an admitted export');
    assert.throws(() => gateway.artifacts.check(), { code: 'ARTIFACT_SUSPENDED' }, 'unrelated artifact work stays blocked during drain');
    const rejected = await post('staffing/excel/export', { requestId: 'too-late', expectedRevision: ready.revision }); assert.equal(rejected.status, 503);
    release.resolve(); await stopping;
    restarted = createPiAgentGateway({ accessService: access, deferredFilePath: path.join(agent, 'deferred.json'), cronFilePath: path.join(agent, 'cron.sqlite') });
    const source = await restarted.staffing.pageSource(), result = await restarted.staffingExcel.operation('draining-export', source);
    assert.equal(result.phase, 'saved', JSON.stringify(result)); assert.equal(result.ledgerRevision, ready.revision);
    const saved = await restarted.artifacts.preview(result.artifactKey); assert.equal(saved.revision, result.sha256);
    const same = await restarted.staffingExcel.operation('draining-export', source); assert.equal(same.artifactKey, result.artifactKey); assert.equal(same.sha256, result.sha256);
    assert.equal((await restarted.staffing.ledger()).occupancies.length, 0);
});
