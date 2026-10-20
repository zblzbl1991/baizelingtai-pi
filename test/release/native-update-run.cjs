const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync, sign } = require('node:crypto');
const { readSafe, hashFileSafe, privateDir, atomicJson, copySafe } = require('../../server/pi-maintenance-files');
const privateFiles = require('../../server/pi-private-files');
const { NativeObserver, sleep } = require('./native-update-observer.cjs');
const processes = require('./native-update-processes.cjs');
const { SCENARIOS } = require('./native-launcher-update.cjs');
const PRE_REVIEW = new Set(['missing-signature', 'invalid-signature', 'foreign-key']);
const JOB_REJECTION = new Set(['target-changed', 'corrupt-download', 'staged-mutation', 'unpublished-source']);
const INTERRUPT = new Set(['interrupt-prepared', 'interrupt-activating', 'interrupt-rollback']);
const ROLLBACK = new Set(['validation-failure', 'validation-timeout']);
const EXPECTED = Object.freeze({ normal: 'committed', 'old-tray-held': 'committed', 'repair-entry': 'committed',
    'repair-changed-entry': 'committed', 'postcommit-preservation': 'committed', 'committed-crash': 'committed', 'target-changed': 'job-rejected',
    'corrupt-download': 'job-rejected', 'staged-mutation': 'job-rejected', 'unpublished-source': 'job-rejected',
    'unknown-cleanup': 'cleanup-unknown', 'interrupt-prepared': 'interrupted', 'interrupt-activating': 'interrupted',
    'interrupt-rollback': 'interrupted', 'occupied-entry': 'entry-occupied', 'recovery-failure': 'recovery-failed',
    'validation-failure': 'rolled-back', 'validation-timeout': 'rolled-back' });
