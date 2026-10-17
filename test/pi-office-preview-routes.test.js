const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express'), http = require('node:http');
const { once } = require('node:events');
const { mountOfficePreviews } = require('../server/pi-office-preview-routes');
test('Office POST uses existing access and Origin protection and never projects engine paths or stderr', async t => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-office-http-'));
    const { WorkspaceAccessService } = require('../server/workspace-access-service');
    const access = new WorkspaceAccessService({ filePath: path.join(directory, 'access.json'), envToken: () => 'office-synthetic-only' });
    const app = express(); access.mount(app); app.use(express.json()); const router = express.Router(); router.use(access.middleware());
    mountOfficePreviews(router, { service: { preview: async () => { throw new Error('C:/secret/path engine stderr private document text'); } } });
    app.use('/api/pi', router); const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { access.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(directory, { recursive: true, force: true }); });
    const url = `http://127.0.0.1:${server.address().port}/api/pi/office/preview`, headers = { 'Content-Type': 'application/json', Authorization: 'Bearer office-synthetic-only' }, body = JSON.stringify({ source: { type: 'project', cwd: '/', path: 'test.docx' } });
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://invalid.example' }, body })).status, 403);
    const result = await fetch(url, { method: 'POST', headers, body }); assert.equal(result.status, 503); assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await result.json(), { error: '办公文件预览组件暂不可用，请稍后重试', code: 'OFFICE_UNAVAILABLE' });
});
