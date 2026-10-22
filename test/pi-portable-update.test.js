const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const express = require('express'), fetch = require('node-fetch');
const { hash } = require('../server/pi-maintenance-files');
const { validPortable, downloadPortable, unpackPortable, stagePortable } = require('../server/pi-portable-installer');
const signatures = require('./update-signature-helper.cjs');
const { MaintenanceClient } = require('../server/pi-maintenance-client');
const { UpdateService, mountUpdateRoutes } = require('../server/pi-update-service');
const fixture = t => { const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-portable-test-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const plan = (feed = 'http://127.0.0.1:1234/latest.json') => ({ format: 'windows-portable-zip', feed, channel: 'stable', version: '1.7.2', piVersion: '1.1.0', downloadUrl: new URL('app.zip', feed).href, bytes: 5, sha256: hash(Buffer.from('hello')) });

test('portable plans bind configured origin, exact integrity and channel', () => {
    const release = plan(); assert.equal(validPortable(release, release.feed), true);
    for (const extra of [{ downloadUrl: 'http://other.invalid/app.zip' }, { bytes: 1024 ** 3 + 1 }, { bytes: 0 }, { channel: 'unknown' },
        { sha256: 'bad' }, { feed: 'http://user:secret@127.0.0.1:1234/latest.json' }, { version: '../escape' }]) assert.equal(validPortable({ ...release, ...extra }, release.feed), false);
});
test('streamed download verifies bytes/hash and never follows redirects or retries failures', async t => {
    const dir = fixture(t), app = express(); let mode = 'ok', calls = 0;
    app.get('/app.zip', (_req, res) => { calls++; if (mode === 'redirect') return res.redirect('/login'); if (mode === 'offline') return res.sendStatus(503); res.send('hello'); });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const release = plan(`http://127.0.0.1:${server.address().port}/latest.json`);
    await downloadPortable(release, path.join(dir, 'ok.zip'), { env: {} }); assert.equal(fs.readFileSync(path.join(dir, 'ok.zip'), 'utf8'), 'hello');
    for (const [name, extra] of [['hash', { sha256: '0'.repeat(64) }], ['short', { bytes: 4 }], ['long', { bytes: 6 }]]) {
        const before = calls; await assert.rejects(downloadPortable({ ...release, ...extra }, path.join(dir, name + '.zip'), { env: {} })); assert.equal(calls, before + 1);
    }
    for (mode of ['redirect', 'offline']) { const before = calls; await assert.rejects(downloadPortable(release, path.join(dir, mode + '.zip'), { env: {} })); assert.equal(calls, before + 1); }
});

// Minimal stored ZIP fixture, independent of the production extractor.
function zip(entries) {
    let offset = 0; const local = [], central = [];
    const crc = bytes => { let result = 0xffffffff; for (const byte of bytes) { result ^= byte; for (let i = 0; i < 8; i++) result = (result >>> 1) ^ (0xedb88320 & -(result & 1)); } return (result ^ 0xffffffff) >>> 0; };
    for (const [name, data, attrs = 0] of entries) {
        const bytes = Buffer.from(data), filename = Buffer.from(name), header = Buffer.alloc(30), record = Buffer.alloc(46);
        header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(2048, 6); header.writeUInt32LE(crc(bytes), 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
        record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(2048, 8); record.writeUInt32LE(crc(bytes), 16); record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(attrs >>> 0, 38); record.writeUInt32LE(offset, 42);
        local.push(header, filename, bytes); central.push(record, filename); offset += header.length + filename.length + bytes.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, directory, end]);
}
test('Windows extractor rejects traversal, links, aliases, user data and bad inventory before activation', { skip: process.platform !== 'win32' }, async t => {
    const dir = fixture(t), prefix = 'baizelingtai-1.7.2/'; let id = 0;
    async function extract(entries) { const file = path.join(dir, `${++id}.zip`); fs.writeFileSync(file, zip(entries)); return unpackPortable(file, path.join(dir, `out-${id}`), '1.7.2'); }
    for (const entries of [[[prefix + '../escape', 'bad']], [[prefix + 'link', 'bad', 0xa0000000]], [[prefix + 'A.txt', 'a'], [prefix + 'a.txt', 'b']],
        [[prefix + 'file:stream', 'bad']], [[prefix + 'CON.txt', 'bad']], [[prefix + 'data/session.jsonl', 'bad']], [[prefix + '.env', 'bad']]]) {
        await assert.rejects(extract(entries)); assert.equal(fs.existsSync(path.join(dir, `out-${id}`)), false);
    }
    const files = [{ path: 'hello.txt', bytes: 5, sha256: hash(Buffer.from('hello')) }];
    const manifest = { version: 1, platform: 'win32', arch: 'x64', appVersion: '1.7.2', files };
    await extract([[prefix + 'hello.txt', 'hello'], [prefix + 'PORTABLE_MANIFEST.json', JSON.stringify(manifest)]]);
    const longPath = Array(12).fill('long-directory-segment').join('/') + '/hello.txt';
    const longManifest = { ...manifest, files: [{ ...files[0], path: longPath }] };
    await extract([[prefix + longPath, 'hello'], [prefix + 'PORTABLE_MANIFEST.json', JSON.stringify(longManifest)]]);
    await assert.rejects(extract([[prefix + 'hello.txt', 'wrong'], [prefix + 'PORTABLE_MANIFEST.json', JSON.stringify(manifest)]]), /hash mismatch/);
    const misdeclared = zip([[prefix + 'overflow.txt', 'oversized']]);
    misdeclared.writeUInt32LE(1, misdeclared.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
    const file = path.join(dir, 'misdeclared.zip'); fs.writeFileSync(file, misdeclared);
    await assert.rejects(unpackPortable(file, path.join(dir, 'overflow'), '1.7.2'), /extraction failed/);
});
test('review reserves async lookup, seals portable ticket and blocks concurrent maintenance', async t => {
    const app = express(), router = express.Router(); app.use(express.json()); app.use('/api/pi', router);
    const root = fixture(t), release = plan(), sign = signatures.signer(root);
    release.signedManifest = sign(signatures.manifest(release));
    const sent = [], maintenance = new MaintenanceClient({ managed: true, nonce: 'fixture', send: message => sent.push(message) });
    maintenance.receive({ type: 'maintenance-status', nonce: 'fixture', status: { supported: true, appUpdateSupported: true, portableUpdateSupported: true, busy: false } });
    maintenance.receive({ type: 'maintenance-activate', nonce: 'fixture' });
    let unlock; const held = new Promise(resolve => { unlock = resolve; });
    const service = new UpdateService({ root, appVersion: '1.7.1', env: { BAIZELINGTAI_UPDATE_FEED_URL: release.feed }, platform: 'win32', arch: 'x64' });
    service.pivane = async () => { await held; return { ...release, status: 'available' }; };
    mountUpdateRoutes(router, service, { maintenance, idle: () => true, pause() {} });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const post = (route, body) => fetch(`http://127.0.0.1:${server.address().port}/api/pi/settings/updates/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const first = post('review', { action: 'application' });
    while (!maintenance.active) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await post('review', { action: 'application' })).status, 409); unlock();
    const reviewed = await first; assert.equal(reviewed.status, 200); const ticket = await reviewed.json();
    assert.equal(ticket.release.sha256, release.sha256); assert.equal(ticket.release.downloadUrl, release.downloadUrl); assert.equal(maintenance.active, 0);
    assert.equal((await post('execute', { ticket: ticket.id, confirmed: true, draftsSaved: true, externalWritersStopped: true, version: '99.0.0' })).status, 400);
    const input = { ticket: ticket.id, confirmed: true, draftsSaved: true, externalWritersStopped: true };
    assert.equal((await post('execute', input)).status, 202); assert.equal((await post('execute', input)).status, 409); assert.equal(sent.length, 1);
});
test('changed manifest or unpublished source stops portable staging before download', { skip: process.platform !== 'win32' }, async t => {
    const dir = fixture(t); fs.mkdirSync(path.join(dir, 'runtime')); fs.writeFileSync(path.join(dir, 'runtime/node.exe'), 'fixture');
    fs.writeFileSync(path.join(dir, 'baizelingtai-portable.json'), JSON.stringify({ version: 1, platform: 'win32', arch: 'x64' }));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"1.7.1"}');
    fs.writeFileSync(path.join(dir, 'TRIAL_MANIFEST.json'), JSON.stringify({ files: [{ path: 'package.json', bytes: 19, sha256: hash(Buffer.from('{"version":"1.7.1"}')) }] }));
    const app = express(); let downloads = 0;
    const sign = signatures.signer(dir);
    app.get('/latest.json', (_req, res) => res.json(sign({ ...signatures.manifest(plan()), version: '1.7.3', package: 'app.zip' })));
    app.get('/app.zip', (_req, res) => { downloads++; res.send('hello'); });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const release = plan(`http://127.0.0.1:${server.address().port}/latest.json`);
    release.signedManifest = sign(signatures.manifest(release));
    const env = { BAIZELINGTAI_UPDATE_FEED_URL: release.feed };
    // Correct the byte count explicitly, so this exercises target drift, not a fixture error.
    const manifestFile = path.join(dir, 'TRIAL_MANIFEST.json'), manifest = JSON.parse(fs.readFileSync(manifestFile)); manifest.files[0].bytes = fs.statSync(path.join(dir, 'package.json')).size; fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    await assert.rejects(stagePortable({ root: dir, directory: path.join(dir, 'candidate'), release, env }), /target changed/);
    fs.appendFileSync(path.join(dir, 'package.json'), ' ');
    await assert.rejects(stagePortable({ root: dir, directory: path.join(dir, 'candidate'), release, env }), /unpublished changes/);
    assert.equal(downloads, 0); assert.equal(fs.existsSync(path.join(dir, 'candidate')), false);
});
