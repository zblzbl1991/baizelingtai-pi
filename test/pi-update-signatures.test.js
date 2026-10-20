const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { generateKeyPairSync, sign } = require('node:crypto');
const { UpdateService, mountUpdateRoutes } = require('../server/pi-update-service');
const { MaintenanceClient } = require('../server/pi-maintenance-client');
const express = require('express'), fetch = require('node-fetch');
const { once } = require('node:events');

const source = 'http://updates.example/updates/latest.json';
const manifest = () => ({ schemaVersion: 1, version: '1.8.1', piVersion: '1.1.0', platform: 'win32', arch: 'x64',
    channel: 'stable', publishedAt: '2026-10-20T00:00:00Z', package: '../releases/app.zip', bytes: 5, sha256: 'a'.repeat(64) });
// Independent signer models the publishing boundary, never uses production payload code.
function signed(data, key) {
    const payload = ['pivane-release-v1', data.schemaVersion, data.version, data.piVersion, data.platform, data.arch,
        data.channel, data.publishedAt, data.package, data.sha256, data.bytes, data.releasesUrl ?? null];
    return { ...data, signature: { algorithm: 'ed25519', keyId: 'release-2026', value: sign(null, Buffer.from(JSON.stringify(payload)), key).toString('base64') } };
}
function install(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-signature-test-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const keys = generateKeyPairSync('ed25519'); fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config/update-trust.json'), JSON.stringify({ schemaVersion: 1, keys: [
        { keyId: 'release-2026', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) } ] }));
    return { root, ...keys };
}
function service(root, data) {
    return new UpdateService({ root, appVersion: '1.8.0', piVersion: '1.1.0', platform: 'win32', arch: 'x64',
        env: { BAIZELINGTAI_UPDATE_FEED_URL: source }, fetch: async () => ({ ok: true, json: async () => data }) });
}

test('trusted installation rejects unsigned releases at the update-check boundary', async t => {
    const { root } = install(t);
    assert.equal((await service(root, manifest()).check()).pivane.status, 'error');
});

