const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { prepareDesktopRestart, listenForStop } = require('../server/pivane-desktop-launcher');
const { createApplication } = require('./desktop-launcher-fixture.cjs');

test('restart control is LF framed; private IPC ignores unknown replies and keeps a slow request occupied', async () => {
    const input = new PassThrough(); let restarts = 0;
    listenForStop(input, () => {}, () => { restarts++; });
    input.write('{"type":"res'); input.write('tart"}\n{"type":"unknown"}\n'); assert.equal(restarts, 1);
    const child = new EventEmitter(); child.connected = true;
    let sent, waiting = 0;
    child.send = (message, callback) => { sent = message; callback(); };
    const launcher = { child, nonce: 'fixture-nonce' };
    let complete = false;
    await assert.rejects(prepareDesktopRestart(launcher), /当前运行版本不支持/);
    assert.equal(sent, undefined);
    const pending = prepareDesktopRestart(launcher, { supported: true, timeoutMs: 5, onWaiting: () => { waiting++; } }).then(() => { complete = true; });
    child.emit('message', { type: 'desktop-restart-result', nonce: 'foreign', id: sent.id, accepted: true });
    child.emit('message', { type: 'desktop-restart-result', nonce: launcher.nonce, id: 'foreign', accepted: true });
    await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(waiting, 1); assert.equal(complete, false);
    child.emit('message', { type: 'desktop-restart-result', nonce: launcher.nonce, id: sent.id, accepted: true });
    await pending; assert.equal(complete, true); assert.equal(child.listenerCount('message'), 0);
    const denied = prepareDesktopRestart(launcher, { supported: true });
    child.emit('message', { type: 'desktop-restart-result', nonce: launcher.nonce, id: sent.id, accepted: false, message: 'busy fixture' });
    await assert.rejects(denied, /busy fixture/);
    const disconnected = prepareDesktopRestart(launcher, { supported: true }); child.emit('disconnect');
    await assert.rejects(disconnected, /连接已断开/);
    assert.equal(child.listenerCount('message'), 0);
    child.send = () => { throw Error('synthetic send failure'); };
    await assert.rejects(prepareDesktopRestart(launcher, { supported: true }), /synthetic send failure/);
    assert.equal(child.listenerCount('message'), 0);
});

async function until(predicate, description, timeout = 45000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const result = predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw Error('Timed out: ' + description);
}
function readySnapshot(file) {
    // The native smoke reporter writes this observation file in place. A poll
    // can land between truncation and the completed write during a restart.
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError || ['ENOENT', 'EACCES', 'EBUSY'].includes(error.code)) return null; throw error; }
}
function launch(root, env) {
    const child = spawn(process.execPath, [path.join(root, 'scripts/start-desktop.cjs')], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const events = []; let pending = '', log = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', text => {
        pending += text; let at;
        while ((at = pending.indexOf('\n')) !== -1) { events.push(JSON.parse(pending.slice(0, at))); pending = pending.slice(at + 1); }
    });
    child.stderr.on('data', bytes => { log = (log + bytes).slice(-8192); });
    const exited = once(child, 'close');
    return { child, events, exited, ready: () => until(() => {
        if (child.exitCode !== null) throw Error(`Runner exited ${child.exitCode}: ${log}`);
        return events.find(event => event.type === 'ready');
    }, 'service ready') };
}

