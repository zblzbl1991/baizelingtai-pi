const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

function transactionFixture(t) {
    const { generateKeyPairSync, sign, createHash } = require('node:crypto');
    const { backupRoots, recordInstallation, atomicJson } = require('../server/pi-maintenance-files');
    const { releaseSignaturePayload } = require('../server/pi-update-signatures');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-activation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const releaseId = randomUUID(), backupId = randomUUID();
    const candidate = path.join(root, '.pivane-runtime/releases', releaseId);
    const sha = bytes => createHash('sha256').update(bytes).digest('hex');
    const write = (base, name, value) => { const file = path.join(base, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
    const native = (base, version) => {
        for (const name of ['native/pivane-desktop-launcher.cs', 'native/pivane-desktop-launcher.manifest', 'public/brand/favicon.ico']) write(base, name, 'synthetic native input');
        write(base, 'native/pivane-desktop-launcher-build.json', JSON.stringify({ version: 1, appVersion: version,
            sourceSha256: sha('synthetic native input'), manifestSha256: sha('synthetic native input'), iconSha256: sha('synthetic native input'), binarySha256: sha(fs.readFileSync(path.join(base, '白泽灵台.exe'))) }));
    };
    write(root, '白泽灵台.exe', 'old fixed entry');
    write(root, 'package.json', JSON.stringify({ name: 'pivane', version: '1.8.0' }));
    native(root, '1.8.0');
    const source = ['白泽灵台.exe', 'package.json'].map(name => ({ path: name, bytes: fs.statSync(path.join(root, name)).size, sha256: sha(fs.readFileSync(path.join(root, name))) }));
    write(root, 'TRIAL_MANIFEST.json', JSON.stringify({ files: source }));
    write(candidate, '白泽灵台.exe', 'new fixed entry');
    write(candidate, 'package.json', JSON.stringify({ name: 'pivane', version: '1.9.0' }));
    write(candidate, 'server.js', '// synthetic service entry');
    write(candidate, 'package-lock.json', JSON.stringify({ version: '1.9.0' }));
    native(candidate, '1.9.0');
    const files = ['白泽灵台.exe', 'package.json', 'server.js', 'package-lock.json', 'native/pivane-desktop-launcher.cs', 'native/pivane-desktop-launcher.manifest', 'public/brand/favicon.ico', 'native/pivane-desktop-launcher-build.json'].map(name => ({ path: name, bytes: fs.statSync(path.join(candidate, name)).size, sha256: sha(fs.readFileSync(path.join(candidate, name))) }));
    write(candidate, 'PORTABLE_MANIFEST.json', JSON.stringify({ version: 1, appVersion: '1.9.0', platform: 'win32', arch: 'x64', files }));
    write(candidate, 'PI_INSTALL_COMPLETE.json', JSON.stringify({ version: '0.85.1', appVersion: '1.9.0', archiveSha256: 'a'.repeat(64), lockSha256: sha(fs.readFileSync(path.join(candidate, 'package-lock.json'))) }));
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    write(root, 'config/update-trust.json', JSON.stringify({ schemaVersion: 1, keys: [{ keyId: 'test', publicKey: publicKey.export({ format: 'pem', type: 'spki' }) }] }));
    const signedManifest = { schemaVersion: 1, version: '1.9.0', piVersion: '0.85.1', platform: 'win32', arch: 'x64', channel: 'stable', publishedAt: '2026-10-20T00:00:00Z', package: 'portable.zip', sha256: 'a'.repeat(64), bytes: 100 };
    signedManifest.signature = { algorithm: 'ed25519', keyId: 'test', value: sign(null, releaseSignaturePayload(signedManifest), privateKey).toString('base64') };
    const release = { version: '1.9.0', piVersion: '0.85.1', channel: 'stable', format: 'windows-portable-zip', feed: 'https://example.test/latest.json', downloadUrl: 'https://example.test/portable.zip', sha256: 'a'.repeat(64), bytes: 100, signedManifest };
    write(root, 'data/value.txt', 'before update');
    const backup = path.join(root, '.pivane-runtime/backups', backupId);
    backupRoots([path.join(root, 'data')], backup);
    recordInstallation(backup, { release: null, package: { version: '1.8.0' }, lock: {} });
    const state = { version: 1, active: null, previous: null, runtimePaths: { PI_CODING_AGENT_DIR: path.join(root, 'data') } };
    atomicJson(path.join(root, '.pivane-runtime/state.json'), state);
    return { root, candidate, releaseId, backupId, release, state, shutdownProof: { complete: true, generation: 'old-generation' } };
}

module.exports = { transactionFixture };
