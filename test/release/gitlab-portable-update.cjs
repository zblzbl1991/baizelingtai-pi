// Manual Windows intranet update rehearsal. Uses only fresh synthetic data and loopback HTTP.
// --source-candidate overlays current distribution files into a NEW simulation ZIP, never a release ZIP.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync, fork } = require('node:child_process');
const { once } = require('node:events');
const { Transform } = require('node:stream');
const { Worker } = require('node:worker_threads');
const { pipeline } = require('node:stream/promises');
const express = require('express');
const fetch = require('node-fetch');
const source = path.resolve(__dirname, '../..');
const tools = require('../../scripts/package-windows-portable.cjs');
const { UpdateService } = require('../../server/pi-update-service');
const { backupRoots, hashFileSafe } = require('../../server/pi-maintenance-files');
const tar = path.join(process.env.SystemRoot, 'System32/tar.exe');
const sha = file => hashFileSafe(file).sha256;
const json = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

function options(args) {
    const result = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--source-candidate') { result.sourceCandidate = true; continue; }
        if (args[i] === '--routine') { result.routine = true; continue; }
        const key = { '--previous-archive': 'previousArchive', '--previous-sha256': 'previousSha256',
            '--archive': 'archive', '--sha256': 'sha256', '--output': 'output', '--browser': 'browser', '--playwright': 'playwright' }[args[i]];
        if (!key || !args[i + 1] || result[key]) throw Error('Invalid rehearsal arguments');
        result[key] = args[++i];
    }
    for (const key of ['previousArchive', 'previousSha256', 'archive', 'sha256', 'output', 'browser', 'playwright']) assert.ok(result[key], `Missing ${key}`);
    for (const key of ['previousSha256', 'sha256']) assert.match(result[key], /^[a-f0-9]{64}$/);
    for (const key of ['previousArchive', 'archive', 'output', 'browser', 'playwright']) result[key] = path.resolve(result[key]);
    assert.ok(!fs.existsSync(result.output), 'output must be a fresh directory');
    return result;
}

function portableNames(directory) {
    const names = [];
    function visit(relative) {
        for (const item of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            const name = relative ? relative + '/' + item.name : item.name;
            if (item.isSymbolicLink()) throw Error('Portable package contains a link: ' + name);
            if (item.isDirectory()) visit(name);
            else if (item.isFile()) names.push(name);
            else throw Error('Unexpected portable entry: ' + name);
        }
    }
    visit('');
    return names;
}

async function inventory(directory) {
    const names = portableNames(directory);
    // Every file is hashed through the repository's descriptor/identity checks.
    // Threads read only this isolated archive; they are not Pi/RPC workers.
    const groups = Array.from({ length: 4 }, () => []);
    names.forEach((name, index) => groups[index % groups.length].push({ name, index }));
    const batches = await Promise.all(groups.map(files => new Promise((resolve, reject) => {
        const worker = new Worker(String.raw`
            const { parentPort, workerData } = require('node:worker_threads');
            const path = require('node:path');
            const { hashFileSafe } = require(path.join(workerData.source, 'server/pi-maintenance-files'));
            const records = workerData.files.map(({ name, index }) => {
                const value = hashFileSafe(path.join(workerData.directory, name));
                return { index, record: { path: name, bytes: value.bytes, sha256: value.sha256 } };
            });
            parentPort.postMessage(records);
        `, { eval: true, trackUnmanagedFds: false, workerData: { source, directory, files } });
        worker.once('message', resolve); worker.once('error', reject);
        worker.once('exit', code => { if (code !== 0) reject(Error('Inventory verification worker failed')); });
    })));
    return batches.flat().sort((a, b) => a.index - b.index).map(item => item.record);
}

