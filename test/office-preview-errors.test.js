const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express'), http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { createOfficePreviewEngine } = require('../server/office-preview/engine');
const { OfficePreviewService } = require('../server/pi-office-previews');
const { mountOfficePreviews } = require('../server/pi-office-preview-routes');
async function endpoint(t, engine) {
    const bytes = fs.readFileSync(path.join(__dirname,'fixtures/office/rich.docx'));
    const revision = createHash('sha256').update(bytes).digest('hex');
    const service = new OfficePreviewService({engine,sources:{limit:()=>bytes.length,read:async()=>({bytes:Buffer.from(bytes),name:'rich.docx',format:'docx',size:bytes.length,revision,proof:'isolated-verified-source'})}});
    const app = express(); app.use(express.json()); const router = express.Router(); mountOfficePreviews(router,{service}); app.use('/api/pi',router);
    const server = http.createServer(app); server.listen(0,'127.0.0.1'); await once(server,'listening');
    t.after(async()=>{await service.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
    return {service,post:()=>fetch(`http://127.0.0.1:${server.address().port}/api/pi/office/preview`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:{type:'project',cwd:'/isolated',path:'rich.docx'}})})};
}
test('a real native output budget rejection remains HTTP413 OFFICE_LIMIT through the adapter and service', {skip:process.platform!=='win32'||process.arch!=='x64'}, async t=>{
    const engine=createOfficePreviewEngine({limits:{maxOutputBytes:20000}});
    assert.equal((await engine.status()).available,true);
    const api=await endpoint(t,engine), response=await api.post();
    assert.equal(response.status,413);
    assert.equal((await response.json()).code,'OFFICE_LIMIT');
    assert.equal(api.service.busy,false);
});

test('actual kit invalid-document rejection remains a content error rather than engine unavailability', {skip:process.platform!=='win32'||process.arch!=='x64'}, async t=>{
    const engine=createOfficePreviewEngine(); t.after(()=>engine.dispose());
    assert.equal((await engine.status()).available,true);
    await assert.rejects(engine.convert(Buffer.from('not an Office container'),'docx'),{code:'OFFICE_INVALID',status:415});
});

test('the published kit taxonomy survives service and HTTP projection without exposing native text', async t=>{
    const { ConversionError }=await import('@deepseek-ai/libreoffice-kit');
    const { nativeConversionError }=require('../server/office-preview/errors');
    for(const [category,status,code] of [['input-too-large',413,'OFFICE_LIMIT'],['output-too-large',413,'OFFICE_LIMIT'],['invalid-document',415,'OFFICE_INVALID'],['unsupported-format',415,'OFFICE_INVALID'],['invalid-output',415,'OFFICE_INVALID'],['timeout',504,'OFFICE_TIMEOUT'],['unavailable',503,'OFFICE_UNAVAILABLE'],['failed',503,'OFFICE_UNAVAILABLE'],['unknown-runtime-fault',503,'OFFICE_UNAVAILABLE']]) {
        const native=new ConversionError(category,'C:/private/secret.docx native stderr');
        const api=await endpoint(t,{generation:category,status:async()=>({available:true}),convert:async()=>{throw nativeConversionError(native.code);},dispose:async()=>{}});
        const response=await api.post(); assert.equal(response.status,status,category);
        const result=await response.json();assert.equal(result.code,code,category);assert.doesNotMatch(JSON.stringify(result),/private|stderr|secret/);assert.equal(api.service.busy,false);
    }
});
