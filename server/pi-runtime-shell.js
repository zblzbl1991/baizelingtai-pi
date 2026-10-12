const fs = require('node:fs');
const path = require('node:path');

// Keep this at the public SDK settings boundary. Windows `where` can return
// OEM-encoded paths, which upstream's UTF-8 discovery cannot decode for Chinese
// installation directories. No settings file or upstream package is rewritten.
function runtimeShellPath(explicit, { root = path.resolve(__dirname, '..'), platform = process.platform } = {}) {
    if (explicit || platform !== 'win32') return explicit;
    for (const base of [root, path.dirname(root)]) {
        const candidate = path.join(base, 'tools/git/bin/bash.exe');
        try { if (fs.statSync(candidate).isFile()) return fs.realpathSync.native(candidate); }
        catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    return explicit;
}
module.exports = { runtimeShellPath };
