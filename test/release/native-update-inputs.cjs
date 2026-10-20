const fs = require('node:fs');
const path = require('node:path');
const { hashFileSafe, readSafe } = require('../../server/pi-maintenance-files');
const signatures = require('../../server/pi-update-signatures');

// Independent acceptance comparison; no application/SDK initialization is needed.
function compareVersions(a, b) {
    const parts = value => {
        const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value || '');
        if (!match || match[4]?.split('.').some(part => /^\d+$/.test(part) && /^0\d/.test(part))) throw Error('Invalid exact package version');
        return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') || [] };
    };
    const left = parts(a), right = parts(b);
    for (let index = 0; index < 3; index++) if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
    if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
    for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
        const x = left.pre[index], y = right.pre[index];
        if (x === y) continue;
        if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
        const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
        if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
        if (xn !== yn) return xn ? -1 : 1;
        return x > y ? 1 : -1;
    }
    return 0;
}
function regularInput(file, directory = false) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || fs.realpathSync.native(file) !== file) throw Error('Acceptance input must have a canonical regular identity');
    return stat;
}
function localManifest(manifest) {
    if (manifest?.platform !== 'win32' || manifest.arch !== 'x64' || !['stable', 'preview'].includes(manifest.channel)
        || manifest.channel === 'stable' && manifest.version?.includes('-') || !Number.isFinite(Date.parse(manifest.publishedAt))) throw Error('Invalid Windows signed manifest');
    compareVersions(manifest.version, manifest.version); compareVersions(manifest.piVersion, manifest.piVersion);
    for (const link of [manifest.package, ...(manifest.releasesUrl === undefined ? [] : [manifest.releasesUrl])]) {
        if (typeof link !== 'string' || !link || /[\s\x00-\x1f]/.test(link)) throw Error('Expected a relative loopback delivery link');
        const url = new URL(link, 'http://127.0.0.1:1/');
        if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('//') || url.origin !== 'http://127.0.0.1:1'
            || url.hash || url.username || url.password || [...url.searchParams.keys()].some(key => key !== 'ref')) throw Error('Manifest must use relative QA delivery links');
    }
    if (!new URL(manifest.package, 'http://127.0.0.1:1/').pathname.endsWith('.zip')) throw Error('Signed target must be a ZIP');
}
function validateInputs(options) {
    for (const key of ['previousArchive', 'archive', 'signedManifest', 'qaTrust', 'browser']) regularInput(options[key]);
    regularInput(options.playwright, fs.lstatSync(options.playwright).isDirectory());
    for (const key of ['archive', 'previousArchive']) if (!/\.zip$/i.test(options[key])) throw Error('Explicit ZIP inputs required');
    const previous = hashFileSafe(options.previousArchive, 2 * 1024 ** 3), candidate = hashFileSafe(options.archive, 2 * 1024 ** 3);
    if (previous.sha256 !== options.previousSha256 || candidate.sha256 !== options.sha256) throw Error('Exact ZIP SHA256 mismatch');
    const trustBytes = readSafe(options.qaTrust, 64 * 1024), trust = signatures.readUpdateTrust(trustBytes);
    if (trust.keys.some(key => !/^qa-[a-zA-Z0-9._-]+$/.test(key.keyId))) throw Error('Acceptance requires explicitly synthetic qa-* public keys');
    const manifest = JSON.parse(readSafe(options.signedManifest, 64 * 1024));
    localManifest(manifest); const signature = signatures.verifyFeedSignatureWithTrust(manifest, trustBytes);
    if (!/^\d+\.\d+\.\d+$/.test(options.previousVersion) || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw Error('Native exact packages require three-part versions matching the existing compiler and tray contract');
    if (manifest.sha256 !== candidate.sha256 || manifest.bytes !== candidate.bytes) throw Error('Signed manifest does not bind the exact ZIP hash and bytes');
    if (compareVersions(manifest.version, options.previousVersion) !== 1) throw Error('Exact candidate version must increase');
    let changedManifest;
    if (options.changedManifest) {
        regularInput(options.changedManifest); changedManifest = JSON.parse(readSafe(options.changedManifest, 64 * 1024));
        localManifest(changedManifest); signatures.verifyFeedSignatureWithTrust(changedManifest, trustBytes);
        if (['version', 'piVersion', 'package', 'sha256', 'bytes'].every(key => manifest[key] === changedManifest[key])) throw Error('Changed target must bind a different signed target');
    }
    return { manifest, changedManifest, trustBytes, signature, artifacts: { previous, candidate,
        manifest: hashFileSafe(options.signedManifest, 64 * 1024), qaTrust: hashFileSafe(options.qaTrust, 64 * 1024) } };
}
module.exports = { validateInputs, compareVersions };
