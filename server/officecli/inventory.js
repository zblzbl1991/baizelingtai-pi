const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function target(platform = process.platform, arch = process.arch, musl) {
    if (musl === undefined && platform === 'linux') musl = !process.report.getReport().header.glibcVersionRuntime;
    return `${platform}${platform === 'linux' && musl ? '-musl' : ''}-${arch}`;
}
function inventory(base = root, key = target()) {
    const manifest = JSON.parse(fs.readFileSync(path.join(base, 'config/officecli.json'), 'utf8'));
    const asset = manifest.assets?.[key];
    if (manifest.version !== 1 || manifest.release !== '1.0.157' || manifest.source !== 'https://github.com/iOfficeAI/OfficeCLI'
        || manifest.sourceRef !== 'b65272a18aef891941451705ff93e8a287f3eb72' || manifest.license !== 'Apache-2.0') throw Error('OfficeCLI manifest requires version review');
    if (!asset || !/^officecli-[a-z0-9-]+(?:\.exe)?$/.test(asset.name) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw Error(`OfficeCLI does not support ${key}`);
    const relative = `native/officecli/bin/${asset.name}`;
    return { ...asset, release: manifest.release, relative, path: path.join(base, relative),
        url: `${manifest.source}/releases/download/v${manifest.release}/${asset.name}` };
}
function verify(base = root, key = target()) {
    const asset = inventory(base, key), canonical = fs.realpathSync.native(base);
    for (const relative of ['native', 'native/officecli', 'native/officecli/bin', asset.relative]) {
        const requested = path.join(canonical, relative), stat = fs.lstatSync(requested);
        if (stat.isSymbolicLink() || fs.realpathSync.native(requested) !== requested
            || (relative === asset.relative ? !stat.isFile() || stat.size > 96 * 1024 * 1024 : !stat.isDirectory())) throw Error('OfficeCLI program location is not regular');
    }
    if (digest(fs.readFileSync(asset.path)) !== asset.sha256) throw Error('OfficeCLI program checksum mismatch; run node scripts/install-officecli.cjs');
    return asset;
}
function distributionFiles(base = root) {
    return ['config/officecli.json', 'native/officecli/LICENSE', 'native/officecli/NOTICE', 'native/officecli/THIRD-PARTY-NOTICES.txt', verify(base).relative];
}
module.exports = { root, digest, target, inventory, verify, distributionFiles };
