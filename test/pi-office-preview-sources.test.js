const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { createHash } = require('node:crypto');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-office-source-')));
const agent = path.join(root, 'agent'), project = path.join(root, 'project'); fs.mkdirSync(agent); fs.mkdirSync(project);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
const { PiSessionStore, getSdk } = require('../server/pi-session-store');
const { PiFileService } = require('../server/pi-file-service');
const { DeliverableService, ENTRY } = require('../server/pi-deliverables');
const { DocumentUploads } = require('../server/pi-document-uploads');
const { ArtifactsService } = require('../server/pi-artifacts');
const { OfficePreviewSources } = require('../server/pi-office-preview-sources');
const { OfficePreviewService } = require('../server/pi-office-previews');
const { zip, docxFiles, xlsxFiles, pptxFiles, pdfBytes } = require('./document-fixtures.cjs');
const { legacy } = require('./office-legacy-fixtures.cjs');
const digest = b => createHash('sha256').update(b).digest('hex');
const store = new PiSessionStore(), supervisor = { removing: new Set(), moving: new Set(), getActiveWorker: () => null };
const files = new PiFileService(store), deliveries = new DeliverableService({ store, supervisor }), documents = new DocumentUploads({ store, supervisor });
const artifacts = new ArtifactsService({ store, supervisor, libraryRoot: path.join(agent, 'library') });
const sources = new OfficePreviewSources({ files, deliveries, documents, artifacts });
const service = new OfficePreviewService({ sources, engine: { generation: 'synthetic-integration', status: async () => ({ available: true }), convert: async () => ({ bytes: pdfBytes(), missingFonts: [] }), dispose: async () => {} },
    limits: { maxReaders: 16, maxSourceBytes: 64*1024**2, maxConcurrent: 1, maxQueued: 8, timeoutMs: 1000, queueTimeoutMs: 1000, maxOutputBytes: 1024**2, maxCachedEntries: 8, maxCachedBytes: 1024**2, spreadsheetBytes: 16*1024**2 } });
