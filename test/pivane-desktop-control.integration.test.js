const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createApplication } = require('./desktop-launcher-fixture.cjs');

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

test('controlled desktop checks and stops the actual owned service, then starts a fresh generation', { timeout: 150000 }, async () => {
    const { root, base, env } = createApplication();
    const runs = [];
    try {
        for (let cycle = 0; cycle < 2; cycle++) {
            const generation = randomUUID(), run = controlled(root, env, generation); runs.push(run);
            const starting = await run.wait(value => value.type === 'starting', 'starting');
            assert.equal(starting.generation, generation, 'all controlled messages bind the owning generation');
            const ready = await run.wait(value => value.type === 'ready', 'IPC + HTTP readiness');
            assert.equal(ready.generation, generation);
            assert.equal(run.events.some(value => value.type === 'waiting'), false, 'the tray owns the stable waiting host');
            assert.equal((await fetch(ready.url)).status, 200);

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
            const stopped = await run.wait(value => value.type === 'stopped', 'actual service cleanup');
            assert.equal(stopped.clean, true);
            assert.equal(stopped.generation, generation);
            assert.equal(stopped.operationId, accepted.operationId);
            assert.equal((await run.exited).code, 0);
            await assert.rejects(fetch(ready.url), /fetch failed/);
        }
    } finally {
        for (const run of runs) {
            if (!run.child.stdin.destroyed) run.child.stdin.end();
            await run.exited;
        }
        fs.rmSync(base, { recursive: true, force: true });
    }
});
