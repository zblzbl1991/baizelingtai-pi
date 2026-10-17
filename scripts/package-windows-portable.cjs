const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const root = path.resolve(__dirname, '..');
const assets = require('./windows-portable-assets.json');
const { feedUrl, sourceLink, parseFeed } = require('../server/pi-update-feed');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const tar = path.join(system, 'tar.exe');

function portableDirectoryName(version) {
    if (typeof version !== 'string' || !/^[0-9][0-9a-z.-]*$/.test(version)) throw Error('Invalid portable version');
    return `baizelingtai-${version}`;
}

function createPortableArchive(app, archive) {
    if (fs.existsSync(archive)) throw Error('Portable archive already exists.');
    const temporary = path.join(path.dirname(archive), `.baizelingtai-${randomUUID()}.zip`);
    try {
        // Windows tar otherwise emits ANSI/GBK names without a Unicode flag.
        execFileSync(tar, ['--options', 'zip:hdrcharset=UTF-8', '-a', '-cf', temporary,
            '-C', path.dirname(app), path.basename(app)], { windowsHide: true });
        // Also refuse a competing build that published after the initial check.
        fs.copyFileSync(temporary, archive, fs.constants.COPYFILE_EXCL);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

async function relocateWithin(root, source, destination) {
    const base = fs.realpathSync.native(root);
    const inside = value => {
        const relative = path.relative(base, value);
        return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    };
    if (fs.lstatSync(source).isSymbolicLink() || !inside(fs.realpathSync.native(source))
        || !inside(path.join(fs.realpathSync.native(path.dirname(destination)), path.basename(destination)))
        || fs.existsSync(destination)) throw Error('Unsafe build relocation');
    // The self-extractor can release transient Windows handles just after returning.
    // Retry only this local atomic move, never the extractor or a network operation.
    for (let attempt = 0; ; attempt++) {
        try { fs.renameSync(source, destination); return; }
        catch (error) {
            if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt >= 6
                || fs.existsSync(destination) || !fs.existsSync(source)) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.min(200 * 2 ** attempt, 1000)));
        }
    }
}

function updateOptions(args) {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
        const key = { '--update-feed-url': 'feed', '--package-url': 'package', '--release-url': 'releasesUrl' }[args[i]];
        if (!key || !args[i + 1] || options[key]) throw Error('Usage: pack:windows [--update-feed-url URL] [--package-url URL_WITH_{filename}] [--release-url URL]');
        options[key] = args[i + 1];
    }
    if (options.feed) {
        options.feed = feedUrl(options.feed);
        for (const key of ['package', 'releasesUrl']) if (options[key]) sourceLink(options[key].replaceAll('{filename}', 'portable.zip'), options.feed);
    } else if (options.package || options.releasesUrl) throw Error('An update feed URL is required');
    return options;
}

function buildUpdateOptions(directory, appVersion, args = []) {
    // Explicit CLI arguments are a complete override of this machine's publishing target.
    if (args.length) return updateOptions(args);
    const file = path.join(directory, '.baizelingtai-update-build.json');
    let config;
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw Error('Cannot read Windows update build configuration'); }
    if (!config || config.version !== 1 || Object.keys(config).some(key => !['version', 'gitlabProjectUrl'].includes(key)))
        throw Error('Invalid Windows update build configuration');
    const project = new URL(feedUrl(config.gitlabProjectUrl));
    const namespace = project.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    if (project.search || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(namespace)) throw Error('Invalid GitLab project URL');
    portableDirectoryName(appVersion);
    const api = `${project.origin}/api/v4/projects/${encodeURIComponent(namespace)}`;
    return updateOptions([
        '--update-feed-url', `${api}/repository/files/updates%2Flatest.json/raw?ref=HEAD`,
        '--package-url', `${api}/packages/generic/baizelingtai/${appVersion}/{filename}`,
        '--release-url', `${project.origin}/${namespace}/-/releases`
    ]);
}

