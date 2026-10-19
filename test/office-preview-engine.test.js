const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficePreviewEngine } = require('../server/office-preview/engine');
test('Office engine stays constructible and explains a missing installation', async () => {
    const engine = createOfficePreviewEngine({ root: __dirname });
    assert.equal(typeof engine.generation, 'string');
    const status = await engine.status();
    assert.equal(status.available, false);
    assert.ok(['office_unavailable', 'office_unsupported'].includes(status.code));
    await assert.rejects(engine.convert(Buffer.from('source'), 'docx'), { code: status.code });
    await engine.dispose();
});

test('native health refresh is reserved before awaiting and disposal prevents a late conversion', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
    const engine = createOfficePreviewEngine();
    const checking = engine.status();
    const refresh = await engine.status({refresh:true});
    assert.equal(refresh.code, 'office_busy');
    const conversion = engine.convert(Buffer.from('invalid'), 'docx');
    const stopped = engine.dispose();
    await assert.rejects(conversion, error => ['office_cancelled','office_unavailable'].includes(error.code));
    await stopped;
    assert.equal((await checking).available, false);
    assert.equal((await engine.status()).available, false);
});

test('installation can report degraded Office while update preflight refuses that candidate', async () => {
    const { preflightOfficePreview } = require('../server/office-preview/preflight');
    assert.equal((await preflightOfficePreview({root:__dirname})).available, false);
    await assert.rejects(preflightOfficePreview({root:__dirname, requireAvailable:true, target:{platform:'win32',arch:'x64'}}), error => ['office_unavailable','office_unsupported'].includes(error.code));
});
