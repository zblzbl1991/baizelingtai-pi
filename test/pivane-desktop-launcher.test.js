const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { desktopEnvironment, browserUrl, checkReady, listenForStop } = require('../server/pivane-desktop-launcher');

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-desktop-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('desktop startup keeps existing identity, data and alias precedence without copying credentials', t => {
    const root = fixture(t), identity = path.join(root, 'agent'), media = path.join(root, 'media');
    fs.writeFileSync(path.join(root, '.env'), `PI_CODING_AGENT_DIR=${identity}\nPIVANE_MEDIA_DATA_DIR=${media}\nPORT=12345\n`);
    const env = desktopEnvironment(root, {});
    assert.equal(env.PI_CODING_AGENT_DIR, identity);
    assert.equal(env.PI_MEDIA_DATA_DIR, media);
    assert.equal(env.PORT, '12345');
    assert.equal(env.PI_WEB_DEFERRED_FILE, undefined, 'native deferred resolver keeps ownership');
    assert.equal(env.PI_MEDIA_CONFIG_DIR, undefined, 'native media config stays in the identity');
    assert.equal(desktopEnvironment(root, { PI_MEDIA_DATA_DIR: root }).PI_MEDIA_DATA_DIR, root);
    assert.equal(fs.existsSync(identity), false);
    assert.equal(fs.existsSync(path.join(root, '.pivane-runtime')), false);
    assert.throws(() => desktopEnvironment(root, { PI_MEDIA_DATA_DIR: 'relative' }), /absolute/);
});

test('browser URL maps wildcard bindings to loopback and validates ports', () => {
    assert.equal(browserUrl('0.0.0.0', 11408), 'http://127.0.0.1:11408/');
    assert.equal(browserUrl('::', 11408), 'http://127.0.0.1:11408/');
    assert.equal(browserUrl('::1', 11408), 'http://[::1]:11408/');
    assert.throws(() => browserUrl('127.0.0.1', 0), /port/);
});

test('readiness requires a valid access endpoint and never follows a redirect', async () => {
    let options;
    await checkReady('http://127.0.0.1:12345/', async (url, request) => {
        assert.equal(url.pathname, '/api/access/status'); options = request;
        return { ok: true, json: async () => ({ authenticated: false }) };
    });
    assert.equal(options.redirect, 'error');
    await assert.rejects(checkReady('http://127.0.0.1:12345/', async () => ({ ok: true, json: async () => ({}) })), /not ready/);
});

test('private stop channel handles fragmented LF, ignores unknown commands, and stops on parent loss', async () => {
    const input = new PassThrough(); let requests = 0;
    listenForStop(input, () => { requests++; });
    input.write('{"type":"restart"}\n{"type":"st');
    assert.equal(requests, 0);
    input.write('op"}\n'); assert.equal(requests, 1);
    input.end(); await once(input, 'end'); assert.equal(requests, 2);
});

// Isolated source integration: reuse only the already-installed dependencies.
// No provider credentials or real identity are inherited; no model requests run.
function application(t) {
    const base = fixture(t), root = path.join(base, '白泽 灵台 & 测试'); fs.mkdirSync(root);
    const source = path.resolve(__dirname, '..');
    for (const file of require('../scripts/source-files.cjs').distributionFiles(source)) {
        const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(source, file), target);
    }
    fs.symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(path.join(root, '.pivane-launcher-test'), 'synthetic instance\n');
    const env = {};
    for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'HOME', 'LANG']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { HOST: '127.0.0.1', PORT: '0', PI_CODING_AGENT_DIR: path.join(base, 'agent'),
        PI_MEDIA_CONFIG_DIR: path.join(base, 'media-lab'), PI_MEDIA_DATA_DIR: path.join(base, 'media'), PI_PROJECT_ROOTS: base,
        PI_WEB_DEFERRED_FILE: path.join(base, 'deferred.json'), PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' });
    return { root, env };
}

function launch(t, root, env) {
    const child = spawn(process.execPath, [path.join(root, 'scripts/start-desktop.cjs')], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const events = []; let pending = '', log = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', text => {
        pending += text; let at;
        while ((at = pending.indexOf('\n')) !== -1) {
            events.push(JSON.parse(pending.slice(0, at))); pending = pending.slice(at + 1);
        }
    });
    child.stderr.on('data', bytes => { log = (log + bytes).slice(-8192); });
    const exited = once(child, 'close');
    t.after(async () => { child.stdin.end(); await exited; });
    async function ready() {
        const until = Date.now() + 45000;
        while (Date.now() < until) {
            if (events.some(event => event.type === 'ready')) return events.find(event => event.type === 'ready');
            if (child.exitCode !== null) throw Error(`Desktop exited: ${JSON.stringify(events)} ${log}`);
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw Error(`Desktop startup timed out: ${log}`);
    }
    return { child, events, exited, ready };
}

test('real managed service becomes ready, serves the workspace, and exits cleanly through its private channel', { timeout: 60000 }, async t => {
    const { root, env } = application(t), run = launch(t, root, env);
    const ready = await run.ready();
    const response = await fetch(ready.url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>白泽灵台<\/title>/);
    const status = await fetch(new URL('api/pi/status', ready.url)).then(value => value.json());
    assert.equal(status.ok, true);
    assert.equal(status.version, require('../package.json').pivaneCompatibility.piVersion);
    // A second owner cannot attach to or terminate the first installation.
    const duplicate = launch(t, root, env);
    const [duplicateCode] = await duplicate.exited;
    assert.equal(duplicateCode, 1);
    assert.equal(duplicate.events.some(event => event.type === 'ready'), false);
    assert.equal((await fetch(ready.url)).status, 200);
    run.child.stdin.write('{"type":"stop"}\n{"type":"stop"}\n');
    const [code] = await run.exited; assert.equal(code, 0);
    await assert.rejects(fetch(ready.url), /fetch failed/);
    const reopened = launch(t, root, env), secondReady = await reopened.ready();
    reopened.child.stdout.destroy(); reopened.child.stderr.destroy(); reopened.child.stdin.destroy();
    assert.equal((await reopened.exited)[0], 0, 'parent loss runs the same graceful shutdown');
    await assert.rejects(fetch(secondReady.url), /fetch failed/);
});

test('occupied HTTP port fails without readiness or termination of its existing owner', { timeout: 60000 }, async t => {
    const { root, env } = application(t), occupied = net.createServer();
    occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
    t.after(() => new Promise(resolve => occupied.close(resolve)));
    env.PORT = String(occupied.address().port);
    const run = launch(t, root, env); const [code] = await run.exited;
    assert.equal(code, 1); assert.equal(run.events.some(event => event.type === 'ready'), false);
    assert.equal(occupied.listening, true);
});

module.exports = { application };
