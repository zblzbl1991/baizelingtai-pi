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
    if (manifest.signature !== undefined) result.signature = JSON.parse(JSON.stringify(manifest.signature));
    return result;
}
function trustedKeys(root) {
    let trust;
    try { trust = JSON.parse(readSafe(trustFile(root), 64 * 1024)); }
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
function verifyFeedSignature(manifest, installationRoot) {
    const keys = trustedKeys(installationRoot), signature = manifest?.signature;
    if (!signature || signature.algorithm !== 'ed25519' || !keys.has(signature.keyId)
        || typeof signature.value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature.value)
        || Object.keys(signature).some(key => !['algorithm', 'keyId', 'value'].includes(key))) throw Error('Untrusted update signature');
    const bytes = Buffer.from(signature.value, 'base64'), payload = releaseSignaturePayload(manifest);
    if (bytes.length !== 64 || bytes.toString('base64') !== signature.value || !verify(null, payload, keys.get(signature.keyId), bytes)) throw Error('Invalid update signature');
    return { keyId: signature.keyId, payloadSha256: createHash('sha256').update(payload).digest('hex') };
}
function verifyReleaseSignature(release, installationRoot) {
    const manifest = release?.signedManifest;
    const proof = verifyFeedSignature(manifest, installationRoot);
    const { sourceLink } = require('./pi-update-feed');
    if (release.format !== 'windows-portable-zip' || manifest.platform !== 'win32' || manifest.arch !== 'x64'
        || !['stable', 'preview'].includes(release.channel) || release.channel === 'stable' && manifest.channel !== 'stable'
        || ['version', 'piVersion', 'bytes', 'sha256'].some(field => release[field] !== manifest[field])
        || sourceLink(manifest.package, release.feed) !== release.downloadUrl) throw Error('Signed portable target mismatch');
    return proof;
}
module.exports = { releaseSignaturePayload, signedManifest, signatureRequired, verifyFeedSignature, verifyReleaseSignature };
