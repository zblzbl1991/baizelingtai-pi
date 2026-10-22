const fs = require('node:fs');
const path = require('node:path');
const { createPublicKey, verify, createHash } = require('node:crypto');
const { readSafe } = require('./pi-maintenance-files');

const FIELDS = ['schemaVersion', 'version', 'piVersion', 'platform', 'arch', 'channel', 'publishedAt', 'package', 'sha256', 'bytes', 'releasesUrl'];
const trustFile = root => path.join(root, 'config/update-trust.json');
function signatureRequired(root) {
    // lstat keeps a dangling link or malformed trust file from disabling verification.
    try { fs.lstatSync(trustFile(root)); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { portableMetadataFile } = require('./pi-update-feed');
    try { return JSON.parse(readSafe(portableMetadataFile(root), 64 * 1024)).launcherUpdateProtocol !== undefined; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function releaseSignaturePayload(manifest) {
    if (!manifest || FIELDS.slice(1, 9).some(field => typeof manifest[field] !== 'string')
        || manifest.schemaVersion !== 1 || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0
        || manifest.releasesUrl !== undefined && typeof manifest.releasesUrl !== 'string') throw Error('Invalid signed update payload');
    return Buffer.from(JSON.stringify(['pivane-release-v1', ...FIELDS.map(field => manifest[field] ?? null)]), 'utf8');
}
function signedManifest(manifest) {
    // Snapshot only protocol fields. Remote key declarations have no authority.
    const result = Object.fromEntries(FIELDS.filter(field => manifest[field] !== undefined).map(field => [field, manifest[field]]));
    if (manifest.signature !== undefined) result.signature = Object.freeze(JSON.parse(JSON.stringify(manifest.signature)));
    return Object.freeze(result);
}
function trustedKeys(root, bytes) {
    let trust;
    try { trust = JSON.parse(bytes || readSafe(trustFile(root), 64 * 1024)); }
    catch { throw Error('Trusted update keys unavailable'); }
    if (trust?.schemaVersion !== 1 || !Array.isArray(trust.keys) || !trust.keys.length || trust.keys.length > 16) throw Error('Invalid trusted update keys');
    const result = new Map();
    for (const entry of trust.keys) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(entry?.keyId || '') || result.has(entry.keyId)
            || typeof entry.publicKey !== 'string' || entry.publicKey.length > 4096
            || !/^-----BEGIN PUBLIC KEY-----\r?\n/.test(entry.publicKey)) throw Error('Invalid trusted update key');
        const key = createPublicKey(entry.publicKey);
        if (key.asymmetricKeyType !== 'ed25519') throw Error('Invalid trusted update key algorithm');
        result.set(entry.keyId, key);
    }
    return result;
}
function verifySignature(signature, payload, keys) {
    if (!signature || signature.algorithm !== 'ed25519' || !keys.has(signature.keyId)
        || typeof signature.value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature.value)
        || Object.keys(signature).some(key => !['algorithm', 'keyId', 'value'].includes(key))) throw Error('Untrusted update signature');
    const bytes = Buffer.from(signature.value, 'base64');
    if (bytes.length !== 64 || bytes.toString('base64') !== signature.value || !verify(null, payload, keys.get(signature.keyId), bytes)) throw Error('Invalid update signature');
    return { keyId: signature.keyId, payloadSha256: createHash('sha256').update(payload).digest('hex') };
}
function readUpdateTrust(bytes) {
    let trust;
    try { trust = JSON.parse(bytes); } catch { throw Error('Invalid update public trust document'); }
    if (!trust || Object.keys(trust).some(key => !['schemaVersion', 'keys'].includes(key))
        || !Array.isArray(trust.keys) || trust.keys.some(key => !key || Object.keys(key).some(name => !['keyId', 'publicKey'].includes(name)))) throw Error('Invalid update public trust document');
    const keys = trustedKeys('', bytes);
    return { schemaVersion: 1, keys: [...keys].map(([keyId, key]) => ({ keyId, publicKey: key.export({ type: 'spki', format: 'pem' }) })) };
}
function verifyFeedSignatureWithTrust(manifest, trustBytes) {
    readUpdateTrust(trustBytes);
    return verifySignature(manifest?.signature, releaseSignaturePayload(manifest), trustedKeys('', trustBytes));
}
function verifyFeedSignature(manifest, installationRoot) {
    return verifySignature(manifest?.signature, releaseSignaturePayload(manifest), trustedKeys(installationRoot));
}
function trustRotationPayload(rotation) {
    if (rotation?.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(rotation.previousTrustSha256 || '')) throw Error('Invalid update key rotation');
    const trust = { schemaVersion: 1, keys: rotation.keys };
    trustedKeys('', Buffer.from(JSON.stringify(trust)));
    const keys = [...rotation.keys].sort((a, b) => a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0).map(key => [key.keyId, key.publicKey]);
    return Buffer.from(JSON.stringify(['pivane-update-key-rotation-v1', 1, rotation.previousTrustSha256, keys]), 'utf8');
}
function verifyTrustRotation(rotation, installationRoot) {
    // Read only: the caller must own the installation lock, obtain explicit local
    // authorization and install atomically. Feeds never call this function.
    const current = readSafe(trustFile(installationRoot), 64 * 1024);
    if (createHash('sha256').update(current).digest('hex') !== rotation?.previousTrustSha256) throw Error('Update trust changed; rotation refused');
    verifySignature(rotation.signature, trustRotationPayload(rotation), trustedKeys(installationRoot, current));
    return { schemaVersion: 1, keys: rotation.keys.map(key => ({ keyId: key.keyId, publicKey: key.publicKey })) };
}
function verifyReleaseSignature(release, installationRoot) {
    const manifest = release?.signedManifest;
    const proof = verifyFeedSignature(manifest, installationRoot);
    const { sourceLink, feedUrl } = require('./pi-update-feed');
    if (feedUrl(release.feed) !== release.feed || release.format !== 'windows-portable-zip' || manifest.platform !== 'win32' || manifest.arch !== 'x64'
        || !['stable', 'preview'].includes(manifest.channel) || !['stable', 'preview'].includes(release.channel) || release.channel === 'stable' && manifest.channel !== 'stable'
        || ['version', 'piVersion', 'bytes', 'sha256'].some(field => release[field] !== manifest[field])
        || sourceLink(manifest.package, release.feed) !== release.downloadUrl || !new URL(release.downloadUrl).pathname.endsWith('.zip')) throw Error('Signed portable target mismatch');
    return proof;
}
module.exports = { readUpdateTrust, verifyFeedSignatureWithTrust, releaseSignaturePayload, signedManifest, signatureRequired, verifyFeedSignature, verifyReleaseSignature, trustRotationPayload, verifyTrustRotation };
