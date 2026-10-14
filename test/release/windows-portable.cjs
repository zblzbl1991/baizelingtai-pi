// Manual Windows x64 acceptance of one exact portable ZIP. Never installs dependencies.
// node test/release/windows-portable.cjs ZIP SHA256
// PLAYWRIGHT_MODULE and CHROMIUM_PATH must identify QA dependencies outside the archive.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function main() {
    assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
    const [archive, expected] = process.argv.slice(2);
    assert.match(expected || '', /^[a-f0-9]{64}$/);
    assert.equal(hash(archive), expected, 'archive hash');
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-portable-validation-')));
    const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-portable-evidence-'));
    let success = false;
    try {
        execFileSync(path.join(process.env.SystemRoot, 'System32/tar.exe'), ['-xf', path.resolve(archive), '-C', base], { windowsHide: true });
        const directories = fs.readdirSync(base, { withFileTypes: true });
        assert.equal(directories.length, 1, 'one portable root directory');
        assert.ok(directories[0].isDirectory() && !directories[0].isSymbolicLink());
        const original = path.join(base, directories[0].name), root = path.join(base, '白泽 灵台 & 便携测试');
        fs.renameSync(original, root); // Exercise a relocated Chinese/space/metacharacter path.
        const tools = require(path.join(root, 'scripts/package-windows-portable.cjs'));
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'PORTABLE_MANIFEST.json'), 'utf8'));
        assert.equal(manifest.platform, 'win32'); assert.equal(manifest.arch, 'x64');
        const expectedDirectory = tools.portableDirectoryName?.(manifest.appVersion) || `baizelingtai-${manifest.appVersion}`;
        assert.ok([expectedDirectory, '白泽灵台'].includes(directories[0].name), 'versioned portable root or legacy root');
        assert.deepEqual(manifest.assets, require(path.join(root, 'scripts/windows-portable-assets.json')).assets, 'pinned tool catalog');
        const actual = tools.inventory(root).filter(file => file.path !== 'PORTABLE_MANIFEST.json');
        assert.deepEqual(actual, manifest.files, 'exact extracted bytes and inventory');
        const portable = JSON.parse(fs.readFileSync(require(path.join(root, 'server/pi-update-feed')).portableMetadataFile(root), 'utf8'));
        const sidecar = archive + '.update.json';
        if (portable.updateFeedUrl || fs.existsSync(sidecar)) {
            const update = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
            assert.equal(update.sha256, expected, 'update feed identifies this exact ZIP');
            assert.equal(update.bytes, fs.statSync(archive).size);
            assert.equal(update.version, manifest.appVersion);
            assert.equal(update.piVersion, require(path.join(root, 'package.json')).dependencies['@earendil-works/pi-coding-agent']);
            const { parseFeed, configuredFeed } = require(path.join(root, 'server/pi-update-feed'));
            parseFeed(update, { source: portable.updateFeedUrl || 'https://example.invalid/latest.json', platform: 'win32', arch: 'x64',
                channel: 'preview', compareVersions: require(path.join(root, 'server/pi-update-service')).compareVersions });
            assert.equal(configuredFeed(root, {}), portable.updateFeedUrl || null);
        }
        for (const file of actual) {
            // This exact zero-byte file is part of the pinned official Node ZIP.
            // Never allow a populated npmrc or any other account configuration.
            if (file.path === 'runtime/node_modules/npm/.npmrc' && file.bytes === 0 && file.sha256 === createHash('sha256').update('').digest('hex')) continue;
            assert.ok(!/^(?:data|\.pivane-runtime|\.pi|backups|docs\/local)\/|(?:^|\/)(?:auth\.json|\.env|\.npmrc|AGENTS\.local\.md)$/.test(file.path), 'no maintainer state: ' + file.path);
        }
        const scratch = path.join(base, 'qa-only'); fs.mkdirSync(scratch);
        const env = tools.portableEnvironment(root, scratch), node = path.join(root, 'runtime/node.exe');
        env.PATH = [path.join(root, 'runtime'), path.join(root, 'tools/rg'), path.join(root, 'tools/fd'), path.join(root, 'tools/git/bin'), path.join(root, 'tools/git/usr/bin'),
            path.join(process.env.SystemRoot, 'System32'), path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0')].join(';');
        const probe = `const assert=require('node:assert/strict'); const fs=require('node:fs');
            assert.equal(process.version,'v${manifest.assets.node.version}');
            const DB=require('better-sqlite3'); const db=new DB(':memory:'); assert.equal(db.prepare('select 42 as value').get().value,42);db.close();
            require('esbuild').transformSync('const x: number=1',{loader:'ts'});
            require('./scripts/source-files.cjs').verifyDesktopLauncher(process.cwd());
            const e=require('./server/pivane-desktop-launcher').desktopEnvironment(process.cwd(),{});assert.equal(e.PI_CODING_AGENT_DIR,require('node:path').join(process.cwd(),'data/agent'));
            const cp=require('node:child_process'); const shell=cp.execFileSync('bash.exe',['--noprofile','--norc','-c','printf portable-shell; git --version; rg --version; fd --version'],{encoding:'utf8'});
            assert.match(shell,/portable-shell/);assert.match(shell,/git version ${manifest.assets.git.version.replaceAll('.', '\\.')}/);assert.match(shell,/ripgrep ${manifest.assets.rg.version.replaceAll('.', '\\.')}/);assert.match(shell,/fd ${manifest.assets.fd.version.replaceAll('.', '\\.')}/);
            console.log(JSON.stringify({node:process.version,shell,sqlite:true,esbuild:true,portableDefaults:true}));`;
        fs.writeFileSync(path.join(evidence, 'probes.json'), execFileSync(node, ['-e', probe], { cwd: root, env, encoding: 'utf8', windowsHide: true }));
        fs.writeFileSync(path.join(root, '.pivane-portable-validation'), 'independent exact ZIP validation\n');
        const browserEnv = { ...env, PLAYWRIGHT_MODULE: process.env.PLAYWRIGHT_MODULE, CHROMIUM_PATH: process.env.CHROMIUM_PATH, PIVANE_DESKTOP_EVIDENCE: path.join(evidence, 'browser') };
        // QA Chromium needs the real Windows profile locations to identify a
        // non-default temporary browser profile. The EXE fixture independently
        // creates its own minimal/synthetic environment inside the browser script.
        for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP']) {
            if (process.env[key]) browserEnv[key] = process.env[key];
        }
        execFileSync(node, [path.join(root, 'test/browser/pivane-desktop-launcher.cjs'), '--portable-root', root], { cwd: root, env: browserEnv, stdio: 'inherit', windowsHide: true });
        // Real Pi worker + native Bash, streaming/cancellation/history; no model/account requests.
        const shell = spawnSync(node, [path.join(root, 'scripts/run-tests.cjs'), 'test/pi-shell.test.js'],
            { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 180000 });
        fs.writeFileSync(path.join(evidence, 'native-shell.log'), (shell.stdout || '') + (shell.stderr || ''));
        assert.equal(shell.status, 0, 'native worker/Shell failed; see ' + path.join(evidence, 'native-shell.log'));
        const after = new Map(tools.inventory(root).map(file => [file.path, file]));
        for (const file of manifest.files) assert.deepEqual(after.get(file.path), file, 'runtime did not change packaged bytes: ' + file.path);
        fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, archive: path.basename(archive), sha256: expected,
            platform: process.platform, arch: process.arch, osRelease: os.release(), hostNode: process.version,
            appVersion: manifest.appVersion, assets: manifest.assets, files: actual.length,
            sourceArchiveSha256: manifest.sourceArchiveSha256, packageLockSha256: hash(path.join(root, 'package-lock.json')),
            installedDependencies: false, systemDeveloperToolsOnPath: false, nativeShell: true, browserOpened: true, cleanExit: true }, null, 2));
        success = true;
        console.log(JSON.stringify({ ok: true, sha256: expected, evidence }));
    } finally {
        if (success) {
            try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
            catch (error) {
                // The default browser is outside our ownership and may retain an
                // OS temp file. Owned service/worker exit was already asserted.
                if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
                console.error('Application validation passed; browser/system scratch remains locked: ' + base);
            }
        } else console.error('Portable validation failed; retained isolated directory: ' + base + '; evidence: ' + evidence);
    }
}
try { main(); } catch (error) { console.error(error.stack); process.exitCode = 1; }
