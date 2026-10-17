const fs = require('node:fs');
const path = require('node:path');
const { ASSETS, root } = require('../server/office-preview/inventory');
function build(base = root) {
    for (const asset of ASSETS.filter(item => item.entry)) {
        const result = require('esbuild').buildSync({ absWorkingDir: base, entryPoints: [asset.entry], bundle: true, platform: 'browser', format: 'iife',
            ...(asset.globalName ? { globalName: asset.globalName } : {}), target: 'es2020', legalComments: 'inline', write: false, minify: true });
        const file = path.join(base, asset.file); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, result.outputFiles[0].contents);
    }
    const notices = [
        ['SheetJS Community Edition 0.20.3', 'xlsx/LICENSE'], ['fflate 0.8.3', 'fflate/LICENSE'], ['sax 1.6.1', 'sax/LICENSE.md']
    ].map(([name, file]) => name + '\n' + fs.readFileSync(path.join(base, 'node_modules', file), 'utf8')).join('\n\n');
    fs.writeFileSync(path.join(base, ASSETS.find(asset => !asset.entry).file), notices);
}
if (require.main === module) { try { build(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { build };
