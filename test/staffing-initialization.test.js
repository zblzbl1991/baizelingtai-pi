'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-staffing-')));
process.env.PI_CODING_AGENT_DIR = root;
const { PiProfileRegistry } = require('../server/pi-profile-registry');
const { StaffingService } = require('../server/staffing/service');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('enable, review initial ledger and restore a stable dedicated profile without changing ordinary defaults', async t => {
    let service;
    const profiles = new PiProfileRegistry({ resolveProject: value => value }, { businessStatus: () => service.status() });
    service = new StaffingService({ profiles });
    assert.equal((await service.status()).state, 'disabled');
    const start = { requestId: 'enable-first', expectedRevision: 0 };
    const enabled = await service.enable(start);
    assert.equal(enabled.state, 'awaiting-import');
    assert.ok(enabled.profileId);
    assert.deepEqual(await service.enable(start), enabled);
    const profile = await profiles.getProfile(enabled.profileId);
    await profiles.save({ expectedRevision: (await profiles.state()).revision,
        profile: { ...profile, name: 'My staffing assistant', soul: 'User custom instructions' } });
    const initialized = await service.initialize({ requestId: 'initial', expectedRevision: enabled.revision,
        people: [{ id: 'person-1', name: '<One>', department: 'A', direct: true }],
        projects: [{ id: 'project-1', name: 'Project A', department: 'A', owner: 'Owner', start: '2026-11-01', end: '2026-11-05', minimum: 1 }],
        occupancies: [{ id: 'assignment-1', personId: 'person-1', projectId: 'project-1', kind: 'project', state: 'reserved', start: '2026-11-01', end: '2026-11-05' }], historyComplete: false });
    assert.equal(initialized.state, 'awaiting-review');
    assert.equal((await service.ledger()).people[0].name, '<One>');
    await assert.rejects(service.confirmInitial({ requestId: 'bad-review', expectedRevision: initialized.revision, reviewed: false }), /review/i);
    const ready = await service.confirmInitial({ requestId: 'review', expectedRevision: initialized.revision, reviewed: true });
    assert.equal(ready.state, 'ready');
    await service.disable({ requestId: 'disable', expectedRevision: ready.revision });
    const disabledRegistry = (await profiles.state()).state;
    assert.deepEqual(await profiles.businessFor(enabled.profileId, disabledRegistry), { id: 'staffing', enabled: false, state: 'disabled' });
    await assert.rejects(profiles.select('/ordinary-project', enabled.profileId), /人员调配业务已停用/);
    assert.equal(await profiles.select('/ordinary-project', null), null, 'ordinary sessions remain available');
    assert.equal((await profiles.getProfile(enabled.profileId)).enabled, true, 'business disable does not edit the assistant enabled preference');
    const disabledList = await profiles.list();
    assert.deepEqual(disabledList.profiles.find(profile => profile.id === enabled.profileId).business, { id: 'staffing', enabled: false, state: 'disabled' });
    const registryRevision = disabledList.revision;
    profiles.businessStatus = async () => { throw new Error('synthetic ledger read failure'); };
    const unavailable = await profiles.list();
    assert.deepEqual(unavailable.profiles.find(profile => profile.id === enabled.profileId).business, { id: 'staffing', enabled: false, state: 'unavailable' });
    assert.equal(unavailable.profiles.find(profile => profile.id === unavailable.defaultAssistantId).business, undefined, 'a failed business ledger does not disable the ordinary assistant');
    assert.equal(unavailable.revision, registryRevision, 'business state is not written into identity settings');
    await assert.rejects(profiles.select('/ordinary-project', enabled.profileId), /人员调配业务已停用/);
    profiles.businessStatus = () => service.status();
    await service.dispose();
    service = new StaffingService({ profiles });
    const restored = await service.enable({ requestId: 'restore', expectedRevision: (await service.status()).revision });
    assert.equal(restored.state, 'ready');
    assert.equal(restored.profileId, enabled.profileId);
    assert.equal(await profiles.select('/ordinary-project', restored.profileId), restored.profileId, 're-enabling restores new sessions with the same identity');
    assert.equal((await service.ledger()).occupancies.length, 1);
    const restoredProfiles = await profiles.list();
    assert.equal(restoredProfiles.profiles.filter(profile => profile.id === restored.profileId).length, 1, 'one stable staffing assistant is retained');
    assert.equal(restoredProfiles.profiles.length, 2, 'the default assistant and staffing assistant remain distinct');
    assert.deepEqual(restoredProfiles.profiles.find(profile => profile.id === restored.profileId).business, { id: 'staffing', enabled: true, state: 'ready' });
    assert.equal((await profiles.getProfile(enabled.profileId)).soul, 'User custom instructions');
    assert.equal((await profiles.list()).defaultProfileId, null);
    assert.deepEqual(await service.operation('enable-first'), { state: 'completed', result: enabled });
    await service.dispose();
});

