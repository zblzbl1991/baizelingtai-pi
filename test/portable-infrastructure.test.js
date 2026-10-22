const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { generateKeyPairSync } = require('node:crypto');
const packaging = require('../scripts/package-windows-portable.cjs');

test('portable public trust and independent repair layout is added from a tiny synthetic input', t => {
    const app = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-portable-tiny-')));
    t.after(() => fs.rmSync(app, { recursive: true, force: true }));
    const inputs = ['runtime/node.exe', 'runtime/LICENSE', 'LICENSE', 'scripts/repair-launcher.cjs', 'scripts/launcher-process-wait.ps1',
        'native/pi-win32-fd.c', 'native/pi-win32-x64-fd.node', 'native/win32-x64-manifest.json'];
    for (const name of inputs) { fs.mkdirSync(path.dirname(path.join(app, name)), { recursive: true }); fs.writeFileSync(path.join(app, name), name.endsWith('.cjs') ? '// synthetic no-import repair entry' : 'synthetic input'); }
    const keys = generateKeyPairSync('ed25519'), trustBytes = Buffer.from(JSON.stringify({ schemaVersion: 1,
        keys: [{ keyId: 'synthetic', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) }] }));
    packaging.installPortableInfrastructure(app, { trustBytes, updateFeedUrl: 'https://updates.example/latest.json' });
    const metadata = JSON.parse(fs.readFileSync(path.join(app, 'baizelingtai-portable.json')));
    assert.equal(metadata.launcherUpdateProtocol, 1); assert.equal(metadata.desktopOwnerProtocol, 1); assert.equal(metadata.updateFeedUrl, 'https://updates.example/latest.json');
    assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'config/update-trust.json'))).keys[0].keyId, 'synthetic');
    assert.equal(fs.readFileSync(path.join(app, 'repair/runtime/node.exe'), 'utf8'), 'synthetic input');
    assert.equal(fs.readFileSync(path.join(app, 'repair/runtime/LICENSE'), 'utf8'), 'synthetic input');
    assert.match(fs.readFileSync(path.join(app, '修复白泽灵台.cmd'), 'utf8'), /diagnose/);
});
