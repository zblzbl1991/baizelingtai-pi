const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

test('fixed desktop entry selects the sole managed active version and refuses uncertain replacement', { skip: process.platform !== 'win32' }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-selection-'));
    const binary = path.resolve(__dirname, '../白泽灵台.exe');
    const stateFile = path.join(root, '.pivane-runtime/state.json');
    const id = randomUUID(), release = path.join(root, '.pivane-runtime/releases', id);
    fs.mkdirSync(release, { recursive: true });
    const lock = Buffer.from('{"version":"9.8.7"}');
    fs.writeFileSync(path.join(release, 'package-lock.json'), lock);
    fs.writeFileSync(path.join(release, 'PI_INSTALL_COMPLETE.json'), JSON.stringify({ version: '0.85.1', appVersion: '9.8.7', lockSha256: createHash('sha256').update(lock).digest('hex') }));
    const script = `[Reflection.Assembly]::LoadFrom($env:TEST_BINARY)|Out-Null; try { [Console]::WriteLine([PivaneProgramSelection]::Resolve($env:TEST_ROOT)) } catch { [Console]::WriteLine('rejected') }`;
    const select = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        encoding: 'utf8', windowsHide: true, env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TEST_BINARY: binary, TEST_ROOT: root }
    }).stdout.trim();
    try {
        fs.writeFileSync(stateFile, JSON.stringify({ version: 1, active: id, activation: { phase: 'validating' } }));
        assert.equal(select(), release);
        fs.writeFileSync(stateFile, JSON.stringify({ version: 1, active: id, activation: { phase: 'activating' } }));
        assert.equal(select(), 'rejected');
        fs.writeFileSync(stateFile, JSON.stringify({ version: 1, active: id, needsRecovery: true }));
        assert.equal(select(), 'rejected');
        fs.writeFileSync(stateFile, JSON.stringify({ version: 1, active: '../escape' }));
        assert.equal(select(), 'rejected');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
