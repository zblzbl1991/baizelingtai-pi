const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { signer } = require('./update-signature-helper.cjs');
const builder = path.resolve(__dirname, '../scripts/package-windows-portable.cjs');
function fixture(t) { const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-signed-delivery-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function run(args) { return spawnSync(process.execPath, [builder, ...args], { encoding: 'utf8', timeout: 15000, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP } }); }

test('Windows build preview requires explicitly supplied trusted public keys and separates unsigned outputs', t => {
    const root = fixture(t); signer(root);
    const args = ['--dry-run', '--update-trust', path.join(root, 'config/update-trust.json'), '--update-feed-url', 'https://updates.example/latest.json'];
    const result = run(args); assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.launcherUpdateProtocol, 1); assert.equal(plan.offlineBundle, null);
    assert.match(plan.unsignedManifest, /\.update\.unsigned\.json$/); assert.equal(plan.signedManifest, null);
    assert.equal(run(['--dry-run', '--update-feed-url', 'https://updates.example/latest.json']).status, 1);
    fs.writeFileSync(path.join(root, 'config/update-trust.json'), JSON.stringify({ schemaVersion: 1, keys: [], privateKey: 'never-print-this-private-field' }));
    const invalid = run(args); assert.equal(invalid.status, 1); assert.ok(!invalid.stderr.includes('never-print-this-private-field'));
});

test('offline assembly rejects an unsigned feed before producing a transfer ZIP', { skip: process.platform !== 'win32' }, t => {
    const root = fixture(t), app = path.join(root, 'baizelingtai-1.8.0'); fs.mkdirSync(app); fs.writeFileSync(path.join(app, 'hello.txt'), 'synthetic');
    const packaging = require('../scripts/package-windows-portable.cjs'), { createHash } = require('node:crypto');
    const archive = app + '.zip', bundle = app + '-offline.zip'; packaging.createPortableArchive(app, archive);
    const bytes = fs.readFileSync(archive), sha256 = createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(archive + '.sha256', `${sha256}  ${path.basename(archive)}\n`);
    const data = packaging.updateManifest({ archive, sha256, bytes: bytes.length, appVersion: '1.8.0', piVersion: '1.1.0', options: { feed: 'https://updates.example/latest.json' } });
    fs.writeFileSync(archive + '.update.json', JSON.stringify(data)); const sign = signer(root);
    assert.throws(() => packaging.createOfflineBundle(archive, bundle, { manifestFile: archive + '.update.json', trustFile: path.join(root, 'config/update-trust.json'), feed: 'https://updates.example/latest.json' }));
    assert.equal(fs.existsSync(bundle), false);
    const signed = sign(data); fs.writeFileSync(archive + '.update.json', JSON.stringify(signed));
    const args = ['--bundle-only', archive, '--signed-manifest', archive + '.update.json', '--update-trust', path.join(root, 'config/update-trust.json'), '--update-feed-url', 'https://updates.example/latest.json'];
    const result = run(args); assert.equal(result.status, 0, result.stderr);
    const published = JSON.parse(result.stdout); assert.equal(published.offlineBundle, bundle);
    assert.equal(published.offlineBundleSha256, createHash('sha256').update(fs.readFileSync(bundle)).digest('hex'));
    const original = fs.readFileSync(bundle); assert.equal(run(args).status, 1); assert.deepEqual(fs.readFileSync(bundle), original);
    fs.unlinkSync(bundle); fs.appendFileSync(archive, 'changed');
    assert.equal(run(args).status, 1); assert.equal(fs.existsSync(bundle), false);
});
