const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { createApplication } = require('./desktop-launcher-fixture.cjs');
const { controlled } = require('./controlled-desktop-fixture.cjs');

function recordPhase(t, value) {
    const line = JSON.stringify(value); t.diagnostic(line);
    if (process.env.DESKTOP_TEST_PHASE_LOG) {
        if (!path.isAbsolute(process.env.DESKTOP_TEST_PHASE_LOG)) throw Error('Desktop test phase log requires an absolute path');
        fs.appendFileSync(process.env.DESKTOP_TEST_PHASE_LOG, line + '\n');
    }
}

test('candidate private validation reads original native data while HTTP mutations remain closed until matching commit', { timeout: 240000 }, async t => {
    const began = performance.now();
    const phase = (name, detail = {}) => recordPhase(t, { case: 'private-validation', phase: name, elapsedMs: Math.round(performance.now() - began), ...detail });
    const { root, base, env } = createApplication({ diagnostic: detail => phase(detail.phase, { fixtureElapsedMs: detail.elapsedMs, ...(detail.files ? { files: detail.files } : {}) }) }), nonce = randomUUID(), activationId = randomUUID();
    phase('fork-requested');
    // Fixture setup and teardown do not consume the backend validation budget.
    // All readiness/data/HTTP proofs share this one monotonic 120s deadline.
    const proofDeadline = performance.now() + 120000;
    const child = fork(path.join(root, 'server.js'), [], { cwd: root, env: { ...env, PI_MANAGED_LAUNCHER: nonce, PI_MANAGED_BASE: root }, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.once('spawn', () => phase('child-spawned', { pid: child.pid }));
    child.once('close', code => phase('child-closed', { code }));
    let diagnostic = ''; child.stderr.on('data', bytes => diagnostic = (diagnostic + bytes).slice(-4096));
    const closed = once(child, 'close');
    const messages = []; child.on('message', value => { messages.push(value); if (value.type === 'maintenance-shutdown-complete') phase('shutdown-proof'); });
    const abort = () => { phase('test-aborted', { shutdownRequested: child.connected }); if (child.connected) child.send({ nonce, type: 'maintenance-shutdown' }); };
    t.signal.addEventListener('abort', abort, { once: true });
    const wait = async (predicate, maxMs = Infinity) => {
        const until = Math.min(proofDeadline, performance.now() + maxMs);
        while (performance.now() < until) {
            const reply = messages.find(predicate); if (reply) return reply;
            if (child.exitCode !== null) break;
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        throw Error('Candidate control response unavailable: ' + diagnostic);
    };
    let succeeded = false;
    try {
        const ready = await wait(value => value.type === 'maintenance-ready');
        phase('maintenance-ready');
        assert.equal(ready.capabilities.validationProof, true);
        const origin = `http://127.0.0.1:${ready.port}`;
        let requestSequence = 0;
        const request = async (route, options = {}, deadline = proofDeadline) => {
            const requestId = ++requestSequence;
            phase('http-request-before', { requestId, route, method: options.method || 'GET' });
            try {
                const response = await fetch(origin + route, { ...options,
                    signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))) });
                phase('http-request-after', { requestId, route, status: response.status });
                return response;
            } catch (error) {
                phase('http-request-error', { requestId, route, error: error.name });
                throw error;
            }
        };
        child.send({ nonce, type: 'maintenance-status', status: { supported: true, activation: { id: activationId, phase: 'validating' } } });
        child.send({ nonce, type: 'desktop-request', method: 'validate', id: 'data-proof', input: { activationId } });
        phase('data-proof-requested');
        const validation = await wait(value => value.id === 'data-proof');
        phase('data-proof-received');
        assert.equal(validation.result?.data, true, JSON.stringify(validation.error));
        assert.equal(validation.result?.activationId, activationId);
        assert.equal((await request('/api/pi/status')).status, 503);
        assert.equal((await request('/api/pi/settings/updates/notifications', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 503);
        child.send({ nonce, type: 'maintenance-activate', activationId });
        assert.equal((await request('/api/pi/status')).status, 503, 'an activation message alone is not the persisted commit');
        assert.ok(performance.now() <= proofDeadline, 'backend validation proofs complete within one shared 120s budget');
        phase('validation-assertions-complete');
        // Business admission follows commit; it is not an activation-validation proof.
        const admissionDeadline = performance.now() + 15000;
        phase('committed-status-sent');
        child.send({ nonce, type: 'maintenance-status', status: { supported: true, activation: { id: activationId, phase: 'committed' } } });
        child.send({ nonce, type: 'maintenance-activate', activationId });
        child.send({ nonce, type: 'desktop-request', method: 'snapshot', id: 'after-commit', input: {} });
        while (!messages.some(value => value.id === 'after-commit') && performance.now() < admissionDeadline && child.exitCode === null) {
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        assert.ok(messages.some(value => value.id === 'after-commit'), 'post-commit snapshot arrives within the ordinary 15s control budget');
        phase('committed-snapshot-received');
        assert.equal((await request('/api/pi/status', {}, performance.now() + 15000)).status, 200);
        phase('admission-assertions-complete'); succeeded = true;
    } finally {
        phase('finally-shutdown-requested', { connected: child.connected });
        if (child.connected) child.send({ nonce, type: 'maintenance-shutdown' });
        await closed;
        t.signal.removeEventListener('abort', abort);
        if (succeeded && !t.signal.aborted) {
            phase('fixture-cleanup-start');
            await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            phase('fixture-cleanup-complete');
        } else phase('retained-synthetic-fixture', { base });
    }
});

for (const unexpected of [false,true]) test(`exit zero without cleanup proof keeps the controlled owner alive and refuses a second owner (${unexpected ? 'unexpected exit' : 'requested stop'})`, { timeout: 60000 }, async t => {
    const began = performance.now();
    const phase = (name, detail = {}) => recordPhase(t, { case: 'missing-cleanup-proof', unexpected, phase: name, elapsedMs: Math.round(performance.now() - began), ...detail });
    const { root, base, env } = createApplication({ diagnostic: detail => phase(detail.phase, { fixtureElapsedMs: detail.elapsedMs, ...(detail.files ? { files: detail.files } : {}) }) }); const runs=[];
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
    let succeeded = false;
    try {
        phase('controlled-run-requested');
        const run=controlled(root,env,randomUUID(),phase);runs.push(run);
        await run.wait(event=>event.type==='ready','synthetic readiness');
        if(!unexpected)run.send({type:'execute-stop',id:'execute',ticket:'synthetic-ticket',draftsSaved:true,externalWritersStopped:true});
        await run.wait(event=>event.type==='error'&&event.code==='DESKTOP_CLEANUP_UNKNOWN','unconfirmed cleanup');
        phase('cleanup-unknown-proven');
        assert.equal(run.child.exitCode,null,'unknown cleanup retains the runner and its ownership guard');
        assert.equal(run.events.some(event=>event.type==='stopped'&&event.clean),false);
        if(!unexpected){
            run.send({type:'snapshot',id:'accepted-progress'});
            const progress=await run.wait(event=>event.type==='snapshot'&&event.id==='accepted-progress','accepted operation progress',3000);
            assert.equal(progress.operationId,'synthetic-operation');assert.equal(progress.accepted,true);assert.equal(progress.complete,false);
            assert.equal(run.events.filter(event=>event.type==='stop-accepted').length,1,'progress never replays cleanup');
        }
        phase('duplicate-requested');
        const duplicate=controlled(root,env,randomUUID(),(name,detail)=>phase('duplicate-'+name,detail));runs.push(duplicate);
        assert.notEqual((await duplicate.exited).code,0);
        assert.equal(duplicate.events.some(event=>event.type==='ready'),false,'another owner cannot start while proof is missing');
        phase('duplicate-refused'); succeeded = true;
    } finally {
        phase('finally-owned-fixture-cleanup');
        // These are isolated fixture runners; their service has already exited.
        for(const run of runs){if(run.child.exitCode===null&&run.child.signalCode===null)run.child.kill();await run.exited;}
        if (succeeded && !t.signal.aborted) { fs.rmSync(base,{recursive:true,force:true}); phase('fixture-cleanup-complete'); }
        else phase('retained-synthetic-fixture',{base});
    }
});
