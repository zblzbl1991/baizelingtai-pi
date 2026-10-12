const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { portableEnvironment, inventory, download } = require('../scripts/package-windows-portable.cjs');

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
