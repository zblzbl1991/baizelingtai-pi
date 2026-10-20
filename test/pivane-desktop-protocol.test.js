const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ManagedLauncher } = require('../server/pi-managed-launcher');
const { PassThrough } = require('node:stream');
const { desktopStartupTimeout, listenForDesktopCommands } = require('../server/pivane-desktop-launcher');

test('controlled pipe accepts only bounded LF commands for its current service generation', async () => {
    const input = new PassThrough(), commands = []; let lost = 0;
    listenForDesktopCommands(input, 'current', command => commands.push(command), () => { lost++; });
    input.write('{"type":"stop","generation":"old","id":"one"}\n');
    input.write('{"type":"snapshot","generation":"current","id":"t');
    input.write('wo"}\n');
    input.write('x'.repeat(9000)); input.write('{"type":"stop","generation":"current","id":"three"}\n');
    input.write('{"type":"review-stop","generation":"current","id":"four"}\n');
    assert.deepEqual(commands.map(command => command.id), ['two', 'four']);
    input.end(); await new Promise(resolve => input.once('end', resolve)); assert.equal(lost, 1);
});

test('desktop startup budget defaults to three minutes and rejects invalid or unbounded values', () => {
    assert.equal(desktopStartupTimeout({}), 180000);
    assert.equal(desktopStartupTimeout({ PIVANE_DESKTOP_START_TIMEOUT_MS: '300000' }), 300000);
    for (const value of ['0', '-1', 'Infinity', '1000', '900001', '1.5', '1e5'])
        assert.throws(() => desktopStartupTimeout({ PIVANE_DESKTOP_START_TIMEOUT_MS: value }), /10000 to 900000/);
});

test('desktop boot waits past the legacy budget and timeout requests cleanup without declaring exit', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-desktop-budget-'));
    t.after(() => fs.rmSync(root, { force: true, recursive: true }));
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.0.0"}');
    const child = new EventEmitter(), sent = [];
    Object.assign(child, { connected: true, exitCode: null, signalCode: null, send: (message, callback) => { sent.push(message); callback?.(); } });
    const launcher = new ManagedLauncher({ root, env: {}, startupTimeoutMs: 180000, forkServer: () => child });
    const boot = launcher.boot(null);
    const rejected = assert.rejects(boot, /startup timed out/);
    t.mock.timers.tick(45000); assert.equal(sent.length, 0);
    t.mock.timers.tick(135000); await rejected;
    assert.equal(sent[0].type, 'maintenance-shutdown');
    const closing = launcher.close(); let closed = false; closing.then(() => { closed = true; });
    await Promise.resolve(); await Promise.resolve(); assert.equal(closed, false);
    child.exitCode = 0; child.emit('exit', 0); await closing;
});

test('managed desktop IPC binds responses to the actual child, nonce and request, and rejects transport uncertainty', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-desktop-ipc-'));
    t.after(() => fs.rmSync(root, { force: true, recursive: true }));
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.0.0"}');
    const child = new EventEmitter(), sent = [];
    Object.assign(child, { connected: true, exitCode: null, signalCode: null,
        send: (message, callback) => { sent.push(message); callback?.(); } });
    const launcher = new ManagedLauncher({ root, env: {}, forkServer: () => child });
    const boot = launcher.boot(null);
    child.emit('message', { type: 'maintenance-ready', nonce: launcher.nonce, port: 12345 });
    await boot;
    const pending = launcher.desktopRequest('snapshot');
    const request = sent.find(message => message.type === 'desktop-request');
    assert.ok(request);
    let settled = false; pending.finally(() => { settled = true; });
    child.emit('message', { type: 'desktop-response', nonce: 'other', id: request.id, result: { complete: true } });
    child.emit('message', { type: 'desktop-response', nonce: launcher.nonce, id: 'old', result: { complete: true } });
    await Promise.resolve(); assert.equal(settled, false);
    child.emit('message', { type: 'desktop-response', nonce: launcher.nonce, id: request.id, result: { complete: true, revision: 'one' } });
    assert.deepEqual(await pending, { complete: true, revision: 'one' });
    const lost = launcher.desktopRequest('execute', { ticket: 'confirmed' });
    child.emit('disconnect');
    await assert.rejects(lost, error => error.code === 'DESKTOP_TRANSPORT_UNKNOWN');
    assert.equal(sent.filter(message => message.type === 'desktop-request').length, 2, 'uncertain execution is never replayed');
    launcher.closed = true; child.exitCode = 0; child.emit('exit', 0);
});

