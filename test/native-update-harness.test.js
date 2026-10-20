const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, generateKeyPairSync, sign, randomUUID } = require('node:crypto');
const { parseOptions, validateInputs } = require('./release/native-launcher-update.cjs');
const { selectGeneration } = require('./release/native-update-observer.cjs');
const { checkpoint } = require('../server/pi-launcher-qa-checkpoints');
const { privateDir, atomicJson, readSafe } = require('../server/pi-maintenance-files');
const { writePrivateFileSync } = require('../server/pi-private-files');
const { NativeObserver } = require('./release/native-update-observer.cjs');

test('exact native acceptance requires explicit bound inputs and a fresh output', t => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-native-cli-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const args = ['--previous-archive', path.join(base, 'old.zip'), '--previous-sha256', '1'.repeat(64),
        '--previous-version', '1.7.99', '--baseline-kind', 'synthetic-qa',
        '--archive', path.join(base, 'new.zip'), '--sha256', '2'.repeat(64),
        '--signed-manifest', path.join(base, 'release.json'), '--qa-trust', path.join(base, 'public.json'),
        '--output', path.join(base, 'fresh'), '--browser', path.join(base, 'chrome.exe'),
        '--playwright', path.join(base, 'playwright'), '--scenario', 'normal'];
    const selected = parseOptions(args);
    assert.equal(selected.scenario, 'normal');
    assert.equal(selected.baselineKind, 'synthetic-qa');
    assert.equal(selected.previousVersion, '1.7.99');
    assert.throws(() => parseOptions([...args, '--scenario', 'repair-entry']), /duplicate/i);
    assert.throws(() => parseOptions([...args, '--routine']), /unknown/i);
    assert.throws(() => parseOptions(args.filter(value => value !== '--qa-trust' && value !== path.join(base, 'public.json'))), /qa-trust/i);
    assert.throws(() => parseOptions(args.filter(value => value !== '--baseline-kind' && value !== 'synthetic-qa')), /baseline-kind/i);
    assert.throws(() => parseOptions(args.map(value => value === 'synthetic-qa' ? 'historical-success' : value)), /baseline kind/i);
    fs.mkdirSync(selected.output);
    assert.throws(() => parseOptions(args), /fresh|exists/i);
});

test('native observer ignores old smoke files and another installation generation', () => {
    const expected = { runId: '08f21b15-26b6-43f8-9960-da4fefdece01', root: path.resolve('isolated-install') };
    const current = { ...expected, instance: '3342d2bb-ee8d-42ad-bfc9-39e513f31b45', generation: 'f720bb6d-e326-484c-9ebe-d8e81b523a58', state: 'ready' };
    assert.equal(selectGeneration(current, expected), current);
    assert.equal(selectGeneration({ ...current, runId: 'an-old-run' }, expected), null);
    assert.equal(selectGeneration({ ...current, root: path.resolve('other-install') }, expected), null);
    assert.equal(selectGeneration({ ...current, generation: '' }, expected), null);
    assert.equal(selectGeneration({ state: 'ready' }, expected), null);
});

test('checkpoint files and sentinel presence alone cannot enable QA controls', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-no-optin-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, '.pivane-launcher-test'), '{"scenario":"validation-failure"}');
    const before = fs.readdirSync(root);
    assert.deepEqual(await checkpoint(root, 'candidate-before-validation', { url: 'http://127.0.0.1:1/' }, { environment: {} }), {});
    assert.deepEqual(fs.readdirSync(root), before);
});

