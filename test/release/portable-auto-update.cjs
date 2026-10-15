// Explicit exact-package E2E. Fresh identities, loopback feed, real browser and launcher.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { fork } = require('node:child_process');
const express = require('express');
const { options, extract, start, verifyPage } = require('./gitlab-portable-update.cjs');
const { portableEnvironment, updateManifest } = require('../../scripts/package-windows-portable.cjs');
const { hashFileSafe, readSafe } = require('../../server/pi-maintenance-files');
const { restoreBackup } = require('../../server/pi-maintenance-restore');
const sha = file => hashFileSafe(file).sha256;
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
async function main(args) {
    const opts = options(args); assert.equal(process.platform, 'win32');
    assert.ok(!opts.sourceCandidate && !opts.routine, 'automatic E2E requires exact ZIPs and full inventory verification');
    assert.equal(sha(opts.previousArchive), opts.previousSha256); assert.equal(sha(opts.archive), opts.sha256);
    fs.mkdirSync(opts.output, { recursive: true });
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'baizelingtai-auto-e2e-')));
    const result = { simulation: true, deployed: false, published: false, scratch, previousSha256: opts.previousSha256, targetSha256: opts.sha256, checks: [] };
    const progress = stage => console.log(JSON.stringify({ stage, output: opts.output }));
    let remote, running, browser;
    try {
        progress('verify-old-package');
        const old = await extract(opts.previousArchive, path.join(scratch, 'old'));
        const oldVersion = JSON.parse(readSafe(path.join(old, 'package.json'))).version;
        const requests = [], app = express(); let mode = 'ok', manifest;
        app.use((req, _res, next) => { requests.push({ method: req.method, path: req.path }); next(); });
        app.get('/updates/latest.json', (_req, res) => {
            if (mode === 'feed-offline') return res.sendStatus(503);
            res.json(mode === 'bad-hash' ? { ...manifest, sha256: '0'.repeat(64) } : manifest);
        });
        app.get('/packages/baizelingtai.zip', (_req, res) => {
            if (mode === 'download-offline') return res.sendStatus(503);
            if (mode === 'redirect') return res.redirect('/login');
            res.sendFile(opts.archive);
        });
        remote = app.listen(0, '127.0.0.1'); await once(remote, 'listening');
        const origin = `http://127.0.0.1:${remote.address().port}`, feed = origin + '/updates/latest.json';
        // The sidecar is bound to this exact target ZIP by the packaging step.
        const target = JSON.parse(fs.readFileSync(opts.archive + '.update.json'));
        assert.equal(target.sha256, opts.sha256); assert.equal(target.bytes, fs.statSync(opts.archive).size);
        manifest = updateManifest({ archive: opts.archive, sha256: opts.sha256, bytes: target.bytes, appVersion: target.version, piVersion: target.piVersion,
            options: { feed, package: origin + '/packages/baizelingtai.zip', releasesUrl: origin + '/releases' } });
        assert.equal(require('../../server/pi-update-service').compareVersions(target.version, oldVersion), 1);
        Object.assign(result, { oldVersion, targetVersion: target.version }); json(path.join(opts.output, 'latest.json'), manifest);
        const data = path.join(scratch, 'data'), project = path.join(scratch, 'project'), qa = path.join(scratch, 'qa');
        for (const dir of [data, project, qa]) fs.mkdirSync(dir);
        const env = portableEnvironment(old, qa), guard = path.join(qa, 'loopback-only.cjs');
        fs.writeFileSync(guard, `for(const protocol of ['node:http','node:https']){const transport=require(protocol),original=transport.request;transport.request=function(input,...args){const value=typeof input==='string'||input instanceof URL?new URL(input):input;if(!['127.0.0.1','localhost','::1','[::1]'].includes(value.hostname||value.host))throw Error('E2E blocked external network');return original.call(this,input,...args)}}`);
        Object.assign(env, { HOST: '127.0.0.1', PORT: '0', PI_CODING_AGENT_DIR: path.join(data, 'agent'), PI_MEDIA_DATA_DIR: path.join(data, 'media'),
            PI_MEDIA_CONFIG_DIR: path.join(data, 'media-lab'), PI_WEB_DEFERRED_FILE: path.join(data, 'deferred.json'), PI_PROJECT_ROOTS: project,
            PI_WEB_TOKEN: 'gitlab-rehearsal-synthetic-only', BAIZELINGTAI_UPDATE_FEED_URL: feed, BAIZELINGTAI_UPDATE_RELEASES_URL: origin + '/releases',
            PIVANE_REHEARSAL_NETWORK_GUARD: guard });
        for (const dir of [env.PI_CODING_AGENT_DIR, env.PI_MEDIA_DATA_DIR, env.PI_MEDIA_CONFIG_DIR]) fs.mkdirSync(dir);
        const { SessionManager } = await import('@earendil-works/pi-coding-agent');
        const sm = SessionManager.create(project, path.join(env.PI_CODING_AGENT_DIR, 'sessions', `--${project.replace(/[:\\/]/g, '-').replace(/^-|-$/g, '')}--`));
        const first = sm.appendMessage({ role: 'user', content: 'Synthetic original branch', timestamp: 1 });
        sm.appendMessage({ role: 'user', content: 'Synthetic first leaf', timestamp: 2 }); sm.branch(first);
        const leaf = sm.appendMessage({ role: 'user', content: 'Synthetic second leaf', timestamp: 3 }); sm.appendLabelChange(leaf, 'synthetic bookmark');
        const seeded = [sm.getSessionFile(), path.join(env.PI_MEDIA_DATA_DIR, 'fixture.wav'), path.join(env.PI_MEDIA_CONFIG_DIR, 'fixture.json'), env.PI_WEB_DEFERRED_FILE];
        fs.writeFileSync(seeded[1], 'synthetic media'); fs.writeFileSync(seeded[2], '{"syntheticUnknownField":true}\n'); fs.writeFileSync(seeded[3], '{"version":1,"jobs":[]}\n');
        const preserved = seeded.map(file => ({ file, sha256: sha(file) })), entries = JSON.stringify(sm.getEntries());
        const assertData = () => { for (const proof of preserved) assert.equal(sha(proof.file), proof.sha256); const opened = SessionManager.open(seeded[0]); assert.equal(opened.getSessionId(), sm.getSessionId()); assert.equal(JSON.stringify(opened.getEntries()), entries); };
        running = await start(old, env, opts.output, 'service');
        const waitJob = async id => {
            const deadline = Date.now() + 15 * 60 * 1000; let phase;
            for (;;) {
                const job = running.launcher.state.job;
                if (job?.id === id && phase !== job.phase) { phase = job.phase; progress(phase); }
                if (job?.id === id && ['succeeded', 'failed', 'interrupted'].includes(job.phase) && !running.launcher.operation) return job;
                assert.ok(Date.now() < deadline, 'maintenance did not finish'); await new Promise(resolve => setTimeout(resolve, 300));
            }
        };
        const submit = async () => {
            const reviewed = await running.api('settings/updates/review', { action: 'application', channel: 'stable' }); assert.equal(reviewed.status, 200);
            const input = { ticket: reviewed.data.id, confirmed: true, draftsSaved: true, externalWritersStopped: true };
            const accepted = await running.api('settings/updates/execute', input); assert.equal(accepted.status, 202);
            assert.equal((await running.api('settings/updates/execute', input)).status, 409);
            return waitJob(accepted.data.id);
        };
        progress('real-package-download-faults');
        for (mode of ['bad-hash', 'download-offline', 'redirect']) {
            const before = requests.filter(request => request.path === '/packages/baizelingtai.zip').length;
            const job = await submit(); assert.equal(job.phase, 'failed'); assert.equal(running.launcher.state.active, null);
            assert.equal(requests.filter(request => request.path === '/packages/baizelingtai.zip').length, before + 1, 'failed download is never retried');
            assertData(); result.checks.push(mode + '-retains-old-no-replay');
        }
        mode = 'ok';
        progress('inject-candidate-startup-failure');
        const forkServer = running.launcher.forkServer, failure = path.join(qa, 'startup-failure.cjs'); fs.writeFileSync(failure, 'process.exit(1)');
        let injected = false;
        running.launcher.forkServer = (file, args, opts) => {
            if (!injected && file.includes(path.join('.pivane-runtime', 'releases'))) {
                injected = true; fs.appendFileSync(seeded[0], '\nsynthetic failed-start modification');
                return fork(failure, [], { ...opts, execPath: path.join(old, 'runtime/node.exe') });
            }
            return forkServer(file, args, opts);
        };
        const failedStart = await submit(); running.launcher.forkServer = forkServer;
        assert.ok(injected); assert.equal(failedStart.phase, 'failed'); assert.ok(failedStart.recoveryBackup); assert.equal(running.launcher.state.active, null); assertData();
        result.checks.push('startup-failure-restores-native-bytes-and-boots-old');
        progress('real-browser-update');
        browser = await require(opts.playwright).chromium.launch({ executablePath: opts.browser, headless: true });
        const errors = [], writes = [];
        async function pageFor(label, width) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN', isMobile: width < 700, hasTouch: width < 700,
                extraHTTPHeaders: { Authorization: 'Bearer gitlab-rehearsal-synthetic-only' } });
            const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
            page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(new URL(request.url()).pathname); });
            await page.route(/https?:\/\/(?!127\.0\.0\.1:)/, route => route.abort());
            await page.goto(running.base, { waitUntil: 'domcontentloaded' }); await page.locator('#workspace-settings-toggle').click();
            await page.locator('[data-settings-tab="updates"]').click(); await page.locator('#updates-install-pivane').waitFor();
            assert.ok((await page.locator('#updates-pivane').innerText()).includes(oldVersion));
            await page.locator('#updates-install-pivane').click(); await page.locator('#updates-confirm-install').waitFor();
            assert.equal(await page.locator('#updates-confirm-install').isDisabled(), true);
            await page.locator('#updates-drafts-saved').check(); await page.locator('#updates-external-stopped').check();
            assert.equal(await page.locator('#updates-confirm-install').isDisabled(), false);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.screenshot({ path: path.join(opts.output, label + '-confirmation.png'), fullPage: true });
            return { context, page };
        }
        const mobile = await pageFor('mobile', 393); await mobile.context.close();
        const desktop = await pageFor('desktop', 1440);
        await desktop.page.locator('#updates-confirm-install').click();
        while (!running.launcher.state.job || ['succeeded', 'failed'].includes(running.launcher.state.job.phase)) await new Promise(resolve => setTimeout(resolve, 50));
        const installed = await waitJob(running.launcher.state.job.id); assert.equal(installed.phase, 'succeeded', installed.output);
        await desktop.page.locator('#updates-operation').filter({ hasText: '更新完成' }).waitFor({ timeout: 30000 });
        const updated = await running.api('settings/updates/check', {}); assert.equal(updated.data.appVersion, target.version); assert.equal(updated.data.pivane.status, 'current');
        assert.equal(writes.filter(route => route.endsWith('/execute')).length, 1, 'browser submits once');
        assert.equal(await desktop.page.locator('#updates-install-pivane').count(), 0); assert.deepEqual(errors, []);
        await desktop.page.screenshot({ path: path.join(opts.output, 'desktop-success.png'), fullPage: true });
        await desktop.context.close(); await verifyPage(browser, running, opts.output, manifest, 'candidate'); await browser.close(); browser = null;
        assertData(); result.checks.push('desktop-click-detect-download-verify-backup-start-current', 'mobile-confirmation-no-overflow', 'no-pageerror-or-duplicate-execute', 'native-id-branches-bookmark-media-config-preserved');
        result.installedJob = { id: installed.id, fromVersion: installed.fromVersion, installedVersion: installed.installedVersion, backup: installed.backup.directory };
        const activeRoot = running.launcher.releasePath(running.launcher.state.active);
        assert.equal(JSON.parse(readSafe(path.join(activeRoot, 'PI_INSTALL_COMPLETE.json'))).archiveSha256, opts.sha256);
        progress('restart-original-entry-then-restore');
        await running.launcher.close(); running = await start(old, env, opts.output, 'restart');
        assert.equal((await running.api('settings/updates')).data.appVersion, target.version); assertData(); result.checks.push('original-entry-restarts-active-new-version');
        await running.launcher.close(); running = null; await restoreBackup(old, installed.id); assertData();
        running = await start(old, env, opts.output, 'rollback'); assert.equal((await running.api('settings/updates')).data.appVersion, oldVersion); assertData();
        result.checks.push('offline-restore-boots-previous-version'); json(path.join(opts.output, 'requests.json'), requests);
        result.ok = true; progress('passed');
    } finally {
        await browser?.close(); await running?.launcher.close();
        if (remote) { remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); }
        json(path.join(opts.output, 'result.json'), result);
    }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.stack); process.exitCode = 1; });
