const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PiProfileRegistry, readRegistry } = require('../server/pi-profile-registry');
const privateFiles = require('../server/pi-private-files');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-initial-profile-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(name) {
    const agentDir = path.join(root, name), directory = path.join(agentDir, 'pivane-profiles');
    fs.mkdirSync(agentDir);
    const createRegistry = () => {
        const registry = new PiProfileRegistry({ resolveProject: () => agentDir });
        registry.paths = async (create = false) => {
            if (create) privateFiles.privateDirectory(directory);
            return { agentDir, root: directory, file: path.join(directory, 'profiles.json') };
        };
        return registry;
    };
    return { registry: createRegistry(), createRegistry, file: path.join(directory, 'profiles.json') };
}

test('concurrent first reads persist one initial profile and stable revisions across restart', async () => {
    const { registry, createRegistry, file } = fixture('first');
    const reads = await Promise.all([registry.list(), registry.list(), createRegistry().list()]);
    for (const result of reads) {
        assert.equal(result.profiles.length, 1);
        assert.equal(result.profiles[0].id, reads[0].profiles[0].id);
        assert.equal(result.revision, reads[0].revision);
        assert.equal(result.profiles[0].name, '小白');
        assert.equal(result.profiles[0].enabled, true);
        assert.deepEqual(result.profiles[0].memory, { enabled: true, autoLearn: false });
        assert.deepEqual(result.profiles[0].skills, { learnedEnabled: true });
        assert.equal(result.profiles[0].soul, '');
        assert.equal(result.defaultProfileId, null);
    }
    assert.deepEqual(readRegistry(file).state.defaults, {});
    assert.equal((await createRegistry().list()).revision, reads[0].revision);
    const renamed = await registry.save({ expectedRevision: reads[0].revision,
        profile: { ...reads[0].profiles[0], name: 'Renamed', enabled: false, memory: { enabled: false } } });
    assert.equal((await createRegistry().list()).profiles[0].name, 'Renamed');
    const trashed = await registry.trash(renamed.profile.id, { expectedRevision: renamed.revision });
    const afterTrash = await createRegistry().list();
    assert.equal(afterTrash.profiles.length, 0);
    assert.equal(afterTrash.trash.length, 1);
    assert.equal(afterTrash.revision, trashed.revision);
});

test('existing profiles are preserved and a saved empty registry is initialized', async () => {
    const { registry, file } = fixture('existing');
    const saved = await registry.save({ expectedRevision: (await registry.state()).revision,
        profile: { name: 'Existing', description: '', soul: 'Keep', enabled: true } });
    assert.deepEqual((await registry.list()).profiles, [saved.profile]);
    assert.equal((await registry.list()).revision, saved.revision);
    // Only synthetic fixture state is replaced here; there is no permanent-delete API.
    fs.writeFileSync(file, JSON.stringify({ version: 1, profiles: [], defaults: {}, customField: 'keep' }));
    assert.equal((await registry.list()).profiles[0].name, '小白');
    assert.equal(readRegistry(file).state.customField, 'keep');
});

test('initialization honors mutation gates and never masks corrupt or uncertain saves', async () => {
    const { registry, file } = fixture('gates');
    registry.maintenance = { locked: true };
    await assert.rejects(registry.list(), error => error.status === 409);
    assert.equal(fs.existsSync(file), false);
    registry.maintenance = { referenceLocked: true };
    await assert.rejects(registry.list(), error => error.status === 409);
    assert.equal(fs.existsSync(file), false);
    registry.maintenance = {};
    const mutate = registry.mutate.bind(registry);
    let release;
    registry.mutate = (...args) => new Promise(resolve => { release = () => resolve(mutate(...args)); });
    const initialization = registry.ensureInitialProfile();
    assert.equal(registry.busy, true, 'reserve before asynchronous reads');
    await assert.rejects(async () => registry.save({}), error => error.status === 409);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    let disposed = false;
    const shutdown = registry.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposed, false);
    release();
    await initialization;
    await shutdown;
    assert.equal(registry.busy, false);
    assert.equal(disposed, true);

    const uncertain = fixture('uncertain');
    const originalMutate = uncertain.registry.mutate.bind(uncertain.registry);
    let writes = 0;
    uncertain.registry.mutate = async (...args) => {
        writes++;
        await originalMutate(...args);
        throw Object.assign(new Error('Unknown save outcome'), { status: 503, code: 'PROFILE_OUTCOME_UNKNOWN' });
    };
    await assert.rejects(uncertain.registry.list(), error => error.status === 503);
    assert.equal((await uncertain.createRegistry().list()).profiles.length, 1);
    assert.equal(writes, 1);
    fs.writeFileSync(uncertain.file, '{broken');
    await assert.rejects(uncertain.createRegistry().list(), /invalid JSON/);
    assert.equal(fs.readFileSync(uncertain.file, 'utf8'), '{broken');
});
