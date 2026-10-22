const fs = require('node:fs');
const path = require('node:path');

// Only deployment/build configuration selects a source; HTTP callers cannot supply URLs.
function feedUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\s\x00-\x1f]/.test(value)) throw Error('Invalid update feed URL');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
        || [...url.searchParams.keys()].some(key => key !== 'ref')) throw Error('Invalid update feed URL');
    return url.href;
}

function portableMetadataFile(root) {
    const file = path.join(root, 'baizelingtai-portable.json'), legacy = path.join(root, 'pivane-portable.json');
    if (fs.existsSync(file) && fs.existsSync(legacy)) throw Error('Conflicting portable metadata files');
    return fs.existsSync(legacy) ? legacy : file;
}

function configuredFeed(root, env) {
    const setting = env.BAIZELINGTAI_UPDATE_FEED_URL ?? env.PIVANE_UPDATE_FEED_URL;
    if (setting !== undefined) return setting ? feedUrl(setting) : null;
    const file = portableMetadataFile(root);
    try {
        const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
        return metadata.updateFeedUrl ? feedUrl(metadata.updateFeedUrl) : null;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw Error('Cannot read portable update source');
    }
}

function sourceLink(value, source) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\s\x00-\x1f]/.test(value)) throw Error('Invalid update link');
    const url = new URL(value, source);
    if (url.origin !== new URL(source).origin || url.username || url.password || url.hash
        || [...url.searchParams.keys()].some(key => key !== 'ref')) throw Error('Invalid update link');
    return url.href;
}

function parseFeed(data, { source, platform, arch, channel, compareVersions, releasesUrl: fallbackReleasesUrl }) {
    if (!data || data.schemaVersion !== 1 || compareVersions(data.version, data.version) !== 0
        || compareVersions(data.piVersion, data.piVersion) !== 0
        || !['stable', 'preview'].includes(data.channel) || (data.channel === 'stable' && data.version.includes('-'))
        || data.platform !== 'win32' || data.arch !== 'x64'
        || !Number.isFinite(Date.parse(data.publishedAt)) || !/^[a-f0-9]{64}$/.test(data.sha256 || '')
        || !Number.isSafeInteger(data.bytes) || data.bytes <= 0) throw Error('Invalid update feed');
    const downloadUrl = sourceLink(data.package, source);
    if (!new URL(downloadUrl).pathname.endsWith('.zip')) throw Error('Invalid Windows update package');
    const releasesUrl = sourceLink(data.releasesUrl || fallbackReleasesUrl || source, source);
    if (platform !== data.platform || arch !== data.arch || (channel === 'stable' && data.channel !== 'stable')) return null;
    return { version: data.version, piVersion: data.piVersion, prerelease: data.channel === 'preview',
        releasesUrl, downloadUrl, sha256: data.sha256, bytes: data.bytes, publishedAt: data.publishedAt,
        packageFormat: 'windows-portable-zip', ...(data.signature !== undefined ? { signedManifest: require('./pi-update-signatures').signedManifest(data) } : {}) };
}

module.exports = { feedUrl, configuredFeed, sourceLink, parseFeed, portableMetadataFile };