test('signed release survives check, maintenance review and single-use execute without losing its exact payload', async t => {
    const { root, privateKey } = install(t), data = signed(manifest(), privateKey), sent = [];
    const updates = service(root, data);
    assert.deepEqual((await updates.check()).pivane.signedManifest, data);
    const maintenance = new MaintenanceClient({ managed: true, nonce: 'signed-fixture', send: value => sent.push(value) });
    maintenance.receive({ type: 'maintenance-status', nonce: 'signed-fixture', status: {
        supported: true, appUpdateSupported: true, portableUpdateSupported: true, busy: false } });
    maintenance.receive({ type: 'maintenance-activate', nonce: 'signed-fixture' });
    const app = express(), router = express.Router(); app.use(express.json()); app.use('/api/pi', router);
    mountUpdateRoutes(router, updates, { maintenance, idle: () => true, pause() {} });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const post = (route, body) => fetch(`http://127.0.0.1:${server.address().port}/api/pi/settings/updates/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const response = await post('review', { action: 'application', channel: 'preview' });
    assert.equal(response.status, 200); const ticket = await response.json();
    assert.deepEqual(ticket.release.signedManifest, data);
    assert.equal((await post('execute', { ticket: ticket.id, confirmed: true, draftsSaved: true, externalWritersStopped: true })).status, 202);
    assert.deepEqual(sent[0].release.signedManifest, data);
});

test('launcher protocol cannot downgrade to unsigned diagnostics when its local trust file is missing', async t => {
    const { root } = install(t); fs.unlinkSync(path.join(root, 'config/update-trust.json'));
    fs.writeFileSync(path.join(root, 'baizelingtai-portable.json'), JSON.stringify({ launcherUpdateProtocol: 1 }));
    assert.equal((await service(root, manifest()).check()).pivane.status, 'error');
});

test('staging rechecks the entire signed identity even when version and archive hash remain unchanged', { skip: process.platform !== 'win32' }, async t => {
    const { root, privateKey } = install(t), { hash } = require('../server/pi-maintenance-files');
    fs.mkdirSync(path.join(root, 'runtime')); fs.writeFileSync(path.join(root, 'runtime/node.exe'), 'fixture');
    fs.writeFileSync(path.join(root, 'baizelingtai-portable.json'), JSON.stringify({ version: 1, platform: 'win32', arch: 'x64', launcherUpdateProtocol: 1 }));
    const pkg = Buffer.from('{"version":"1.8.0"}'); fs.writeFileSync(path.join(root, 'package.json'), pkg);
    fs.writeFileSync(path.join(root, 'TRIAL_MANIFEST.json'), JSON.stringify({ files: [{ path: 'package.json', bytes: pkg.length, sha256: hash(pkg) }] }));
    let data = signed({ ...manifest(), package: 'app.zip', sha256: hash(Buffer.from('hello')) }, privateKey), downloads = 0;
    const app = express(); app.get('/latest.json', (_req, res) => res.json(data)); app.get('/app.zip', (_req, res) => { downloads++; res.send('hello'); });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const feed = `http://127.0.0.1:${server.address().port}/latest.json`, env = { BAIZELINGTAI_UPDATE_FEED_URL: feed };
    const updates = new UpdateService({ root, env, platform: 'win32', arch: 'x64' });
    const release = { ...(await updates.manifest('stable')), format: 'windows-portable-zip', feed, channel: 'stable' };
    data = signed({ ...data, publishedAt: '2026-10-20T01:00:00Z' }, privateKey);
    await assert.rejects(require('../server/pi-portable-installer').stagePortable({ root, directory: path.join(root, 'candidate'), release, env }), /target changed/);
    assert.equal(downloads, 0);
});

test('trusted update checks reject forged signatures, unknown publishers and changes to every signed field', async t => {
    const { root, privateKey } = install(t), original = signed(manifest(), privateKey);
    const changes = [{ version: '1.8.2' }, { piVersion: '1.1.1' }, { channel: 'preview' }, { publishedAt: '2026-10-21T00:00:00Z' },
        { package: '../releases/other.zip' }, { sha256: 'b'.repeat(64) }, { bytes: 6 }, { releasesUrl: '/other-release' },
        { signature: { ...original.signature, keyId: 'remote-key', publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) } },
        { signature: { ...original.signature, algorithm: 'rsa' } }, { signature: { ...original.signature, value: 'A'.repeat(86) + '==' } }];
    for (const change of changes) assert.equal((await service(root, { ...original, ...change }).check()).pivane.status, 'error', Object.keys(change)[0]);
    const other = generateKeyPairSync('ed25519');
    assert.equal((await service(root, signed(manifest(), other.privateKey)).check()).pivane.status, 'error');
    assert.equal((await service(root, original).check()).pivane.verification.status, 'verified');
});

test('unsigned legacy read-only diagnostics are explicitly unverified and cannot produce a maintenance ticket', async t => {
    const { root } = install(t); fs.unlinkSync(path.join(root, 'config/update-trust.json'));
    const updates = service(root, manifest()), maintenance = new MaintenanceClient({ managed: true, nonce: 'legacy', send() {} });
    assert.equal((await updates.check()).pivane.verification.status, 'unverified');
    maintenance.receive({ type: 'maintenance-status', nonce: 'legacy', status: { supported: true, appUpdateSupported: true, portableUpdateSupported: true } });
    maintenance.receive({ type: 'maintenance-activate', nonce: 'legacy' });
    const app = express(), router = express.Router(); app.use(express.json()); app.use('/api/pi', router);
    mountUpdateRoutes(router, updates, { maintenance, idle: () => true });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/settings/updates/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'application' }) });
    assert.equal(response.status, 503); assert.equal(maintenance.tickets.size, 0);
});
