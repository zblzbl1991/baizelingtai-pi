const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { privateDir } = require('../server/pi-maintenance-files');
const { writePrivateFileSync } = require('../server/pi-private-files');

function qaFixture(t) {
    const scope = privateDir(fs.mkdtempSync(path.join(os.tmpdir(), '白泽 QA & scope-'))), root = privateDir(path.join(scope, 'installation'));
    t.after(() => fs.rmSync(scope, { recursive: true, force: true }));
    const names = { PI_CODING_AGENT_DIR: 'agent', PI_CODING_AGENT_SESSION_DIR: 'sessions', PI_MEDIA_DATA_DIR: 'media', PI_MEDIA_CONFIG_DIR: 'media-config',
        PI_PROJECT_ROOTS: 'project', HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', TEMP: 'tmp', TMP: 'tmp',
        PIVANE_NATIVE_QA_CHECKPOINTS: 'checkpoints', PIVANE_NATIVE_QA_RECEIPTS: 'receipts' };
    const paths = Object.fromEntries(Object.entries(names).map(([key, relative]) => [key, privateDir(path.join(scope, relative))]));
    // Windows PowerShell initializes this known-folder child before running its
    // read-only DACL query, so prepare it before filesystem identity capture.
    privateDir(path.join(paths.HOME, 'AppData'));
    privateDir(path.join(scope, 'permission-tmp'));
    paths.PI_WEB_DEFERRED_FILE = path.join(scope, 'deferred.json'); writePrivateFileSync(paths.PI_WEB_DEFERRED_FILE, '[]');
    const record = { schemaVersion: 1, runId: randomUUID(), root, scope, scenario: 'normal', paths };
    const scopeMarker = path.join(scope, '.pivane-native-qa.json'), rootMarker = path.join(root, '.pivane-launcher-test');
    writePrivateFileSync(scopeMarker, JSON.stringify(record)); writePrivateFileSync(rootMarker, JSON.stringify(record));
    return { scope, root, record, scopeMarker, rootMarker, environment: { PIVANE_NATIVE_QA: '1', PIVANE_NATIVE_QA_SCOPE: scope, PIVANE_NATIVE_QA_RUN_ID: record.runId } };
}

test('ordinary product environment does not opt into native QA continuation', () => {
    const { continuationEnvironment } = require('../server/pi-launcher-qa-context');
    assert.deepEqual(continuationEnvironment('not-even-a-directory', { OPENAI_API_KEY: 'synthetic-not-forwarded', NODE_OPTIONS: '--synthetic-not-forwarded' }), {});
});

test('QA continuation rejects browser execution options before reading paths', () => {
    const { continuationEnvironment } = require('../server/pi-launcher-qa-context');
    assert.throws(() => continuationEnvironment('not-a-root', { PIVANE_NATIVE_QA: '1', PIVANE_NATIVE_QA_SCOPE: 'not-a-scope',
        PIVANE_NATIVE_QA_RUN_ID: '11111111-1111-4111-8111-111111111111', openBrowser: '1' }), /Unsafe native QA environment/);
});

test('partial or invented native QA contexts fail closed', () => {
    const { continuationEnvironment } = require('../server/pi-launcher-qa-context');
    assert.throws(() => continuationEnvironment('not-a-root', { PIVANE_NATIVE_QA_SCOPE: 'not-a-scope' }), /QA/);
    assert.throws(() => continuationEnvironment('not-a-root', { PIVANE_NATIVE_QA: 'true' }), /QA/);
    assert.throws(() => continuationEnvironment('not-a-root', { PIVANE_NATIVE_QA: '1', PIVANE_NATIVE_QA_SCOPE: 'not-a-scope', PIVANE_NATIVE_QA_RUN_ID: 'not-a-uuid' }), /QA/);
});