async function extract(archive, destination, routine = false) {
    // Check names and symlink attributes before any ZIP entry is extracted.
    const script = String.raw`$ErrorActionPreference='Stop'
        $ProgressPreference='SilentlyContinue'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip=[IO.Compression.ZipFile]::OpenRead($env:PIVANE_REHEARSAL_ZIP)
        try { foreach ($entry in $zip.Entries) {
            $name=$entry.FullName
            if ($name -match '(^[/\\]|[:\\]|(^|/)\.\.(/|$))' -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Unsafe ZIP entry' }
        } } finally { $zip.Dispose() }`;
    execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { env: { ...process.env, PIVANE_REHEARSAL_ZIP: archive }, windowsHide: true });
    fs.mkdirSync(destination);
    execFileSync(tar, ['-xf', archive, '-C', destination], { windowsHide: true });
    const entries = fs.readdirSync(destination, { withFileTypes: true });
    assert.equal(entries.length, 1); assert.ok(entries[0].isDirectory() && !entries[0].isSymbolicLink());
    const root = path.join(destination, entries[0].name);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'PORTABLE_MANIFEST.json')));
    assert.equal(entries[0].name, tools.portableDirectoryName(manifest.appVersion));
    if (!routine) assert.deepEqual((await inventory(root)).filter(file => file.path !== 'PORTABLE_MANIFEST.json'), manifest.files, 'all extracted bytes match inventory');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version, manifest.appVersion);
    return root;
}

