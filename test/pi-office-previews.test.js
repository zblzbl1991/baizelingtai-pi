const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { OfficePreviewService } = require('../server/pi-office-previews');
const { zip, docxFiles, xlsxFiles, pdfBytes } = require('./document-fixtures.cjs');
const hash = b => createHash('sha256').update(b).digest('hex');
const bytes = zip(docxFiles());
function fixture(options = {}) {
    let reads = 0, calls = 0;
    const sources = { limit: () => bytes.length, read: async source => { reads++; return { bytes, name: 'sample.docx', format: 'docx', size: bytes.length, revision: hash(bytes), proof: source.path }; } };
    const engine = { generation: 'synthetic-v1', status: () => ({ available: true }), convert: async () => { calls++; return { bytes: pdfBytes(), missingFonts: ['Synthetic Missing Font'] }; }, dispose: async () => {} };
    const service = new OfficePreviewService({ sources, engine, limits: {maxReaders:16,maxSourceBytes:64*1024**2,maxConcurrent:1,maxQueued:8,queueTimeoutMs:1000,timeoutMs:1000,maxOutputBytes:1024**2,maxCachedEntries:8,maxCachedBytes:1024**2,spreadsheetBytes:16*1024**2}, ...options });
    return { service, sources, engine, get reads() { return reads; }, get calls() { return calls; } };
}
test('a derived PDF has a separate identity, retains original source bytes and reauthorizes cache hits', async () => {
    const f = fixture(), source = { type: 'project', cwd: '/fixture', path: 'sample.docx' };
    try {
        const first = await f.service.preview({ source, expectedRevision: hash(bytes) });
        assert.equal(first.source.revision, hash(bytes)); assert.equal(first.preview.kind, 'pdf');
        assert.notEqual(first.preview.revision, first.source.revision);
        assert.deepEqual(Buffer.from(first.preview.base64, 'base64'), pdfBytes());
        assert.ok(first.warnings.some(w => w.includes('Synthetic Missing Font')));
        await f.service.preview({ source }); assert.equal(f.calls, 1); assert.equal(f.reads, 4);
        f.sources.read = async () => { throw Object.assign(new Error('revoked'), { status: 403 }); };
        await assert.rejects(f.service.preview({ source }), { status: 403 });
    } finally { await f.service.dispose(); }
});
test('sources changed during conversion never deliver a stale derived PDF', async () => {
    const f = fixture(); let finish, entered;
    const ready = new Promise(r => entered = r), gate = new Promise(r => finish = r);
    f.engine.convert = async () => { entered(); await gate; return { bytes: pdfBytes(), missingFonts: [] }; };
    const pending = f.service.preview({ source: { type: 'project', path: 'before.docx' } });
    await ready; f.sources.read = async () => ({ bytes, name: 'sample.docx', format: 'docx', size: bytes.length, revision: hash(bytes), proof: 'changed' }); finish();
    await assert.rejects(pending, { code: 'OFFICE_SOURCE_CHANGED' }); await f.service.dispose();
});
test('shared readers cancel independently and the last cancellation remains busy through native cleanup', async () => {
    const f = fixture(); let complete, entered; let signal;
    const ready = new Promise(r => entered = r), cleanup = new Promise(r => complete = r);
    f.engine.convert = async (_bytes, _format, options) => { signal = options.signal; entered(); await cleanup; return { bytes: pdfBytes(), missingFonts: [] }; };
    const a = new AbortController(), b = new AbortController(), source = { type: 'project', path: 'same.docx' };
    const first = f.service.preview({ source }, a.signal), second = f.service.preview({ source }, b.signal);
    const firstRejected = assert.rejects(first, { code: 'OFFICE_ABORTED' }), secondRejected = assert.rejects(second, { code: 'OFFICE_ABORTED' });
    await ready; await new Promise(r => setImmediate(r)); a.abort(); assert.equal(signal.aborted, false);
    b.abort(); assert.equal(signal.aborted, true); assert.equal(f.service.busy, true);
    let disposed = false; const stopping = f.service.dispose().then(() => disposed = true);
    await new Promise(r => setImmediate(r)); assert.equal(disposed, false); complete();
    await Promise.all([firstRejected, secondRejected, stopping]); assert.equal(f.service.busy, false);
});
test('readers and byte reservations reject excess requests synchronously before source reads', async () => {
    const f = fixture(); f.service.limits.maxReaders = 1; let complete, entered;
    const ready = new Promise(r => entered = r), gate = new Promise(r => complete = r);
    const originalRead = f.sources.read; f.sources.read = async source => { entered(); await gate; return originalRead(source); };
    const first = f.service.preview({ source: { type: 'project' } });
    await assert.rejects(f.service.preview({ source: { type: 'project' } }), { code: 'OFFICE_BUSY' });
    await ready; complete(); await first; await f.service.dispose();
});
test('conversion timeout waits for real cleanup and permits a fresh request only afterward', async () => {
    const f = fixture(); f.service.limits.timeoutMs = 5; let complete, entered, signal;
    const ready = new Promise(r => entered = r), gate = new Promise(r => complete = r);
    f.engine.convert = async (_b, _f, opts) => { signal = opts.signal; entered(); await gate; return { bytes: pdfBytes() }; };
    const pending = f.service.preview({ source: { type: 'project' } }), rejected = assert.rejects(pending, { code: 'OFFICE_TIMEOUT' });
    await ready; await new Promise(r => signal.addEventListener('abort', r, { once: true })); assert.equal(f.service.busy, true);
    complete(); await rejected; assert.equal(f.service.busy, false); await f.service.dispose();
});
test('refresh reserves exclusive admission before await, clears prior generation cache and retains busy until status completes', async () => {
    const f = fixture(), source = { type: 'project', path: 'same.docx' };
    await f.service.preview({ source }); let finish, entered;
    const ready = new Promise(r => entered = r), gate = new Promise(r => finish = r);
    f.engine.status = async options => { if (options?.refresh) { entered(); await gate; f.engine.generation = 'synthetic-v2'; } return { available: true }; };
    const refresh = f.service.preview({ source, refresh: true });
    const rejected = assert.rejects(f.service.preview({ source }), { code: 'OFFICE_BUSY' });
    await ready; assert.equal(f.service.busy, true); finish(); await Promise.all([refresh, rejected]);
    assert.equal(f.calls, 2); await f.service.preview({ source }); assert.equal(f.calls, 2); await f.service.dispose();
});
test('queue limits and queue timeout do not release a running conversion before cleanup', async () => {
    const f = fixture(); f.service.limits.maxQueued = 1; f.service.limits.queueTimeoutMs = 5;
    f.sources.read = async source => ({ bytes: Buffer.from(source.path), name: 'sample.docx', format: 'docx', size: source.path.length, revision: hash(source.path), proof: source.path });
    let entered, release; const ready = new Promise(r => entered = r), gate = new Promise(r => release = r);
    f.engine.convert = async () => { entered(); await gate; return { bytes: pdfBytes() }; };
    const first = f.service.preview({ source: { type: 'project', path: 'first' } }); await ready;
    const second = f.service.preview({ source: { type: 'project', path: 'second' } }), timedOut = assert.rejects(second, { code: 'OFFICE_TIMEOUT' });
    await new Promise(r => setImmediate(r));
    await assert.rejects(f.service.preview({ source: { type: 'project', path: 'third' } }), { code: 'OFFICE_BUSY' });
    await timedOut; assert.equal(f.service.busy, true); release(); await first; await f.service.dispose();
});
test('failed and oversized conversions never become cache hits and workbook reads do not require the PDF engine', async () => {
    const f = fixture(), source = { type: 'project', path: 'failure' }; let attempts = 0;
    f.engine.convert = async () => { attempts++; throw new Error('synthetic conversion failure'); };
    await assert.rejects(f.service.preview({ source })); await assert.rejects(f.service.preview({ source })); assert.equal(attempts, 2);
    f.engine.convert = async () => ({ bytes: Buffer.alloc(f.service.limits.maxOutputBytes + 1) });
    await assert.rejects(f.service.preview({ source }), { code: 'OFFICE_LIMIT' });
    const workbook = zip(xlsxFiles()); f.sources.read = async () => ({ bytes: workbook, size: workbook.length, format: 'xlsx', name: 'fixture.xlsx', revision: hash(workbook), proof: 'workbook' });
    f.engine.status = async () => { throw new Error('must not require a PDF converter'); };
    const result = await f.service.preview({ source }); assert.equal(result.preview.kind, 'workbook'); assert.deepEqual(Buffer.from(result.preview.base64, 'base64'), workbook);
    f.service.limits.spreadsheetBytes = 1; await assert.rejects(f.service.preview({ source }), { code: 'OFFICE_LIMIT' }); await f.service.dispose();
});
test('shutdown remains busy through engine disposal and does not admit new readers', async () => {
    const f = fixture(); let complete, entered;
    const ready = new Promise(r => entered = r), gate = new Promise(r => complete = r);
    f.engine.dispose = async () => { entered(); await gate; };
    const stopping = f.service.dispose(); await ready;
    const wasBusy = f.service.busy; complete(); await stopping;
    assert.equal(wasBusy, true); assert.equal(f.service.busy, false);
    await assert.rejects(f.service.preview({ source: { type: 'project' } }), { code: 'OFFICE_UNAVAILABLE' });
});
test('shutdown forwards cancellation to an initial engine health probe before joining it', async () => {
    const f = fixture(); let entered, complete, disposalForwarded = false;
    const ready = new Promise(r => entered = r), health = new Promise(r => complete = r);
    f.engine.status = async () => { entered(); return health; };
    f.engine.dispose = async () => { disposalForwarded = true; complete({ available: false }); };
    const probing = f.service.status(); await ready; const stopping = f.service.dispose();
    const forwardedBeforeJoin = disposalForwarded; complete({ available: false });
    await Promise.all([probing, stopping]); assert.equal(forwardedBeforeJoin, true);
});
test('failed engine shutdown propagates the failure and retains busy shutdown state', async () => {
    const f = fixture(), failure = new Error('synthetic native cleanup failure');
    f.engine.dispose = async () => { throw failure; };
    await assert.rejects(f.service.dispose(), failure);
    assert.equal(f.service.busy, true);
    assert.notEqual(f.service.disposed, true);
    await assert.rejects(f.service.preview({ source: { type: 'project' } }), { code: 'OFFICE_UNAVAILABLE' });
});
