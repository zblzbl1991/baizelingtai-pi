'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-adjustments-')));
process.env.PI_CODING_AGENT_DIR = root;
const { PiProfileRegistry } = require('../server/pi-profile-registry');
const { StaffingService } = require('../server/staffing/service');
let sequence = 0;
const project = { id: 'A', name: 'Project A', owner: 'Owner', department: 'A', start: '2026-11-01', end: '2026-11-05', minimum: 2 };
async function fixture() {
    const agent = path.join(root, String(++sequence)); fs.mkdirSync(agent); process.env.PI_CODING_AGENT_DIR = agent;
    const service = new StaffingService({ profiles: new PiProfileRegistry({ resolveProject: value => value }), today: () => '2026-11-03' });
    const enabled = await service.enable({ requestId: 'enable', expectedRevision: 0 });
    const initial = await service.initialize({ requestId: 'initial', expectedRevision: enabled.revision, historyComplete: false, projects: [project],
        people: [{ id: 'D', name: '<Direct>', department: 'A', direct: true }, { id: 'N', name: 'Member', department: 'A', direct: false },
            { id: 'R', name: 'Replacement', department: 'A', direct: true }, { id: 'F', name: 'Fourth', department: 'A', direct: false },
            { id: 'G', name: 'Fifth', department: 'A', direct: false }, { id: 'B', name: 'Borrowed', department: 'B', direct: true }],
        occupancies: ['D', 'N'].map(personId => ({ id: 'O-' + personId, personId, projectId: 'A', kind: 'project', state: 'reserved', start: project.start, end: project.end })) });
    await service.confirmInitial({ requestId: 'review', expectedRevision: initial.revision, reviewed: true });
    return service;
}
async function prepare(service, change) { return service.prepareAdjustment({ requestId: 'prepare-' + (++sequence), expectedRevision: (await service.status()).revision, ...change }, await service.pageSource()); }
async function commit(service, plan, action = 'apply') { return service.commitPlan({ requestId: 'commit-' + (++sequence), expectedRevision: plan.revision, planId: plan.id, action }, await service.pageSource()); }
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('truthful leave shows daily headcount and direct gaps in all three ledger views', async t => {
    const service = await fixture(); t.after(() => service.dispose());
    let view = await service.views({ kind: 'projects' });
    assert.equal(view.projects[0].coverage.satisfied, true); assert.equal(view.projects[0].coverage.allConfirmed, false);
    const plan = await prepare(service, { kind: 'absence', personId: 'D', absenceKind: 'leave', start: '2026-11-03', end: '2026-11-03', reason: 'Temporary leave' });
    assert.equal((await service.views({ kind: 'projects' })).projects[0].coverage.satisfied, true, 'preview does not change current attendance');
    const saved = await commit(service, plan);
    view = await service.views({ kind: 'projects' });
    assert.equal(view.revision, saved.revision);
    assert.deepEqual(view.projects[0].coverage.segments.map(s => [s.start,s.end,s.count,s.direct,s.missing,s.missingDirect]), [
        ['2026-11-01','2026-11-02',2,1,0,false], ['2026-11-03','2026-11-03',1,0,1,true], ['2026-11-04','2026-11-05',2,1,0,false] ]);
    const available = await service.views({ kind: 'availability', department: 'A', start: '2026-11-03', end: '2026-11-03' });
    assert.ok(!available.people.some(p => p.id === 'D'));
    const calendar = await service.views({ kind: 'people', personId: 'D', start: project.start, end: project.end });
    assert.deepEqual(calendar.people[0].occupancies.map(o => o.kind).sort(), ['leave','project']);
    const history = await service.views({ kind: 'history' });
    assert.equal(history.events.at(-1).after.occupancies[0].kind, 'leave');
});