test('explicit matching private QA sentinels generate only the minimum continuation environment at both boundaries', t => {
    const input = qaFixture(t), { continuationEnvironment } = require('../server/pi-launcher-qa-context');
    const before = fs.statSync(input.record.paths.TEMP, { bigint: true });
    const environment = continuationEnvironment(input.root, { ...input.environment, SystemRoot: process.env.SystemRoot, PATH: 'ignored ambient path' });
    assert.deepEqual(environment, { ...input.record.paths, ...input.environment, PIVANE_NATIVE_QA_SCENARIO: 'normal', PIVANE_DESKTOP_SMOKE_ROOT: input.root,
        PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' });
    const reopened = continuationEnvironment(input.root, { ...environment, SystemRoot: process.env.SystemRoot });
    assert.deepEqual(reopened, environment);
    const after = fs.statSync(input.record.paths.TEMP, { bigint: true });
    assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ctimeNs, before.ctimeNs);
    assert.equal(Object.hasOwn(environment, 'PATH'), false); assert.equal(Object.hasOwn(environment, 'SystemRoot'), false);
});

test('initial tray validation CLI accepts only its fixed validation operation', () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/launcher-qa.cjs'), 'execute', 'not-a-root'],
        { encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot } });
    assert.equal(result.status, 1); assert.match(result.stderr, /Usage: launcher-qa validate <root>/); assert.equal(result.stdout, '');
});

test('QA variable aliases and differently cased path bindings fail closed', t => {
    const input = qaFixture(t), { continuationEnvironment } = require('../server/pi-launcher-qa-context');
    assert.throws(() => continuationEnvironment(input.root, { pivane_native_qa: '1' }), /QA/);
    assert.throws(() => continuationEnvironment(input.root, { ...input.environment, pi_coding_agent_dir: input.scope }), /Unsafe native QA environment/);
    assert.throws(() => continuationEnvironment(input.root, { ...input.environment, Pivane_Native_Qa_Run_Id: input.record.runId }), /Unsafe native QA environment/);
});

test('both independent handoff spawn boundaries use the validated continuation allowlist', () => {
    const runner = fs.readFileSync(path.join(__dirname, '../server/pivane-desktop-update.js'), 'utf8');
    const helper = fs.readFileSync(path.join(__dirname, '../server/pi-launcher-activation.js'), 'utf8');
    assert.match(runner, /continuationEnvironment\(launcher.root, launcher.env\)/);
    assert.match(helper, /continuationEnvironment\(root, process.env\)/);
    for (const source of [runner, helper]) {
        assert.match(source, /env:\s*\{[^}]*\.\.\.continuation/s);
        assert.doesNotMatch(source, /\.\.\.process.env|\.\.\.launcher.env/);
    }
});

