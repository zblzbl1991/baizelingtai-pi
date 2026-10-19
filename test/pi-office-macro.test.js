const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createAutoOpenDoc } = require('./office-macro-fixtures.cjs');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-office-macro-')));
const project = path.join(root, 'project'), markerPath = path.join(root, 'autoopen-marker.txt'); fs.mkdirSync(project);
Object.assign(process.env, { PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_PROJECT_ROOTS: project, PI_OFFLINE: '1' });
const { OfficePreviewService } = require('../server/pi-office-previews');
const { OfficePreviewSources } = require('../server/pi-office-preview-sources');
const { PiFileService } = require('../server/pi-file-service');
const { PiSessionStore } = require('../server/pi-session-store');
test('a runnable DOC AutoOpen container is refused by real sources before native conversion', async () => {
    const original = fs.readFileSync(path.join(__dirname, 'fixtures/office/rich.doc'));
    const fixture = createAutoOpenDoc(original, { markerPath, canaryRoot: root, CFB: require('xlsx').CFB });
    assert.ok(fixture.source.includes('Public Sub AutoOpen()')); assert.ok(fixture.source.includes('PIVANE-SYNTHETIC-VBA-AUTOOPEN'));
    fs.writeFileSync(path.join(project, 'autoopen.doc'), fixture.bytes); let nativeCalls = 0;
    const service = new OfficePreviewService({ sources: new OfficePreviewSources({ files: new PiFileService(new PiSessionStore()) }),
        engine: { generation: 'macro-admission', status: async () => ({ available: true }), convert: async () => { nativeCalls++; throw new Error('must not enter native'); }, dispose: async () => {} } });
    try {
        await assert.rejects(service.preview({ source: { type: 'project', cwd: project, path: 'autoopen.doc' } }), { code: 'OFFICE_INVALID' });
        assert.equal(nativeCalls, 0); assert.equal(fs.existsSync(markerPath), false);
        assert.throws(() => createAutoOpenDoc(original, { markerPath: path.join(root, '../outside.txt'), canaryRoot: root, CFB: require('xlsx').CFB }), /Marker must/);
    } finally { await service.dispose(); }
});
test('macro canary paths support Unicode parents without lossy source encoding', () => {
    const original = fs.readFileSync(path.join(__dirname, 'fixtures/office/rich.doc'));
    const canaryRoot = path.join(root, '中文测试'), markerPath = path.join(canaryRoot, 'autoopen-marker.txt');
    const fixture = createAutoOpenDoc(original, { markerPath, canaryRoot, CFB: require('xlsx').CFB });
    assert.ok(fixture.source.includes('ChrW(20013)')); assert.match(fixture.source, /^[\x00-\x7f]+$/);
    assert.equal(fixture.markerPath, markerPath);
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
