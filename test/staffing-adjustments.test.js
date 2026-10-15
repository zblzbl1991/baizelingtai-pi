'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-adjustments-')));
process.env.PI_CODING_AGENT_DIR = root;
const { PiProfileRegistry } = require('../server/pi-profile-registry');
const { StaffingService } = require('../server/staffing/service');
let sequence = 0;
const project = { id: 'A', name: 'Project A', owner: 'Owner', department: 'A', start: '2026-11-01', end: '2026-11-05', minimum: 2 };
async function fixture(today = () => '2026-11-03') {
    const agent = path.join(root, String(++sequence)); fs.mkdirSync(agent); process.env.PI_CODING_AGENT_DIR = agent;
    const service = new StaffingService({ profiles: new PiProfileRegistry({ resolveProject: value => value }), today });
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

test('formalize existing reservations without duplicating people and recommend only missing additions', async t => {
    const service = await fixture(); t.after(() => service.dispose());
    const formal = await prepare(service, { kind: 'formalize', projectId: 'A' });
    assert.equal((await service.views({ kind: 'projects' })).projects[0].coverage.allConfirmed, false);
    await commit(service, formal);
    let view = await service.views({ kind: 'projects' });
    assert.equal(view.projects[0].team.length, 2); assert.equal(view.projects[0].coverage.allConfirmed, true);
    const newProject = { ...project, id: 'five', start: '2026-12-01', end: '2026-12-05', minimum: 5 };
    let plan = await service.prepareChange({ requestId: 'reserve-three', expectedRevision: view.revision, project: newProject, personIds: ['D','N','R'] }, await service.pageSource());
    await commit(service, plan, 'reserve');
    const result = await service.query({ kind: 'recommend', project: newProject }, await service.pageSource());
    assert.equal(result.existingTeam.length, 3); assert.equal(result.additionalNeeded, 2);
    assert.deepEqual(result.selected.map(p => p.id), ['F','G']);
    plan = await service.prepareChange({ requestId: 'add-two', expectedRevision: result.revision, project: newProject, personIds: result.selected.map(p => p.id) }, await service.pageSource());
    await commit(service, plan, 'reserve');
    view = await service.views({ kind: 'projects' });
    assert.equal(view.projects.find(p => p.id === 'five').team.length, 5);
    assert.equal(view.projects.find(p => p.id === 'five').coverage.satisfied, true);
});

test('interval replacement and future release preserve elapsed workload and project history', async t => {
    const service = await fixture(); t.after(() => service.dispose());
    await commit(service, await prepare(service, { kind: 'absence', personId: 'D', absenceKind: 'leave', start: '2026-11-03', end: '2026-11-03', reason: 'Leave' }));
    const replacement = await prepare(service, { kind: 'replace', projectId: 'A', occupancyId: 'O-D', replacementPersonId: 'R', start: '2026-11-03', end: '2026-11-03', reason: 'Cover leave' });
    assert.equal(replacement.affectedProjects[0].coverage.satisfied, true);
    await commit(service, replacement);
    let result = await service.views({ kind: 'projects' });
    assert.equal(result.projects[0].coverage.satisfied, true);
    const early = await prepare(service, { kind: 'release', releaseKind: 'early-end', projectId: 'A', effectiveDate: '2026-11-04', reason: 'Early finish' });
    assert.deepEqual(early.project.lifecycle, { state: 'ended', effectiveDate: '2026-11-04' });
    assert.equal(early.lastRequiredDate, '2026-11-03');
    await commit(service, early);
    const available = await service.views({ kind: 'availability', department: 'A', start: '2026-11-04', end: '2026-11-05' });
    assert.ok(available.people.some(p => p.id === 'D')); assert.ok(available.people.some(p => p.id === 'N'));
    const days = await service.views({ kind: 'people', start: '2026-11-06', end: '2026-11-06' });
    assert.equal(days.people.find(p => p.id === 'D').workDays, 2);
    assert.equal(days.people.find(p => p.id === 'N').workDays, 3);
    assert.equal(days.people.find(p => p.id === 'R').workDays, 1);
    const history = await service.views({ kind: 'history' });
    assert.ok(history.events.some(e => e.before?.occupancies?.some(o => o.id === 'O-D' && o.end === '2026-11-05')));
    assert.ok(history.events.some(e => e.after?.projects?.some(p => p.lifecycle?.state === 'ended')));
    await assert.rejects(prepare(service, { kind: 'release', releaseKind: 'withdraw', projectId: 'A', occupancyId: 'O-N', effectiveDate: '2026-11-02', reason: 'No retrospective release' }), /future|past|date/i);
});


test('future reschedule checks inclusive conflicts and refuses retrospective rewrites; extensions keep elapsed days', async t => {
    const service = await fixture(); t.after(() => service.dispose()); const source = await service.pageSource();
    for (const [name,start,end] of [['future','2026-12-01','2026-12-05'],['busy','2026-12-10','2026-12-11']]) {
        const p = await service.prepareChange({ requestId: 'prepare-' + name, expectedRevision: (await service.status()).revision, project: { ...project, id: name, start, end, minimum: 1 }, personIds: ['D'] }, source); await commit(service,p,'confirm');
    }
    const before = await service.views({ kind:'projects' });
    await assert.rejects(prepare(service,{kind:'reschedule',projectId:'future',start:'2026-12-08',end:'2026-12-10',reason:'Endpoint overlap'}), /Overlapping/i);
    assert.equal((await service.status()).revision,before.revision);
    const moved = await prepare(service,{kind:'reschedule',projectId:'future',start:'2026-12-06',end:'2026-12-09',reason:'Move future project'});
    assert.equal((await service.views({kind:'availability',department:'A',start:'2026-12-01',end:'2026-12-05'})).people.some(p=>p.id==='D'),false);
    await commit(service,moved);
    assert.equal((await service.views({kind:'availability',department:'A',start:'2026-12-01',end:'2026-12-05'})).people.some(p=>p.id==='D'),true);
    await assert.rejects(prepare(service,{kind:'reschedule',projectId:'A',start:'2026-11-02',end:'2026-11-06',reason:'Started project'}), /started|elapsed/i);
    await commit(service,await prepare(service,{kind:'extend',projectId:'A',end:'2026-11-07',reason:'Extend future days'}));
    const result = await service.views({kind:'people',personId:'D',start:'2026-11-08',end:'2026-11-08'});
    assert.equal(result.people[0].workDays,7);
    const current = await service.views({kind:'projects'});
    assert.equal(current.projects.find(p=>p.id==='A').end,'2026-11-07');
});

test('page routes own adjustment authority, exact confirmation receipts and stale changes', async t => {
    const service = await fixture();
    const express = require('express'), http = require('node:http'), { once } = require('node:events');
    const { WorkspaceAccessService } = require('../server/workspace-access-service');
    const { mountStaffingRoutes } = require('../server/staffing/routes');
    const access = new WorkspaceAccessService({ filePath: path.join(root,'http-access.json'), envToken: () => 'synthetic-staffing' });
    const app = express(); access.mount(app); app.use(express.json()); const router = express.Router(); router.use(access.middleware()); mountStaffingRoutes(router,service); app.use('/api/pi',router);
    const server = http.createServer(app); server.listen(0,'127.0.0.1'); await once(server,'listening');
    t.after(async()=> { await service.dispose(); access.dispose(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const call = (url,body,originHeader=origin) => fetch(origin+'/api/pi/staffing'+url,{method:body?'POST':'GET',headers:{Authorization:'Bearer synthetic-staffing',Origin:originHeader,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal((await call('/adjust',{},'https://invalid.example')).status,403);
    const input = {requestId:'http-adjust',expectedRevision:(await service.status()).revision,kind:'formalize',projectId:'A'};
    const response = await call('/adjust',input); assert.equal(response.status,200); const plan = await response.json();
    assert.equal(plan.source.kind,'page');
    assert.equal((await call('/plans/'+plan.id+'?kind=page')).status,200);
    assert.equal((await call('/plans/'+plan.id+'?kind=page&profileId=forged')).status,400);
    const body = {requestId:'http-confirm',expectedRevision:plan.revision,planId:plan.id,action:'apply',source:{kind:'page'}};
    const saved = await (await call('/commit',body)).json(); assert.equal(saved.coverage.allConfirmed,true);
    assert.deepEqual(await (await call('/commit',body)).json(),saved);
    assert.equal((await call('/commit',{...body,action:'confirm'})).status,409);
    const history = await (await call('/views?kind=history')).json(); assert.equal(history.revision,saved.revision);
    assert.equal((await call('/views?kind=people&start=2026-02-30&end=2026-03-01')).status,400);
    assert.equal((await call('/agent/prepare',{...input,source:{kind:'page'}})).status,403);
});

test('borrowing is a human page permission for one replacement and stale adjustments cannot commit', async t => {
    const service=await fixture();t.after(()=>service.dispose());
    const input={kind:'replace',projectId:'A',occupancyId:'O-D',replacementPersonId:'B',start:'2026-11-03',end:'2026-11-03',reason:'Borrow cover'};
    await assert.rejects(prepare(service,input),/department/i);
    const nativeSource={sessionId:'session',sessionPath:path.join(root,'synthetic.jsonl'),cwd:root,profileId:(await service.status()).profileId};
    await assert.rejects(service.prepareAdjustment({requestId:'worker-borrow',expectedRevision:(await service.status()).revision,...input,allowCrossDepartment:true},nativeSource),{status:403});
    const permitted=await prepare(service,{...input,allowCrossDepartment:true});
    assert.equal(permitted.crossDepartment,true);await commit(service,permitted);
    await assert.rejects(prepare(service,{...input,occupancyId:'O-N',start:'2026-11-04',end:'2026-11-04'}),/department/i);
    const first=await prepare(service,{kind:'formalize',projectId:'A'}),second=await prepare(service,{kind:'formalize',projectId:'A'});
    await assert.rejects(commit(service,first),{status:409});await commit(service,second);
    const before=await service.status();
    await assert.rejects(prepare(service,{kind:'release',projectId:'A',releaseKind:'cancel',effectiveDate:'2026-02-30',reason:'Invalid date'}),/date/i);
    assert.equal((await service.status()).revision,before.revision);
});


test('a release plan cannot silently become retrospective across the server calendar boundary', async t => {
    let day='2026-11-03';const service=await fixture(()=>day);t.after(()=>service.dispose());
    const plan=await prepare(service,{kind:'release',projectId:'A',releaseKind:'withdraw',occupancyId:'O-D',effectiveDate:'2026-11-03',reason:'Withdraw from today'});
    day='2026-11-04';
    await assert.rejects(commit(service,plan),/past|future|elapsed/i);
    const result=await service.views({kind:'projects'});assert.equal(result.projects[0].team.length,2);assert.equal(result.projects[0].coverage.satisfied,true);
});