test('real service refuses a busy restart, then shuts down once and a fresh runner loads modified code with the same data paths', { timeout: 90000 }, async t => {
    const fixture = createApplication(), { root, env } = fixture, runs = [];
    t.after(async () => { for (const run of runs) { if (run.child.exitCode === null) run.child.stdin.end(); await run.exited; } fs.rmSync(fixture.base, { recursive: true, force: true }); });
    const source = path.join(root, 'server.js');
    const endpoint = "\napp.get('/api/desktop-restart-fixture', (_req,res) => res.json({revision:1}));\napp.get('/api/desktop-restart-hold', (_req,res) => {res.write('held');setTimeout(()=>res.end('done'),1500)});\napp.get('/api/desktop-restart-config', (_req,res) => {piAgentGateway.auxiliaryModels.busy=true;setTimeout(()=>{piAgentGateway.auxiliaryModels.busy=false},1200);res.end('held')});\n";
    fs.appendFileSync(source, endpoint);
    const first = launch(root, env); runs.push(first); const ready = await first.ready();
    const held = await fetch(new URL('api/desktop-restart-hold', ready.url));
    first.child.stdin.write('{"type":"restart"}\n{"type":"restart"}\n');
    await until(() => first.events.find(event => event.type === 'restart-blocked'), 'busy restart refusal');
    assert.equal(first.child.exitCode, null); assert.equal(first.events.filter(event => event.type === 'restart-blocked').length, 1);
    await held.text();
    await fetch(new URL('api/desktop-restart-config', ready.url));
    first.child.stdin.write('{"type":"restart"}\n');
    await until(() => first.events.filter(event => event.type === 'restart-blocked').length === 2, 'configuration save refusal');
    await new Promise(resolve => setTimeout(resolve, 1250));
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('res.json({revision:1})', 'res.json({revision:2})'));
    first.child.stdin.write('{"type":"restart"}\n{"type":"restart"}\n');
    assert.equal((await first.exited)[0], 0);
    assert.equal(first.events.filter(event => event.type === 'restarting').length, 1);
    await assert.rejects(fetch(ready.url), /fetch failed/);
    const second = launch(root, env); runs.push(second); const restarted = await second.ready();
    assert.notEqual(second.child.pid, first.child.pid);
    assert.deepEqual(await fetch(new URL('api/desktop-restart-fixture', restarted.url)).then(response => response.json()), { revision: 2 });
    assert.equal(restarted.agentDir, ready.agentDir); assert.equal(restarted.mediaDir, ready.mediaDir);
    assert.deepEqual((await fetch(new URL('api/pi/activity', restarted.url)).then(response => response.json())).runtimes, []);
    second.child.stdin.write('{"type":"stop"}\n'); assert.equal((await second.exited)[0], 0);
});

test('native tray menu restarts the Node runner once and keeps the tray owner alive; refused or failed shutdown never retries', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
    for (const mode of ['ok', 'blocked', 'shutdown-failure', 'startup-failure']) {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-tray-restart-')));
        fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, 'public/brand'), { recursive: true });
        fs.mkdirSync(path.join(root, '.pivane-runtime/desktop'), { recursive: true });
        fs.copyFileSync(path.resolve(__dirname, '../public/brand/favicon.ico'), path.join(root, 'public/brand/favicon.ico'));
        fs.writeFileSync(path.join(root, '.pivane-launcher-test'), 'independent tray fixture');
        fs.writeFileSync(path.join(root, 'scripts/start-desktop.cjs'), `
            const fs=require('node:fs'), path=require('node:path'), root=${JSON.stringify(root)}, mode=${JSON.stringify(mode)};
            const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
            if(process.argv.includes('--identity')) emit({root,id:path.basename(root)});
            else {
                const counter=path.join(root,'start-count.json');const count=fs.existsSync(counter)?JSON.parse(fs.readFileSync(counter,'utf8'))+1:1;fs.writeFileSync(counter,JSON.stringify(count));
                if(mode==='startup-failure'&&count===2){emit({type:'error',message:'synthetic second startup failed'});process.exit(1)}
                emit({type:'ready',url:'http://127.0.0.1:12345/',logFile:'synthetic.log'});
                process.stdin.setEncoding('utf8'); let pending='';
                process.stdin.on('data', text=>{pending+=text;let at;while((at=pending.indexOf('\\n'))!==-1){
                    const message=JSON.parse(pending.slice(0,at));pending=pending.slice(at+1);
                    if(message.type==='restart') {
                        if(mode==='blocked') emit({type:'restart-blocked',message:'busy fixture'});
                        else {emit({type:'restarting'});process.exit(mode==='shutdown-failure'?1:0);}
                    } else if(message.type==='stop') process.exit(0);
                }});
                process.stdin.on('end',()=>process.exit(0));
            }
        `);
        const env = {};
        for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) if (process.env[key]) env[key] = process.env[key];
        Object.assign(env, { PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_MEDIA_DATA_DIR: path.join(root, 'media'), PI_WEB_DEFERRED_FILE: path.join(root, 'deferred.json') });
        const child = spawn('powershell.exe', ['-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass','-File', path.resolve(__dirname,'../scripts/desktop-tray.ps1'), '-AppRoot',root,'-NodePath',process.execPath,'-NoOpen','-SmokeTest'], { env, windowsHide:true, stdio:['ignore','pipe','pipe'] });
        let output=''; child.stdout.on('data', bytes=>{output+=bytes}); child.stderr.on('data',bytes=>{output+=bytes});
        const exited = once(child,'close'), report=path.join(root,'.pivane-runtime/desktop/smoke-result.json'), ready=path.join(root,'.pivane-runtime/desktop/smoke-ready.json');
        t.after(async()=>{if(child.exitCode===null)fs.writeFileSync(path.join(root,'.pivane-launcher-stop'),'cleanup');await exited;fs.rmSync(root,{recursive:true,force:true})});
        const initial = await until(()=>readySnapshot(ready),'native tray ready',15000);
        fs.writeFileSync(path.join(root,'.pivane-launcher-restart'),'one explicit restart');
        if(mode==='ok') await until(()=>{const value=readySnapshot(ready);return value&&value.pid!==initial.pid},'fresh Node runner',15000);
        else if(mode==='blocked') await until(()=>output.includes('busy fixture') || !fs.existsSync(path.join(root,'.pivane-launcher-restart')),'restart attempted',15000);
        if(mode==='ok'||mode==='blocked') fs.writeFileSync(path.join(root,'.pivane-launcher-stop'),'finish');
        const [code]=await exited;
        assert.equal(code,['shutdown-failure','startup-failure'].includes(mode)?1:0,output);
        const events=JSON.parse(fs.readFileSync(report,'utf8'));
        assert.equal(events.filter(event=>event.type==='restart-requested').length,1);
        assert.equal(events.filter(event=>event.type==='ready').length,mode==='ok'?2:1);
        assert.equal(events.some(event=>event.type==='restart-blocked'),mode==='blocked');
        assert.equal(events.some(event=>event.type==='browser-opened'),false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(root,'start-count.json'),'utf8')),['ok','startup-failure'].includes(mode)?2:1);
    }
});