test('staffing HTTP uses workspace authentication and Origin, persists request results and rejects stale or duplicate mutations', async t => {
    const express = require('express'), http = require('node:http');
    const { once } = require('node:events');
    const { WorkspaceAccessService } = require('../server/workspace-access-service');
    const { mountStaffingRoutes } = require('../server/staffing/routes');
    const service = new StaffingService({ profiles: new PiProfileRegistry({ resolveProject: value => value }) });
    const access = new WorkspaceAccessService({ filePath: path.join(root, 'access.json'), envToken: () => 'synthetic-staffing-access' });
    const app = express(), router = express.Router();
    access.mount(app); app.use(express.json()); router.use(access.middleware()); mountStaffingRoutes(router, service); app.use('/api/pi', router);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => { await service.dispose(); access.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const call = (route, method = 'GET', body, extra = {}) => fetch(origin + '/api/pi/staffing' + route, { method,
        headers: { Authorization: 'Bearer synthetic-staffing-access', 'Content-Type': 'application/json', Origin: origin, ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await fetch(origin + '/api/pi/staffing/status')).status, 401);
    assert.equal((await call('/disable', 'POST', {}, { Origin: 'https://invalid.example' })).status, 403);
    const current = await (await call('/status')).json();
    const input = { requestId: 'http-disable', expectedRevision: current.revision };
    const response = await call('/disable', 'POST', input); assert.equal(response.status, 200);
    const disabled = await response.json(); assert.equal(disabled.state, 'disabled');
    assert.equal((await call('/ledger')).status, 409);
    assert.deepEqual(await (await call('/disable', 'POST', input)).json(), disabled);
    assert.equal((await call('/disable', 'POST', { ...input, expectedRevision: disabled.revision })).status, 409);
    assert.equal((await call('/enable', 'POST', { requestId: 'stale', expectedRevision: current.revision })).status, 409);
    assert.equal((await call('/enable', 'POST', { requestId: 'unknown-field', expectedRevision: disabled.revision, confirmed: true })).status, 400);
    const lookup = await call('/operations/http-disable');
    assert.equal(lookup.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await lookup.json(), { state: 'completed', result: disabled });
    assert.deepEqual(await (await call('/operations/not-submitted')).json(), { state: 'unknown', noReplay: true });
    const enabled = await (await call('/enable', 'POST', { requestId: 'http-restore', expectedRevision: disabled.revision })).json();
    assert.equal(enabled.state, 'ready');
    const concurrent = await Promise.allSettled([
        service.disable({ requestId: 'concurrent-one', expectedRevision: enabled.revision }),
        service.disable({ requestId: 'concurrent-two', expectedRevision: enabled.revision })
    ]);
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.find(result => result.status === 'rejected').reason.status, 409);
    require('./private-file-helper.cjs').assertPrivateFile(path.join(root, 'pivane-staffing', 'ledger.json'));
    require('./private-file-helper.cjs').assertPrivateFile(path.join(root, 'pivane-profiles', 'profiles.json'));
});

test('ready gate, maintenance and shutdown reserve work before awaits and reject new mutations', async () => {
    let suspended = true;
    const profiles = new PiProfileRegistry({ resolveProject: value => value });
    const service = new StaffingService({ profiles, isSuspended: () => suspended });
    const before = await service.status();
    await assert.rejects(service.requireReady(), /enablement/);
    await assert.rejects(service.enable({ requestId: 'maintenance', expectedRevision: before.revision }), { status: 409 });
    assert.deepEqual(await service.status(), before);
    suspended = false;
    const operation = service.enable({ requestId: 'before-stop', expectedRevision: before.revision });
    assert.equal(service.busy, true);
    const stopping = service.dispose();
    await assert.rejects(service.disable({ requestId: 'after-stop', expectedRevision: before.revision }), { status: 409 });
    const completed = await operation;
    await stopping;
    assert.equal(service.busy, false);
    assert.equal((await service.operation('before-stop')).result.revision, completed.revision);
});

test('interrupted initialization resumes the exact request and adopts its existing business-bound profile', async t => {
    const agent = path.join(root, 'recovery'); fs.mkdirSync(agent);
    process.env.PI_CODING_AGENT_DIR = agent;
    t.after(() => { process.env.PI_CODING_AGENT_DIR = root; });
    const profiles = new PiProfileRegistry({ resolveProject: value => value });
    const existing = await profiles.ensureManagedProfile('pivane-staffing:v1', { name: 'Custom', description: '', soul: 'Keep my instructions', enabled: true });
    let release;
    const held = profiles.reserve(() => new Promise(resolve => { release = resolve; }));
    await Promise.resolve();
    let service = new StaffingService({ profiles });
    const input = { requestId: 'recover-enable', expectedRevision: 0 };
    await assert.rejects(service.enable(input), { status: 409 });
    assert.equal((await service.status()).state, 'initializing');
    assert.deepEqual((await service.status()).initialization, input);
    assert.deepEqual(await service.operation(input.requestId), { state: 'pending', noReplay: true });
    await assert.rejects(service.enable({ requestId: 'another-enable', expectedRevision: (await service.status()).revision }), /original initialization/);
    release(); await held; await service.dispose();
    service = new StaffingService({ profiles: new PiProfileRegistry({ resolveProject: value => value }) });
    const recovered = await service.enable(input);
    assert.equal(recovered.state, 'awaiting-import');
    assert.equal(recovered.profileId, existing.profile.id);
    const recoveredProfiles = await profiles.list();
    assert.equal(recoveredProfiles.profiles.filter(profile => profile.id === recovered.profileId).length, 1, 'recovery does not duplicate the managed assistant');
    assert.equal(recoveredProfiles.profiles.length, 2, 'the independent default assistant is also retained');
    assert.equal((await profiles.getProfile(recovered.profileId)).soul, 'Keep my instructions');
    await assert.rejects(service.requireReady(), /initial ledger review/);
    const before = await service.status();
    await assert.rejects(service.initialize({ requestId: 'bad-date', expectedRevision: before.revision,
        people: [{ id: 'P1', name: 'One', department: 'A', direct: true }],
        projects: [{ id: 'A', name: 'A', department: 'A', owner: 'Owner', start: '2026-02-30', end: '2026-03-02', minimum: 1 }],
        occupancies: [], historyComplete: false }), /Invalid/);
    assert.deepEqual(await service.status(), before);
    await service.dispose();
});

test('a corrupt, oversized or linked ledger fails closed without replacing user data', async () => {
    const service = new StaffingService({ profiles: new PiProfileRegistry({ resolveProject: value => value }) });
    const before = await service.status(), directory = path.join(root, 'pivane-staffing'), file = path.join(directory, 'ledger.json');
    const original = fs.readFileSync(file);
    try {
        fs.writeFileSync(file, '{invalid');
        await assert.rejects(service.status(), /invalid JSON/);
        await assert.rejects(service.disable({ requestId: 'corrupt', expectedRevision: before.revision }), /invalid JSON/);
        assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
        fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024 + 1, 32));
        await assert.rejects(service.status(), /Invalid staffing ledger file/);
        assert.equal(fs.statSync(file).size, 8 * 1024 * 1024 + 1);
    } finally { fs.writeFileSync(file, original); }
    const moved = path.join(root, 'original-staffing');
    fs.renameSync(directory, moved);
    try {
        fs.symlinkSync(moved, directory, process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(service.status(), /symlink|symbolic|link|unsafe|Invalid|符号链接/i);
    } finally { if (fs.existsSync(directory)) { if (process.platform === 'win32') fs.rmdirSync(directory); else fs.unlinkSync(directory); } fs.renameSync(moved, directory); }
    assert.deepEqual(await service.status(), before);
    await service.dispose();
});