function unsupported(message) { const error = Error(message); error.code = 'QA_UNSUPPORTED'; throw error; }
function jsonFile(file, max = 1024 * 1024) { return JSON.parse(readSafe(file, max)); }
function program(root, state) { return state?.active ? path.join(root, '.pivane-runtime/releases', state.active) : root; }
function scoped(scope, file) {
    if (!path.isAbsolute(file) || !file.startsWith(scope + path.sep) || fs.realpathSync.native(file) !== file) throw Error('Fault/cleanup target escaped its canonical QA scope');
    return file;
}
async function request(url, route, input) {
    const response = await fetch(new URL('api/pi/' + route, url), { method: input === undefined ? 'GET' : 'POST',
        headers: { origin: new URL(url).origin, ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }), redirect: 'error', signal: AbortSignal.timeout(15000) });
    const data = await response.json(); return { status: response.status, data, observedAt: new Date().toISOString() };
}
async function rejectionProbes(url, root) {
    const read = await request(url, 'status'); assert.equal(read.status, 503);
    const mutation = await request(url, 'settings/updates/notifications', {}); assert.equal(mutation.status, 503);
    const WebSocket = require(path.join(root, 'node_modules/ws'));
    const socket = new WebSocket(new URL('api/pi/ws', url).href.replace(/^http:/, 'ws:'), { origin: new URL(url).origin });
    const blocked = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(Error('Candidate WS admission probe timed out')); }, 15000);
        socket.once('error', error => { clearTimeout(timer); reject(error); });
        socket.once('open', () => socket.send(JSON.stringify({ type: 'get_state', id: 'native-qa-admission' })));
        socket.on('message', bytes => {
            const reply = JSON.parse(bytes);
            if (reply.id !== 'native-qa-admission') return;
            clearTimeout(timer); socket.close(); resolve(reply);
        });
    });
    assert.equal(blocked.success, false); assert.match(blocked.error, /维护/);
    return { read, mutation, websocket: blocked, background: 'native gateway health proof; no provider/task dispatch was requested' };
}
function makePaths(scope) {
    const names = { PI_CODING_AGENT_DIR: 'agent', PI_CODING_AGENT_SESSION_DIR: 'sessions', PI_MEDIA_DATA_DIR: 'media',
        PI_MEDIA_CONFIG_DIR: 'media-config', PI_WEB_DEFERRED_FILE: 'deferred.json', PI_PROJECT_ROOTS: 'project',
        HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', TEMP: 'tmp', TMP: 'tmp',
        PIVANE_NATIVE_QA_CHECKPOINTS: 'checkpoints', PIVANE_NATIVE_QA_RECEIPTS: 'receipts' };
    const paths = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, path.join(scope, name)]));
    for (const [key, file] of Object.entries(paths)) {
        if (key === 'PI_WEB_DEFERRED_FILE') privateFiles.writePrivateFileSync(file, '{"version":1,"jobs":[]}\n', true);
        else privateDir(file);
    }
    // Windows PowerShell initializes this directory even with explicit APPDATA.
    privateDir(path.join(paths.HOME, 'AppData'));
    privateDir(path.join(scope, 'permission-tmp'));
    return paths;
}
function baseEnvironment(paths) {
    const systemRoot = fs.realpathSync.native(process.env.SystemRoot);
    return { SystemRoot: systemRoot, SystemDrive: path.parse(systemRoot).root.slice(0, 2),
        PATH: [path.join(systemRoot, 'System32'), path.join(systemRoot, 'System32/WindowsPowerShell/v1.0')].join(';'),
        ...paths };
}
async function startFeed(options, inputs) {
    let mode = PRE_REVIEW.has(options.scenario) ? options.scenario : 'valid';
    const deliveries = [];
    const source = structuredClone(inputs.manifest), foreign = structuredClone(source);
    const key = generateKeyPairSync('ed25519').privateKey;
    foreign.signature = { algorithm: 'ed25519', keyId: 'qa-foreign', value: sign(null, require('../../server/pi-update-signatures').releaseSignaturePayload(foreign), key).toString('base64') };
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
        if (pathname === '/feed.json') {
            let manifest = structuredClone(mode === 'changed' ? inputs.changedManifest : mode === 'foreign-key' ? foreign : source);
            if (mode === 'missing-signature') delete manifest.signature;
            if (mode === 'invalid-signature') manifest.signature.value = 'A'.repeat(86) + '==';
            deliveries.push({ at: new Date().toISOString(), kind: 'manifest', mode, signatureKeyId: manifest.signature?.keyId || null });
            res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(manifest)); return;
        }
        if (pathname === new URL(source.package, 'http://127.0.0.1').pathname) {
            res.setHeader('content-type', 'application/zip'); res.setHeader('content-length', source.bytes);
            const input = fs.createReadStream(options.archive), delivery = { at: new Date().toISOString(), kind: 'zip', mode, bytes: 0, changedByte: false, completed: false };
            deliveries.push(delivery);
            const meter = new (require('node:stream').Transform)({ transform(chunk, _encoding, done) {
                delivery.bytes += chunk.length;
                if (delivery.mode === 'corrupt' && !delivery.changedByte && chunk.length) { chunk = Buffer.from(chunk); chunk[0] ^= 0xff; delivery.changedByte = true; }
                done(null, chunk);
            } });
            res.on('finish', () => { delivery.completed = true; });
            input.on('error', () => res.destroy()); meter.on('error', () => res.destroy()); res.on('close', () => input.destroy()); input.pipe(meter).pipe(res); return;
        }
        res.writeHead(404); res.end('QA origin has no such resource');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { url: `http://127.0.0.1:${server.address().port}/feed.json`, setMode: value => { mode = value; },
        deliveries: () => deliveries.slice(-128),
        close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
async function session(operation, root, env, file) {
    const result = await processes.run(path.join(root, 'runtime/node.exe'), [path.join(__dirname, 'native-update-session.cjs'), operation, root, ...(file ? [file] : [])], env,
        { cwd: env.PI_PROJECT_ROOTS, timeoutMs: 180000 });
    return JSON.parse(result.stdout);
}
function seedFiles(paths) {
    privateDir(path.join(paths.PI_CODING_AGENT_DIR, 'prompts'));
    const entries = [[path.join(paths.PI_CODING_AGENT_DIR, 'settings.json'), '{"defaultThinkingLevel":"off","syntheticUnknownField":true}\n'],
        [path.join(paths.PI_MEDIA_DATA_DIR, 'fixture.bin'), 'synthetic native acceptance media\n'],
        [path.join(paths.PI_MEDIA_CONFIG_DIR, 'fixture.json'), '{"synthetic":true}\n'],
        [path.join(paths.PI_PROJECT_ROOTS, 'fixture.txt'), 'synthetic project bytes\n'],
        [path.join(paths.PI_CODING_AGENT_DIR, 'prompts', 'qa.md'), 'Synthetic preserved prompt\n'],
        [path.join(paths.PI_CODING_AGENT_DIR, 'qa-history.json'), '{"syntheticHistory":["preserve"]}\n']];
    for (const [file, bytes] of entries) privateFiles.writePrivateFileSync(file, bytes, true);
    return [...entries.slice(1).map(([file]) => ({ file, ...hashFileSafe(file) })),
        { file: paths.PI_WEB_DEFERRED_FILE, ...hashFileSafe(paths.PI_WEB_DEFERRED_FILE) }];
}
async function repair(root, command, env, id, input = '') {
    const args = [path.join(root, 'repair/scripts/repair-launcher.cjs'), command, root, ...(id ? [id] : [])];
    return processes.launch(path.join(root, 'repair/runtime/node.exe'), args, env, { cwd: root, input, timeoutMs: 180000 }).result;
}
function assertComponents(current, root, expectedVersion, expectedPi, manifest) {
    assert.equal(current.programRoot, root); assert.equal(current.nodePath, path.join(root, 'runtime/node.exe'));
    assert.equal(current.componentVersions?.appVersion, expectedVersion); assert.equal(current.componentVersions?.engineVersion, expectedPi);
    assert.equal(current.componentVersions?.launcherVersion, expectedVersion); assert.equal(current.componentVersions?.trayVersion, expectedVersion);
    const build = jsonFile(path.join(root, 'native/pivane-desktop-launcher-build.json'));
    assert.equal(current.components?.nativeVersion, expectedVersion + '.0'); assert.equal(current.components?.nativeSha256, build.binarySha256);
    assert.equal(current.components?.nativePath, path.join(root, '白泽灵台.exe'));
    assert.equal(current.components?.traySha256, hashFileSafe(path.join(root, 'scripts/desktop-tray.ps1')).sha256);
    assert.equal(current.components?.nodePath, path.join(root, 'runtime/node.exe'));
    assert.equal(current.components?.processes?.length, 2);
    if (manifest) assert.equal(build.binarySha256, manifest.files.find(entry => entry.path === '白泽灵台.exe')?.sha256);
}
function candidateSnapshot(observer, state, { restored }) {
    const receipt = [...observer.receipts.values()].find(value => value.point === 'candidate-before-validation' && value.details?.candidateDataFile);
    assert.ok(receipt, 'deterministic guarded candidate data injection was actually reached');
    const safety = state.activation.safetyBackup;
    assert.ok(safety?.directory, 'failed candidate data has a safety snapshot');
    const plan = require('../../server/pi-maintenance-backup').inspectBackupContents(safety.directory);
    const entry = plan.manifest.entries.find(value => value.path === receipt.details.candidateDataFile);
    assert.ok(entry, 'safety snapshot contains the candidate-only increment at its original absolute path');
    assert.equal(entry.sha256, receipt.details.candidateDataProof.sha256); assert.equal(entry.bytes, receipt.details.candidateDataProof.bytes);
    const object = path.join(safety.directory, 'files', entry.object);
    assert.deepEqual(hashFileSafe(object), receipt.details.candidateDataProof, 'actual backup object retains the exact candidate bytes');
    const preservedObject = path.join(observer.evidence, 'failed-candidate-increment.bin');
    copySafe(object, preservedObject, { bytes: 0, files: 0, maxBytes: 4096, maxFiles: 1 });
    atomicJson(path.join(observer.evidence, 'failed-candidate-backup-manifest.json'), plan.manifest);
    if (restored) assert.equal(fs.existsSync(receipt.details.candidateDataFile), false, 'original data scope excludes the candidate-only increment after rollback');
    return { injection: receipt.details, backupDirectory: safety.directory, object, preservedObject, proof: hashFileSafe(object), originalRestored: restored };
}
async function legacyRefusal(root, candidateRoot, scope, paths, env, report) {
    const scopeFile = path.join(scope, 'legacy-scope.json');
    atomicJson(scopeFile, { schemaVersion: 1, runtimePaths: Object.fromEntries(['PI_CODING_AGENT_DIR', 'PI_MEDIA_DATA_DIR', 'PI_MEDIA_CONFIG_DIR', 'PI_WEB_DEFERRED_FILE'].map(key => [key, paths[key]])),
        backupRoots: [paths.PI_CODING_AGENT_DIR, paths.PI_MEDIA_DATA_DIR, paths.PI_MEDIA_CONFIG_DIR, paths.PI_WEB_DEFERRED_FILE], backupDirectory: path.join(scope, 'offline-backup') });
    const executable = path.join(candidateRoot, 'repair/runtime/node.exe'), script = path.join(candidateRoot, 'repair/scripts/repair-launcher.cjs');
    const before = fs.existsSync(path.join(root, '.pivane-runtime/state.json')) ? hashFileSafe(path.join(root, '.pivane-runtime/state.json')) : null;
    const plan = await processes.run(executable, [script, 'legacy-plan', root, '--scope', scopeFile], env, { cwd: scope });
    const result = JSON.parse(plan.stdout); assert.equal(result.blocker, 'LEGACY_CLEANUP_UNPROVEN'); assert.equal(result.canMigrateAutomatically, false);
    const rejected = await processes.launch(executable, [script, 'migrate-legacy', root], env, { cwd: scope }).result;
    assert.equal(rejected.code, 1); assert.match(rejected.stderr, /LEGACY_CLEANUP_UNPROVEN/);
    const after = fs.existsSync(path.join(root, '.pivane-runtime/state.json')) ? hashFileSafe(path.join(root, '.pivane-runtime/state.json')) : null;
    assert.deepEqual(after, before);
    report.legacy = { plan: result, rejection: rejected, oldProcessStarted: false, actualMigration: false,
        evidenceBoundary: 'Exact legacy bytes and independent repair refusal; ticket04 evidence remains the migration reference' };
}
async function runAcceptance(options, inputs) {
    const scope = options.output, root = path.join(scope, '白泽 灵台 & QA'), candidateRoot = path.join(scope, 'candidate-input');
    const runId = randomUUID(), report = { schemaVersion: 1, runId, scenario: options.scenario, startedAt: new Date().toISOString(),
        status: 'running', execution: 'exact-windows-native', baselineKind: options.baselineKind, syntheticBaseline: options.baselineKind === 'synthetic-qa',
        artifacts: inputs.artifacts, inputs: { previousArchive: options.previousArchive, archive: options.archive, previousVersion: options.previousVersion,
            signedManifest: options.signedManifest, qaTrust: options.qaTrust }, harnessSourceSha256: hashFileSafe(__filename).sha256,
        host: { node: process.version, platform: process.platform, arch: process.arch, osRelease: require('node:os').release(), osVersion: require('node:os').version() },
        harnessClosure: Object.fromEntries(['native-launcher-update.cjs', 'native-update-inputs.cjs', 'native-update-run.cjs', 'native-update-observer.cjs',
            'native-update-processes.cjs', 'native-update-session.cjs', 'native-update-committed-crash.cjs', '../../server/pi-launcher-qa-context.js', '../../server/pi-launcher-qa-checkpoints.js']
            .map(name => [name, hashFileSafe(path.resolve(__dirname, name), 1024 * 1024)])),
        productBudgets: { activationMs: 120000, stableMs: 15000, ordinaryControlMs: 15000 },
        scenarios: Object.fromEntries(SCENARIOS.map(name => [name, { status: 'not-run' }])), layers: {}, limitations: [
            'Committed-crash verifies a real service HANDLE and owner admission; it does not create or hold an actual RPC worker HANDLE',
            'No real provider/model/background task dispatch; native initialization health plus HTTP/WS admission are the covered boundaries' ] };
    let feed, browser, observer, env, paths, current, holder, serviceWitness, helperWitness, failed = true, safeToRemove = false;
    let previousManifest, candidateManifest;
    const resultFile = path.join(scope, 'result.json');
    fs.mkdirSync(scope); privateDir(scope);
    const persist = () => atomicJson(resultFile, report);
    try {
        persist(); paths = makePaths(scope);
        const unpack = require('../../server/pi-portable-installer').unpackPortable;
        previousManifest = await unpack(options.previousArchive, root, options.previousVersion);
        candidateManifest = await unpack(options.archive, candidateRoot, inputs.manifest.version);
        report.previousInventory = { files: previousManifest.files.length, manifest: hashFileSafe(path.join(root, 'PORTABLE_MANIFEST.json'), 64 * 1024 ** 2) };
        report.candidateInventory = { files: candidateManifest.files.length, manifest: hashFileSafe(path.join(candidateRoot, 'PORTABLE_MANIFEST.json'), 64 * 1024 ** 2) };
        report.layers.serialExactExtractionAndInventory = true;
        for (const directory of [candidateRoot, ...(options.scenario === 'legacy-refusal' ? [] : [root])]) {
            const metadata = jsonFile(require('../../server/pi-update-feed').portableMetadataFile(directory));
            if (metadata.launcherUpdateProtocol !== 1 || !fs.existsSync(path.join(directory, 'server/pi-launcher-qa-context.js'))
                || !fs.existsSync(path.join(directory, 'server/pi-launcher-qa-checkpoints.js'))) unsupported('Accurate package lacks the guarded native QA continuation/checkpoint protocol; build a separate explicit QA artifact');
            if (options.scenario !== 'legacy-refusal' && metadata.desktopOwnerProtocol !== 1) unsupported('Automatic exact-package acceptance requires baseline and candidate desktopOwnerProtocol 1 metadata');
            for (const file of ['repair/runtime/node.exe', 'repair/scripts/repair-launcher.cjs']) assert.ok(fs.lstatSync(path.join(directory, file)).isFile());
        }
        require('../../server/pi-update-signatures').readUpdateTrust(readSafe(path.join(candidateRoot, 'config/update-trust.json'), 64 * 1024));
        report.shippedCandidateTrust = hashFileSafe(path.join(candidateRoot, 'config/update-trust.json'), 64 * 1024);
        const system = baseEnvironment(paths);
        if (options.scenario === 'legacy-refusal') {
            await legacyRefusal(root, candidateRoot, scope, paths, system, report); safeToRemove = true;
        } else {
            feed = await startFeed(options, inputs);
            const marker = { schemaVersion: 1, runId, root, scope, scenario: options.scenario, paths };
            privateFiles.writePrivateFileSync(path.join(scope, '.pivane-native-qa.json'), JSON.stringify(marker), true);
            privateFiles.writePrivateFileSync(path.join(root, '.pivane-launcher-test'), JSON.stringify(marker), true);
            const context = require('../../server/pi-launcher-qa-context').continuationEnvironment(root,
                { ...system, PIVANE_NATIVE_QA: '1', PIVANE_NATIVE_QA_SCOPE: scope, PIVANE_NATIVE_QA_RUN_ID: runId, PIVANE_NATIVE_QA_SCENARIO: options.scenario });
            env = { ...system, ...context, HOST: '127.0.0.1', PORT: '0', BAIZELINGTAI_UPDATE_FEED_URL: feed.url };
            report.qaTrustInstallation = { previous: hashFileSafe(path.join(root, 'config/update-trust.json')), installed: inputs.artifacts.qaTrust,
                authorization: 'Explicit --qa-trust input, only this fresh synthetic installation; original exact ZIP remains unchanged' };
            atomicJson(path.join(root, 'config/update-trust.json'), JSON.parse(inputs.trustBytes));
            const seeded = seedFiles(paths), native = await session('seed', root, env);
            report.nativeBefore = native; seeded.push({ file: native.file, ...hashFileSafe(native.file) });
            report.dataBefore = seeded;
            observer = new NativeObserver({ root, scope, runId, environment: env });
            const shortcutDirectory = privateDir(path.join(scope, 'shortcuts'));
            const shortcut = await processes.createShortcut(root, shortcutDirectory, env);
            report.shortcut = { path: shortcut, originalFixedTarget: path.join(root, '白泽灵台.exe') };
            report.layers.fixedEntryAttempted = true; report.initialEntryCommand = await processes.startFixedEntry(root, env);
            current = await observer.until(value => value.current?.state === 'ready' && value.current, 'initial real fixed EXE/tray/service');
            const original = current, baselineEntry = hashFileSafe(path.join(root, '白泽灵台.exe'));
            const oldPi = jsonFile(path.join(root, 'package.json')).dependencies['@earendil-works/pi-coding-agent'];
            assertComponents(current, root, options.previousVersion, oldPi, previousManifest);
            report.layers.fixedExeRealTrayBundledRunnerService = true; report.initial = current; persist();
            report.initialService = await observer.until(value => value.receipts.find(receipt => receipt.point === 'service-live' && receipt.details.programRoot === root), 'actual baseline service process identity', 15000);
            const chromium = require(options.playwright).chromium;
            browser = await chromium.launch({ executablePath: options.browser, headless: true, env: system });
            report.browser = { version: browser.version(), executable: options.browser,
                playwrightVersion: jsonFile(path.join(path.dirname(require.resolve(options.playwright)), 'package.json')).version };
            const browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
            const page = await browserContext.newPage(), pageErrors = [];
            page.on('pageerror', error => pageErrors.push(error.message));
            await page.goto(current.waitingUrl, { waitUntil: 'domcontentloaded' }); await page.waitForURL(current.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            assert.equal(await page.title(), '白泽灵台');
            await page.screenshot({ path: path.join(scope, 'evidence', 'before.png'), fullPage: true });
            if (options.scenario === 'unknown-cleanup') {
                const live = await observer.until(value => value.receipts.find(receipt => receipt.point === 'service-live'), 'real service receipt for pre-held exit witness', 15000);
                serviceWitness = await processes.witnessServiceExit(live, env);
            }
            const arm = (point, action) => observer.arm(point, action);
            if (['normal', 'repair-entry', 'repair-changed-entry', 'postcommit-preservation', 'committed-crash'].includes(options.scenario)) arm('candidate-before-validation', 'pause');
            if (options.scenario === 'staged-mutation') arm('candidate-staged', 'pause');
            if (options.scenario === 'occupied-entry' || options.scenario === 'interrupt-prepared') arm('helper-before-apply', 'pause');
            if (options.scenario === 'old-tray-held') arm('handoff-outer-exit', 'pause');
            if (options.scenario === 'interrupt-activating') arm('activation-replacing', 'pause');
            if (['validation-failure', 'recovery-failure', 'interrupt-rollback'].includes(options.scenario)) arm('candidate-before-validation', 'fail');
            if (options.scenario === 'validation-timeout') arm('candidate-before-validation', 'timeout');
            if (['recovery-failure', 'interrupt-rollback'].includes(options.scenario)) arm('rollback-restoring', 'pause');
            if (options.scenario === 'unknown-cleanup') arm('service-before-cleanup-proof', 'omit-proof');
            const reviewed = await request(current.url, 'settings/updates/review', { action: 'application', channel: inputs.manifest.channel });
            report.review = reviewed;
            if (PRE_REVIEW.has(options.scenario)) {
                assert.notEqual(reviewed.status, 200); assert.equal(observer.state()?.active ?? null, null);
                const refusal = await observer.until(value => value.receipts.find(receipt => receipt.point === 'review-refused'), 'actual signed review refusal diagnosis', 15000);
                assert.match(refusal.details.outcome, options.scenario === 'invalid-signature' ? /Invalid update signature/ : /Untrusted update signature/);
                assert.ok(feed.deliveries().some(delivery => delivery.kind === 'manifest' && delivery.mode === options.scenario));
                report.signatureRefusal = refusal;
                assert.equal((await request(current.url, 'status')).status, 200);
                assert.equal(observer.events(original.generation, 'exited').length, 0); assert.equal(observer.state()?.job ?? null, null);
                assert.equal([...observer.receipts.values()].filter(receipt => receipt.point === 'service-live').length, 1);
                assert.equal([...observer.receipts.values()].some(receipt => receipt.point === 'service-before-cleanup-proof'), false);
            } else {
                assert.equal(reviewed.status, 200); assert.equal(reviewed.data.release?.sha256, options.sha256);
                assert.equal(reviewed.data.release?.version, inputs.manifest.version);
                if (options.scenario === 'target-changed') feed.setMode('changed');
                if (options.scenario === 'corrupt-download') feed.setMode('corrupt');
                if (options.scenario === 'unpublished-source') {
                    const sourceFile = scoped(root, path.join(root, 'server/pi-update-feed.js'));
                    report.sourceMutation = { file: sourceFile, before: hashFileSafe(sourceFile) };
                    fs.appendFileSync(sourceFile, '\n// isolated QA unpublished change\n'); report.sourceMutation.after = hashFileSafe(sourceFile);
                }
                // Exactly one execute submission. No catch/retry path resubmits it.
                report.execute = await request(current.url, 'settings/updates/execute', { ticket: reviewed.data.id,
                    confirmed: true, draftsSaved: true, externalWritersStopped: true });
                assert.equal(report.execute.status, 202); assert.equal(report.execute.data.accepted, true); persist();
                const handled = new Set(); let interrupted = false, recoveryObjectRemoved = false;
                const until = Date.now() + 20 * 60 * 1000;
                let outcome;
                while (Date.now() < until) {
                    const value = observer.poll(), state = value.state, activation = state?.activation;
                    for (const receipt of value.receipts.filter(item => item.state === 'paused' && !handled.has(item.receiptId))) {
                        handled.add(receipt.receiptId);
                        if (receipt.point !== 'candidate-staged') assert.equal(receipt.details.activationId, activation?.id, 'checkpoint belongs to the current durable activation');
                        else assert.equal(receipt.details.releaseId, report.execute.data.id, 'staged mutation belongs to the single accepted execution');
                        if (receipt.point === 'candidate-before-validation') {
                            assert.equal(state?.activation?.phase, 'validating');
                            report.admission = await rejectionProbes(receipt.details.url, root);
                            assert.equal(observer.state().activation.phase, 'validating', 'business probe cannot commit');
                            observer.resume(receipt);
                        } else if (receipt.point === 'candidate-staged') {
                            const target = scoped(root, path.join(receipt.details.candidateDirectory, 'server/pi-update-feed.js'));
                            report.stagedMutation = { target, before: hashFileSafe(target) };
                            fs.appendFileSync(target, '\n// isolated staged inventory fault\n'); report.stagedMutation.after = hashFileSafe(target); observer.resume(receipt);
                        } else if (receipt.point === 'handoff-outer-exit') {
                            assert.equal(activation.phase, 'prepared'); assert.equal(state.active ?? null, null);
                            await processes.openShortcut(root, shortcut, env); await sleep(500);
                            assert.equal(observer.current()?.generation, original.generation); assert.equal(observer.state().activation.phase, 'prepared');
                            report.heldOldTray = { receipt, duplicateOpenedExistingOwner: true }; observer.resume(receipt);
                        } else if (INTERRUPT.has(options.scenario)) {
                            report.interruption = await processes.interruptHelper(receipt, env); interrupted = true;
                        } else if (receipt.point === 'helper-before-apply' && options.scenario === 'occupied-entry') {
                            helperWitness = await processes.witnessHelperExit(receipt, env);
                            holder = await processes.holdEntry(path.join(root, '白泽灵台.exe'), env); report.entryHolder = { pid: holder.pid }; observer.resume(receipt);
                        } else if (receipt.point === 'rollback-restoring' && options.scenario === 'recovery-failure') {
                            helperWitness = await processes.witnessHelperExit(receipt, env);
                            const backup = scoped(root, receipt.details.backupDirectory), manifest = jsonFile(path.join(backup, 'manifest.json'), 128 * 1024 ** 2);
                            const object = scoped(backup, path.join(backup, 'files', manifest.entries.find(entry => entry.type === 'file').object));
                            const withheld = path.join(scope, 'withheld-backup-object'); fs.renameSync(object, withheld);
                            report.recoveryFault = { receipt, object, withheld }; recoveryObjectRemoved = true; observer.resume(receipt);
                        } else throw Error('Unexpected paused native QA checkpoint');
                        persist();
                    }
                    if (activation?.phase === 'committed') { outcome = 'committed'; break; }
                    if (ROLLBACK.has(options.scenario) && activation?.phase === 'rolled-back') { outcome = 'rolled-back'; break; }
                    if (JOB_REJECTION.has(options.scenario) && state?.job?.phase === 'failed') { outcome = 'job-rejected'; break; }
                    if (options.scenario === 'unknown-cleanup' && value.current?.state === 'unknown'
                        && value.receipts.some(receipt => receipt.point === 'service-before-cleanup-proof' && receipt.action === 'omit-proof')) { outcome = 'cleanup-unknown'; break; }
                    if (interrupted) { outcome = 'interrupted'; break; }
                    if (options.scenario === 'occupied-entry' && activation?.phase === 'activating'
                        && value.receipts.some(receipt => receipt.point === 'helper-failed')) { outcome = 'entry-occupied'; break; }
                    if (recoveryObjectRemoved && activation?.phase === 'rolling-back' && state.needsRecovery
                        && value.receipts.some(receipt => receipt.point === 'helper-failed')) { outcome = 'recovery-failed'; break; }
                    if (value.current?.state === 'error' || state?.needsRecovery && !['occupied-entry', 'recovery-failure'].includes(options.scenario)) throw Error('Unexpected native failure; preserve the first outcome');
                    await sleep(100);
                }
                if (!outcome) throw Error('Native scenario did not reach its expected durable outcome');
                assert.equal(outcome, EXPECTED[options.scenario], 'a missing fault hook or unexpected recovery cannot pass another scenario');
                report.outcome = outcome; report.finalState = observer.state();
                if (outcome === 'job-rejected') {
                    const expectedReason = { 'target-changed': /Portable target changed/, 'corrupt-download': /Portable ZIP bytes or SHA256 mismatch/,
                        'staged-mutation': /Activation inventory hash mismatch/, 'unpublished-source': /Current program has unpublished changes/ }[options.scenario];
                    assert.match(report.finalState.job.output, expectedReason, 'actual maintenance diagnosis must match the injected fault');
                    assert.equal(report.finalState.active ?? null, null); assert.equal(report.finalState.activation ?? null, null);
                    if (options.scenario === 'staged-mutation') { assert.ok(report.stagedMutation); assert.notEqual(report.stagedMutation.before.sha256, report.stagedMutation.after.sha256); }
                    else {
                        assert.equal(report.finalState.job.backup, null); assert.equal(observer.events(original.generation, 'exited').length, 0);
                        assert.equal([...observer.receipts.values()].filter(receipt => receipt.point === 'service-live').length, 1);
                        assert.equal([...observer.receipts.values()].some(receipt => receipt.point === 'service-before-cleanup-proof'), false);
                    }
                    if (options.scenario === 'target-changed') assert.ok(feed.deliveries().some(value => value.kind === 'manifest' && value.mode === 'changed'));
                    if (options.scenario === 'corrupt-download') assert.ok(feed.deliveries().some(value => value.kind === 'zip' && value.mode === 'corrupt' && value.changedByte && value.completed && value.bytes === inputs.manifest.bytes));
                    if (options.scenario === 'unpublished-source') { assert.ok(report.sourceMutation); assert.notEqual(report.sourceMutation.before.sha256, report.sourceMutation.after.sha256); }
                    const readyUntil = Date.now() + 180000; let originalStatus;
                    do { try { originalStatus = await request(original.url, 'status'); } catch {} if (originalStatus?.status === 200) break; await sleep(200); } while (Date.now() < readyUntil);
                    assert.equal(originalStatus?.status, 200, 'original business service must remain/recover available after this specific rejection'); report.originalAfterRejection = originalStatus;
                }
                if (outcome === 'cleanup-unknown') {
                    assert.equal(report.finalState.activation, undefined); assert.equal(report.finalState.active ?? null, null);
                    assert.equal(observer.events(original.generation, 'stopped').some(event => event.event.clean), false);
                    const proof = await serviceWitness.exited; report.serviceExit = proof;
                    report.cleanup = await processes.teardownUnknownOwners(observer.current(), proof, env); safeToRemove = true;
                    report.layers.missingProofIsNotProductClean = true;
                } else if (['interrupted', 'entry-occupied', 'recovery-failed'].includes(outcome)) {
                    if (helperWitness) report.helperExit = await helperWitness.exited;
                    if (holder) { report.entryHolder.released = await holder.release(); holder = null; }
                    const before = observer.state(); await sleep(1000); assert.deepEqual(observer.state(), before, 'release/interrupt cannot replay activation');
                    const diagnosis = await repair(root, 'diagnose', env); assert.equal(diagnosis.code, 0);
                    report.repairDiagnosis = JSON.parse(diagnosis.stdout); assert.equal(report.repairDiagnosis.status, 'manual-recovery');
                    if (outcome === 'recovery-failed' || options.scenario === 'interrupt-rollback') assert.equal(before.activation.rollbackAttempts, 1);
                    if (outcome === 'recovery-failed' || options.scenario === 'interrupt-rollback') report.failedCandidateSnapshot = candidateSnapshot(observer, before, { restored: false });
                    report.limitations.push('Fixed EXE error MessageBox UI was not reopened; actual shipped independent repair diagnosed the interrupted state');
                    safeToRemove = true;
                } else if (outcome === 'rolled-back') {
                    const state = observer.state(); assert.equal(state.activation.rollbackAttempts, 1); assert.equal(state.active ?? null, null);
                    assert.equal(state.activation.failureShutdownProof.complete, true);
                    assert.deepEqual(state.activation.failureProcessProof.processes, state.activation.failureHandoffProcesses);
                    assert.equal(hashFileSafe(path.join(root, '白泽灵台.exe')).sha256, baselineEntry.sha256);
                    assert.ok(state.activation.safetyBackup, 'failed candidate data has a separate safety snapshot');
                    report.failedCandidateSnapshot = candidateSnapshot(observer, state, { restored: true });
                    current = await observer.until(value => value.current?.state === 'ready' && value.current.generation !== original.generation && value.current, 'actual rollback helper reopens original real tray');
                    assertComponents(current, root, options.previousVersion, oldPi, previousManifest);
                    report.rollback = current;
                } else if (outcome === 'committed') {
                    const state = observer.state(), active = program(root, state), activation = state.activation;
                    assert.equal(activation.release.sha256, options.sha256); assert.equal(activation.release.version, inputs.manifest.version);
                    assert.deepEqual(activation.processProof.processes, activation.handoffProcesses);
                    assert.deepEqual(activation.handoffProcesses, original.components.processes);
                    assert.equal(activation.shutdownProof.complete, true);
                    for (const key of ['control', 'versions', 'service', 'data', 'tray']) assert.equal(activation.validation[key], true);
                    assert.ok(activation.validation.stableMs >= 15000);
                    assert.ok(Date.parse(activation.committedAt) <= activation.validation.deadline);
                    for (const [key, file] of Object.entries(paths).filter(([key]) => key.startsWith('PI_'))) assert.equal(state.runtimePaths[key], file);
                    assert.equal(Object.keys(state.runtimePaths).some(key => key.startsWith('PIVANE_NATIVE_QA')), false);
                    current = await observer.until(value => value.current?.state === 'ready' && value.current.generation !== original.generation && value.current, 'automatically reopened real candidate tray after durable commit');
                    assertComponents(current, active, inputs.manifest.version, inputs.manifest.piVersion, candidateManifest);
                    assert.equal(hashFileSafe(path.join(root, '白泽灵台.exe')).sha256, current.components.nativeSha256);
                    report.committed = current; report.layers.realHandleHelperAutomaticNewTrayAndDurableCommit = true;
                    const business = await request(current.url, 'status'); assert.equal(business.status, 200);
                    assert.ok(Date.parse(business.observedAt) >= Date.parse(activation.committedAt)); report.firstBusinessAfterCommit = business;
                    if (options.scenario === 'committed-crash') {
                        await require('./native-update-committed-crash.cjs').committedCrash({ root, paths, env, observer, current, shortcut, report, persist, repair });
                        current = null;
                    } else {
                        report.preShortcutStop = await observer.stop(current);
                        const beforeGeneration = current.generation;
                        await processes.openShortcut(root, shortcut, env);
                        current = await observer.until(value => value.current?.state === 'ready' && value.current.generation !== beforeGeneration && value.current, 'original shortcut reopens the active target with a new real tray generation');
                        assertComponents(current, active, inputs.manifest.version, inputs.manifest.piVersion, candidateManifest);
                        const opens = observer.events(current.generation, 'browser-opened').length;
                        await processes.openShortcut(root, shortcut, env);
                        await observer.until(value => value.current?.generation === current.generation && observer.events(current.generation, 'browser-opened').length > opens, 'duplicate original shortcut reaches current real owner', 30000);
                        report.reopened = current; report.layers.originalShortcutReopenAndDuplicateOwner = true;
                        await page.goto(current.waitingUrl, { waitUntil: 'domcontentloaded' }); await page.waitForURL(current.url, { timeout: 30000 });
                        await page.screenshot({ path: path.join(scope, 'evidence', 'after.png'), fullPage: true });
                        if (['repair-entry', 'repair-changed-entry', 'postcommit-preservation'].includes(options.scenario)) {
                            const newest = path.join(paths.PI_CODING_AGENT_DIR, 'newest-after-commit.txt'); privateFiles.writePrivateFileSync(newest, 'newest synthetic committed data\n', true);
                            const newestProof = hashFileSafe(newest); report.preRepairStop = await observer.stop(current); current = null; safeToRemove = true;
                            const denied = await repair(root, 'rollback-handoff', env, activation.id, '[]\n');
                            assert.equal(denied.code, 1); assert.match(denied.stderr, /manual recovery|committed|Activation/i);
                            report.postcommit = { newest, before: newestProof, recoveryRefused: denied };
                            if (options.scenario !== 'postcommit-preservation') {
                                const fixed = path.join(root, '白泽灵台.exe');
                                if (options.scenario === 'repair-entry') fs.unlinkSync(fixed); else fs.writeFileSync(fixed, 'isolated changed entry');
                                const changedEntry = options.scenario === 'repair-changed-entry' ? hashFileSafe(fixed) : null;
                                const hidden = path.join(scope, 'hidden-main-node-modules'); fs.renameSync(path.join(root, 'node_modules'), hidden);
                                try {
                                    const diagnosis = await repair(root, 'diagnose', env); assert.equal(diagnosis.code, 0); report.independentRepair = { diagnosis: JSON.parse(diagnosis.stdout), mainDependenciesHidden: true };
                                    if (options.scenario === 'repair-changed-entry') {
                                        const rejected = await repair(root, 'restore-entry', env, activation.id); assert.equal(rejected.code, 1); report.independentRepair.defaultRefusal = rejected;
                                        const restored = await processes.run(path.join(root, 'repair/runtime/node.exe'), [path.join(root, 'repair/scripts/repair-launcher.cjs'), 'restore-entry', root, activation.id, '--replace-changed'], env, { cwd: root });
                                        report.independentRepair.restore = JSON.parse(restored.stdout);
                                    } else { const restored = await repair(root, 'restore-entry', env, activation.id); assert.equal(restored.code, 0); report.independentRepair.restore = JSON.parse(restored.stdout); }
                                    assert.equal(hashFileSafe(fixed).sha256, activation.activeEntry.sha256);
                                    if (changedEntry) {
                                        const repairState = observer.state().activation.entryRepair;
                                        const retained = path.join(root, '.pivane-runtime/activation', activation.id, 'entry-repair', repairState.id, 'previous-entry.exe');
                                        assert.deepEqual(hashFileSafe(retained), changedEntry, 'explicit changed-entry repair retains the exact previous bytes');
                                        report.independentRepair.retainedChangedEntry = { path: retained, proof: hashFileSafe(retained) };
                                    }
                                } finally { fs.renameSync(hidden, path.join(root, 'node_modules')); }
                                report.layers.shippedIndependentRepairNodeWithoutMainEntryOrDependencies = true;
                            }
                            assert.deepEqual(hashFileSafe(newest), newestProof); assert.equal(observer.state().active, state.active);
                        }
                    }
                }
            }
            if (current && !safeToRemove) {
                if (current.state !== 'ready') current = await observer.until(value => value.current?.state === 'ready' && value.current, 'original owner remains available after expected refusal');
                report.finalStop = await observer.stop(current); safeToRemove = true;
            }
            for (const entry of seeded) assert.equal(hashFileSafe(entry.file).sha256, entry.sha256, 'native session/media/project bytes preserved');
            assert.equal(jsonFile(path.join(paths.PI_CODING_AGENT_DIR, 'settings.json')).syntheticUnknownField, true);
            const activeProgram = program(root, observer.state());
            report.nativeAfter = await session('inspect', activeProgram, env, native.file);
            assert.deepEqual(report.nativeAfter, native, 'native session ID, full branches and bookmark entries preserved');
            assert.deepEqual(pageErrors, []); report.pageErrors = pageErrors;
            report.layers.nativeSessionSemanticsAndOriginalDataPaths = true;
        }
        report.status = 'passed'; report.scenarios[options.scenario] = { status: 'passed', outcome: report.outcome || (options.scenario === 'legacy-refusal' ? 'legacy-refused' : 'review-refused') };
        failed = false;
    } catch (error) {
        report.status = error.code === 'QA_UNSUPPORTED' ? 'unsupported' : 'failed'; report.error = { name: error.name, message: error.message };
        report.scenarios[options.scenario] = { status: report.status, error: report.error };
        report.cleanup = { status: 'retained-first-failure', root, scope, liveOwnerMayRemain: Boolean(report.layers.fixedEntryAttempted && !safeToRemove) };
    } finally {
        if (holder) { try { await holder.release(); } catch (error) { report.holderReleaseError = error.message; } }
        try { await browser?.close(); } catch (error) { report.browserCloseError = error.message; }
        try { await feed?.close(); } catch (error) { report.feedCloseError = error.message; }
        if (feed) report.deliveries = feed.deliveries();
        try { observer?.poll(); } catch (error) { report.finalObservationError = error.message; }
        report.finishedAt = new Date().toISOString();
        if (!failed && safeToRemove && options.retainSuccess !== 'yes') {
            // Verify final absolute targets before any recursive Windows delete.
            try {
                for (const directory of [root, candidateRoot]) { scoped(scope, directory); fs.rmSync(directory, { recursive: true, force: false, maxRetries: 5, retryDelay: 200 }); }
                report.programTrees = 'removed-after-verified-fixture-teardown';
            } catch (error) {
                report.programTrees = 'retained-cleanup-error'; report.cleanupError = error.message;
                report.status = 'failed'; report.scenarios[options.scenario].status = 'failed';
            }
        } else report.programTrees = 'retained';
        persist();
    }
    return { status: report.status, scenario: options.scenario, report: resultFile, scope,
        exitCode: report.status === 'passed' ? 0 : report.status === 'unsupported' ? 2 : 1 };
}
module.exports = { runAcceptance };
