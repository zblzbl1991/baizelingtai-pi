const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
function setup(api) {
    const node = () => ({ children: [], append(...values) { this.children.push(...values); }, remove() { this.removed = true; }, setAttribute() {}, addEventListener() {}, replaceChildren(...values) { this.children = values; } });
    const rendered = [], context = { document: { createElement: node }, AbortController, Uint8Array, atob, setInterval, clearInterval,
        PiI18n: { locale: 'en' }, PiFilePreviews: { render(body, data, options) { rendered.push({ data, bytes: options.bytes() }); return () => {}; } } };
    context.window = context; vm.runInNewContext(fs.readFileSync(require.resolve('../public/pi-office-file-preview.js'), 'utf8'), context);
    return { ui: context.PiOfficeFilePreview, body: node(), rendered, api };
}
test('Office bridge renders derived PDF separately and refreshes the authorized source', async () => {
    const calls = [], original = { source: { type: 'project', cwd: '/project', path: 'report.docx' }, name: 'report.docx', revision: 'a'.repeat(64) };
    const { ui, body, rendered } = setup();
    const close = ui.render(body, original, { state: {}, refresh: true, api: async (url, options) => { calls.push({ url, options }); return { source: { format: 'docx', revision: original.revision }, preview: { kind: 'pdf', mime: 'application/pdf', encoding: 'base64', base64: btoa('%PDF-derived'), size: 12 }, warnings: [] }; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.supports('X.DOC'), true); assert.equal(ui.supports('x.csv'), false);
    assert.equal(calls[0].url, '/api/pi/office/preview'); assert.equal(JSON.parse(calls[0].options.body).refresh, true);
    assert.deepEqual(JSON.parse(calls[0].options.body).source, original.source);
    assert.equal(Buffer.from(rendered[0].bytes).toString(), '%PDF-derived'); assert.equal(original.base64, undefined); close();
});
test('closed or replaced Office readers abort their request and reject late results', async () => {
    const { ui, body, rendered } = setup(); let release, request, active = true;
    const close = ui.render(body, { source: { type: 'artifact', key: 'a'.repeat(64) }, name: 'report.ppt' }, {
        isCurrent: () => active, api: async (_, options) => { request = options; return new Promise(resolve => { release = resolve; }); }
    });
    await new Promise(resolve => setImmediate(resolve)); active = false; close();
    assert.equal(request.signal.aborted, true);
    release({ source: { format: 'ppt' }, preview: { kind: 'pdf', encoding: 'base64', base64: btoa('%PDF-derived'), size: 12 } });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(rendered.length, 0); assert.equal(body.children[0].removed, true);
});
