'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { once } = require('node:events');
test('workspace Excel endpoints import through confirmation and independently save exported bytes', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-excel-http-'))); process.env.PI_CODING_AGENT_DIR = root;
    const express = require('express'), { StaffingService } = require('../server/staffing/service'), { PiProfileRegistry } = require('../server/pi-profile-registry');
    const { StaffingExcelService } = require('../server/staffing/excel-service'), { mountStaffingExcelRoutes } = require('../server/staffing/excel-routes');
    const { mountStaffingRoutes } = require('../server/staffing/routes'), { ArtifactsService } = require('../server/pi-artifacts'), { WorkspaceAccessService } = require('../server/workspace-access-service');
    const staffing = new StaffingService({ profiles: new PiProfileRegistry({ resolveProject: value => value }) });
    const artifacts = new ArtifactsService({ store: { resolveProject: value => value }, supervisor: {}, libraryRoot: path.join(root, 'library') }), excel = new StaffingExcelService({ staffing, artifacts });
    const access = new WorkspaceAccessService({ filePath: path.join(root, 'access.json'), envToken: () => '' });
    const app = express(); access.mount(app); app.use(express.json()); const router = express.Router(); router.use(access.middleware());
    mountStaffingRoutes(router, staffing); mountStaffingExcelRoutes(router, excel); app.use('/api/pi', router);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = 'http://127.0.0.1:' + server.address().port;
    const post = async (url, body) => { const res = await fetch(origin + '/api/pi/staffing/' + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) }); const result = await res.json(); assert.equal(res.status, 200, JSON.stringify(result)); return result; };
    try {
        await post('enable', { requestId: 'enable', expectedRevision: 0 });
        const response = await fetch(origin + '/api/pi/staffing/excel/template'), bytes = Buffer.from(await response.arrayBuffer()); assert.equal(response.status, 200);
        const upload = await fetch(origin + '/api/pi/staffing/excel/uploads?requestId=upload-http', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Origin: origin }, body: bytes });
        const uploaded = await upload.json(); assert.equal(upload.status, 200, JSON.stringify(uploaded));
        const plan = await post('excel/import', { requestId: 'prepare-http', expectedRevision: (await staffing.status()).revision, uploadId: uploaded.id });
        assert.equal((await staffing.ledger()).people.length, 0);
        const result = await post('commit', { requestId: 'apply-http', expectedRevision: plan.revision, planId: plan.id, action: 'apply-import', source: { kind: 'page' } });
        await post('confirm-initial', { requestId: 'review-http', expectedRevision: result.revision, reviewed: true });
        const report = await post('excel/export', { requestId: 'export-http', expectedRevision: (await staffing.status()).revision });
        assert.equal(report.phase, 'saved'); assert.equal((await artifacts.preview(report.artifactKey)).revision, report.sha256);
        const download = await fetch(origin + report.downloadHref); assert.equal(download.status, 200);
        assert.equal(require('node:crypto').createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex'), report.sha256);
        const forged = await fetch(origin + '/api/pi/staffing/excel/export', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ requestId: 'forged', expectedRevision: report.ledgerRevision, bytes: 'bad', source: { kind: 'page' } }) });
        assert.equal(forged.status, 400);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await excel.dispose(); await staffing.dispose(); await artifacts.dispose(); access.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
