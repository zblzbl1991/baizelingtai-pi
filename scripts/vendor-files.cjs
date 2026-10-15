const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
function vendorFiles(root, { verify = true, packageName } = {}) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor/manifest.json'), 'utf8'));
    if (manifest.version !== 1 || !Array.isArray(manifest.packages)) throw new Error('Invalid vendor manifest');
    const files = ['vendor/manifest.json'], seen = new Set();
    if (packageName && !manifest.packages.some(pkg => pkg.name === packageName)) throw new Error('Unknown vendor package');
    for (const pkg of manifest.packages) {
        if (packageName && pkg.name !== packageName) continue;
        const directory = pkg.directory || pkg.name;
        if (!/^(?:@[a-z-]+\/)?[a-z][a-z0-9-]+$/.test(pkg.name) || !/^[a-z][a-z0-9-]+$/.test(directory)
            || !Array.isArray(pkg.files) || pkg.kind !== undefined && pkg.kind !== 'skill') throw new Error('Invalid vendor package');
        for (const file of pkg.files) {
            if (!file.path.startsWith(`vendor/${directory}/`) || file.path.split('/').some(p => !p || p === '.' || p === '..' || p === 'node_modules')
                || file.path.includes('\\') || seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid vendor file');
            seen.add(file.path);
            const full = path.join(root, file.path);
            if (!fs.lstatSync(full).isFile() || fs.realpathSync(full) !== full) throw new Error(`Vendor file is not regular: ${file.path}`);
            if (verify && createHash('sha256').update(fs.readFileSync(full)).digest('hex') !== file.sha256) throw new Error(`Upstream source changed: ${file.path}`);
            files.push(file.path);
        }
        if (pkg.kind === 'skill') {
            const skill = fs.readFileSync(path.join(root, 'vendor', directory, 'SKILL.md'), 'utf8');
            // Standalone skills have no npm metadata; pin their original name,
            // source ref and license in the same reviewed file manifest.
            const name = /^---\r?\n[\s\S]*?^name:\s*([^\r\n]+)$/m.exec(skill)?.[1];
            if (name !== pkg.name || !/^[a-f0-9]{40}$/.test(pkg.version) || pkg.license !== 'AGPL-3.0-only'
                || !pkg.files.some(file => file.path === `vendor/${directory}/LICENSE`)) throw new Error('Vendor skill identity mismatch');
        } else {
            const metadata = JSON.parse(fs.readFileSync(path.join(root, 'vendor', directory, 'package.json'), 'utf8'));
            if (metadata.name !== pkg.name || metadata.version !== pkg.version || metadata.license !== pkg.license) throw new Error('Vendor identity mismatch');
        }
    }
    return files;
}
module.exports = { vendorFiles };
