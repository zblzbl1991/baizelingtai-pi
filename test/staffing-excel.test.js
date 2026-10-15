'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
test('standard staffing Excel preserves more than one document page and literal spreadsheet text', async () => {
    const { StaffingExcelService } = require('../server/staffing/excel-service');
    const excel = new StaffingExcelService();
    try {
        const data = { people: Array.from({ length: 241 }, (_, i) => ({ id: 'P' + i, name: i ? 'Same name' : '=1+1', department: 'A', direct: i === 0 })),
            projects: [{ id: 'H1', name: 'Ended', department: 'A', owner: 'Owner', start: '2026-10-01', end: '2026-10-20', minimum: 1, lifecycle: { state: 'ended', effectiveDate: '2026-10-15' } }],
            occupancies: [{ id: 'A1', personId: 'P0', projectId: 'H1', kind: 'project', state: 'confirmed', start: '2026-10-01', end: '2026-10-14' },
                { id: 'A2', personId: 'P0', projectId: 'H1', kind: 'project', state: 'cancelled', start: '2026-10-15', end: '2026-10-20' }], historyComplete: false };
        const bytes = excel.workbook(data, { revision: 12, generatedAt: '2026-10-15T08:00:00.000Z' });
        const parsed = await excel.inspect(bytes);
        assert.equal(parsed.data.people.length, 241);
        assert.equal(parsed.data.people[0].name, '=1+1');
        assert.equal(parsed.sourceRevision, 12);
        assert.equal(parsed.generatedAt, '2026-10-15T08:00:00.000Z');
        assert.deepEqual(parsed.data, data);
    } finally { await excel.dispose(); }
});
test('Excel import rejects formulas, macros, noncanonical dates, duplicate IDs and resource overrun', async () => {
    const { StaffingExcelService } = require('../server/staffing/excel-service'), { officeZip } = require('../server/pi-document-parser');
    const { zip } = require('./document-fixtures.cjs');
    const excel = new StaffingExcelService();
    const data = { people: [{ id: 'P1', name: 'One', department: 'A', direct: true }], projects: [{ id: 'J1', name: 'Project', department: 'A', owner: 'Owner', start: '2026-11-01', end: '2026-11-02', minimum: 1 }], occupancies: [], historyComplete: false };
    try {
        const good = excel.workbook(data), original = officeZip(good);
        const modify = (name, transform) => zip(Object.fromEntries(original.names.map(file => [file, file === name ? transform(original.read(file).toString()) : original.read(file)])));
        await assert.rejects(excel.inspect(modify('xl/worksheets/sheet1.xml', text => text.replace('<is><t xml:space="preserve">One</t></is>', '<f>1+1</f><v>2</v>'))), /formula/i);
        await assert.rejects(excel.inspect(modify('[Content_Types].xml', text => text.replace('spreadsheetml.sheet.main', 'spreadsheetml.macroEnabled.main'))), /macro|standard/i);
        await assert.rejects(excel.inspect(modify('xl/worksheets/sheet2.xml', text => text.replace('2026-11-01', '46327'))), /staffing|date/i);
        await assert.rejects(excel.inspect(Buffer.alloc(20 * 1024 ** 2 + 1)), { status: 413 });
        const duplicate = modify('xl/worksheets/sheet1.xml', text => text.replace('</sheetData>', '<row r="3"><c r="A3" t="inlineStr"><is><t>P1</t></is></c><c r="B3" t="inlineStr"><is><t>Other</t></is></c><c r="C3" t="inlineStr"><is><t>A</t></is></c><c r="D3" t="inlineStr"><is><t>true</t></is></c></row></sheetData>'));
        await assert.rejects(excel.inspect(duplicate), /duplicate/i);
    } finally { await excel.dispose(); }
});
test('initial Excel import and later differences require a source-bound inspected plan', async () => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-import-'))); process.env.PI_CODING_AGENT_DIR = root;
    const { StaffingService } = require('../server/staffing/service'), { PiProfileRegistry } = require('../server/pi-profile-registry');
    const { StaffingExcelService } = require('../server/staffing/excel-service');
    const excel = new StaffingExcelService(), staffing = new StaffingService({ profiles: new PiProfileRegistry({ resolveProject: value => value }), imports: excel, today: () => '2026-10-15' }); excel.staffing = staffing;
    try {
        const enabled = await staffing.enable({ requestId: 'enable-import', expectedRevision: 0 }), source = await staffing.pageSource({ phase: 'initial' });
        const data = { people: [{ id: 'P1', name: 'Same', department: 'A', direct: true }, { id: 'P2', name: 'Same', department: 'A', direct: false }], projects: [], occupancies: [], historyComplete: false };
        const upload = await excel.upload(excel.workbook(data, { revision: 0 }), { requestId: 'upload-initial' }, source);
        const plan = await staffing.prepareImport({ requestId: 'prepare-initial', expectedRevision: enabled.revision, uploadId: upload.id }, source);
        assert.equal((await staffing.ledger()).people.length, 0); assert.equal(plan.kind, 'import'); assert.equal(plan.totalChanges, 2);
        const applied = await staffing.commitPlan({ requestId: 'apply-initial', expectedRevision: plan.revision, planId: plan.id, action: 'apply-import' }, source);
        assert.equal(applied.state, 'awaiting-review');
        assert.equal((await staffing.ledger()).people.length, 2);
        const ready = await staffing.confirmInitial({ requestId: 'review-import', expectedRevision: applied.revision, reviewed: true });
        const assignment = await staffing.prepareChange({ requestId: 'assign-before-roundtrip', expectedRevision: ready.revision, project: { id: 'unchanged', name: 'Project', owner: 'Owner', department: 'A', start: '2026-11-01', end: '2026-11-02', minimum: 1 }, personIds: ['P1'] }, source);
        const confirmed = await staffing.commitPlan({ requestId: 'confirm-before-roundtrip', expectedRevision: assignment.revision, planId: assignment.id, action: 'confirm' }, source);
        const beforeRoundtrip = await staffing.ledger();
        const unchangedFile = await excel.upload(excel.workbook({ people: beforeRoundtrip.people, projects: beforeRoundtrip.projects, occupancies: beforeRoundtrip.occupancies, historyComplete: beforeRoundtrip.historyComplete }, { revision: confirmed.revision }), { requestId: 'upload-unchanged' }, source);
        const unchanged = await staffing.prepareImport({ requestId: 'prepare-unchanged', expectedRevision: confirmed.revision, uploadId: unchangedFile.id }, source);
        assert.equal(unchanged.totalChanges, 0, 'property order must not create changes in an unchanged workbook');
        assert.equal(unchanged.warning, '', 'a freshly exported revision is not old merely because preparing a plan advances the revision');
        data.people[1].name = 'Changed';
        const changed = await excel.upload(excel.workbook(data, { revision: 0 }), { requestId: 'upload-change' }, source);
        const diff = await staffing.prepareImport({ requestId: 'prepare-change', expectedRevision: unchanged.revision, uploadId: changed.id }, source);
        assert.equal(diff.totalChanges, 1); assert.match(diff.warning, /版本较旧/);
        assert.equal((await staffing.ledger()).people[1].name, 'Same');
        await staffing.commitPlan({ requestId: 'apply-change', expectedRevision: diff.revision, planId: diff.id, action: 'apply-import' }, source);
        assert.equal((await staffing.ledger()).people[1].name, 'Changed');
        data.people[1].department = 'B'; data.projects = [{ id: 'J1', name: 'New', owner: 'Owner', department: 'A', start: '2026-12-01', end: '2026-12-02', minimum: 1 }];
        data.occupancies = [{ id: 'A1', personId: 'P2', projectId: 'J1', kind: 'project', state: 'reserved', start: '2026-12-01', end: '2026-12-02' }];
        const borrowed = await excel.upload(excel.workbook(data, { revision: 0 }), { requestId: 'upload-borrowed' }, source);
        await assert.rejects(staffing.prepareImport({ requestId: 'prepare-borrowed', expectedRevision: (await staffing.status()).revision, uploadId: borrowed.id }, source), /cross.department|跨事业部/i);
        data.people[1].department = 'A'; data.occupancies.push({ id: 'leave-import', personId: 'P2', kind: 'leave', state: 'confirmed', start: '2026-12-01', end: '2026-12-01' });
        const unavailable = await excel.upload(excel.workbook(data, { revision: 0 }), { requestId: 'upload-unavailable' }, source);
        await assert.rejects(staffing.prepareImport({ requestId: 'prepare-unavailable', expectedRevision: (await staffing.status()).revision, uploadId: unavailable.id }, source), /unavailable/i);
        const truthful = { people: beforeRoundtrip.people, projects: beforeRoundtrip.projects, occupancies: [...beforeRoundtrip.occupancies,
            { id: 'later-leave', personId: 'P1', kind: 'leave', state: 'confirmed', start: '2026-11-01', end: '2026-11-01' }], historyComplete: false };
        const leaveFile = await excel.upload(excel.workbook(truthful), { requestId: 'upload-truthful-leave' }, source);
        const leavePlan = await staffing.prepareImport({ requestId: 'prepare-truthful-leave', expectedRevision: (await staffing.status()).revision, uploadId: leaveFile.id }, source);
        assert.ok(leavePlan.id, 'truthful absence must preserve an existing assignment');
        truthful.occupancies[0] = { ...truthful.occupancies[0], state: 'reserved' };
        const retainedFile = await excel.upload(excel.workbook(truthful), { requestId: 'upload-retained-assignment' }, source);
        const retainedPlan = await staffing.prepareImport({ requestId: 'prepare-retained-assignment', expectedRevision: leavePlan.revision, uploadId: retainedFile.id }, source);
        assert.ok(retainedPlan.id, 'a changed row may retain days already assigned to the same person and project');
    } finally { await excel.dispose(); await staffing.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('an exact generated staffing source saves an independent artifact and preserves export version', async () => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-export-'))); process.env.PI_CODING_AGENT_DIR = root;
    const { StaffingService } = require('../server/staffing/service'), { PiProfileRegistry } = require('../server/pi-profile-registry');
    const { StaffingExcelService } = require('../server/staffing/excel-service'), { ArtifactsService } = require('../server/pi-artifacts');
    const staffing = new StaffingService({ profiles: new PiProfileRegistry({ resolveProject: value => value }) });
    const artifacts = new ArtifactsService({ store: { resolveProject: value => value }, supervisor: {}, libraryRoot: path.join(root, 'artifacts') });
    const excel = new StaffingExcelService({ staffing, artifacts });
    try {
        const enabled = await staffing.enable({ requestId: 'enable-export', expectedRevision: 0 });
        const initial = await staffing.initialize({ requestId: 'initial-export', expectedRevision: enabled.revision, people: [{ id: 'P1', name: 'Direct', department: 'A', direct: true }], projects: [], occupancies: [], historyComplete: false });
        const ready = await staffing.confirmInitial({ requestId: 'review-export', expectedRevision: initial.revision, reviewed: true });
        const source = { sessionId: 'synthetic', sessionPath: path.join(root, 'session'), cwd: root, profileId: ready.profileId };
        const input = { requestId: 'export-once', expectedRevision: ready.revision };
        const result = await excel.export(input, source);
        assert.equal(result.phase, 'saved'); assert.equal(result.ledgerRevision, ready.revision);
        assert.ok(result.artifactKey); assert.equal(result.origin, null);
        const saved = await artifacts.preview(result.artifactKey);
        assert.equal(saved.revision, result.sha256);
        assert.equal((await excel.inspect(Buffer.from(saved.base64, 'base64'))).sourceRevision, ready.revision);
        const blockedPath = path.join(root, 'not-a-library'); fs.writeFileSync(blockedPath, 'preserve');
        const blockedArtifacts = new ArtifactsService({ store: { resolveProject: value => value }, supervisor: {}, libraryRoot: blockedPath });
        const blockedExcel = new StaffingExcelService({ staffing, artifacts: blockedArtifacts });
        try {
            const failed = await blockedExcel.export({ requestId: 'export-save-fails', expectedRevision: ready.revision }, source);
            assert.equal(failed.phase, 'available'); assert.ok(failed.saveError); assert.equal(failed.artifactKey, undefined);
            assert.equal((await staffing.ledger()).people.length, 1);
            const checked = await blockedExcel.operation('export-save-fails', source); assert.equal(checked.phase, 'available'); assert.equal(checked.noReplay, true);
        } finally { await blockedExcel.dispose(); await blockedArtifacts.dispose(); }
        await staffing.disable({ requestId: 'disable-export', expectedRevision: ready.revision });
        assert.equal((await artifacts.preview(result.artifactKey)).revision, result.sha256);
        assert.deepEqual(await excel.operation('export-once', source), result);
    } finally { await excel.dispose(); await staffing.dispose(); await artifacts.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
