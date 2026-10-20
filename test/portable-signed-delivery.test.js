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
    fs.writeFileSync(path.join(root, 'config/update-trust.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(root, 'config/update-trust.json'))), privateKey: 'never-print-this-private-field' }));
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
    fs.unlinkSync(bundle);
    fs.writeFileSync(archive + '.update.json', JSON.stringify(sign({ ...data, version: '1.9.0' })));
    assert.equal(run(args).status, 1); assert.equal(fs.existsSync(bundle), false);
    fs.writeFileSync(archive + '.update.json', JSON.stringify(signed));
    fs.appendFileSync(archive, 'changed');
    assert.equal(run(args).status, 1); assert.equal(fs.existsSync(bundle), false);
});

test('portable repair distribution is independent of the primary program and includes its own Node and public trust', { skip: process.platform !== 'win32', timeout: 120000 }, t => {
    const program = path.resolve(__dirname, '..'), base = fixture(t), app = path.join(base, 'baizelingtai-fixture'); fs.mkdirSync(app);
    const files = require('../server/pi-launcher-repair').repairFiles(program);
    for (const file of files) { fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true }); fs.copyFileSync(path.join(program, file), path.join(app, file)); }
    fs.mkdirSync(path.join(app, 'runtime')); fs.copyFileSync(process.execPath, path.join(app, 'runtime/node.exe')); fs.writeFileSync(path.join(app, 'runtime/LICENSE'), 'synthetic Node license marker'); fs.writeFileSync(path.join(app, 'LICENSE'), 'synthetic application license marker');
    signer(base); const trustBytes = fs.readFileSync(path.join(base, 'config/update-trust.json'));
    const packaging = require('../scripts/package-windows-portable.cjs');
    packaging.installPortableInfrastructure(app, { trustBytes, updateFeedUrl: 'https://updates.example/latest.json' });
    const inventory = packaging.inventory(app), names = new Set(inventory.map(file => file.path));
    for (const file of ['config/update-trust.json', 'baizelingtai-portable.json', 'repair/runtime/node.exe', 'repair/runtime/LICENSE', 'repair/LICENSE', 'repair/scripts/repair-launcher.cjs', '修复白泽灵台.cmd']) assert.ok(names.has(file), file);
    assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'baizelingtai-portable.json'))).launcherUpdateProtocol, 1);
    for (const file of files) assert.ok(names.has('repair/' + file), file);
    assert.equal(fs.readFileSync(path.join(app, 'repair/runtime/LICENSE'), 'utf8'), 'synthetic Node license marker');
    fs.mkdirSync(path.join(app, '.pivane-runtime')); const state = '{"version":1,"active":null,"previous":null}'; fs.writeFileSync(path.join(app, '.pivane-runtime/state.json'), state);
    // Only these synthetic, explicitly bounded fixture directories are removed.
    for (const directory of ['server', 'scripts']) { const target = path.join(app, directory); assert.equal(path.dirname(target), app); fs.rmSync(target, { recursive: true, force: true }); }
    const result = spawnSync(path.join(app, 'repair/runtime/node.exe'), [path.join(app, 'repair/scripts/repair-launcher.cjs'), 'diagnose', app], {
        encoding: 'utf8', timeout: 30000, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP } });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'manual-recovery');
    assert.equal(fs.readFileSync(path.join(app, '.pivane-runtime/state.json'), 'utf8'), state);
});
