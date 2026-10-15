const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-create-directory-')));
const project = path.join(root, 'project'), agent = path.join(root, 'agent');
fs.mkdirSync(project); fs.mkdirSync(agent);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = project; process.env.PI_OFFLINE = '1';
process.env.PI_WEB_TOKEN = 'isolated-directory-test';
const { PiSessionStore } = require('../server/pi-session-store');
const { PiProjectDirectories } = require('../server/pi-project-directories');
const store = new PiSessionStore(), service = new PiProjectDirectories({ store });
const create = name => service.create({ parent: project, name });
test.after(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });

test('creates exactly one ordinary directory with Chinese and spaces; collisions preserve existing objects', async () => {
    const name = '中文 文件夹', target = path.join(project, name);
    assert.deepEqual(await create(name), { parent: project, path: target, name });
    assert.ok(fs.statSync(target).isDirectory());
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
    await assert.rejects(create(name), { code: 'DIRECTORY_EXISTS' });
    fs.writeFileSync(path.join(project, 'file.txt'), 'unchanged');
    await assert.rejects(create('file.txt'), { code: 'DIRECTORY_EXISTS' });
    assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(project, 'file.txt'), 'utf8'), 'unchanged');
    assert.equal(service.jobs.size, 0);
});

test('rejects traversal, paths, blank and oversized names, extra fields, private roots and links outside allowed roots', async () => {
    for (const name of ['', ' ', '.', '..', '../escape', 'a/b', 'a\\b', '/absolute', '\0', 'a\nb', '中'.repeat(86), null]) {
        await assert.rejects(create(name), { code: 'DIRECTORY_NAME' });
    }
    for (const name of ['.pi', '.ssh', '.env']) await assert.rejects(create(name), { code: 'DIRECTORY_PRIVATE' });
    await assert.rejects(service.create({ parent: project, name: 'x', recursive: true }), { code: 'DIRECTORY_NAME' });
    await assert.rejects(service.create({ parent: 'relative', name: 'x' }), { code: 'DIRECTORY_NAME' });
    await assert.rejects(service.create({ parent: root, name: 'x' }), { code: 'FILE_PROJECT' });
    const link = path.join(project, 'outside'); fs.symlinkSync(agent, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(service.create({ parent: link, name: 'x' }), { code: 'FILE_PROJECT' });
    assert.equal(fs.existsSync(path.join(agent, 'x')), false);
    const broad = new PiSessionStore(); broad.roots = [root];
    const privateService = new PiProjectDirectories({ store: broad });
    await assert.rejects(privateService.create({ parent: agent, name: 'private' }), { code: 'FILE_PRIVATE' });
    await privateService.dispose();
    if (process.platform === 'win32') for (const name of ['CON', 'nul.txt', 'trailing.', 'trailing ', 'x:y']) await assert.rejects(create(name), { code: 'DIRECTORY_NAME' });
});

test('reserves before await, blocks maintenance and shutdown, and does not release work on a disconnected response', async () => {
    const pending = create('single-submit');
    assert.equal(service.jobs.size, 1);
    await assert.rejects(create('duplicate'), { code: 'DIRECTORY_BUSY' });
    await pending;
    let suspended = false;
    const closing = new PiProjectDirectories({ store, isSuspended: () => suspended });
    const writing = closing.create({ parent: project, name: 'stopped' });
    const rejected = assert.rejects(writing, { code: 'DIRECTORY_BUSY' });
    const disposal = closing.dispose();
    assert.equal(closing.jobs.size, 1);
    await rejected; await disposal;
    assert.equal(fs.existsSync(path.join(project, 'stopped')), false);
    suspended = true;
    await assert.rejects(closing.create({ parent: project, name: 'after-stop' }), { code: 'DIRECTORY_BUSY' });
});

test('parent changes before creation fail closed; denied writes retain the parent; post-write failures report uncertainty without deleting', async () => {
    const io = require('../server/pi-file-io'), originalOpen = io.openReadSync;
    try {
        io.openReadSync = filename => {
            const fd = originalOpen(filename);
            if (filename === project) fs.utimesSync(project, new Date(), new Date(Date.now() + 10000));
            return fd;
        };
        await assert.rejects(create('changed-parent'), { code: 'DIRECTORY_CHANGED' });
    } finally { io.openReadSync = originalOpen; }
    assert.equal(fs.existsSync(path.join(project, 'changed-parent')), false);
    const mkdir = fs.mkdirSync;
    try {
        fs.mkdirSync = () => { throw Object.assign(new Error('synthetic permission denial'), { code: 'EACCES' }); };
        await assert.rejects(create('denied'), { code: 'DIRECTORY_DENIED' });
    } finally { fs.mkdirSync = mkdir; }
    assert.equal(fs.existsSync(path.join(project, 'denied')), false);
    const resolve = store.resolveProject;
    try {
        store.resolveProject = function (value) { if (value === path.join(project, 'uncertain')) throw Error('synthetic changed identity'); return resolve.call(this, value); };
        await assert.rejects(create('uncertain'), { code: 'DIRECTORY_UNCERTAIN' });
    } finally { store.resolveProject = resolve; }
    assert.ok(fs.statSync(path.join(project, 'uncertain')).isDirectory());
    assert.equal(service.jobs.size, 0);
});

test('real gateway authenticates creation, checks Origin and roots, reports capability and leaves workers untouched', async t => {
    const express = require('express');
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const gateway = createPiAgentGateway(), app = express();
    app.use(express.json()); gateway.mount(app);
    const server = app.listen(0, '127.0.0.1');
    await require('node:events').once(server, 'listening');
    t.after(async () => { await gateway.dispose(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}/api/pi`;
    const request = (endpoint, options = {}) => fetch(base + endpoint, { ...options,
        headers: { Authorization: 'Bearer isolated-directory-test', 'Content-Type': 'application/json', ...options.headers } });
    const body = JSON.stringify({ parent: project, name: 'http-created' });
    assert.equal((await fetch(base + '/directories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
    assert.equal((await request('/directories', { method: 'POST', body, headers: { Origin: 'http://untrusted.invalid' } })).status, 403);
    assert.equal((await (await request('/status')).json()).createDirectories, true);
    const response = await request('/directories', { method: 'POST', body });
    assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await response.json(), { parent: project, path: path.join(project, 'http-created'), name: 'http-created' });
    assert.equal((await request('/directories', { method: 'POST', body })).status, 409);
    assert.equal((await request('/directories', { method: 'POST', body: JSON.stringify({ parent: root, name: 'escape' }) })).status, 403);
    assert.ok((await (await request('/directories?path=' + encodeURIComponent(project))).json()).directories.some(row => row.name === 'http-created'));
    assert.equal((await (await request('/activity')).json()).projectDirectoryOperations, 0);
    assert.equal(gateway.supervisor.workers.size, 0);

    // Keep the server-side reservation even after the browser disconnects.
    const fsp = require('node:fs/promises'), realpath = fsp.realpath;
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const abort = new AbortController();
    try {
        fsp.realpath = async filename => { if (filename === agent) { entered(); await gate; } return realpath(filename); };
        const disconnected = request('/directories', { method: 'POST', body: JSON.stringify({ parent: project, name: 'disconnected' }), signal: abort.signal });
        const rejected = assert.rejects(disconnected, { name: 'AbortError' });
        await started;
        assert.equal((await (await request('/activity')).json()).projectDirectoryOperations, 1);
        abort.abort(); await rejected;
        assert.equal((await (await request('/activity')).json()).projectDirectoryOperations, 1);
        release();
        for (let index = 0; index < 100; index++) {
            if (!(await (await request('/activity')).json()).projectDirectoryOperations) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(fs.statSync(path.join(project, 'disconnected')).isDirectory());
        assert.equal((await (await request('/activity')).json()).projectDirectoryOperations, 0);
    } finally { release(); fsp.realpath = realpath; }
});