test.after(async () => { await service.dispose(); await artifacts.dispose(); await documents.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
test('six Office formats use real four-source authority and preserve original bytes across preview', async () => {
    const { SessionManager } = await getSdk();
    const session = await store.createSession(project, 'Synthetic Office sources'), cwd = session.cwd, manager = SessionManager.open(session.path);
    const base = manager.appendMessage({ role: 'user', content: 'Synthetic fixture only', timestamp: 1 });
    const branchLocators = [];
    for (const format of ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']) {
        const bytes = format.endsWith('x') ? zip(({ docx: docxFiles, xlsx: xlsxFiles, pptx: pptxFiles })[format]()) : legacy(format), name = 'sample.' + format;
        fs.writeFileSync(path.join(cwd, name), bytes);
        const receipt = await deliveries.objects.publish({ cwd, sessionId: session.id }, { requestId: format, title: 'Synthetic', files: [name] });
        manager.appendCustomEntry(ENTRY, receipt.reference);
        const uploaded = await documents.upload({ cwd, sessionId: session.id, requestId: format, name }, bytes);
        manager.appendMessage({ role: 'user', content: uploaded.marker, timestamp: 2 });
        const saved = await artifacts.library.mutation(c => artifacts.library.save(c, digest(Buffer.from(format)), bytes, { name, kind: 'document' }));
        const locators = [{ type: 'project', cwd, path: name }, { type: 'delivery', cwd, sessionId: session.id, id: receipt.reference.id, index: 0 }, { type: 'artifact', key: saved.id }, { type: 'upload', cwd, sessionId: session.id, id: uploaded.reference.id }];
        for (const source of locators) {
            const original = await sources.read(source); assert.deepEqual(original.bytes, bytes);
            const preview = await service.preview({ source, expectedRevision: digest(bytes) });
            assert.equal(preview.source.name, name); assert.equal(preview.source.revision, digest(bytes));
            assert.equal(preview.preview.kind, ['xls', 'xlsx'].includes(format) ? 'workbook' : 'pdf');
            assert.deepEqual((await sources.read(source)).bytes, bytes);
            assert.ok(!JSON.stringify(preview).includes(agent));
        }
        branchLocators.push(locators[1]);
        await artifacts.library.mutation(async catalog => { catalog.entries.find(e => e.id === saved.id).trashedAt = new Date().toISOString(); await artifacts.library.commit(catalog); });
        await assert.rejects(service.preview({ source: locators[2] }), { code: 'ARTIFACT_TRASHED' });
        const other = await store.createSession(cwd, 'Other draft');
        await assert.rejects(sources.read({ ...locators[3], sessionId: other.id }), { code: 'DOCUMENT_SCOPE' });
        assert.deepEqual(Buffer.from((await files.preview({ cwd, path: name })).base64, 'base64'), bytes);
        assert.deepEqual(Buffer.from((await deliveries.request({ cwd, sessionId: session.id, id: receipt.reference.id, index: 0 })).base64, 'base64'), bytes);
    }
    manager.branch(base); manager.appendMessage({ role: 'user', content: 'Other native branch', timestamp: 3 });
    for (const source of branchLocators) await assert.rejects(service.preview({ source }), { code: 'DELIVERY_SCOPE' });
    await assert.rejects(sources.read({ type: 'project', cwd, path: '../agent/private.docx' }), { code: 'FILE_OUTSIDE' });
    assert.equal(supervisor.getActiveWorker(session.path), null);
});
test('equal-byte path replacement and source worker replacement invalidate an in-flight derived PDF', async () => {
    const { SessionManager } = await getSdk();
    const session = await store.createSession(project, 'Replacement proof'), cwd = session.cwd, manager = SessionManager.open(session.path);
    manager.appendMessage({ role: 'user', content: 'Before', timestamp: 1 });
    const parts = docxFiles(); parts['word/document.xml'] = parts['word/document.xml'].replace('100', 'replacement-fixture');
    const bytes = zip(parts), name = 'identity.docx'; fs.writeFileSync(path.join(cwd, name), bytes);
    const receipt = await deliveries.objects.publish({ cwd, sessionId: session.id }, { requestId: 'identity', title: 'Identity fixture', files: [name] });
    manager.appendCustomEntry(ENTRY, receipt.reference);
    let entered, finish;
    const ready = new Promise(r => entered = r), gate = new Promise(r => finish = r), oldConvert = service.engine.convert;
    service.engine.convert = async () => { entered(); await gate; return { bytes: pdfBytes(), missingFonts: [] }; };
    const source = { type: 'project', cwd, path: name }, pending = service.preview({ source }), rejected = assert.rejects(pending, { code: 'OFFICE_SOURCE_CHANGED' });
    await ready; const replacement = path.join(cwd, 'replacement.tmp'); fs.writeFileSync(replacement, bytes); fs.renameSync(replacement, path.join(cwd, name)); finish();
    await rejected; service.engine.convert = oldConvert;
    assert.deepEqual((await sources.read(source)).bytes, bytes);
    const worker = () => ({ cwd, sessionId: session.id, disposed: false, restarting: false, request: async () => ({ entries: manager.getEntries(), leafId: manager.getLeafId() }) });
    let active = worker(); const getWorker = supervisor.getActiveWorker; supervisor.getActiveWorker = () => active;
    try {
        const locator = { type: 'delivery', cwd, sessionId: session.id, id: receipt.reference.id, index: 0 };
        const first = await sources.read(locator); active = worker(); const second = await sources.read(locator);
        assert.equal(first.revision, second.revision); assert.notEqual(first.proof, second.proof);
        let converted, release;
        const converting = new Promise(r => converted = r), cleanup = new Promise(r => release = r);
        const race = new OfficePreviewService({ sources, limits: service.limits, engine: { generation: 'worker-replacement', status: async () => ({ available: true }), convert: async () => { converted(); await cleanup; return { bytes: pdfBytes() }; }, dispose: async () => {} } });
        const rendering = race.preview({ source: locator }), stale = assert.rejects(rendering, { code: 'OFFICE_SOURCE_CHANGED' });
        await converting; active = worker(); release(); await stale; await race.dispose();
        const raw = await deliveries.request({ cwd, sessionId: session.id, id: receipt.reference.id, index: 0 });
        const json = JSON.stringify(raw); assert.ok(!json.includes('officeProof')); assert.ok(!json.includes('verified file identity'));
    } finally { supervisor.getActiveWorker = getWorker; }
});
test('legacy attachment preview does not grant Agent text parsing or private source editing', async () => {
    const { SessionManager } = await getSdk(), session = await store.createSession(project, 'Legacy read boundary'), cwd = session.cwd, manager = SessionManager.open(session.path);
    manager.appendMessage({ role: 'user', content: 'Legacy fixture', timestamp: 1 });
    const worker = { cwd, sessionId: session.id, disposed: false, restarting: false, request: async () => ({ entries: manager.getEntries(), leafId: manager.getLeafId() }) };
    const reads = new DocumentUploads({ store, supervisor: { removing: new Set(), moving: new Set(), getActiveWorker: () => worker } });
    try {
        for (const format of ['doc', 'xls', 'ppt']) {
            const bytes = legacy(format), uploaded = await documents.upload({ cwd, sessionId: session.id, requestId: 'legacy-' + format, name: 'legacy.' + format }, bytes);
            manager.appendMessage({ role: 'user', content: uploaded.marker, timestamp: 2 });
            await assert.rejects(reads.read(worker, { id: uploaded.reference.id }), { code: 'DOCUMENT_FORMAT' });
            await assert.rejects(reads.read(worker, { id: uploaded.reference.id, action: 'source' }), { code: 'DOCUMENT_FORMAT' });
            assert.deepEqual((await sources.read({ type: 'upload', cwd, sessionId: session.id, id: uploaded.reference.id })).bytes, bytes);
        }
    } finally { await reads.dispose(); }
});
