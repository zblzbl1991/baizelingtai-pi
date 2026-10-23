const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createApplication } = require('./desktop-launcher-fixture.cjs');
const { replaceManaged } = require('../server/pi-start-control');

test('foreground entry starts and replaces the actual isolated backend with IPC and HTTP readiness', { timeout: 300000 }, async t => {
    const { root, base, env } = createApplication();
    const runs = [];
    try {
        for (let cycle = 0; cycle < 2; cycle++) {
            const began = Date.now();
            const child = spawn(process.execPath, [path.join(__dirname, 'start-managed-fixture.cjs'), root], {
                cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
            });
            const run = { child, stdout: '', stderr: '' }; runs.push(run);
            child.stdout.on('data', bytes => { run.stdout += bytes; });
            child.stderr.on('data', bytes => { run.stderr += bytes; });
            run.closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
            const deadline = Date.now() + 190000;
            while (!run.stdout.includes('ENTRY_READY')) {
                if (child.exitCode !== null || Date.now() > deadline) throw Error(`Isolated startup failed: ${run.stdout}\n${run.stderr}`);
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            assert.doesNotMatch(run.stderr, /startup timed out/);
            const match = run.stdout.match(/backend running at http:\/\/localhost:(\d+)/);
            assert.ok(match, 'actual backend reports its assigned HTTP port');
            const origin = `http://127.0.0.1:${match[1]}`;
            assert.equal((await fetch(origin + '/api/access/status')).status, 200);
            assert.equal((await fetch(origin)).status, 200);
            t.diagnostic(`Isolated foreground cycle ${cycle + 1}: IPC and HTTP ready in ${Date.now() - began}ms`);
            if (cycle === 1) {
                assert.deepEqual(await runs[0].closed, { code: 0, signal: null });
                assert.match(run.stdout, /旧实例已完成停机/);
            }
        }
        assert.equal(await replaceManaged(root), true);
        assert.deepEqual(await runs[1].closed, { code: 0, signal: null });
    } finally {
        for (const run of runs) {
            if (!run.child.stdin.destroyed && run.child.exitCode === null) run.child.stdin.end('stop\n');
            await run.closed;
        }
        await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
});
