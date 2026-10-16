const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const { copyCode } = require('../server/pi-update-installer');
const { readSafe, hash } = require('../server/pi-maintenance-files');

async function until(fn, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Isolated maintenance test timed out');
}
let fixture;
test.after(async () => {
    if (!fixture) return;
    fixture.owner?.terminate();
    const child = fixture.child;
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    fs.rmSync(fixture.root, { recursive: true, force: true });
});
test.before(t => {
    const started = performance.now();
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-managed-http-')));
    const app = path.join(root, 'app'); fixture = { root, app };
    t.diagnostic('managed HTTP fixture copy start');
    copyCode(path.resolve(__dirname, '..'), app);
    t.diagnostic(`managed HTTP fixture copy complete: ${Math.round(performance.now() - started)} ms`);
    // Protected full-source copying measured 239 s on Windows; it has its own
    // bounded setup budget. The actual maintenance scenario retains 90 s.
}, { timeout: 300000 });
test('managed launcher performs authenticated backup and restart with paused schedules and unchanged native data', { timeout: 90000 }, async t => {
    const started = performance.now(), stage = name => t.diagnostic(`managed HTTP ${name}: ${Math.round(performance.now() - started)} ms`);
    const { root, app } = fixture, data = path.join(root, 'data'), project = path.join(root, 'project');
    fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(app, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.mkdirSync(path.join(data, 'agent/sessions'), { recursive: true }); fs.mkdirSync(project);
    fs.writeFileSync(path.join(data, 'agent/auth.json'), '{}');
    fs.writeFileSync(path.join(data, 'agent/sessions/sentinel.jsonl'), '{"native":"fixture bytes must stay unchanged"}\n');
    const queue = path.join(data, 'deferred.json');
    fs.writeFileSync(queue, JSON.stringify({ version: 1, jobs: [{ id: randomUUID(), cwd: project, sessionId: randomUUID(), dueAt: Date.now() + 3600000,
        payload: { message: 'Never deliver during maintenance', images: [] }, status: 'scheduled', revision: 1 }] }));
    let output = '', owner;
    const child = spawn(process.execPath, [path.join(app, 'server.js')], { cwd: app,
        env: { PATH: process.env.PATH, HOME: os.homedir(), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            HOST: '127.0.0.1', PORT: '0', PI_CODING_AGENT_DIR: path.join(data, 'agent'), PI_MEDIA_DATA_DIR: path.join(data, 'media'),
            PI_MEDIA_CONFIG_DIR: path.join(data, 'agent/media-lab'), PI_PROJECT_ROOTS: project, PI_WEB_DEFERRED_FILE: queue,
            PI_WEB_TOKEN: 'maintenance-fixture-only', PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    fixture.child = child;
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const port = await until(() => {
        if (child.exitCode !== null) throw new Error('Isolated launcher exited: ' + output);
        return /running at http:\/\/localhost:(\d+)/.exec(output)?.[1];
    });
    stage('launcher listening');
    const base = `http://127.0.0.1:${port}`;
    const headers = { Authorization: 'Bearer maintenance-fixture-only', Origin: base, 'Content-Type': 'application/json' };
    const api = (route, method = 'GET', body, extra = {}) => fetch(base + '/api/pi/settings/updates' + route, { method, headers: { ...headers, ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const initial = await until(async () => { const response = await api('/maintenance'); const data = await response.json(); return data.supported && !data.busy && data; });
    stage('maintenance ready');
    assert.equal((await fetch(base + '/api/pi/settings/updates/maintenance')).status, 401);
    assert.equal((await api('/review', 'POST', { action: 'backup' }, { Origin: 'https://untrusted.invalid' })).status, 403);
    assert.equal((await api('/review', 'POST', { action: 'backup', command: 'never run' })).status, 400);
    const created = await fetch(base + '/api/pi/sessions', { method: 'POST', headers, body: JSON.stringify({ cwd: project, name: 'Native maintenance owner' }) });
    assert.equal(created.status, 201); const native = await created.json();
    owner = new WebSocket(base.replace('http:', 'ws:') + '/api/pi/ws', { origin: base }); fixture.owner = owner;
    await once(owner, 'open');
    const opened = once(owner, 'message');
    owner.send(JSON.stringify({ id: 'owner', type: 'open_session', cwd: project, sessionId: native.id, token: 'maintenance-fixture-only' }));
    assert.equal(JSON.parse((await opened)[0]).success, true);
    const ownerBytes = fs.readFileSync(native.path);
    stage('native owner opened');
    const before = fs.readFileSync(path.join(data, 'agent/sessions/sentinel.jsonl'));
    let generation = initial.generation;
    for (const action of ['backup', 'restart']) {
        stage(action + ' start');
        const review = await api('/review', 'POST', { action }); assert.equal(review.status, 200);
        const ticket = await review.json();
        const request = { ticket: ticket.id, confirmed: true, draftsSaved: true, externalWritersStopped: true };
        assert.equal((await api('/execute', 'POST', { ...request, command: 'never run' })).status, 400);
        const executed = await api('/execute', 'POST', request);
        assert.equal(executed.status, 202, JSON.stringify(await executed.clone().json()));
        assert.equal((await executed.json()).id, ticket.id);
        stage(action + ' accepted');
        const observation = { action, polls: 0, maxPollMs: 0, changes: [] };
        t.after(() => t.diagnostic(JSON.stringify({ maintenancePolls: observation,
            launcherStarts: (output.match(/running at http:\/\/localhost:/g) || []).length, childExit: child.exitCode, childSignal: child.signalCode })));
        const done = await until(async () => {
            const began = performance.now(); observation.polls++;
            const observed = value => {
                const previous = observation.changes.at(-1);
                if (!previous || JSON.stringify(previous.value) !== JSON.stringify(value)) {
                    if (observation.changes.length === 30) observation.changes.shift();
                    observation.changes.push({ ms: Math.round(performance.now() - started), value });
                }
            };
            try {
                const response = await api('/maintenance'); if (!response.ok) { observed({ status: response.status }); return false; }
                const value = await response.json(); observed({ busy: value.busy, phase: value.job?.phase, currentTicket: value.job?.id === ticket.id, generation: value.generation });
                return value.job?.id === ticket.id && !value.busy && value;
            } catch (error) { observed({ error: error.name, code: error.cause?.code }); return false; }
            finally { observation.maxPollMs = Math.max(observation.maxPollMs, performance.now() - began); }
        });
        assert.equal(done.job.phase, 'succeeded', JSON.stringify(done.job)); assert.notEqual(done.generation, generation); generation = done.generation;
        stage(action + ' complete');
        assert.equal(JSON.parse(fs.readFileSync(queue)).jobs[0].status, 'paused');
        assert.deepEqual(fs.readFileSync(path.join(data, 'agent/sessions/sentinel.jsonl')), before);
        assert.deepEqual(fs.readFileSync(native.path), ownerBytes);
        assert.equal(owner.readyState, WebSocket.CLOSED);
        assert.equal((await api('/execute', 'POST', request)).status, 409, 'old tickets cannot replay after restart');
        if (action === 'backup') {
            const directory = done.job.backup.directory;
            const manifest = JSON.parse(readSafe(path.join(directory, 'manifest.json')));
            const entry = manifest.entries.find(e => e.path.endsWith('sentinel.jsonl'));
            assert.deepEqual(fs.readFileSync(path.join(directory, 'files', entry.object)), before);
            assert.equal(entry.sha256, hash(before));
            assert.ok(fs.existsSync(path.join(directory, 'installation.json')));
        } else assert.equal(done.job.backup, null);
    }
    assert.equal((output.match(/running at http:\/\/localhost:/g) || []).length, 3);
    assert.equal(child.exitCode, null);
});