function zipPackage(archive) {
    const script = String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip=[IO.Compression.ZipFile]::OpenRead($env:PIVANE_REHEARSAL_ZIP)
        try {
            $entries=@($zip.Entries | Where-Object { $_.FullName -match '^[^/]+/package.json$' })
            if ($entries.Count -ne 1 -or $entries[0].Length -gt 1048576) { throw 'Invalid application package metadata' }
            $reader=[IO.StreamReader]::new($entries[0].Open(),[Text.Encoding]::UTF8)
            try { $reader.ReadToEnd() } finally { $reader.Dispose() }
        } finally { $zip.Dispose() }`;
    return JSON.parse(execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { env: { ...process.env, PIVANE_REHEARSAL_ZIP: archive }, windowsHide: true, encoding: 'utf8' }));
}

async function download(plan, destination) {
    assert.ok(!fs.existsSync(destination));
    const response = await fetch(plan.downloadUrl, { redirect: 'error', timeout: 12000 });
    if (!response.ok) throw Error('Download failed');
    const digest = createHash('sha256'); let bytes = 0;
    const meter = new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > plan.bytes) return done(Error('ZIP byte count mismatch'));
        digest.update(chunk); done(null, chunk);
    } });
    try {
        await pipeline(response.body, meter, fs.createWriteStream(destination, { flags: 'wx' }));
        if (bytes !== plan.bytes) throw Error('ZIP byte count mismatch');
        if (digest.digest('hex') !== plan.sha256) throw Error('ZIP SHA256 mismatch');
    } catch (error) {
        if (fs.existsSync(destination)) fs.unlinkSync(destination);
        throw error;
    }
}

async function start(root, env, output, name) {
    const { ManagedLauncher } = require(path.join(root, 'server/pi-managed-launcher'));
    const launcher = new ManagedLauncher({ root, env, forkServer: (file, args, opts) => {
        const child = fork(file, args, { ...opts, execPath: path.join(root, 'runtime/node.exe'),
            execArgv: ['--require', env.PIVANE_REHEARSAL_NETWORK_GUARD], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        const log = fs.createWriteStream(path.join(output, `${name}.log`), { flags: 'a' });
        for (const stream of [child.stdout, child.stderr]) stream.pipe(log, { end: false });
        child.once('close', () => log.end());
        return child;
    } });
    try { await launcher.start(); }
    catch (error) { await launcher.close(); throw error; }
    const base = `http://127.0.0.1:${launcher.env.PORT}`;
    // IPC announces listening before the legacy application's startup callbacks
    // finish. Probe read-only HTTP readiness; do not change API test timeouts.
    const deadline = Date.now() + 45000;
    for (;;) {
        try {
            const response = await fetch(base + '/api/access/status', { timeout: 5000,
                headers: { Authorization: 'Bearer gitlab-rehearsal-synthetic-only', Origin: base } });
            if (response.ok) break;
        } catch { /* Retry only this read-only startup probe, never an update. */ }
        if (Date.now() >= deadline) { await launcher.close(); throw Error('Isolated HTTP readiness timed out'); }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    const api = async (route, body) => {
        const response = await fetch(base + '/api/pi/' + route, { method: body ? 'POST' : 'GET', timeout: 15000,
            headers: { Authorization: 'Bearer gitlab-rehearsal-synthetic-only', Origin: base, 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, data: await response.json() };
    };
    return { launcher, base, api };
}

async function verifyPage(browser, instance, output, manifest, name) {
    for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 393, height: 852 }]]) {
        const context = await browser.newContext({ viewport, locale: 'zh-CN', isMobile: label === 'mobile', hasTouch: label === 'mobile',
            extraHTTPHeaders: { Authorization: 'Bearer gitlab-rehearsal-synthetic-only' } });
        const page = await context.newPage(), errors = [], writes = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('request', r => { if (r.method() !== 'GET' && r.url().includes('/api/')) writes.push(new URL(r.url()).pathname); });
        await page.route(/https?:\/\/(?!127\.0\.0\.1:)/, route => route.abort());
        try {
            await page.goto(instance.base, { waitUntil: 'domcontentloaded' });
            await page.locator('#workspace-settings-toggle').click();
            await page.locator('[data-settings-tab="updates"]').click();
            await page.locator('#updates-source').waitFor();
            await page.waitForFunction(() => !document.getElementById('updates-check').disabled);
            await page.locator('#updates-check').click();
            await page.waitForFunction(() => !document.getElementById('updates-check').disabled);
            await page.locator('#updates-agent-guide summary').click();
            const prompt = await page.locator('#updates-agent-prompt').inputValue();
            assert.ok(!prompt.includes('https://github.com'));
            const { data } = await instance.api('settings/updates');
            assert.ok(prompt.includes(data.source.url));
            for (const field of ['latest.json', 'SemVer', 'version', 'package', 'bytes', 'sha256']) assert.ok(prompt.includes(field));
            assert.ok(prompt.includes('原数据绝对路径') && prompt.includes('没有新版就结束'));
            assert.ok(!prompt.includes(manifest.sha256) && !prompt.includes(manifest.package), 'read target values from a fresh manifest');
            assert.equal(await page.locator('#updates-pivane a[href$=".zip"]').getAttribute('href'), manifest.package);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            if (label === 'mobile') assert.ok(await page.locator('#updates-agent-prompt').evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 16);
            assert.deepEqual(errors, []);
            assert.ok(writes.every(route => /settings\/updates\/(check|notifications)$/.test(route)), 'no prompt, installation or data writes from update page');
            fs.writeFileSync(path.join(output, `${name}-${label}-prompt.txt`), prompt);
            await page.screenshot({ path: path.join(output, `${name}-${label}.png`), fullPage: true });
        } finally { await context.close(); }
    }
}

