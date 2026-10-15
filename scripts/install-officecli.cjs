'use strict';
// Fixed release only. No global installation, PATH changes, skill installation or auto-update.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { root, inventory, verify, digest } = require('../server/officecli/inventory');
async function download(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || new URL(response.url).protocol !== 'https:') throw Error(`OfficeCLI download failed: ${response.status}`);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 96 * 1024 * 1024) throw Error('OfficeCLI download exceeds 96 MiB');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
async function install({ base = root, key, fetchBytes = download } = {}) {
    const asset = inventory(base, key);
    if (fs.existsSync(asset.path)) {
        verify(base, key);
        if (process.platform !== 'win32') fs.chmodSync(asset.path, 0o755);
        return asset;
    }
    const canonical = fs.realpathSync.native(base);
    for (const relative of ['native', 'native/officecli', 'native/officecli/bin']) {
        const directory = path.join(canonical, relative);
        try { fs.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(directory) !== directory) throw Error('OfficeCLI install directory is not regular');
    }
    const bytes = await fetchBytes(asset.url);
    if (!Buffer.isBuffer(bytes) || bytes.length > 96 * 1024 * 1024 || digest(bytes) !== asset.sha256) throw Error('OfficeCLI download checksum mismatch');
    const temporary = `${asset.path}.${randomUUID()}.tmp`;
    try {
        // Recheck after network I/O, and create without replacing another install.
        const directory = path.dirname(asset.path);
        if (fs.realpathSync.native(directory) !== directory || fs.lstatSync(directory).isSymbolicLink()) throw Error('OfficeCLI install directory changed');
        fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o755 });
        fs.linkSync(temporary, asset.path);
    } finally { fs.rmSync(temporary, { force: true }); }
    return verify(base, key);
}
if (require.main === module) install().then(asset => console.log(`OfficeCLI ${asset.release} verified for this platform`)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { install };