test('authorized checkpoints consume once and only their fresh receipt nonce can resume them', { timeout: 60000 }, async t => {
    const scope = privateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-checkpoint-'))), root = privateDir(path.join(scope, 'install'));
    t.after(() => fs.rmSync(scope, { recursive: true, force: true }));
    const names = { PI_CODING_AGENT_DIR: 'agent', PI_CODING_AGENT_SESSION_DIR: 'sessions', PI_MEDIA_DATA_DIR: 'media', PI_MEDIA_CONFIG_DIR: 'media-config',
        PI_PROJECT_ROOTS: 'project', HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', TEMP: 'tmp', TMP: 'tmp',
        PIVANE_NATIVE_QA_CHECKPOINTS: 'checkpoints', PIVANE_NATIVE_QA_RECEIPTS: 'receipts' };
    const paths = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, privateDir(path.join(scope, name))]));
    privateDir(path.join(paths.HOME, 'AppData')); privateDir(path.join(scope, 'permission-tmp'));
    paths.PI_WEB_DEFERRED_FILE = path.join(scope, 'deferred.json'); writePrivateFileSync(paths.PI_WEB_DEFERRED_FILE, '[]');
    const marker = { schemaVersion: 1, runId: randomUUID(), root, scope, scenario: 'normal', paths };
    writePrivateFileSync(path.join(scope, '.pivane-native-qa.json'), JSON.stringify(marker));
    writePrivateFileSync(path.join(root, '.pivane-launcher-test'), JSON.stringify(marker));
    const environment = { SystemRoot: process.env.SystemRoot, PIVANE_NATIVE_QA: '1', PIVANE_NATIVE_QA_SCOPE: scope, PIVANE_NATIVE_QA_RUN_ID: marker.runId };
    const observer = new NativeObserver({ root, scope, runId: marker.runId, environment });
    const command = observer.arm('candidate-before-validation', 'pause');
    let resumed = false;
    const pending = checkpoint(root, 'candidate-before-validation', {}, { environment }).then(() => { resumed = true; });
    pending.catch(() => {});
    const receipt = await observer.until(value => value.receipts.find(entry => entry.commandId === command.commandId && entry.state === 'paused'), 'tiny paused checkpoint', 15000);
    observer.resume({ ...receipt, receiptId: randomUUID() });
    await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(resumed, false, 'an old/unrelated nonce cannot release the current pause');
    observer.resume(receipt); await pending; assert.equal(resumed, true);
    assert.deepEqual(await checkpoint(root, 'candidate-before-validation', {}, { environment }), {}, 'a consumed command does not pause another generation');
    const commandFile = path.join(paths.PIVANE_NATIVE_QA_CHECKPOINTS, 'candidate-before-validation.json');
    atomicJson(commandFile, command);
    await assert.rejects(checkpoint(root, 'candidate-before-validation', {}, { environment }), /already been consumed/);
    atomicJson(commandFile, { ...command, commandId: randomUUID(), runId: randomUUID() });
    await assert.rejects(checkpoint(root, 'candidate-before-validation', {}, { environment }), /not authorized/);
});

test('acceptance verifies the exact artifact and synthetic trust before creating any output', t => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-native-input-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const put = (name, value) => { const file = path.join(base, name); fs.writeFileSync(file, value); return file; };
    const digest = value => createHash('sha256').update(value).digest('hex');
    const manifest = { schemaVersion: 1, version: '1.8.0', piVersion: '0.85.1', platform: 'win32', arch: 'x64',
        channel: 'stable', publishedAt: '2026-10-20T00:00:00Z', package: 'candidate.zip', sha256: digest('candidate bytes'), bytes: 15 };
    const payload = Buffer.from(JSON.stringify(['pivane-release-v1', 1, '1.8.0', '0.85.1', 'win32', 'x64', 'stable',
        '2026-10-20T00:00:00Z', 'candidate.zip', digest('candidate bytes'), 15, null]));
    manifest.signature = { algorithm: 'ed25519', keyId: 'qa-test', value: sign(null, payload, privateKey).toString('base64') };
    const options = { previousArchive: put('old.zip', 'old bytes'), previousSha256: digest('old bytes'), previousVersion: '1.7.99',
        baselineKind: 'synthetic-qa', archive: put('candidate.zip', 'candidate bytes'), sha256: digest('candidate bytes'),
        signedManifest: put('signed.json', JSON.stringify(manifest)), qaTrust: put('public.json', JSON.stringify({ schemaVersion: 1,
            keys: [{ keyId: 'qa-test', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }] })),
        browser: put('chrome.exe', ''), playwright: base, scenario: 'normal', output: path.join(base, 'fresh') };
    assert.equal(validateInputs(options).manifest.version, '1.8.0');
    assert.equal(fs.existsSync(options.output), false);
    assert.throws(() => validateInputs({ ...options, sha256: '0'.repeat(64) }), /SHA256|hash/i);
    manifest.signature.value = 'A'.repeat(86) + '=='; fs.writeFileSync(options.signedManifest, JSON.stringify(manifest));
    assert.throws(() => validateInputs(options), /signature/i);
    assert.equal(fs.existsSync(options.output), false);
});