test('native Windows tray restarts its actual isolated service and reloads edited source without reopening the tray', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
    const fixture = createApplication(), { root, env } = fixture;
    const source = path.join(root, 'server.js');
    fs.appendFileSync(source, "\napp.get('/api/tray-source-fixture',(_req,res)=>res.json({revision:1}));\n");
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File',
        path.resolve(__dirname, '../scripts/desktop-tray.ps1'), '-AppRoot', root, '-NodePath', process.execPath, '-NoOpen', '-SmokeTest'],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'close'); let output = '';
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    t.after(async () => { if (child.exitCode === null) fs.writeFileSync(path.join(root, '.pivane-launcher-stop'), 'cleanup'); await exited; fs.rmSync(fixture.base, { recursive: true, force: true }); });
    const readyFile = path.join(root, '.pivane-runtime/desktop/smoke-ready.json');
    const first = await until(() => { if (child.exitCode !== null) throw Error(output); return readySnapshot(readyFile); }, 'real tray startup');
    const trayPid = child.pid;
    assert.deepEqual(await fetch(new URL('api/tray-source-fixture', first.url)).then(response => response.json()), { revision: 1 });
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('res.json({revision:1})', 'res.json({revision:2})'));
    fs.writeFileSync(path.join(root, '.pivane-launcher-restart'), 'explicit native menu restart');
    const second = await until(() => {
        if (child.exitCode !== null) throw Error(output);
        const value = readySnapshot(readyFile); return value && value.pid !== first.pid ? value : null;
    }, 'actual service restart');
    assert.equal(child.pid, trayPid); assert.equal(child.exitCode, null);
    assert.deepEqual(await fetch(new URL('api/tray-source-fixture', second.url)).then(response => response.json()), { revision: 2 });
    fs.writeFileSync(path.join(root, '.pivane-launcher-stop'), 'finish');
    assert.equal((await exited)[0], 0, output);
    const events = JSON.parse(fs.readFileSync(path.join(root, '.pivane-runtime/desktop/smoke-result.json'), 'utf8'));
    assert.equal(events.filter(event => event.type === 'ready').length, 2);
    assert.equal(events.filter(event => event.type === 'restart-requested').length, 1);
    assert.equal(events.filter(event => event.type === 'restarting').length, 1);
    assert.equal(events.filter(event => event.type === 'exited' && event.exitCode === 0).length, 2);
    assert.equal(events.some(event => event.type === 'browser-opened' || event.type === 'error'), false);
});
