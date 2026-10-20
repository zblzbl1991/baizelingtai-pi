const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { transactionFixture } = require('./launcher-activation-fixture.cjs');
const { atomicJson, hash } = require('../server/pi-maintenance-files');
const { prepareActivation, inspectActivation } = require('../server/pi-launcher-activation');
const { createTrayLink, validateDesktop } = require('../server/pivane-desktop-update');
const { ManagedLauncher } = require('../server/pi-managed-launcher');

// Real child, HTTP and nonce IPC; external tray is a synthetic protocol peer.
// The fixture is a signed pre-staged validation transaction, not an exact ZIP
// upgrade or a claim that the synthetic native entry can run on Windows.
test('five startup proofs and stable observation commit before the candidate opens business', { timeout: 45000 }, async t => {
    const input = transactionFixture(t), version = require('../package.json').version;
    const write = (name, value) => { const file = path.join(input.candidate, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
    write('package.json', JSON.stringify({ name: 'pivane', version }));
    write('package-lock.json', JSON.stringify({ version }));
    write('node_modules/@earendil-works/pi-coding-agent/package.json', '{"version":"0.85.1"}');
    write('scripts/desktop-tray.ps1', '# synthetic external tray protocol peer');
    const build = JSON.parse(fs.readFileSync(path.join(input.candidate, 'native/pivane-desktop-launcher-build.json')));
    build.appVersion = version; write('native/pivane-desktop-launcher-build.json', JSON.stringify(build));
    write('server.js', `
        const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),nonce=process.env.PI_MANAGED_LAUNCHER;
        let active=false;const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');
            if(req.url==='/api/access/status')return res.end('{"authenticated":false}');res.statusCode=active?200:503;res.end('{}');});
        server.listen(0,'127.0.0.1',()=>process.send({type:'maintenance-ready',nonce,port:server.address().port,
            healthUrl:'http://127.0.0.1:'+server.address().port+'/api/access/status',appVersion:require('./package.json').version,
            engineVersion:'0.85.1',capabilities:{shutdownProof:true,validationProof:true}}));
        process.on('message',message=>{if(message.nonce!==nonce)return;
            if(message.type==='maintenance-activate')active=true;
            if(message.type==='desktop-request')process.send({type:'desktop-response',nonce,id:message.id,result:message.method==='validate'?
                {activationId:message.input.activationId,control:true,data:fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'value.txt'),'utf8')==='before update',appVersion:require('./package.json').version,engineVersion:'0.85.1'}:{active}});
            if(message.type==='maintenance-shutdown')server.close(()=>process.send({type:'maintenance-shutdown-complete',nonce},()=>process.exit(0)));
        });
    `);
    const files = [];
    function inventory(relative = '') { for (const entry of fs.readdirSync(path.join(input.candidate, relative), { withFileTypes: true })) {
        const name = relative ? relative + '/' + entry.name : entry.name;
        if (entry.isDirectory()) inventory(name);
        else if (!['PI_INSTALL_COMPLETE.json', 'PORTABLE_MANIFEST.json'].includes(name)) { const bytes=fs.readFileSync(path.join(input.candidate,name)); files.push({path:name,bytes:bytes.length,sha256:hash(bytes)}); }
    } }
    inventory();
    write('PORTABLE_MANIFEST.json', JSON.stringify({ version: 1, platform: 'win32', arch: 'x64', appVersion: version, files }));
    write('PI_INSTALL_COMPLETE.json', JSON.stringify({ version: '0.85.1', appVersion: version, archiveSha256: 'a'.repeat(64), lockSha256: hash(fs.readFileSync(path.join(input.candidate, 'package-lock.json'))) }));
    const sign = require('./update-signature-helper.cjs').signer(input.root);
    input.release.version = version; input.release.signedManifest = sign({ ...input.release.signedManifest, version, signature: undefined });
    // Match the real extractor's protected candidate directory before taking
    // immutable identity evidence; inherited fixture ACLs are not that boundary.
    require('../server/pi-maintenance-files').privateDir(input.candidate);
    input.state.activation = prepareActivation(input);
    input.state.activation.phase = 'validating'; input.state.active = input.releaseId;
    atomicJson(path.join(input.root, '.pivane-runtime/state.json'), input.state);
    const launcher = new ManagedLauncher({ root: input.root, programRoot: input.candidate, env: { SystemRoot: process.env.SystemRoot }, requireShutdownProof: true });
    try {
    await launcher.start();
    const url = `http://127.0.0.1:${launcher.env.PORT}/`;
    assert.equal((await fetch(url)).status, 503);
    const evidence = { programRoot: input.candidate, nativePath: path.join(input.candidate, '白泽灵台.exe'), nativeVersion: version + '.0', nativeSha256: build.binarySha256,
        traySha256: hash(fs.readFileSync(path.join(input.candidate, 'scripts/desktop-tray.ps1'))), nodePath: process.execPath,
        processes: [{ pid: process.pid, creationTime: '134054000000000000' }, { pid: process.ppid, creationTime: '134053000000000000' }] };
    let link;
    link = createTrayLink({ programRoot: input.candidate, emit: command => link.receive({ ...evidence, type: 'tray-validated', challenge: command.challenge }) });
    link.receive({ ...evidence, type: 'tray-attached' });
    const began = Date.now();
    await validateDesktop({ launcher, link, url, fetcher: fetch, deadline: Date.now() + 30000 });
    assert.ok(Date.now() - began >= 15000, 'stable observation is real elapsed time');
    assert.equal(inspectActivation(input.root, input.state.activation.id).phase, 'committed');
    assert.equal((await launcher.desktopRequest('snapshot')).active, true);
    assert.equal((await fetch(url)).status, 200);
    fs.writeFileSync(path.join(input.root, 'data/value.txt'), 'new business data');
    await assert.rejects(launcher.rollbackValidation(), /not pending/);
    assert.equal(fs.readFileSync(path.join(input.root, 'data/value.txt'), 'utf8'), 'new business data');
    assert.equal((await fetch(url)).status, 200, 'a committed instance remains available after a refused automatic rollback');
    } finally { await launcher.close(); }
});

test('failed candidate cleanup records a new generation proof without restoring data before outer exit', { timeout: 30000 }, async t => {
    const input = transactionFixture(t);
    const file = path.join(input.candidate, 'server.js');
    fs.writeFileSync(file, `const nonce=process.env.PI_MANAGED_LAUNCHER;
        process.on('message',message=>{if(message.nonce===nonce&&message.type==='maintenance-shutdown')
            process.send({type:'maintenance-shutdown-complete',nonce},()=>process.exit(0));});
        process.send({type:'maintenance-ready',nonce,port:12345,appVersion:'1.9.0',capabilities:{shutdownProof:true}});`);
    const manifestFile = path.join(input.candidate, 'PORTABLE_MANIFEST.json'), manifest = JSON.parse(fs.readFileSync(manifestFile));
    const entry = manifest.files.find(item => item.path === 'server.js'), bytes = fs.readFileSync(file); entry.bytes = bytes.length; entry.sha256 = hash(bytes);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    require('../server/pi-maintenance-files').privateDir(input.candidate);
    input.state.activation = prepareActivation(input); input.state.activation.phase = 'validating'; input.state.active = input.releaseId;
    atomicJson(path.join(input.root, '.pivane-runtime/state.json'), input.state);
    const launcher = new ManagedLauncher({ root: input.root, programRoot: input.candidate, env: { SystemRoot: process.env.SystemRoot }, requireShutdownProof: true });
    try {
        await launcher.start();
        fs.writeFileSync(path.join(input.root, 'data/value.txt'), 'failed candidate writes');
        const intent = await launcher.rollbackValidation();
        assert.equal(intent.mode, 'rollback');
        const activation = inspectActivation(input.root, intent.id);
        assert.equal(activation.failureShutdownProof.complete, true);
        assert.equal(activation.failureShutdownProof.activationId, intent.id);
        assert.equal(activation.failureShutdownProof.releaseId, input.releaseId);
        assert.notEqual(activation.failureShutdownProof.generation, activation.shutdownProof.generation);
        assert.equal(activation.phase, 'validating', 'only the independent helper may restore after full outer exit');
        assert.equal(fs.readFileSync(path.join(input.root, 'data/value.txt'), 'utf8'), 'failed candidate writes');
        await new Promise(resolve => setImmediate(resolve));
        let duplicate;
        try { duplicate = await require('../server/pi-installation-lock').acquireInstallationLock(input.root); }
        catch (error) { assert.match(error.message, /EADDRINUSE|address already in use/); }
        finally { await duplicate?.close(); }
        assert.equal(duplicate, undefined, 'candidate runner retains the original installation lock while preparing outer handoff');
    } finally { await launcher.close(); }
});
