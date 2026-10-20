const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createApplication } = require('./desktop-launcher-fixture.cjs');
const { controlled } = require('./controlled-desktop-fixture.cjs');

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