function updateManifest({ archive, sha256, bytes, appVersion, piVersion, options, now = new Date() }) {
    const data = { schemaVersion: 1, version: appVersion, piVersion, platform: 'win32', arch: 'x64',
        channel: appVersion.includes('-') ? 'preview' : 'stable', publishedAt: now.toISOString(),
        package: options.package?.replaceAll('{filename}', path.basename(archive)) || path.basename(archive), sha256, bytes,
        ...(options.releasesUrl ? { releasesUrl: options.releasesUrl } : {}) };
    // Validate the same schema the installed application consumes before publishing a sidecar.
    parseFeed(data, { source: options.feed || 'https://example.invalid/latest.json', platform: 'win32', arch: 'x64',
        channel: 'preview', compareVersions: require('../server/pi-update-service').compareVersions });
    return data;
}

// A fresh build must never import the maintainer's npm credentials or Pi identity.
function portableEnvironment(app, scratch) {
    const env = {};
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)'])
        if (process.env[name]) env[name] = process.env[name];
    env.PATH = [path.join(app, 'runtime'), path.join(app, 'tools/rg'), path.join(app, 'tools/fd'), path.join(app, 'tools/git/bin'), path.join(app, 'tools/git/usr/bin'), system,
        path.join(system, 'WindowsPowerShell/v1.0')].join(';');
    Object.assign(env, { HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch,
        TEMP: scratch, TMP: scratch, PSModulePath: path.join(system, 'WindowsPowerShell/v1.0/Modules'),
        PI_CODING_AGENT_DIR: path.join(scratch, 'agent'), PI_MEDIA_DATA_DIR: path.join(scratch, 'media'),
        PI_MEDIA_CONFIG_DIR: path.join(scratch, 'media-lab'), PI_WEB_DEFERRED_FILE: path.join(scratch, 'deferred.json'),
        PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1',
        PI_NPM_CLI: path.join(app, 'runtime/node_modules/npm/bin/npm-cli.js'),
        npm_config_registry: 'https://registry.npmjs.org/', npm_config_userconfig: path.join(scratch, 'empty.npmrc'),
        npm_config_globalconfig: path.join(scratch, 'empty-global.npmrc'), npm_config_cache: path.join(root, 'dist/portable-cache/npm') });
    return env;
}

function inventory(directory) {
    const files = [];
    function visit(relative) {
        for (const item of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            const name = relative ? relative + '/' + item.name : item.name;
            if (item.isSymbolicLink()) throw Error('Portable package contains a link: ' + name);
            if (item.isDirectory()) visit(name);
            else if (item.isFile()) files.push({ path: name, bytes: fs.statSync(path.join(directory, name)).size, sha256: hash(path.join(directory, name)) });
            else throw Error('Unexpected portable entry: ' + name);
        }
    }
    visit(''); return files;
}

