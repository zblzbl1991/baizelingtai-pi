const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');
const { createPrivateKey, createPublicKey, createHash } = require('node:crypto');
const cli = path.resolve(__dirname, '../scripts/update-signing.cjs');
const password = 'synthetic signing password 2026';
function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-signing-cli-')));
    fs.mkdirSync(path.join(root, 'config'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function run(args, input = password) {
    const result = spawnSync(process.execPath, [cli, ...args, ...(args[0] === 'rotation-apply' ? [] : ['--passphrase-stdin'])], { input: input + '\n', encoding: 'utf8', timeout: 15000,
        env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP } });
    assert.ok(!((result.stdout || '') + (result.stderr || '')).includes(password), 'password must never be printed');
    assert.ok(!/BEGIN (?:ENCRYPTED )?PRIVATE KEY/.test((result.stdout || '') + (result.stderr || '')), 'key bytes must never be printed');
    return result;
}
function keygen(root, keyId = 'test-publisher') {
    return ['keygen', '--private-key', path.join(root, 'publisher.pem'), '--trust-file', path.join(root, 'config/update-trust.json'), '--key-id', keyId];
}

test('offline key generation emits an encrypted Ed25519 key and matching separate public trust without overwriting', t => {
    const root = fixture(t), args = keygen(root), result = run(args);
    assert.equal(result.status, 0, result.stderr);
    const pem = fs.readFileSync(path.join(root, 'publisher.pem'));
    assert.match(pem.toString(), /^-----BEGIN ENCRYPTED PRIVATE KEY-----/);
    assert.throws(() => createPrivateKey(pem));
    const key = createPrivateKey({ key: pem, passphrase: password }), trust = JSON.parse(fs.readFileSync(path.join(root, 'config/update-trust.json')));
    assert.equal(key.asymmetricKeyType, 'ed25519');
    assert.equal(trust.keys[0].publicKey, createPublicKey(key).export({ type: 'spki', format: 'pem' }));
    assert.equal(run(args).status, 1); assert.deepEqual(fs.readFileSync(path.join(root, 'publisher.pem')), pem);
});

test('publisher signs only the exact archive described by a v1 manifest and output is verified by update checks', async t => {
    const root = fixture(t); assert.equal(run(keygen(root)).status, 0);
    const archive = path.join(root, 'app.zip'), manifestFile = path.join(root, 'manifest.json'), output = path.join(root, 'signed.json');
    const bytes = Buffer.alloc(22); bytes.writeUInt32LE(0x06054b50); fs.writeFileSync(archive, bytes);
    const data = { schemaVersion: 1, version: '1.8.1', piVersion: '1.1.0', platform: 'win32', arch: 'x64', channel: 'stable',
        publishedAt: '2026-10-20T00:00:00Z', package: 'app.zip', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    fs.writeFileSync(manifestFile, JSON.stringify(data));
    const args = ['sign', '--private-key', path.join(root, 'publisher.pem'), '--key-id', 'test-publisher', '--trust-root', root,
        '--manifest', manifestFile, '--archive', archive, '--feed', 'http://updates.example/latest.json', '--output', output];
    const result = run(args); assert.equal(result.status, 0, result.stderr);
    const signed = JSON.parse(fs.readFileSync(output)); assert.equal(signed.schemaVersion, 1); assert.equal(signed.signature.algorithm, 'ed25519');
    const service = new (require('../server/pi-update-service').UpdateService)({ root, env: { BAIZELINGTAI_UPDATE_FEED_URL: 'http://updates.example/latest.json' },
        appVersion: '1.8.0', platform: 'win32', arch: 'x64', fetch: async () => ({ ok: true, json: async () => signed }) });
    assert.equal((await service.check()).pivane.verification.status, 'verified');
    const saved = fs.readFileSync(output); assert.equal(run(args).status, 1); assert.deepEqual(fs.readFileSync(output), saved);
    fs.unlinkSync(output); fs.appendFileSync(archive, 'changed');
    assert.equal(run(args).status, 1); assert.equal(fs.existsSync(output), false);
    fs.writeFileSync(archive, bytes);
    assert.equal(run(args, 'wrong password').status, 1); assert.equal(fs.existsSync(output), false);
});

test('authorized offline rotation signs with existing trust and apply owns the installation lock without replay', async t => {
    const root = fixture(t), next = fixture(t); assert.equal(run(keygen(root)).status, 0); assert.equal(run(keygen(next, 'next-publisher')).status, 0);
    const trustFile = path.join(root, 'config/update-trust.json'), oldTrust = fs.readFileSync(trustFile), rotationFile = path.join(root, 'rotation.json');
    const args = ['rotation-sign', '--private-key', path.join(root, 'publisher.pem'), '--key-id', 'test-publisher', '--installation-root', root,
        '--next-trust', path.join(next, 'config/update-trust.json'), '--output', rotationFile];
    const result = run(args); assert.equal(result.status, 0, result.stderr);
    assert.equal(run(args).status, 1);
    const apply = ['rotation-apply', '--installation-root', root, '--rotation', rotationFile];
    const lock = await require('../server/pi-installation-lock').acquireInstallationLock(root);
    try { assert.equal(run(apply).status, 1); assert.deepEqual(fs.readFileSync(trustFile), oldTrust); }
    finally { await lock.close(); }
    assert.equal(run(apply).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(trustFile)), JSON.parse(fs.readFileSync(path.join(next, 'config/update-trust.json'))));
    assert.equal(run(apply).status, 1);
});

test('publisher refuses a manifest changed while waiting for the secret and leaves no signed output', async t => {
    const root = fixture(t); assert.equal(run(keygen(root)).status, 0);
    const archive = path.join(root, 'app.zip'), manifestFile = path.join(root, 'manifest.json'), output = path.join(root, 'signed.json');
    const bytes = Buffer.alloc(22); bytes.writeUInt32LE(0x06054b50); fs.writeFileSync(archive, bytes);
    const data = { schemaVersion: 1, version: '1.8.1', piVersion: '1.1.0', platform: 'win32', arch: 'x64', channel: 'stable',
        publishedAt: '2026-10-20T00:00:00Z', package: 'app.zip', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    fs.writeFileSync(manifestFile, JSON.stringify(data));
    const child = spawn(process.execPath, [cli, 'sign', '--private-key', path.join(root, 'publisher.pem'), '--key-id', 'test-publisher', '--trust-root', root,
        '--manifest', manifestFile, '--archive', archive, '--feed', 'http://updates.example/latest.json', '--output', output, '--passphrase-stdin'],
        { env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP }, stdio: ['pipe', 'pipe', 'pipe'] });
    let diagnostics = ''; child.stdout.on('data', chunk => { diagnostics += chunk; }); child.stderr.on('data', chunk => { diagnostics += chunk; });
    const completed = new Promise(resolve => child.once('close', resolve));
    const ready = await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(false); }, 3000);
        child.stderr.on('data', () => { if (diagnostics.includes('等待标准输入口令')) { clearTimeout(timer); resolve(true); } });
        child.once('close', () => { clearTimeout(timer); resolve(false); });
    });
    if (ready) { fs.writeFileSync(manifestFile, JSON.stringify({ ...data, version: '1.8.2' })); child.stdin.end(password + '\n'); }
    const status = await completed; assert.equal(ready, true, 'CLI should announce only its public input stage');
    assert.equal(status, 1); assert.equal(fs.existsSync(output), false); assert.ok(!diagnostics.includes(password));
});

