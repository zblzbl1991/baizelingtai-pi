const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { OfficePreviewService } = require('../server/pi-office-previews');
const config = require('../config/office-preview.json');
const { pdfBytes } = require('./document-fixtures.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const turn = () => new Promise(resolve => setImmediate(resolve));
function gate() { let release; return { promise: new Promise(resolve => release = resolve), release: () => release() }; }
// Public source/engine seams: these tests isolate synchronous reservation and
// cache policies; real containers and native identities are tested separately.
function fixture({ reservation = 1024, shared = false, limits, outputs = {} } = {}) {
    let reads = 0; const calls = [];
    const sources = { limit: () => reservation, read: async source => {
        reads++; const bytes = Buffer.from(shared ? 'same verified input' : source.path);
        return { bytes, name: 'fixture.docx', format: 'docx', size: bytes.length, revision: hash(bytes), proof: source.path };
    } };
    const engine = { generation: 'limits-test', status: async () => ({ available: true }),
        convert: async bytes => { const name = bytes.toString(); calls.push(name); return { bytes: outputs[name] || pdfBytes() }; }, dispose: async () => {} };
    const service = new OfficePreviewService({ sources, engine });
    if (limits) Object.assign(service.limits, limits);
    return { service, sources, engine, calls, get reads() { return reads; }, open: path => service.preview({ source: { type: 'project', path } }) };
}
test('default source-byte budget reserves before reads and releases reservations after delivery', async () => {
    assert.equal(config.conversion.maxSourceBytes, 64 * 1024 ** 2);
    const f = fixture({ reservation: 16 * 1024 ** 2, shared: true }), blocked = gate(), read = f.sources.read;
    f.sources.read = async source => { await blocked.promise; return read(source); };
    const pending = Array.from({ length: 4 }, (_, i) => f.open(String(i)));
    await assert.rejects(f.open('over-byte-budget'), { code: 'OFFICE_BUSY' }); assert.equal(f.reads, 0);
    blocked.release(); await Promise.all(pending); assert.equal(f.calls.length, 1); assert.equal(f.reads, 8);
    await f.open('released'); assert.equal(f.calls.length, 1); await f.service.dispose();
});
test('default sixteen-reader cap includes readers sharing one native conversion', async () => {
    assert.equal(config.conversion.maxReaders, 16);
    const f = fixture({ shared: true }), blocked = gate(), convert = f.engine.convert;
    f.engine.convert = async bytes => { await blocked.promise; return convert(bytes); };
    const pending = Array.from({ length: 16 }, (_, i) => f.open(String(i)));
    await assert.rejects(f.open('seventeenth'), { code: 'OFFICE_BUSY' });
    await turn(); assert.equal(f.reads, 16); blocked.release(); await Promise.all(pending);
    assert.equal(f.calls.length, 1); await f.service.dispose();
});
test('default one-running plus eight-queued boundary rejects the next distinct conversion', async () => {
    assert.equal(config.conversion.maxConcurrent, 1); assert.equal(config.conversion.maxQueued, 8);
    const f = fixture(), blocked = gate(), convert = f.engine.convert;
    f.engine.convert = async bytes => { await blocked.promise; return convert(bytes); };
    const pending = Array.from({ length: 9 }, (_, i) => f.open(String(i))); await turn();
    await assert.rejects(f.open('tenth-distinct'), { code: 'OFFICE_BUSY' });
    pending.push(...Array.from({ length: 7 }, () => f.open('0'))); await turn();
    await assert.rejects(f.open('seventeenth-even-when-shared'), { code: 'OFFICE_BUSY' });
    blocked.release(); await Promise.all(pending); assert.equal(f.calls.length, 9); await f.service.dispose();
});
test('entry-bounded cache evicts the least recently used conversion', async () => {
    assert.equal(config.conversion.maxCachedEntries, 8);
    const f = fixture({ limits: { maxCachedEntries: 2 } });
    for (const name of ['A', 'B', 'A', 'C', 'A']) await f.open(name);
    assert.deepEqual(f.calls, ['A', 'B', 'C']); await f.open('B'); assert.deepEqual(f.calls, ['A', 'B', 'C', 'B']);
    await f.service.dispose();
});
test('byte-bounded cache accepts exact fits, evicts LRU, and never caches individually oversized PDFs', async () => {
    assert.equal(config.conversion.maxCachedBytes, 64 * 1024 ** 2);
    const pdf = pdfBytes(), larger = Buffer.concat([pdf, Buffer.from('\n% extra bounded PDF comment')]);
    const f = fixture({ limits: { maxCachedBytes: pdf.length * 2, maxCachedEntries: 8 }, outputs: { large: Buffer.concat([larger, larger]) } });
    for (const name of ['A', 'B', 'A', 'C', 'A']) await f.open(name);
    assert.deepEqual(f.calls, ['A', 'B', 'C']); await f.open('B'); assert.deepEqual(f.calls, ['A', 'B', 'C', 'B']);
    await f.open('large'); await f.open('large'); assert.equal(f.calls.filter(name => name === 'large').length, 2);
    await f.service.dispose();
});
