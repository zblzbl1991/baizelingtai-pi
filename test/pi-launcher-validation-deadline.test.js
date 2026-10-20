const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transactionFixture } = require('./launcher-activation-fixture.cjs');
const { prepareActivation, commitActivation, inspectActivation } = require('../server/pi-launcher-activation');
const { atomicJson } = require('../server/pi-maintenance-files');

test('startup verification cannot commit after its validation deadline passes during inventory verification', t => {
    const input = transactionFixture(t);
    input.state.activation = prepareActivation(input);
    const id = input.state.activation.id, file = path.join(input.root, '.pivane-runtime/state.json');
    input.state.activation.phase = 'validating'; input.state.active = input.releaseId;
    atomicJson(file, input.state);
    const before = fs.readFileSync(file, 'utf8'), deadline = Date.now() + 60000;
    const validation = { control: true, versions: true, service: true, data: true, tray: true, stableMs: 15000, deadline };
    let checks = 0;
    t.mock.method(Date, 'now', () => ++checks === 1 ? deadline - 1 : deadline + 1);
    assert.throws(() => commitActivation(input.root, id, validation), /deadline|expired/);
    assert.equal(inspectActivation(input.root, id).phase, 'validating');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    t.mock.restoreAll();
    for (const invalid of [null, '123', NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, deadline - 120000]) {
        assert.throws(() => commitActivation(input.root, id, { ...validation, deadline: invalid }), /deadline|expired/);
        assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
    commitActivation(input.root, id, { ...validation, deadline: Date.now() + 60000 });
    assert.equal(inspectActivation(input.root, id).phase, 'committed');
});