test('desktop cleanup requires the owned child acknowledgement and actual clean exit', async t => {
    for (const proof of ['none', 'wrong', 'valid']) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-desktop-proof-'));
        t.after(() => fs.rmSync(root, { force: true, recursive: true }));
        fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.0.0"}');
        const child = new EventEmitter();
        Object.assign(child, { connected: true, exitCode: null, signalCode: null, send: (_message, callback) => callback?.() });
        const launcher = new ManagedLauncher({ root, env: {}, requireShutdownProof: true, forkServer: () => child });
        const boot = launcher.boot(null);
        child.emit('message', { type: 'maintenance-ready', nonce: launcher.nonce, port: 12345, capabilities: { shutdownProof: true } }); await boot;
        let released = false; launcher.guard = { close: async () => { released = true; } };
        const closing = launcher.close(); const outcome = closing.then(() => 'clean', () => 'unknown');
        await new Promise(resolve => setImmediate(resolve));
        if (proof !== 'none') child.emit('message', { type: 'maintenance-shutdown-complete', nonce: proof === 'valid' ? launcher.nonce : 'foreign' });
        assert.equal(released, false, 'ack alone cannot release the service ownership guard');
        child.exitCode = 0; child.emit('exit', 0);
        assert.equal(await outcome, proof === 'valid' ? 'clean' : 'unknown');
        assert.equal(released, proof === 'valid');
    }
});

test('desktop refuses an older service without cleanup proof capability', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-desktop-legacy-'));
    t.after(() => fs.rmSync(root, { force: true, recursive: true }));
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.0.0"}');
    const child = new EventEmitter();
    Object.assign(child, { connected: true, exitCode: null, signalCode: null, send: (_message, callback) => callback?.() });
    const launcher = new ManagedLauncher({ root, env: {}, requireShutdownProof: true, forkServer: () => child });
    const boot = launcher.boot(null);
    child.emit('message', { type: 'maintenance-ready', nonce: launcher.nonce, port: 12345 });
    await assert.rejects(boot, /does not support verified desktop cleanup/);
    launcher.closed=true; child.exitCode=0; child.emit('exit',0);
});

test('startup timeout registers the cleanup request before an early completion acknowledgement', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pivane-timeout-proof-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.writeFileSync(path.join(root,'package.json'),'{"version":"1.0.0"}');
    const child=new EventEmitter(); Object.assign(child,{connected:true,exitCode:null,signalCode:null,send:(_message,callback)=>callback?.()});
    const launcher=new ManagedLauncher({root,env:{},startupTimeoutMs:10000,requireShutdownProof:true,forkServer:()=>child});
    const rejected=assert.rejects(launcher.boot(null),/timed out/);
    t.mock.timers.tick(10000);await rejected;
    child.emit('message',{type:'maintenance-shutdown-complete',nonce:launcher.nonce});
    child.exitCode=0;child.emit('exit',0);
    await launcher.close();
});

test('private candidate data validation uses its remaining budget while ordinary control keeps fifteen seconds', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pivane-validation-budget-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.writeFileSync(path.join(root,'package.json'),'{"version":"1.0.0"}');
    const child=new EventEmitter(), sent=[];
    Object.assign(child,{connected:true,exitCode:null,signalCode:null,send:(message,callback)=>{sent.push(message);callback?.();}});
    const launcher=new ManagedLauncher({root,env:{},forkServer:()=>child});
    const boot=launcher.boot(null); child.emit('message',{type:'maintenance-ready',nonce:launcher.nonce,port:12345}); await boot;
    const validation=launcher.desktopRequest('validate',{activationId:'candidate'},{timeoutMs:60000});
    let validationSettled=false; validation.then(()=>{validationSettled=true;},()=>{validationSettled=true;});
    const snapshot=assert.rejects(launcher.desktopRequest('snapshot'),error=>error.code==='DESKTOP_TRANSPORT_UNKNOWN');
    t.mock.timers.tick(15000); await snapshot;
    assert.equal(validationSettled,false,'original data reads may use the remaining activation budget');
    const request=sent.find(message=>message.method==='validate');
    child.emit('message',{type:'desktop-response',nonce:launcher.nonce,id:request.id,result:{data:true}});
    assert.deepEqual(await validation,{data:true});
    launcher.closed=true;child.exitCode=0;child.emit('exit',0);
});
