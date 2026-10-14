const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { portableEnvironment, inventory, download, updateOptions, updateManifest, relocateWithin,
    portableDirectoryName, createPortableArchive, buildUpdateOptions } = require('../scripts/package-windows-portable.cjs');

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-package-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test('portable build environment uses bundled npm/runtime and never inherits account configuration', t => {
    const root = fixture(t), scratch = path.join(root, 'scratch');
    const env = portableEnvironment(root, scratch);
    assert.equal(env.PI_NPM_CLI, path.join(root, 'runtime/node_modules/npm/bin/npm-cli.js'));
    assert.equal(env.HOME, scratch);
    assert.equal(env.USERPROFILE, scratch);
    assert.equal(env.npm_config_registry, 'https://registry.npmjs.org/');
    assert.equal(env.PI_CODING_AGENT_DIR, path.join(scratch, 'agent'));
    assert.equal(env.PATH.split(';')[0], path.join(root, 'runtime'));
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.npm_config_auth, undefined);
    assert.equal(env.PI_WEB_TOKEN, undefined);
});
test('portable inventory hashes every dependency/license and refuses linked private directories', t => {
    const root = fixture(t), outside = fixture(t);
    fs.mkdirSync(path.join(root, 'node_modules/library'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/library/LICENSE'), 'license');
    const files = inventory(root);
    assert.deepEqual(files, [{ path: 'node_modules/library/LICENSE', bytes: 7,
        sha256: createHash('sha256').update('license').digest('hex') }]);
    fs.symlinkSync(outside, path.join(root, 'node_modules/private'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => inventory(root), /contains a link/);
});
test('portable cache is verified before reuse and fails closed on changed downloads', async t => {
    const root = fixture(t), file = path.join(root, 'runtime.zip'); fs.writeFileSync(file, 'synthetic archive');
    const asset = { filename: 'runtime.zip', sha256: createHash('sha256').update('synthetic archive').digest('hex') };
    assert.equal(await download(asset, root), file);
    fs.appendFileSync(file, 'changed');
    await assert.rejects(download(asset, root), /hash mismatch/);
});

test('portable names follow the requested version and cannot escape the output directory', () => {
    assert.equal(portableDirectoryName('1.7.0'), 'baizelingtai-1.7.0');
    assert.equal(portableDirectoryName('1.8.0-rc.1'), 'baizelingtai-1.8.0-rc.1');
    for (const version of ['../outside', '1.7.0/other', '1.7.0\\other', '1.7.0:other', '', undefined])
        assert.throws(() => portableDirectoryName(version), /Invalid portable version/);
});

test('Windows ZIP uses Unicode names understood by the independent Windows decoder and never overwrites',
    { skip: process.platform !== 'win32' }, t => {
        const base = fixture(t), parent = path.join(base, '中文 空格 & 路径');
        const app = path.join(parent, portableDirectoryName('1.7.0'));
        fs.mkdirSync(app, { recursive: true });
        fs.writeFileSync(path.join(app, '白泽灵台.exe'), 'binary fixture');
        fs.writeFileSync(path.join(app, '便携版使用说明.txt'), '中文说明', 'utf8');
        const archive = path.join(base, path.basename(app) + '.zip');
        createPortableArchive(app, archive);
        const script = `$ProgressPreference='SilentlyContinue'
            $ErrorActionPreference='Stop'
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $zip=[IO.Compression.ZipFile]::OpenRead($env:PIVANE_TEST_ZIP)
            try {
                $entry=$zip.GetEntry('baizelingtai-1.7.0/便携版使用说明.txt')
                if ($null -eq $entry -or $null -eq $zip.GetEntry('baizelingtai-1.7.0/白泽灵台.exe')) { throw 'Chinese ZIP names missing' }
                $reader=[IO.StreamReader]::new($entry.Open(),[Text.Encoding]::UTF8)
                try { if ($reader.ReadToEnd() -ne '中文说明') { throw 'ZIP bytes changed' } } finally { $reader.Dispose() }
            } finally { $zip.Dispose() }`;
        execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
            { env: { ...process.env, PIVANE_TEST_ZIP: archive }, windowsHide: true });
        const before = fs.readFileSync(archive);
        assert.throws(() => createPortableArchive(app, archive), /already exists/);
        assert.deepEqual(fs.readFileSync(archive), before);
        assert.ok(!fs.readdirSync(base).some(name => name.startsWith('.baizelingtai-')), 'temporary ZIP removed');
    });

test('portable update sidecar binds the exact ZIP and accepts public GitLab package/release links', () => {
    const options = updateOptions(['--update-feed-url', 'http://gitlab.example/team/baizelingtai/-/raw/main/updates/latest.json',
        '--package-url', 'http://gitlab.example/api/v4/projects/20/packages/generic/baizelingtai/1.8.0/{filename}',
        '--release-url', 'http://gitlab.example/team/baizelingtai/-/releases/v1.8.0']);
    const args = { archive: 'baizelingtai-1.8.0.zip', sha256: 'b'.repeat(64), bytes: 12345,
        appVersion: '1.8.0', piVersion: '1.1.0', options, now: new Date('2026-10-12T00:00:00Z') };
    const manifest = updateManifest(args);
    assert.equal(manifest.version, '1.8.0'); assert.equal(manifest.channel, 'stable'); assert.equal(manifest.piVersion, '1.1.0');
    assert.equal(manifest.sha256, args.sha256); assert.equal(manifest.bytes, args.bytes);
    assert.equal(manifest.package, 'http://gitlab.example/api/v4/projects/20/packages/generic/baizelingtai/1.8.0/' + args.archive);
    assert.equal(manifest.releasesUrl, options.releasesUrl);
    assert.equal(updateManifest({ ...args, options: {}, appVersion: '1.8.0-rc.1' }).channel, 'preview');
    assert.equal(updateManifest({ ...args, options: {} }).package, args.archive);
    for (const options of [['--unknown', 'x'], ['--update-feed-url'], ['--package-url', 'http://gitlab.example/a.zip'],
        ['--update-feed-url', 'http://gitlab.example/latest.json', '--package-url', 'https://elsewhere.example/a.zip']]) assert.throws(() => updateOptions(options));
    assert.throws(() => updateManifest({ ...args, sha256: 'bad' }), /Invalid update feed/);
});

test('standard Windows build derives baizelingtai GitLab links from local configuration and follows the application version', t => {
    const root = fixture(t), file = path.join(root, '.baizelingtai-update-build.json');
    assert.deepEqual(buildUpdateOptions(root, '1.8.0'), {});
    fs.writeFileSync(file, JSON.stringify({ version: 1, gitlabProjectUrl: 'http://gitlab.example/hnxt/yfzx/service/baizelingtai' }));
    const options = buildUpdateOptions(root, '1.8.0');
    assert.equal(options.feed, 'http://gitlab.example/api/v4/projects/hnxt%2Fyfzx%2Fservice%2Fbaizelingtai/repository/files/updates%2Flatest.json/raw?ref=HEAD');
    assert.equal(options.package, 'http://gitlab.example/api/v4/projects/hnxt%2Fyfzx%2Fservice%2Fbaizelingtai/packages/generic/baizelingtai/1.8.0/{filename}');
    assert.equal(options.releasesUrl, 'http://gitlab.example/hnxt/yfzx/service/baizelingtai/-/releases');
    assert.ok(buildUpdateOptions(root, '1.9.0').package.includes('/1.9.0/'));
    const override = ['--update-feed-url', 'http://other.example/latest.json'];
    assert.deepEqual(buildUpdateOptions(root, '1.8.0', override), { feed: 'http://other.example/latest.json' });
    for (const config of [{ version: 2 }, { version: 1, gitlabProjectUrl: 'http://gitlab.example/project' },
        { version: 1, gitlabProjectUrl: 'http://user:private@gitlab.example/team/project' },
        { version: 1, gitlabProjectUrl: 'http://gitlab.example/team/project?ref=main' },
        { version: 1, gitlabProjectUrl: 'http://gitlab.example/team/project', token: 'private' }]) {
        fs.writeFileSync(file, JSON.stringify(config)); assert.throws(() => buildUpdateOptions(root, '1.8.0'));
    }
    fs.writeFileSync(file, '{'); assert.throws(() => buildUpdateOptions(root, '1.8.0'), /Cannot read/);
    assert.deepEqual(buildUpdateOptions(root, '1.8.0', override), { feed: 'http://other.example/latest.json' });
});

test('portable relocation waits for a real Windows directory handle and stays inside its own build root', { skip: process.platform !== 'win32' }, async t => {
    const root = fixture(t), outside = fixture(t), source = path.join(root, 'PortableGit'), destination = path.join(root, 'git');
    fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'LICENSE'), 'fixture');
    await assert.rejects(relocateWithin(root, source, path.join(outside, 'git')), /Unsafe build/);
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready');setTimeout(()=>{},800)"], {
        cwd: source, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = once(child, 'close');
    try {
        await once(child.stdout, 'data');
        assert.throws(() => fs.renameSync(source, destination), error => ['EBUSY', 'EPERM'].includes(error.code));
        await relocateWithin(root, source, destination);
        assert.equal(fs.readFileSync(path.join(destination, 'LICENSE'), 'utf8'), 'fixture');
        assert.equal(fs.existsSync(source), false);
    } finally { await exited; }
});
