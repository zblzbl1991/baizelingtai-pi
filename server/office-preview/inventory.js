const fs = require('node:fs');
const path = require('node:path');
const { hashFileSafe, readSafe } = require('../pi-maintenance-files');
const VERSION = '0.1.1';
const KIT = '@deepseek-ai/libreoffice-kit';
const ENGINE = '@deepseek-ai/libreoffice-kit-win32-x64';
const root = path.resolve(__dirname, '../..');
const ASSETS = Object.freeze([
    { entry: 'public/office-preview/model.js', globalName: 'PiOfficeWorkbookModel', file: 'public/vendor/office-preview/workbook-model.js', url: '/vendor/office-preview/workbook-model.js' },
    { entry: 'public/office-preview/worker.js', file: 'public/vendor/office-preview/workbook-worker.js', url: '/vendor/office-preview/workbook-worker.js' },
    { file: 'public/vendor/office-preview/THIRD-PARTY-NOTICES.txt', url: '/vendor/office-preview/THIRD-PARTY-NOTICES.txt' }
]);
function packageDirectory(name, base = root, installationRoot = base) {
    let directory;
    try { directory = path.dirname(require.resolve(name + '/package.json', { paths: [base] })); }
    catch {
        directory = path.dirname(require.resolve(name, { paths: [base] }));
        while (!fs.existsSync(path.join(directory, 'package.json')) || JSON.parse(readSafe(path.join(directory, 'package.json'))).name !== name) {
            const parent = path.dirname(directory);
            if (parent === directory) throw Error('Office dependency manifest missing');
            directory = parent;
        }
    }
    directory = fs.realpathSync.native(directory);
    const modules = fs.realpathSync.native(path.join(installationRoot, 'node_modules'));
    if (!directory.startsWith(modules + path.sep)) throw Error('Office dependency escapes installation');
    return directory;
}
function dependencyClosure(base = root) {
    const found = new Map();
    function visit(name, from) {
        const directory = packageDirectory(name, from, base);
        if (found.has(directory)) return;
        const metadata = JSON.parse(readSafe(path.join(directory, 'package.json')));
        found.set(directory, { name: metadata.name, version: metadata.version, directory });
        for (const dependency of Object.keys(metadata.dependencies || {})) visit(dependency, directory);
    }
    visit(KIT, base); visit(ENGINE, base);
    return [...found.values()];
}
function packageFiles(directory) {
    const files = [];
    function visit(relative) {
        const current = path.join(directory, relative);
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (!relative && entry.name === 'node_modules') continue;
            const file = relative ? relative + '/' + entry.name : entry.name;
            if (entry.isSymbolicLink()) throw Error('Office package contains a symlink');
            if (entry.isDirectory()) visit(file);
            else if (entry.isFile()) files.push(file);
            else throw Error('Office package contains a nonregular object');
        }
    }
    visit(''); return files.sort();
}
function verifyRuntime(base = root) {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Office preview currently requires Windows x64');
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 19)) throw Error('Office preview requires Node >=22.19.0');
    const reviewed = JSON.parse(readSafe(path.join(base, 'config/office-preview-assets.json'), 4 * 1024 * 1024));
    const closure = dependencyClosure(base);
    if (reviewed.version !== VERSION || reviewed.platform !== 'win32-x64' || closure.length !== reviewed.packages.length) throw Error('Office engine inventory requires review');
    for (const item of closure) {
        const expected = reviewed.packages.find(p => p.name === item.name && p.version === item.version);
        if (!expected || ((item.name === KIT || item.name === ENGINE) && item.version !== VERSION)) throw Error('Office dependency version differs from reviewed inventory');
        if (JSON.stringify(packageFiles(item.directory)) !== JSON.stringify(Object.keys(expected.files).sort())) throw Error('Office package file inventory differs');
        for (const [relative, sha256] of Object.entries(expected.files)) {
            if (!/^[a-f0-9]{64}$/.test(sha256) || relative.split('/').some(part => !part || part === '..' || part === '.') || path.isAbsolute(relative) || relative.includes('\\')) throw Error('Unsafe Office inventory');
            const file = path.join(item.directory, relative);
            if (hashFileSafe(file, 512 * 1024 * 1024).sha256 !== sha256) throw Error('Office engine integrity failed; run node scripts/install.cjs');
        }
    }
    const engineDirectory = packageDirectory(ENGINE, base);
    const manifest = JSON.parse(readSafe(path.join(engineDirectory, 'prebuilds.json')));
    if (manifest.schemaVersion !== 1 || manifest.version !== VERSION || manifest.platform !== 'win32-x64' || manifest.status !== 'built' || manifest.engine?.kind !== 'native') throw Error('Office native metadata mismatch');
    for (const [file, sha256] of Object.entries(manifest.files)) if (hashFileSafe(path.join(engineDirectory, file), 512 * 1024 * 1024).sha256 !== sha256) throw Error('Office native checksum mismatch');
    return { version: VERSION, platform: 'win32-x64', kit: path.join(packageDirectory(KIT, base), 'lib/index.js'), engineDirectory, files: reviewed.packages.reduce((n,p) => n + Object.keys(p.files).length, 0) };
}
function distributionFiles() { return ['config/office-preview.json', 'config/office-preview-assets.json', ...ASSETS.map(asset => asset.file)]; }
function mountAssets(app, base = root) {
    for (const asset of ASSETS) app.get(asset.url, (_req, res) => res.sendFile(path.join(base, asset.file)));
}
module.exports = { VERSION, KIT, ENGINE, ASSETS, root, dependencyClosure, packageFiles, verifyRuntime, distributionFiles, mountAssets };
