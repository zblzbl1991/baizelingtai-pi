const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runtimeShellPath } = require('../server/pi-runtime-shell');
const { settingsView } = require('../server/pi-bundled-resources');

test('bundled Bash bypasses OEM path discovery without replacing explicit settings or saving user state', t => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-shell-path-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, '白泽 灵台 & 便携'), bash = path.join(root, 'tools/git/bin/bash.exe');
    fs.mkdirSync(path.dirname(bash), { recursive: true }); fs.writeFileSync(bash, 'synthetic executable');
    assert.equal(runtimeShellPath(undefined, { root, platform: 'win32' }), fs.realpathSync.native(bash));
    const custom = path.join(base, 'chosen-shell.exe');
    assert.equal(runtimeShellPath(custom, { root, platform: 'win32' }), custom, 'explicit missing paths still fail through the native SDK');
    assert.equal(runtimeShellPath(undefined, { root, platform: 'linux' }), undefined);
    assert.equal(runtimeShellPath(undefined, { root: path.join(base, 'without-tools'), platform: 'win32' }), undefined);
    const settings = { getShellPath: () => custom };
    assert.equal(settingsView(settings, root, base).getShellPath(), custom);
    assert.equal(settings.getShellPath(), custom);
    assert.equal(fs.existsSync(path.join(base, 'settings.json')), false);
});