async function download(asset, cache) {
    const destination = path.join(cache, asset.filename);
    if (fs.existsSync(destination)) {
        if (hash(destination) !== asset.sha256) throw Error('Cached download hash mismatch; remove and retry: ' + destination);
        return destination;
    }
    console.log('Downloading ' + asset.filename);
    const temporary = destination + '.partial-' + process.pid;
    try {
        // Windows' bundled curl supports network proxy environments and transient retries.
        // Disable user curlrc so build downloads cannot inherit unrelated account options.
        await promisify(execFile)(path.join(system, 'curl.exe'), ['--disable', '--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
            '--retry', '3', '--connect-timeout', '30', '--max-time', '900', '--silent', '--show-error', '--output', temporary, asset.url], { windowsHide: true });
        if (hash(temporary) !== asset.sha256) throw Error('Downloaded archive hash mismatch: ' + asset.filename);
        fs.renameSync(temporary, destination);
        return destination;
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

async function main() {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Build this package on Windows x64 with Node.js 22.');
    const args = process.argv.slice(2), dryRun = args.includes('--dry-run');
    if (args.filter(arg => arg === '--dry-run').length > 1) throw Error('Duplicate --dry-run');
    if (assets.version !== 1 || assets.platform !== 'win32' || assets.arch !== 'x64') throw Error('Invalid portable asset catalog.');
    const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const updates = buildUpdateOptions(root, appVersion, args.filter(arg => arg !== '--dry-run'));
    const appName = portableDirectoryName(appVersion);
    const archive = path.join(root, 'dist', `${appName}.zip`);
    if (dryRun) {
        console.log(JSON.stringify({ dryRun: true, archive, updateFeed: archive + '.update.json', updates }, null, 2));
        return;
    }
    if ([archive, archive + '.sha256', archive + '.update.json'].some(file => fs.existsSync(file)))
        throw Error('Portable output already exists; preserve or move the existing package before building.');
    const cache = path.join(root, 'dist/portable-cache'); fs.mkdirSync(cache, { recursive: true });
    // Reuse the one public inventory and all neutral-config/native/license gates.
    const snapshot = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/package-trial.cjs')], { encoding: 'utf8', windowsHide: true }));
    if (snapshot.appVersion !== appVersion) throw Error('Application version changed during packaging; no portable ZIP was published.');
    const downloads = {};
    for (const [name, asset] of Object.entries(assets.assets)) downloads[name] = await download(asset, cache);
    const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'baizelingtai-portable-build-')));
    try {
        const app = path.join(temporary, appName), scratch = path.join(temporary, 'build-only');
        fs.mkdirSync(scratch); fs.writeFileSync(path.join(scratch, 'empty.npmrc'), ''); fs.writeFileSync(path.join(scratch, 'empty-global.npmrc'), '');
        execFileSync(tar, ['-xf', snapshot.archive, '-C', temporary], { windowsHide: true });
        fs.renameSync(path.join(temporary, 'pivane-trial'), app);
        const unpack = path.join(temporary, 'unpack'); fs.mkdirSync(unpack);
        for (const name of ['node', 'rg', 'fd']) execFileSync(tar, ['-xf', downloads[name], '-C', unpack], { windowsHide: true });
        fs.renameSync(path.join(unpack, assets.assets.node.directory), path.join(app, 'runtime'));
        fs.mkdirSync(path.join(app, 'tools'));
        fs.renameSync(path.join(unpack, assets.assets.rg.directory), path.join(app, 'tools/rg'));
        fs.renameSync(path.join(unpack, assets.assets.fd.directory), path.join(app, 'tools/fd'));
        // Windows tar cannot decode this upstream archive's LZMA settings.
        // Run the hash-verified portable self-extractor in our own scratch
        // directory, including its local post-install preparation, then relocate.
        const env = portableEnvironment(app, scratch), node = path.join(app, 'runtime/node.exe');
        const extractor = path.join(scratch, 'PortableGit.exe'); fs.copyFileSync(downloads.git, extractor);
        execFileSync(extractor, ['-y', '-gm2'], { cwd: scratch, env, windowsHide: true });
        await relocateWithin(temporary, path.join(scratch, 'PortableGit'), path.join(app, 'tools/git'));
        for (const [file, args, expected] of [[node, ['--version'], 'v' + assets.assets.node.version],
            [path.join(app, 'tools/git/bin/git.exe'), ['--version'], 'git version ' + assets.assets.git.version],
            [path.join(app, 'tools/rg/rg.exe'), ['--version'], 'ripgrep ' + assets.assets.rg.version],
            [path.join(app, 'tools/fd/fd.exe'), ['--version'], 'fd ' + assets.assets.fd.version]]) {
            if (!execFileSync(file, args, { env, encoding: 'utf8', windowsHide: true }).trim().startsWith(expected)) throw Error('Runtime version mismatch: ' + file);
        }
        execFileSync(node, [path.join(app, 'scripts/install.cjs'), '--omit=dev'], { cwd: app, env, stdio: 'inherit', windowsHide: true });
        execFileSync(node, [path.join(app, 'scripts/install-office-preview.cjs'), '--require-available'], { cwd: app, env, stdio: 'inherit', windowsHide: true });
        // Retain installed dependency and tool licenses in full; do not prune packages.
        fs.writeFileSync(path.join(app, 'baizelingtai-portable.json'), JSON.stringify({ version: 1, platform: 'win32', arch: 'x64',
            ...(updates.feed ? { updateFeedUrl: updates.feed } : {}) }, null, 2) + '\n');
        fs.writeFileSync(path.join(app, '便携版使用说明.txt'), '\ufeff白泽灵台 Windows x64 便携版\r\n\r\n解压完整目录后，双击 白泽灵台.exe。无需安装 Node、Git 或 ripgrep。\r\n首次启动后在供应商与模型设置中配置自己的账户。\r\n数据默认保存在本目录 data 中；正常退出托盘后备份完整目录。\r\n已有 .env 或环境变量配置优先。移动目录不迁移已有会话中的项目路径。\r\n需要 Windows 10/11 x64、自带 Windows PowerShell 5.1、.NET Framework 4 和默认浏览器。\r\n便携包不会注册服务或开机启动。退出前保存草稿、结束任务并暂停预约。\r\n');
        fs.writeFileSync(path.join(app, 'PORTABLE_NOTICES.txt'), 'This package retains original dependency licenses in node_modules and tool distributions.\n' +
            Object.entries(assets.assets).map(([name, asset]) => `${name} ${asset.version}\n${asset.url}\nSHA256 ${asset.sha256}\n`).join('\n') +
            `\nNode.js: runtime/LICENSE (includes bundled components).\nGit for Windows: tools/git/LICENSE.txt and component license files. Git is GPL-2.0; corresponding sources and build recipes: https://github.com/git-for-windows/git/tree/v${assets.assets.git.version} and https://github.com/git-for-windows/build-extra .\nRipgrep: tools/rg/COPYING, LICENSE-MIT, UNLICENSE.\nfd: tools/fd/LICENSE-MIT, LICENSE-APACHE.\n`);
        for (const file of ['runtime/LICENSE', 'tools/git/LICENSE.txt', 'tools/rg/COPYING', 'tools/rg/LICENSE-MIT', 'tools/rg/UNLICENSE', 'tools/fd/LICENSE-MIT', 'tools/fd/LICENSE-APACHE'])
            if (!fs.existsSync(path.join(app, file))) throw Error('Missing runtime license: ' + file);
        const sourceFiles = JSON.parse(fs.readFileSync(path.join(app, 'TRIAL_MANIFEST.json'), 'utf8')).files;
        for (const file of sourceFiles) if (hash(path.join(app, file.path)) !== file.sha256) throw Error('Installation changed frozen source: ' + file.path);
        const files = inventory(app);
        fs.writeFileSync(path.join(app, 'PORTABLE_MANIFEST.json'), JSON.stringify({ version: 1, platform: 'win32', arch: 'x64', appVersion: snapshot.appVersion,
            sourceArchiveSha256: snapshot.sha256, assets: assets.assets, generatedAt: new Date().toISOString(), files }, null, 2) + '\n');
        createPortableArchive(app, archive);
        const sha256 = hash(archive);
        fs.writeFileSync(archive + '.sha256', `${sha256}  ${path.basename(archive)}\n`, { flag: 'wx' });
        const bytes = fs.statSync(archive).size, updateFeed = archive + '.update.json';
        fs.writeFileSync(updateFeed, JSON.stringify(updateManifest({ archive, sha256, bytes, appVersion: snapshot.appVersion,
            piVersion: snapshot.piVersion, options: updates }), null, 2) + '\n', { flag: 'wx' });
        console.log(JSON.stringify({ archive, sha256, updateFeed, appVersion: snapshot.appVersion, files: files.length, bytes }, null, 2));
    } finally {
        // This exact, canonical, mkdtemp-created path is the only recursive cleanup target.
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}
module.exports = { portableEnvironment, inventory, download, updateOptions, updateManifest, relocateWithin,
    portableDirectoryName, createPortableArchive, buildUpdateOptions };
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