async function main(args) {
    assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
    const opts = options(args);
    assert.equal(sha(opts.previousArchive), opts.previousSha256); assert.equal(sha(opts.archive), opts.sha256);
    fs.mkdirSync(opts.output, { recursive: true });
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'baizelingtai-gitlab-rehearsal-')));
    const report = { simulation: true, deployed: false, published: false, platform: process.platform, hostNode: process.version,
        previousArchiveSha256: opts.previousSha256, baseTargetArchiveSha256: opts.sha256, sourceCandidate: Boolean(opts.sourceCandidate), checks: {} };
    const progress = stage => console.log(JSON.stringify({ stage, output: opts.output }));
    let gitlab, browser, running;
    try {
        progress('verify-and-extract-base-packages');
        const old = await extract(opts.previousArchive, path.join(scratch, 'previous'), opts.routine);
        // A prebuilt ZIP is extracted only after the approved download, not twice.
        const targetPackage = zipPackage(opts.archive);
        const staged = opts.sourceCandidate ? await extract(opts.archive, path.join(scratch, 'candidate-base'), opts.routine) : null;
        const previousVersion = JSON.parse(fs.readFileSync(path.join(old, 'package.json'))).version;
        const targetVersion = targetPackage.version;
        assert.equal(require('../../server/pi-update-service').compareVersions(targetVersion, previousVersion), 1, 'must rehearse a real version transition');
        if (opts.sourceCandidate) {
            assert.equal(sha(path.join(source, 'package-lock.json')), sha(path.join(staged, 'package-lock.json')), 'candidate dependency lock must match source for overlays');
            progress('freeze-current-source-in-simulation-candidate');
            const files = require('../../scripts/source-files.cjs').distributionFiles(source);
            for (const file of files) { const dest = path.join(staged, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(source, file), dest); }
            const records = files.map(file => ({ path: file, bytes: fs.statSync(path.join(staged, file)).size, sha256: sha(path.join(staged, file)) }));
            report.sourceFilesSha256 = createHash('sha256').update(JSON.stringify(records)).digest('hex');
            json(path.join(opts.output, 'source-files.json'), records);
            json(path.join(staged, 'TRIAL_MANIFEST.json'), { version: 1, appVersion: targetVersion, simulation: true, files: records });
            const metadata = JSON.parse(fs.readFileSync(path.join(staged, 'PORTABLE_MANIFEST.json')));
            const map = new Map(metadata.files.map(file => [file.path, file]));
            for (const file of [...records, { path: 'TRIAL_MANIFEST.json', bytes: fs.statSync(path.join(staged, 'TRIAL_MANIFEST.json')).size, sha256: sha(path.join(staged, 'TRIAL_MANIFEST.json')) }]) map.set(file.path, file);
            const recordsInventory = opts.routine ? portableNames(staged).filter(file => file !== 'PORTABLE_MANIFEST.json').map(file => {
                assert.ok(map.has(file), 'simulation inventory must cover ' + file); return map.get(file);
            }) : (await inventory(staged)).filter(file => file.path !== 'PORTABLE_MANIFEST.json');
            json(path.join(staged, 'PORTABLE_MANIFEST.json'), { ...metadata, simulation: true, sourceFilesSha256: report.sourceFilesSha256, files: recordsInventory });
        }
        const candidate = path.join(opts.output, `baizelingtai-${targetVersion}.zip`);
        progress('create-simulation-zip');
        if (opts.sourceCandidate) tools.createPortableArchive(staged, candidate);
        else fs.copyFileSync(opts.archive, candidate, fs.constants.COPYFILE_EXCL);
        const targetSha256 = sha(candidate), targetBytes = fs.statSync(candidate).size;
        Object.assign(report, { previousVersion, targetVersion, targetSha256, targetBytes, scratch });
        const requests = []; let mode = 'ok', manifest;
        const project = 'team/baizelingtai', apiRoot = `/api/v4/projects/${encodeURIComponent(project)}`;
        const app = express();
        app.use((req, _res, next) => { requests.push({ method: req.method, path: req.originalUrl }); next(); });
        app.get(`${apiRoot}/repository/files/updates%2Flatest.json/raw`, (_req, res) => {
            if (mode === 'offline') return res.status(503).json({ error: 'synthetic unavailable' });
            if (mode === 'login') return res.type('html').send('<html>GitLab sign in</html>');
            res.json(mode === 'invalid' ? { ...manifest, package: 'http://elsewhere.invalid/app.zip' } : manifest);
        });
        app.get(`${apiRoot}/packages/generic/baizelingtai/${targetVersion}/baizelingtai-${targetVersion}.zip`, (_req, res) => {
            if (mode === 'download-offline') return res.sendStatus(503);
            if (mode === 'redirect') return res.redirect('/users/sign_in');
            res.sendFile(candidate);
        });
        app.get('/team/baizelingtai/-/releases', (_req, res) => res.send('Synthetic GitLab releases'));
        gitlab = app.listen(0, '127.0.0.1'); await once(gitlab, 'listening');
        const origin = `http://127.0.0.1:${gitlab.address().port}`;
        const feed = `${origin}${apiRoot}/repository/files/updates%2Flatest.json/raw?ref=HEAD`;
        manifest = tools.updateManifest({ archive: candidate, sha256: targetSha256, bytes: targetBytes,
            appVersion: targetVersion, piVersion: targetPackage.dependencies['@earendil-works/pi-coding-agent'],
            options: { feed, package: `${origin}${apiRoot}/packages/generic/baizelingtai/${targetVersion}/{filename}`, releasesUrl: `${origin}/team/baizelingtai/-/releases` } });
        json(path.join(opts.output, 'latest.json'), manifest);
        const data = path.join(scratch, 'user-data'), projectPath = path.join(scratch, 'project');
        fs.mkdirSync(data); fs.mkdirSync(projectPath);
        const qa = path.join(scratch, 'qa'); fs.mkdirSync(qa);
        const env = tools.portableEnvironment(old, qa);
        const networkGuard = path.join(qa, 'loopback-only.cjs');
        fs.writeFileSync(networkGuard, String.raw`
            for (const protocol of ['node:http', 'node:https']) {
                const transport = require(protocol), original = transport.request;
                transport.request = function(input, ...args) {
                    const value = typeof input === 'string' || input instanceof URL ? new URL(input) : input;
                    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(value.hostname || value.host)) throw Error('Rehearsal blocked external network');
                    return original.call(this, input, ...args);
                };
            }
        `);
        Object.assign(env, { HOST: '127.0.0.1', PORT: '0', PI_CODING_AGENT_DIR: path.join(data, 'agent'),
            PI_MEDIA_DATA_DIR: path.join(data, 'media'), PI_MEDIA_CONFIG_DIR: path.join(data, 'media-lab'),
            PI_WEB_DEFERRED_FILE: path.join(data, 'deferred.json'), PI_PROJECT_ROOTS: projectPath,
            PI_WEB_TOKEN: 'gitlab-rehearsal-synthetic-only', PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1',
            BAIZELINGTAI_UPDATE_FEED_URL: feed, PIVANE_UPDATE_FEED_URL: feed, BAIZELINGTAI_UPDATE_RELEASES_URL: manifest.releasesUrl });
        env.PIVANE_REHEARSAL_NETWORK_GUARD = networkGuard;
        for (const dir of [env.PI_CODING_AGENT_DIR, env.PI_MEDIA_DATA_DIR, env.PI_MEDIA_CONFIG_DIR]) fs.mkdirSync(dir, { recursive: true });
        // Use the native SessionManager once while no service/worker owns this file.
        const { SessionManager } = await import('@earendil-works/pi-coding-agent');
        const sessionDir = path.join(env.PI_CODING_AGENT_DIR, 'sessions', `--${projectPath.replace(/[:\\/]/g, '-').replace(/^-|-$/g, '')}--`);
        const sm = SessionManager.create(projectPath, sessionDir);
        const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 2, api: 'openai-completions', provider: 'fixture', model: 'fixture',
            stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
        const first = sm.appendMessage({ role: 'user', content: 'Synthetic update rehearsal', timestamp: 1 });
        sm.appendMessage(assistant('First branch')); sm.branch(first);
        const leaf = sm.appendMessage(assistant('Second branch')); sm.appendLabelChange(leaf, 'synthetic bookmark');
        sm.appendSessionInfo('GitLab update rehearsal');
        const sessionPath = sm.getSessionFile(), nativeEntries = JSON.stringify(sm.getEntries());
        const seeded = [sessionPath, path.join(env.PI_CODING_AGENT_DIR, 'settings.json'), path.join(env.PI_MEDIA_DATA_DIR, 'fixture.wav'),
            path.join(env.PI_MEDIA_CONFIG_DIR, 'fixture.json'), env.PI_WEB_DEFERRED_FILE, path.join(projectPath, 'fixture.txt')];
        for (const [file, value] of [[seeded[1], '{"defaultThinkingLevel":"off","syntheticUnknownField":true}\n'], [seeded[2], 'synthetic media bytes'],
            [seeded[3], '{"synthetic":true}\n'], [seeded[4], '{"version":1,"jobs":[]}\n'], [seeded[5], 'synthetic project bytes']]) fs.writeFileSync(file, value);
        const unchanged = seeded.map(file => ({ file, sha256: sha(file) }));
        const assertData = () => { for (const entry of unchanged) assert.equal(sha(entry.file), entry.sha256, 'original data bytes');
            const opened = SessionManager.open(sessionPath); assert.equal(opened.getSessionId(), sm.getSessionId()); assert.equal(JSON.stringify(opened.getEntries()), nativeEntries); };
        progress('exercise-detection-and-download-failures');
        const lookup = async () => new UpdateService({ env, appVersion: previousVersion, platform: 'win32', arch: 'x64' }).check();
        const selected = (await lookup()).pivane;
        assert.equal(selected.status, 'available'); assert.equal(selected.version, targetVersion);
        report.checks.detectNewVersion = true;
        for (const errorMode of ['offline', 'login', 'invalid']) {
            mode = errorMode; const failed = await lookup(); assert.equal(failed.pivane.status, 'error'); assert.equal(failed.pi.status, 'error');
        }
        mode = 'ok';
        await assert.rejects(download({ ...selected, sha256: '0'.repeat(64) }, path.join(scratch, 'bad-hash.zip')), /SHA256 mismatch/);
        await assert.rejects(download({ ...selected, bytes: selected.bytes - 1 }, path.join(scratch, 'bad-size.zip')), /byte count mismatch/);
        for (const errorMode of ['redirect', 'download-offline']) {
            mode = errorMode; await assert.rejects(download(selected, path.join(scratch, `${errorMode}.zip`)));
        }
        mode = 'ok'; const before = requests.length;
        manifest = { ...manifest, version: '99.0.0' };
        const changed = (await lookup()).pivane;
        assert.notEqual(changed.version, selected.version); assert.equal(requests.length, before + 1, 'changed plan stops before download');
        manifest = { ...manifest, version: targetVersion };
        report.checks.failuresStopBeforeExtraction = ['feed-offline', 'login-html', 'cross-origin', 'SHA256', 'bytes', 'redirect', 'download-offline', 'changed-target'];
        progress('boot-previous-version-with-synthetic-data');
        running = await start(old, env, opts.output, 'previous');
        const oldSnapshot = await running.api('settings/updates');
        assert.equal(oldSnapshot.status, 200); assert.equal(oldSnapshot.data.appVersion, previousVersion);
        if (oldSnapshot.data.source?.type === 'manifest') {
            const detection = await running.api('settings/updates/check', {});
            assert.equal(detection.data.pivane.version, targetVersion);
        } else report.checks.legacyBootstrapRequired = true;
        const sessions = await running.api('sessions?cwd=' + encodeURIComponent(projectPath));
        assert.equal(sessions.status, 200); assert.ok(sessions.data.sessions.some(item => item.id === sm.getSessionId()), 'old service finds native session');
        const downloaded = path.join(scratch, 'approved.zip');
        await download(selected, downloaded); assert.equal(sha(downloaded), targetSha256);
        const next = await extract(downloaded, path.join(scratch, 'installed'), opts.routine);
        report.checks.downloadWholeArchiveIntegrity = true;
        report.checks.fullInventory = !opts.routine;
        await running.launcher.close(); running = null;
        assertData();
        const backup = backupRoots([data, projectPath], path.join(scratch, 'stopped-backup'));
        const backupManifest = JSON.parse(fs.readFileSync(path.join(backup.directory, 'manifest.json')));
        for (const entry of backupManifest.entries.filter(item => item.type === 'file')) assert.equal(sha(path.join(backup.directory, 'files', entry.object)), entry.sha256);
        report.checks.stoppedBackupVerified = true;
        // Persist absolute defaults in the new application's own .env before first startup.
        const transfer = Object.fromEntries(['PI_CODING_AGENT_DIR', 'PI_MEDIA_DATA_DIR', 'PI_MEDIA_CONFIG_DIR', 'PI_WEB_DEFERRED_FILE', 'PI_PROJECT_ROOTS',
            'BAIZELINGTAI_UPDATE_FEED_URL', 'BAIZELINGTAI_UPDATE_RELEASES_URL'].map(key => [key, env[key]]));
        fs.writeFileSync(path.join(next, '.env'), Object.entries(transfer).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
        const nextEnv = { ...env }; for (const key of Object.keys(transfer)) delete nextEnv[key]; delete nextEnv.PIVANE_UPDATE_FEED_URL;
        require(path.join(next, 'server/pi-local-env')).loadLocalEnv(path.join(next, '.env'), nextEnv);
        for (const [key, value] of Object.entries(transfer)) assert.equal(nextEnv[key], value);
        progress('boot-candidate-and-verify-real-desktop-mobile-page');
        running = await start(next, nextEnv, opts.output, 'candidate');
        const current = await running.api('settings/updates/check', {});
        assert.equal(current.status, 200); assert.equal(current.data.appVersion, targetVersion); assert.equal(current.data.pivane.status, 'current');
        assert.equal(current.data.piVersion, manifest.piVersion);
        for (const action of ['application', 'update']) assert.equal((await running.api('settings/updates/review', { action })).status, 409, 'ZIP requires independent maintenance');
        browser = await require(opts.playwright).chromium.launch({ executablePath: opts.browser, headless: true });
        await verifyPage(browser, running, opts.output, manifest, 'candidate');
        await browser.close(); browser = null;
        await running.launcher.close(); running = null;
        assertData(); report.checks.sameAbsoluteDataAndNativeBranches = true; report.checks.realDesktopMobilePrompt = true;
        progress('restore-stopped-backup-and-boot-previous-version');
        for (const entry of backupManifest.entries.filter(item => item.type === 'file')) fs.copyFileSync(path.join(backup.directory, 'files', entry.object), entry.path);
        assertData();
        running = await start(old, env, opts.output, 'rollback');
        const rolledBack = await running.api('settings/updates');
        assert.equal(rolledBack.data.appVersion, previousVersion);
        await running.launcher.close(); running = null; assertData();
        report.checks.rollbackToPreviousVersion = true; report.checks.noAutomaticReplay = true;
        report.checks.onlyLoopbackGitLabRequests = requests.every(request => request.method === 'GET' && request.path.startsWith('/api/v4/projects/'));
        assert.equal(report.checks.onlyLoopbackGitLabRequests, true);
        json(path.join(opts.output, 'requests.json'), requests);
        report.ok = true;
        progress('passed');
    } finally {
        await browser?.close(); await running?.launcher.close();
        if (gitlab) { gitlab.closeAllConnections(); await new Promise(resolve => gitlab.close(resolve)); }
        json(path.join(opts.output, 'result.json'), report);
        // Retain only synthetic scratch for audit/reproduction; no user paths are copied or removed.
    }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { options, download, start, verifyPage, extract };
