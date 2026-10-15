'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-plans-')));
process.env.PI_CODING_AGENT_DIR = root;
const { PiProfileRegistry } = require('../server/pi-profile-registry');
const { StaffingService } = require('../server/staffing/service');
let service;
test.after(async () => { await service?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
const project = { id: 'new', name: 'New', owner: 'Owner', department: 'A', start: '2026-11-01', end: '2026-11-05', minimum: 2 };
const source = { sessionId: 'synthetic-session', sessionPath: path.join(root, 'session.jsonl'), cwd: root, profileId: '' };
test('recommend full-range available staff by direct coverage and ninety-day workload without occupying people', async () => {
    service = new StaffingService({ profiles: new PiProfileRegistry({ resolveProject: value => value }) });
    const enabled = await service.enable({ requestId: 'enable', expectedRevision: 0 }); source.profileId = enabled.profileId;
    const initialized = await service.initialize({ requestId: 'initial', expectedRevision: enabled.revision,
        people: [{ id: 'P1', name: 'Direct', department: 'A', direct: true }, { id: 'P2', name: 'Free', department: 'A', direct: false },
            { id: 'P3', name: 'Busy', department: 'A', direct: true }, { id: 'P4', name: 'Borrowed', department: 'B', direct: true }],
        projects: [{ ...project, id: 'old', start: '2026-10-01', end: '2026-10-20', minimum: 1 }],
        occupancies: [{ id: 'worked', personId: 'P1', projectId: 'old', kind: 'project', state: 'confirmed', start: '2026-10-01', end: '2026-10-03' },
            { id: 'leave', personId: 'P3', kind: 'leave', state: 'confirmed', start: '2026-11-05', end: '2026-11-06' }], historyComplete: false });
    await service.confirmInitial({ requestId: 'review', expectedRevision: initialized.revision, reviewed: true });
    const before = await service.ledger();
    const result = await service.query({ kind: 'recommend', project }, source);
    assert.deepEqual(result.selected.map(person => person.id), ['P1', 'P2']);
    assert.equal(result.selected[0].workDays, 3);
    assert.equal(result.historyComplete, false);
    assert.match(result.warning, /历史不完整/);
    assert.deepEqual(result.candidates.map(person => person.id), ['P2', 'P1']);
    assert.deepEqual((await service.ledger()).occupancies, before.occupancies);
    const nextDay = await service.query({ kind: 'recommend', project: { ...project, start: '2026-11-07', end: '2026-11-07' } }, source);
    assert.equal(nextDay.selected[0].id, 'P3');
});
test('exact prepared plans persist, commit once, reject stale cards and survive disable epochs', async () => {
    const before = await service.status();
    const input = { requestId: 'prepare-one', expectedRevision: before.revision, project, personIds: ['P1', 'P2'] };
    const plan = await service.prepareChange(input, source);
    assert.equal(plan.coverage.satisfied, true); assert.equal(plan.coverage.allConfirmed, false);
    assert.equal((await service.ledger()).projects.length, 1);
    assert.deepEqual(await service.prepareChange(input, source), plan);
    const second = await service.prepareChange({ ...input, requestId: 'prepare-two', expectedRevision: plan.revision }, source);
    await assert.rejects(service.commitPlan({ requestId: 'off-branch', planId: second.id, expectedRevision: second.revision, action: 'reserve' }, { ...source, nativePlanIds: [] }), { status: 403 });
    await assert.rejects(service.commitPlan({ requestId: 'commit-stale', planId: plan.id, expectedRevision: plan.revision, action: 'reserve' }, source), { status: 409 });
    const commit = { requestId: 'commit-once', planId: second.id, expectedRevision: second.revision, action: 'reserve' };
    const saved = await service.commitPlan(commit, source);
    assert.equal(saved.coverage.satisfied, true); assert.equal(saved.coverage.allConfirmed, false);
    assert.deepEqual(await service.commitPlan(commit, source), saved);
    await assert.rejects(service.commitPlan({ ...commit, action: 'confirm' }, source), { status: 409 });
    assert.equal((await service.query({ kind: 'recommend', project }, source)).selected.length, 0);
    assert.equal((await service.ledger()).occupancies.filter(row => row.projectId === 'new').length, 2);
    await service.dispose(); service = new StaffingService({ profiles: new PiProfileRegistry({ resolveProject: value => value }) });
    assert.deepEqual(await service.operation('commit-once'), { state: 'completed', result: saved });
    const pending = await service.prepareChange({ ...input, project: { ...project, id: 'next', start: '2026-12-01', end: '2026-12-02' }, requestId: 'prepare-disable', expectedRevision: saved.revision }, source);
    const disabled = await service.disable({ requestId: 'disable-plans', expectedRevision: pending.revision });
    const restored = await service.enable({ requestId: 'restore-plans', expectedRevision: disabled.revision });
    assert.ok(restored.epoch > pending.epoch);
    await assert.rejects(service.commitPlan({ requestId: 'old-card', planId: pending.id, expectedRevision: restored.revision, action: 'reserve' }, source), { status: 409 });
});
test('human plan adjustment grants borrowing only to that plan and keeps source-bound operation authority', async () => {
    const projectForBorrowing = { ...project, id: 'borrow', start: '2027-01-01', end: '2027-01-02' };
    let revision = (await service.status()).revision;
    await assert.rejects(service.prepareChange({ requestId: 'model-cannot-borrow', expectedRevision: revision, project: projectForBorrowing, personIds: ['P4'] }, source), { status: 409 });
    const partial = await service.prepareChange({ requestId: 'partial', expectedRevision: revision, project: projectForBorrowing, personIds: ['P2'] }, source);
    assert.equal(partial.coverage.satisfied, false); assert.equal(partial.coverage.segments[0].missingDirect, true);
    const permission = await service.revisePlan({ requestId: 'permission', planId: partial.id, expectedRevision: partial.revision, personIds: ['P2'], allowCrossDepartment: true }, source);
    assert.ok(permission.candidates.some(person => person.id === 'P4'));
    const revised = await service.revisePlan({ requestId: 'replace', planId: permission.id, expectedRevision: permission.revision, personIds: ['P2', 'P4'], allowCrossDepartment: true }, source);
    assert.equal(revised.coverage.satisfied, true);
    const saved = await service.commitPlan({ requestId: 'borrow-confirm', planId: revised.id, expectedRevision: revised.revision, action: 'confirm' }, source);
    assert.equal(saved.coverage.allConfirmed, true);
    assert.equal((await service.plan(partial.id, source)).outcome.planId, revised.id);
    const anotherSource = { ...source, sessionId: 'another-session' };
    await assert.rejects(service.plan(partial.id, anotherSource), { status: 403 });
    await assert.rejects(service.operationForSource('borrow-confirm', anotherSource), { status: 403 });
    assert.deepEqual(await service.operationForSource('borrow-confirm', source), { state: 'completed', result: saved });
    const nextProject = { ...projectForBorrowing, id: 'home', start: '2027-02-01', end: '2027-02-02' };
    await assert.rejects(service.prepareChange({ requestId: 'next-plan-no-permission', expectedRevision: saved.revision, project: nextProject, personIds: ['P4'] }, source), { status: 409 });
});