test('invalid secrets and unauthorized rotation never leave a successful output or replace local trust', t => {
    const root = fixture(t), next = fixture(t);
    assert.equal(run(keygen(root), 'short').status, 1);
    assert.equal(fs.existsSync(path.join(root, 'publisher.pem')), false);
    assert.equal(fs.existsSync(path.join(root, 'config/update-trust.json')), false);
    assert.equal(run(keygen(root)).status, 0); assert.equal(run(keygen(next, 'unknown-publisher')).status, 0);
    const output = path.join(root, 'unauthorized-rotation.json'), before = fs.readFileSync(path.join(root, 'config/update-trust.json'));
    const args = ['rotation-sign', '--private-key', path.join(next, 'publisher.pem'), '--key-id', 'unknown-publisher', '--installation-root', root,
        '--next-trust', path.join(next, 'config/update-trust.json'), '--output', output];
    assert.equal(run(args).status, 1); assert.equal(fs.existsSync(output), false);
    assert.deepEqual(fs.readFileSync(path.join(root, 'config/update-trust.json')), before);
    const direct = spawnSync(process.execPath, [cli, ...keygen(fixture(t))], { input: password + '\n', encoding: 'utf8', timeout: 10000,
        env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP } });
    assert.equal(direct.status, 1); assert.ok(!direct.stderr.includes(password));
});
