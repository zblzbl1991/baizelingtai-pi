const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync, fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createApplication } = require('./desktop-launcher-fixture.cjs');

test('tray identity reserves the resolved workspace port without starting a service', () => {
    const { root, base, env } = createApplication();
    try {
        fs.writeFileSync(path.join(root, '.env'), 'PORT=62345\n');
        const result = spawnSync(process.execPath, [path.join(root, 'scripts/start-desktop.cjs'), '--identity'],
            { cwd: root, env: { ...env, PORT: '61234' }, windowsHide: true, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const identity = JSON.parse(result.stdout);
        assert.equal(identity.root, root);
        assert.deepEqual(identity.reservedPorts, [61234], 'inherited configuration wins over .env');
        assert.equal(fs.existsSync(path.join(root, '.pivane-runtime')), false, 'identity lookup has no owner side effects');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('desktop identity rejects an unselected program directory and pins the original installation', () => {
    const { root, base, env } = createApplication();
    try {
        const other = path.join(base, 'other-installation'); fs.mkdirSync(other);
        const result = spawnSync(process.execPath, [path.join(root, 'scripts/start-desktop.cjs'), '--identity'],
            { cwd: root, env: { ...env, PIVANE_INSTALLATION_ROOT: other, PIVANE_PROGRAM_ROOT: root }, windowsHide: true, encoding: 'utf8' });
        assert.notEqual(result.status, 0, 'a different installation cannot execute this program as its selected version');
        assert.equal(fs.existsSync(path.join(other, '.pivane-runtime')), false);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('candidate private validation reads original native data while HTTP mutations remain closed until matching commit', { timeout: 90000 }, async () => {
    const { root, base, env } = createApplication(), nonce = randomUUID(), activationId = randomUUID();
    const child = fork(path.join(root, 'server.js'), [], { cwd: root, env: { ...env, PI_MANAGED_LAUNCHER: nonce, PI_MANAGED_BASE: root }, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let diagnostic = ''; child.stderr.on('data', bytes => diagnostic = (diagnostic + bytes).slice(-4096));
    const closed = once(child, 'close');
    const messages = []; child.on('message', value => messages.push(value));
    const wait = async predicate => {
        const until = Date.now() + 45000;
        while (Date.now() < until) {
            const reply = messages.find(predicate); if (reply) return reply;
            if (child.exitCode !== null) break;
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        throw Error('Candidate control response unavailable: ' + diagnostic);
    };
    try {
        const ready = await wait(value => value.type === 'maintenance-ready');
        assert.equal(ready.capabilities.validationProof, true);
        const origin = `http://127.0.0.1:${ready.port}`;
        child.send({ nonce, type: 'maintenance-status', status: { supported: true, activation: { id: activationId, phase: 'validating' } } });
        child.send({ nonce, type: 'desktop-request', method: 'validate', id: 'data-proof', input: { activationId } });
        const validation = await wait(value => value.id === 'data-proof');
        assert.equal(validation.result?.data, true, JSON.stringify(validation.error));
        assert.equal(validation.result?.activationId, activationId);
        assert.equal((await fetch(origin + '/api/pi/status')).status, 503);
        assert.equal((await fetch(origin + '/api/pi/settings/updates/notifications', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 503);
        child.send({ nonce, type: 'maintenance-activate', activationId });
        assert.equal((await fetch(origin + '/api/pi/status')).status, 503, 'an activation message alone is not the persisted commit');
        child.send({ nonce, type: 'maintenance-status', status: { supported: true, activation: { id: activationId, phase: 'committed' } } });
        child.send({ nonce, type: 'maintenance-activate', activationId });
        child.send({ nonce, type: 'desktop-request', method: 'snapshot', id: 'after-commit', input: {} });
        await wait(value => value.id === 'after-commit');
        assert.equal((await fetch(origin + '/api/pi/status')).status, 200);
    } finally {
        if (child.connected) child.send({ nonce, type: 'maintenance-shutdown' });
        await closed;
        await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
});

// This seam crosses the real runner, ManagedLauncher, child IPC and gateway.
// It owns a synthetic installation/identity and never sends model requests.
function controlled(root, env, generation) {
    const child = spawn(process.execPath, [path.join(root, 'scripts/start-desktop.cjs'), '--controlled', '--generation', generation],
        { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const events = []; let pending = '', diagnostic = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => {
        pending += text;
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            try { events.push(JSON.parse(line)); }
            catch { diagnostic += '\nInvalid private frame'; }
        }
    });
    child.stderr.on('data', text => { diagnostic = (diagnostic + text).slice(-4096); });
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const send = command => child.stdin.write(JSON.stringify({ generation, ...command }) + '\n');
    async function wait(predicate, description, timeout = 45000) {
        const until = Date.now() + timeout;
        while (Date.now() < until) {
            const event = events.find(predicate);
            if (event) return event;
            if (child.exitCode !== null || child.signalCode !== null) break;
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        throw Error(`Missing ${description}: ${JSON.stringify(events)} ${diagnostic}`);
    }
    return { child, events, send, wait, exited };
}

test('controlled desktop checks and stops the actual owned service, then starts a fresh generation', { timeout: 300000 }, async () => {
    const { root, base, env } = createApplication();
    const runs = [], sockets = [];
    try {
        for (let cycle = 0; cycle < 2; cycle++) {
            const generation = randomUUID(), run = controlled(root, env, generation); runs.push(run);
            const starting = await run.wait(value => value.type === 'starting', 'starting');
            assert.equal(starting.generation, generation, 'all controlled messages bind the owning generation');
            const ready = await run.wait(value => value.type === 'ready', 'IPC + HTTP readiness');
            assert.equal(ready.generation, generation);
            assert.equal(ready.versions.appVersion, require('../package.json').version);
            assert.equal(ready.versions.engineVersion, require('../node_modules/@earendil-works/pi-coding-agent/package.json').version);
            assert.equal(run.events.some(value => value.type === 'waiting'), false, 'the tray owns the stable waiting host');
            assert.equal((await fetch(ready.url)).status, 200);
            const workspace = new WebSocket(new URL('api/pi/ws', ready.url).href.replace(/^http:/, 'ws:'), { origin: new URL(ready.url).origin });
            sockets.push(workspace); await once(workspace, 'open');
            const workspaceClosed = once(workspace, 'close');
            const created = await fetch(new URL('api/pi/sessions',ready.url), {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cwd:root,name:'Synthetic idle workbench'})});
            assert.equal(created.status,201); const session=await created.json();
            // An idle authenticated workbench keeps its transport open while its
            // actual native worker is available; no model prompt is sent.
            const opened = new Promise((resolve, reject) => {
                // Native worker startup has its own 120s budget. It is separate
                // from the private desktop control response's unchanged 15s.
                const timer = setTimeout(() => reject(Error('Idle workspace did not open')), 120000);
                workspace.on('message', bytes => { const reply=JSON.parse(bytes); if(reply.id==='idle-workspace'){clearTimeout(timer);resolve(reply);} });
            });
            workspace.send(JSON.stringify({ type:'open_session', id:'idle-workspace', cwd:root,sessionId:session.id }));
            assert.equal((await opened).success,true);

            run.send({ type: 'snapshot', generation: randomUUID(), id: 'stale' });
            run.send({ type: 'stop', id: 'no-bypass', action: 'stop' });
            let snapshot;
            for (let attempt = 0; attempt < 30; attempt++) {
                const id = `snapshot-${attempt}`;
                run.send({ type: 'snapshot', id });
                snapshot = await run.wait(value => value.type === 'snapshot' && value.id === id, 'read-only readiness');
                assert.equal(snapshot.generation, generation);
                assert.equal(typeof snapshot.revision, 'string');
                if (snapshot.complete && snapshot.blockers.length === 0) break;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.equal(snapshot.complete, true);
            assert.deepEqual(snapshot.blockers, []);
            assert.equal(run.events.some(value => value.id === 'stale'), false, 'old generations have no authority');
            assert.equal((await fetch(ready.url)).status, 200, 'ready service rejects the startup-only stop bypass');

            run.send({ type: 'review-stop', id: 'review', action: cycle ? 'exit' : 'stop' });
            const review = await run.wait(value => value.type === 'stop-review' && value.id === 'review', 'idle review');
            assert.equal(review.complete, true); assert.ok(review.ticket);
            assert.equal((await fetch(ready.url)).status, 200, 'review leaves the workspace usable');
            run.send({ type: 'execute-stop', id: 'execute', ticket: review.ticket, draftsSaved: true, externalWritersStopped: true });
            const accepted = await run.wait(value => value.type === 'stop-accepted' && value.id === 'execute', 'atomic acceptance');
            assert.equal(typeof accepted.operationId, 'string');
            const stopped = await run.wait(value => value.type === 'stopped', 'actual service cleanup with an open idle workbench', 10000);
            assert.equal((await workspaceClosed)[0],1001,'server closes the idle workbench transport normally');
            assert.equal(stopped.clean, true);
            assert.equal(stopped.generation, generation);
            assert.equal(stopped.operationId, accepted.operationId);
            assert.equal((await run.exited).code, 0);
            await assert.rejects(fetch(ready.url), /fetch failed/);
        }
    } finally {
        for(const socket of sockets)socket.terminate();
        for (const run of runs) {
            if (!run.child.stdin.destroyed) run.child.stdin.end();
            await run.exited;
        }
        // Owned runners and their pipes have closed; Windows may still be releasing directory handles.
        await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
});

test('exit zero without cleanup proof keeps the controlled owner alive and refuses a second owner', { timeout: 60000 }, async () => {
    for (const unexpected of [false,true]) {
    const { root, base, env } = createApplication(); const runs=[];
    env.PIVANE_TEST_UNEXPECTED_EXIT=unexpected?'1':'0';
    fs.writeFileSync(path.join(root,'server.js'), `
        const http=require('node:http'), nonce=process.env.PI_MANAGED_LAUNCHER;
        const server=http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end('{"authenticated":false}')});
        server.listen(0,'127.0.0.1',()=>{process.send({type:'maintenance-ready',nonce,port:server.address().port,appVersion:require('./package.json').version,engineVersion:'0.85.1',capabilities:{shutdownProof:true}});if(process.env.PIVANE_TEST_UNEXPECTED_EXIT==='1')setTimeout(()=>process.exit(0),500)});
        process.on('message',message=>{
            if(message.nonce!==nonce)return;
            if(message.type==='desktop-request')process.send({type:'desktop-response',nonce,id:message.id,result:message.method==='execute'?{accepted:true,operationId:'synthetic-operation'}:{complete:true,revision:'one',blockers:[],scheduled:{futureCount:0,latestCount:0},ticket:'synthetic-ticket'}});
            if(message.type==='maintenance-shutdown')server.close(()=>process.exit(0));
        });
    `);
    try {
        const run=controlled(root,env,randomUUID());runs.push(run);
        await run.wait(event=>event.type==='ready','synthetic readiness');
        if(!unexpected)run.send({type:'execute-stop',id:'execute',ticket:'synthetic-ticket',draftsSaved:true,externalWritersStopped:true});
        await run.wait(event=>event.type==='error'&&event.code==='DESKTOP_CLEANUP_UNKNOWN','unconfirmed cleanup');
        assert.equal(run.child.exitCode,null,'unknown cleanup retains the runner and its ownership guard');
        assert.equal(run.events.some(event=>event.type==='stopped'&&event.clean),false);
        if(!unexpected){
            run.send({type:'snapshot',id:'accepted-progress'});
            const progress=await run.wait(event=>event.type==='snapshot'&&event.id==='accepted-progress','accepted operation progress',3000);
            assert.equal(progress.operationId,'synthetic-operation');assert.equal(progress.accepted,true);assert.equal(progress.complete,false);
            assert.equal(run.events.filter(event=>event.type==='stop-accepted').length,1,'progress never replays cleanup');
        }
        const duplicate=controlled(root,env,randomUUID());runs.push(duplicate);
        assert.notEqual((await duplicate.exited).code,0);
        assert.equal(duplicate.events.some(event=>event.type==='ready'),false,'another owner cannot start while proof is missing');
    } finally {
        // These are isolated fixture runners; their service has already exited.
        for(const run of runs){if(run.child.exitCode===null&&run.child.signalCode===null)run.child.kill();await run.exited;}
        fs.rmSync(base,{recursive:true,force:true});
    }
    }
});
