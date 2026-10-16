'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { StaffingService } = require('../server/staffing/service');
const { PiProfileRegistry } = require('../server/pi-profile-registry');
// Prepare the isolated SDK/identity before timing crash/recovery operations.
let warmupAgent;
test.before(async () => {
    warmupAgent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-recovery-warmup-')));
    process.env.PI_CODING_AGENT_DIR = warmupAgent;
    const service = new StaffingService({ profiles: new PiProfileRegistry({ resolveProject: value => value }) });
    try { await service.status(); } finally { await service.dispose(); }
});
test.after(() => { if (warmupAgent) fs.rmSync(warmupAgent, { recursive: true, force: true }); });
function fixture(t) {
    const agent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-recovery-')));
    process.env.PI_CODING_AGENT_DIR = agent;
    t.after(() => fs.rmSync(agent, { recursive: true, force: true }));
    const profiles = new PiProfileRegistry({ resolveProject: value => value });
    const service = new StaffingService({ profiles });
    t.after(() => service.dispose());
    return { agent, service, profiles };
}
async function childFixture(t, agent, mode) {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/staffing-crash-child.cjs'), agent, mode], {
        env: { ...process.env, PI_CODING_AGENT_DIR: agent }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const ready = new Promise((resolve, reject) => {
        let buffer = '';
        child.stdout.on('data', chunk => {
            buffer += chunk;
            for (;;) {
                const index = buffer.indexOf('\n'); if (index < 0) break;
                const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
                if (line.startsWith('STAFFING_FIXTURE:')) resolve(JSON.parse(line.slice('STAFFING_FIXTURE:'.length)));
            }
        });
        child.once('error', reject);
        void exited.then(result => reject(new Error('Fixture exited before barrier: ' + JSON.stringify(result) + stderr)));
    });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    return { child, ready: await ready, async crash() {
        assert.equal(child.kill('SIGKILL'), true, 'terminate the independent process without running JS finally');
        const result = await exited;
        assert.ok(result.signal === 'SIGKILL' || result.code !== 0);
        return result;
    } };
}
const input = { requestId: 'crashed-enable', expectedRevision: 0 };
const initial = revision => ({ requestId: 'initial-after-crash', expectedRevision: revision,
    people: [{ id: 'P1', name: 'Synthetic One', department: 'A', direct: true }], projects: [], occupancies: [], historyComplete: false });

test('an independent ledger writer excludes a second writer, and an OS crash releases it for public initialization', { timeout: 180000 }, async t => {
    const { agent, service, profiles } = fixture(t);
    assert.equal((await service.status()).revision, 0);
    const child = await childFixture(t, agent, 'ledger-before');
    assert.equal(child.ready.stage, 'ledger-before');
    await assert.rejects(service.enable({ requestId: 'competing', expectedRevision: 0 }), { status: 409 });
    assert.equal((await service.status()).state, 'disabled');
    assert.deepEqual(await service.operation(input.requestId), { state: 'unknown', noReplay: true });
    await child.crash();
    const enabled = await service.enable(input);
    const imported = await service.initialize(initial(enabled.revision));
    const ready = await service.confirmInitial({ requestId: 'review-after-crash', expectedRevision: imported.revision, reviewed: true });
    assert.equal(ready.state, 'ready');
    assert.equal((await service.ledger()).people[0].id, 'P1');
    assert.equal((await profiles.list()).profiles.length, 1);
    assert.deepEqual(await service.operation(input.requestId), { state: 'completed', result: enabled });
});

test('a crash during the real profile save releases profile ownership and resumes the pending staffing enable', { timeout: 180000 }, async t => {
    const { agent, service, profiles } = fixture(t);
    await service.status();
    const child = await childFixture(t, agent, 'profiles-before');
    assert.equal(child.ready.stage, 'profiles-before');
    assert.equal((await service.status()).state, 'initializing');
    assert.deepEqual(await service.operation(input.requestId), { state: 'pending', noReplay: true });
    await assert.rejects(profiles.save({ expectedRevision: (await profiles.state()).revision,
        profile: { name: 'Competing profile', description: '', soul: '', enabled: true } }), { status: 409 });
    await child.crash();
    const enabled = await service.enable(input);
    assert.equal(enabled.state, 'awaiting-import');
    assert.equal((await profiles.list()).profiles.length, 1);
    assert.equal((await profiles.list()).profiles[0].id, enabled.profileId);
    assert.deepEqual(await service.operation(input.requestId), { state: 'completed', result: enabled });
});

