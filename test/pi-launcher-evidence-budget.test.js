const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { privateDir, atomicJson } = require('../server/pi-maintenance-files');
const { helperCommand, activationFileProof } = require('../server/pi-launcher-activation');

test('helper command reads twenty thousand source proofs plus the two known capability proofs within the unchanged byte budget', t => {
    const root = privateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-evidence-budget-'))), id = randomUUID();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = privateDir(path.join(root, '.pivane-runtime/activation', id)), file = path.join(directory, 'entries.json');
    // The public command reader checks the evidence envelope, not source files.
    // Placeholders keep this budget test tiny; no source inventory is created.
    const sources = Array(20000).fill({});
    const capability = ['baizelingtai-portable.json', 'PORTABLE_MANIFEST.json'].map(name => {
        const target = path.join(root, name); fs.writeFileSync(target, '{}'); return { path: name, ...activationFileProof(target) };
    });
    const command = original => {
        atomicJson(file, { version: 1, id, root, original, candidate: [], closure: [] });
        atomicJson(path.join(root, '.pivane-runtime/state.json'), { version: 1, activation: { id, root, evidence: activationFileProof(file) } });
        return helperCommand(root, id);
    };
    assert.equal(command([...sources, ...capability]).executable, path.join(directory, 'helper/runtime/node.exe'));
    assert.doesNotThrow(() => command([...sources.slice(1), ...capability]));
    assert.throws(() => command([...sources, ...capability, {}]), /Invalid activation evidence/);
    assert.throws(() => command([...sources, {}, {}]), /Invalid activation evidence/);
    assert.throws(() => command([...sources, capability[0], capability[0]]), /Invalid activation evidence/);
    assert.doesNotThrow(() => command(sources));
});
