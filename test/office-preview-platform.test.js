const test = require('node:test');
const assert = require('node:assert/strict');
const { preflightOfficePreview } = require('../server/office-preview/preflight');

test('strict candidate preflight degrades undeclared native platforms without requiring Windows components', async () => {
    for (const target of [{platform:'linux',arch:'x64'},{platform:'darwin',arch:'arm64'},{platform:'darwin',arch:'x64'},{platform:'win32',arch:'arm64'}]) {
        const status = await preflightOfficePreview({root:__dirname,requireAvailable:true,target});
        assert.equal(status.available,false);
        assert.equal(status.code,'office_unsupported');
        assert.equal(status.platform,`${target.platform}-${target.arch}`);
        assert.match(status.message,/unsupported/);
        assert.doesNotMatch(status.message,/Visual C\+\+|vc_redist/);
    }
});

test('the install entry preserves platform applicability when strict candidates are prepared', async () => {
    const { install } = require('../scripts/install-office-preview.cjs');
    const status = await install({requireAvailable:true,target:{platform:'linux',arch:'x64'}});
    assert.equal(status.available,false);
    assert.equal(status.code,'office_unsupported');
});

test('declared native candidates retain strict unhealthy rejection and valid platform targets cannot override support', async () => {
    await assert.rejects(preflightOfficePreview({root:__dirname,requireAvailable:true,target:{platform:'win32',arch:'x64'}}), error => ['office_unavailable','office_unsupported'].includes(error.code));
    await assert.rejects(preflightOfficePreview({requireAvailable:true,target:{platform:'linux',arch:'x64',supported:true}}), /Invalid Office preview platform target/);
});

test('the actual declared Windows x64 runtime still passes strict native candidate health', {skip:process.platform !== 'win32' || process.arch !== 'x64'}, async () => {
    const status = await preflightOfficePreview({requireAvailable:true});
    assert.equal(status.available,true);
    assert.equal(status.platform,'win32-x64');
    assert.equal(status.version,'0.1.1');
});