test('HTTP reports an unknown outcome after ledger publication and the original request resolves without another write', { timeout: 180000 }, async t => {
    const { agent, service, profiles } = fixture(t);
    await service.status();
    const child = await childFixture(t, agent, 'ledger-after-error');
    const origin = child.ready.origin;
    const headers = { Authorization: 'Bearer synthetic-staffing-recovery', 'Content-Type': 'application/json', Origin: origin };
    const response = await fetch(origin + '/api/pi/staffing/enable', { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /unknown|original request/i);
    const result = await (await fetch(origin + '/api/pi/staffing/operations/' + input.requestId, { headers })).json();
    assert.equal(result.state, 'completed');
    assert.equal(result.result.state, 'awaiting-import');
    assert.equal((await profiles.list()).profiles.length, 1);
    const imported = await service.initialize(initial(result.result.revision));
    assert.equal(imported.state, 'awaiting-review');
    assert.deepEqual(await service.operation(input.requestId), result);
});

test('a published profile survives an OS crash and staffing adopts its stable binding without overwriting user edits', { timeout: 180000 }, async t => {
    const { agent, service, profiles } = fixture(t);
    await service.status();
    const child = await childFixture(t, agent, 'profiles-after');
    assert.equal(child.ready.stage, 'profiles-after');
    const published = await profiles.list();
    assert.equal(published.profiles.length, 1);
    const profile = published.profiles[0];
    await assert.rejects(profiles.save({ expectedRevision: published.revision, profile: { ...profile, name: 'Other writer' } }), { status: 409 });
    await child.crash();
    await profiles.save({ expectedRevision: published.revision, profile: { ...profile, name: 'Recovery custom name', soul: 'User edited recovery instructions' } });
    const enabled = await service.enable(input);
    assert.equal(enabled.profileId, profile.id);
    assert.equal((await profiles.list()).profiles.length, 1);
    assert.equal((await profiles.getProfile(profile.id)).soul, 'User edited recovery instructions');
    assert.equal((await profiles.getProfile(profile.id)).name, 'Recovery custom name');
    assert.equal((await profiles.list()).defaultProfileId, null);
});

test('a completed ledger publication survives a crash and subsequent initialization uses the same operation result', { timeout: 180000 }, async t => {
    const { agent, service, profiles } = fixture(t);
    await service.status();
    const child = await childFixture(t, agent, 'ledger-after');
    assert.equal(child.ready.stage, 'ledger-after');
    const result = await service.operation(input.requestId);
    assert.equal(result.state, 'completed');
    await assert.rejects(service.initialize(initial(result.result.revision)), { status: 409 });
    await child.crash();
    assert.deepEqual(await service.operation(input.requestId), result);
    assert.deepEqual(await service.enable(input), result.result);
    const imported = await service.initialize(initial(result.result.revision));
    assert.equal(imported.state, 'awaiting-review');
    assert.equal((await profiles.list()).profiles.length, 1);
});

test('a post-publication profile error is unknown and explicit initialization recovery does not duplicate the profile', { timeout: 180000 }, async t => {
    const { agent, service, profiles } = fixture(t);
    await service.status();
    const child = await childFixture(t, agent, 'profiles-after-error');
    const origin = child.ready.origin;
    const headers = { Authorization: 'Bearer synthetic-staffing-recovery', 'Content-Type': 'application/json', Origin: origin };
    const response = await fetch(origin + '/api/pi/staffing/enable', { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /unknown|original initialization request/i);
    assert.deepEqual(await service.operation(input.requestId), { state: 'pending', noReplay: true });
    assert.equal((await service.status()).state, 'initializing');
    const published = (await profiles.list()).profiles[0];
    const enabled = await service.enable(input);
    assert.equal(enabled.profileId, published.id);
    assert.equal((await profiles.list()).profiles.length, 1);
    assert.deepEqual(await service.operation(input.requestId), { state: 'completed', result: enabled });
});

for (const scope of ['ledger', 'profiles']) test(`an unknown legacy ${scope} lock fails closed regardless of age or owner claims`, async t => {
    const { agent, service } = fixture(t);
    const directory = path.join(agent, scope === 'ledger' ? 'pivane-staffing' : 'pivane-profiles');
    const legacy = path.join(directory, scope + '.lock');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'untrusted-old-owner', createdAt: '1970-01-01' }));
    fs.utimesSync(legacy, new Date(0), new Date(0));
    await assert.rejects(service.enable(input), { status: 409, code: 'STORAGE_LEGACY_LOCK' });
    assert.equal(fs.lstatSync(legacy).isDirectory(), true);
    assert.equal(fs.existsSync(path.join(legacy, 'owner.json')), true);
    assert.deepEqual(await service.operation(input.requestId), scope === 'ledger' ? { state: 'unknown', noReplay: true } : { state: 'pending', noReplay: true });
});
