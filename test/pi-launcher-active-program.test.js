const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { verifyActiveProgram } = require('../server/pi-launcher-activation');

test('first installation has no activation evidence while a claimed release requires installation state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-first-boot-'));
    try {
        assert.deepEqual(verifyActiveProgram(root, null), { supported: false });
        assert.throws(() => verifyActiveProgram(root, randomUUID()), /state|identity/);
        fs.mkdirSync(path.join(root, '.pivane-runtime'));
        fs.writeFileSync(path.join(root, '.pivane-runtime/state.json'), '{broken');
        assert.throws(() => verifyActiveProgram(root, null));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