test('initial fixed entry validates strict QA before tray identity or smoke authority', () => {
    const tray = fs.readFileSync(path.join(__dirname, '../scripts/desktop-tray.ps1'), 'utf8');
    const validation = tray.indexOf("'scripts\\launcher-qa.cjs'");
    assert.ok(validation > 0 && validation < tray.indexOf("'\"' + $runner + '\" --identity'"));
    assert.match(tray, /strictQaRequested -and -not \$script:smokeValidated/);
    assert.match(tray, /NODE_.*throw 'Native QA/s);
});

test('missing, malformed, oversized and unrecognized sentinels never authorize continuation', t => {
    const input = qaFixture(t), { continuationEnvironment } = require('../server/pi-launcher-qa-context');
    const original = JSON.stringify(input.record);
    for (const content of ['{', ' '.repeat(65537), JSON.stringify({ ...input.record, providerToken: 'synthetic' }),
        JSON.stringify({ ...input.record, paths: { ...input.record.paths, AUTH: 'synthetic' } })]) {
        fs.writeFileSync(input.scopeMarker, content);
        assert.throws(() => continuationEnvironment(input.root, input.environment), /QA sentinel/);
    }
    fs.writeFileSync(input.scopeMarker, original); fs.unlinkSync(input.rootMarker);
    assert.throws(() => continuationEnvironment(input.root, input.environment));
});

test('sentinels bind the original root, run, scenario and every supplied path', t => {
    const input = qaFixture(t), { continuationEnvironment } = require('../server/pi-launcher-qa-context');
    for (const changed of [{ runId: randomUUID() }, { root: input.scope }, { scenario: 'different' },
        { paths: { ...input.record.paths, PI_MEDIA_DATA_DIR: fs.realpathSync.native(os.tmpdir()) } }]) {
        const record = { ...input.record, ...changed };
        fs.writeFileSync(input.scopeMarker, JSON.stringify(record)); fs.writeFileSync(input.rootMarker, JSON.stringify(record));
        assert.throws(() => continuationEnvironment(input.root, { ...input.environment, PIVANE_NATIVE_QA_SCENARIO: 'normal' }), /QA/);
    }
    fs.writeFileSync(input.scopeMarker, JSON.stringify(input.record)); fs.writeFileSync(input.rootMarker, JSON.stringify(input.record));
    assert.throws(() => continuationEnvironment(input.root, { ...input.environment, PI_CODING_AGENT_DIR: input.scope }), /binding mismatch/);
});

test('QA continuation refuses ancestor aliases and missing permission scratch without creating paths', t => {
    const input = qaFixture(t), { continuationEnvironment } = require('../server/pi-launcher-qa-context');
    const actual = privateDir(path.join(input.scope, 'actual')), child = privateDir(path.join(actual, 'agent'));
    const alias = path.join(input.scope, 'alias'); fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const record = { ...input.record, paths: { ...input.record.paths, PI_CODING_AGENT_DIR: path.join(alias, 'agent') } };
    fs.writeFileSync(input.scopeMarker, JSON.stringify(record)); fs.writeFileSync(input.rootMarker, JSON.stringify(record));
    assert.throws(() => continuationEnvironment(input.root, input.environment), /canonical|alias/);
    assert.ok(fs.statSync(child).isDirectory());
    fs.writeFileSync(input.scopeMarker, JSON.stringify(input.record)); fs.writeFileSync(input.rootMarker, JSON.stringify(input.record));
    const scratch = path.join(input.scope, 'permission-tmp'); fs.rmdirSync(scratch);
    assert.throws(() => continuationEnvironment(input.root, input.environment)); assert.equal(fs.existsSync(scratch), false);
});

test('explicit QA rejects unknown flags, credentials, Node options and browser authority', t => {
    const input = qaFixture(t), { continuationEnvironment } = require('../server/pi-launcher-qa-context');
    for (const field of ['PIVANE_NATIVE_QA_UNKNOWN', 'OPENAI_API_KEY', 'AUTHORIZATION', 'NODE_OPTIONS', 'NODE_PATH', 'PIVANE_DESKTOP_SMOKE_OPEN_BROWSER']) {
        assert.throws(() => continuationEnvironment(input.root, { ...input.environment, [field]: 'synthetic' }), /Unsafe native QA environment/);
    }
});

test('QA requires actual private filesystem permissions rather than Windows mode bits', t => {
    const input = qaFixture(t), { continuationEnvironment } = require('../server/pi-launcher-qa-context');
    if (process.platform === 'win32') {
        const change = spawnSync(path.join(process.env.SystemRoot, 'System32/icacls.exe'), [input.record.paths.PI_WEB_DEFERRED_FILE, '/grant', '*S-1-1-0:(R)'],
            { windowsHide: true, encoding: 'utf8' });
        assert.equal(change.status, 0, 'synthetic DACL setup failed');
    } else fs.chmodSync(input.record.paths.PI_WEB_DEFERRED_FILE, 0o644);
    assert.throws(() => continuationEnvironment(input.root, input.environment), /permissions/);
});

test('initial tray validation CLI returns the same allowlist for a Chinese path containing space and ampersand', t => {
    const input = qaFixture(t);
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/launcher-qa.cjs'), 'validate', input.root],
        { encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot, ...input.record.paths, ...input.environment }, timeout: 30000, maxBuffer: 65536 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ...input.record.paths, ...input.environment, PIVANE_NATIVE_QA_SCENARIO: 'normal',
        PIVANE_DESKTOP_SMOKE_ROOT: input.root, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' });
});
