const fs = require('node:fs');
const path = require('node:path');

// Application source discovery is shared by checking, testing and packaging.
// Data, vendored assets and maintainer records are never discovered as source.
const GROUPS = Object.freeze({
    server: { directory: 'server', extensions: ['.js', '.mjs', '.ts'] },
    public: { directory: 'public', extensions: ['.js', '.css', '.html'], excluded: ['vendor', 'brand', 'images', 'videos', 'audio', 'downloads', 'legacy-workspace'] },
    scripts: { directory: 'scripts', extensions: ['.cjs', '.ps1'] },
    packages: { directory: 'pi-packages', extensions: ['.json', '.js', '.cjs', '.mjs', '.ts'] },
    tests: { directory: 'test', pattern: /\.test\.js$/ },
    testSupport: { directory: 'test', extensions: ['.js', '.cjs', '.mjs', '.ts'] },
    browser: { directory: 'test/browser', extensions: ['.cjs'] },
    release: { directory: 'test/release', extensions: ['.cjs'] }
});

function sourceFiles(root, group) {
    const rule = GROUPS[group];
    if (!rule) throw new Error(`Unknown source group: ${group}`);
    const files = [];
    function visit(relative) {
        const directory = path.join(root, relative);
        if (fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Source directory is a symlink: ${relative}`);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            if (entry.name.startsWith('.') || rule.excluded?.includes(entry.name) || ['node_modules', 'backups', 'pivane-usage', 'pivane-cron', 'pivane-uploads', 'pivane-queue', 'pivane-session-moves', 'pivane-artifacts'].includes(entry.name) || /\.bak(?:[.-]|$)|\.tmp$|~$/i.test(entry.name)) continue;
            const file = `${relative}/${entry.name}`;
            if (entry.isSymbolicLink()) throw new Error(`Source entry is a symlink: ${file}`);
            if (entry.isDirectory()) visit(file);
            else if (entry.isFile() && (rule.pattern ? rule.pattern.test(entry.name) : rule.extensions.includes(path.extname(entry.name)))) files.push(file);
        }
    }
    visit(rule.directory);
    return files;
}

function verifyBundledMemory(root) {
    const file = path.join(root, 'server/profile-memory/upstream-bundle.mjs');
    const message = 'Bundled memory is missing or differs from the reviewed build; run node scripts/install.cjs before packaging';
    try {
        if (!fs.lstatSync(file).isFile() || fs.realpathSync.native(file) !== path.join(fs.realpathSync.native(root), 'server/profile-memory/upstream-bundle.mjs')) throw new Error(message);
        const digest = require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if (digest !== require('../server/profile-memory/management').BUNDLE_SHA256) throw new Error(message);
    } catch (error) { throw new Error(message, { cause: error }); }
}

function distributionFiles(root) {
    verifyBundledMemory(root);
    verifyDesktopLauncher(root);
    const { publicDocumentation, assertPublicPath } = require('./check-docs.cjs');
    const files = [
        ...publicDocumentation(root), 'docs/public-files.json',
        ...require('./vendor-files.cjs').vendorFiles(root),
        ...require('../server/officecli/inventory').distributionFiles(root),
        'native/pi-win32-fd.c', 'native/pi-win32-x64-fd.node', 'native/win32-x64-manifest.json',
        'native/pi-darwin-fd.c', 'native/pi-darwin-fd.node', 'native/darwin-fd-manifest.json',
        'package.json', 'package-lock.json', 'LICENSE', 'server.js', '.env.example', '.gitignore', 'scripts/windows-portable-assets.json',
        '白泽灵台.exe', '启动白泽灵台.vbs', '启动白泽灵台.cmd',
        'native/pivane-desktop-launcher.cs', 'native/pivane-desktop-launcher.manifest', 'native/pivane-desktop-launcher-build.json',
        'public/vendor/mermaid-11.17.2.min.js', 'public/vendor/mermaid-LICENSE.txt',
        'public/vendor/katex-0.18.7/katex.min.js', 'public/vendor/katex-0.18.7/katex.min.css', 'public/vendor/katex-0.18.7/LICENSE',
        'public/brand/fontawesome-6.4.0/css/all.min.css', 'public/brand/fontawesome-6.4.0/LICENSE.txt',
        ...['fa-brands-400', 'fa-regular-400', 'fa-solid-900', 'fa-v4compatibility'].flatMap(name => ['woff2', 'ttf'].map(ext => `public/brand/fontawesome-6.4.0/webfonts/${name}.${ext}`)),
        'public/site.webmanifest', 'public/brand/logo.svg', 'public/brand/logo-dark.svg', 'public/brand/logo-app.svg',
        'public/brand/logo-horizontal.svg', 'public/brand/logo-horizontal-dark.svg',
        'public/brand/logo-maskable-192.png', 'public/brand/logo-maskable-512.png',
        'public/brand/favicon.ico', 'public/brand/apple-touch-icon.png',
        ...[64, 192, 512, 1024].map(size => `public/brand/logo-${size}.png`),
        'config/media-lab.json', 'config/tts-providers.json',
        'server/profile-memory/upstream-lock.json',
        'test/private-file-helper.cjs', 'test/fixtures/pi-0843-session.jsonl', 'test/fixtures/release-video.mp4'
    ];
    const fonts = 'public/vendor/katex-0.18.7/fonts';
    for (const name of fs.readdirSync(path.join(root, fonts)).sort()) {
        if (/^KaTeX_[A-Za-z0-9]+-[A-Za-z]+\.(woff2?|ttf)$/.test(name)) files.push(`${fonts}/${name}`);
    }
    for (const group of Object.keys(GROUPS)) files.push(...sourceFiles(root, group));
    const result = [...new Set(files)].sort();
    for (const file of result) assertPublicPath(file);
    return result;
}

function verifyDesktopLauncher(root) {
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'native/pivane-desktop-launcher-build.json'), 'utf8'));
    const hash = file => require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    if (metadata.version !== 1 || metadata.platform !== 'win32' || metadata.arch !== 'anycpu' || metadata.runtime !== '.NET Framework 4' ||
        !/^[a-f0-9]{64}$/.test(metadata.compilerSha256 || '') ||
        metadata.appVersion !== JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ||
        metadata.sourceSha256 !== hash('native/pivane-desktop-launcher.cs') ||
        metadata.manifestSha256 !== hash('native/pivane-desktop-launcher.manifest') ||
        metadata.iconSha256 !== hash('public/brand/favicon.ico') || metadata.binarySha256 !== hash('白泽灵台.exe')) {
        throw Error('Desktop executable differs from its source/build manifest; rebuild on Windows.');
    }
}
module.exports = { sourceFiles, distributionFiles, verifyBundledMemory, verifyDesktopLauncher };
