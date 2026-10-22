// Synthetic publishing boundary; no production signing code or real publisher keys.
const { generateKeyPairSync, sign } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path');
function signer(root) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config/update-trust.json'), JSON.stringify({ schemaVersion: 1,
        keys: [{ keyId: 'test-publisher', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }] }));
    return data => {
        const payload = ['pivane-release-v1', data.schemaVersion, data.version, data.piVersion, data.platform, data.arch,
            data.channel, data.publishedAt, data.package, data.sha256, data.bytes, data.releasesUrl ?? null];
        return { ...data, signature: { algorithm: 'ed25519', keyId: 'test-publisher', value: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64') } };
    };
}
function manifest(release) {
    return { schemaVersion: 1, platform: 'win32', arch: 'x64', version: release.version, piVersion: release.piVersion,
        channel: release.channel, package: release.downloadUrl, bytes: release.bytes, sha256: release.sha256,
        publishedAt: '2026-10-20T00:00:00Z' };
}
module.exports = { signer, manifest };
