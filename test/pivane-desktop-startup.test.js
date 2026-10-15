const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { createDesktopStartup } = require('../server/pivane-desktop-startup');
const root = path.resolve(__dirname, '..');

test('startup page retries a denied temporary port and still serves its own status', async t => {
    const create = http.createServer;
    const attempts = [];
    t.mock.method(http, 'createServer', (...args) => {
        const server = create(...args), listen = server.listen;
        server.listen = function (port, host) {
            attempts.push({ port, host });
            if (attempts.length === 1) {
                process.nextTick(() => server.emit('error', Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:55572'), { code: 'EACCES' })));
                return server;
            }
            return listen.call(this, port, host);
        };
        return server;
    });
    const startup = await createDesktopStartup({ root });
    t.after(() => startup.close());
    assert.ok(attempts.length >= 2 && attempts.length <= 32);
    assert.ok(attempts.every(attempt => attempt.host === '127.0.0.1'));
    assert.notEqual(attempts[1].port, attempts[0].port);
    assert.deepEqual(await fetch(new URL('status', startup.url)).then(value => value.json()), { state: 'starting', instance: startup.instance, generation: startup.generation });
});

test('temporary port retries are bounded, propagate unrelated failures and leave no listeners behind', async t => {
    const create = http.createServer;
    let code = 'EACCES', attempts = 0, server, initialListeningListeners;
    t.mock.method(http, 'createServer', (...args) => {
        server = create(...args);
        initialListeningListeners = server.listenerCount('listening');
        server.listen = function () {
            attempts++;
            process.nextTick(() => this.emit('error', Object.assign(new Error('Synthetic bind refusal'), { code })));
            return this;
        };
        return server;
    });
    await assert.rejects(createDesktopStartup({ root }), /allocate.*port/i);
    assert.equal(attempts, 32);
    assert.equal(server.listening, false);
    assert.equal(server.listenerCount('listening'), initialListeningListeners);
    assert.equal(server.listenerCount('error'), 0);
    code = 'EADDRINUSE'; attempts = 0;
    await assert.rejects(createDesktopStartup({ root }), /allocate.*port/i);
    assert.equal(attempts, 32);
    code = 'EINVAL'; attempts = 0;
    await assert.rejects(createDesktopStartup({ root }), { code: 'EINVAL' });
    assert.equal(attempts, 1);
});

test('startup page is available before readiness and serves only its bounded local assets/status', async t => {
    const startup = await createDesktopStartup({ root });
    t.after(() => startup.close());
    const port = Number(new URL(startup.url).port);
    assert.ok(port < 40000 || port >= 60000, 'startup HTTP cannot conflict with an installation guard port');
    const page = await fetch(startup.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /正在启动/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.deepEqual(await fetch(new URL('status', startup.url)).then(value => value.json()), { state: 'starting', instance: startup.instance, generation: startup.generation });
    for (const file of ['startup.js', 'startup.css', 'brand.png']) assert.equal((await fetch(new URL(file, startup.url))).status, 200);
    assert.equal((await fetch(new URL('.env', startup.url))).status, 404);
    assert.equal((await fetch(new URL('status', startup.url), { method: 'POST' })).status, 405);
    assert.equal((await fetch(new URL('status', startup.url), { headers: { Origin: 'http://foreign.example' } })).status, 403);
    const foreignHost = await new Promise((resolve, reject) => {
        const request = http.get(startup.url, { headers: { Host: 'foreign.example' } }, response => { response.resume(); resolve(response.statusCode); });
        request.on('error', reject);
    });
    assert.equal(foreignHost, 403);
    startup.ready('http://127.0.0.1:11408/');
    assert.deepEqual(await fetch(new URL('status', startup.url)).then(value => value.json()), { state: 'ready', instance: startup.instance, generation: startup.generation, url: 'http://127.0.0.1:11408/' });
    await startup.close();
    await assert.rejects(fetch(startup.url), /fetch failed/);
});

test('failure is delivered to the waiting browser before shutdown, never replaced by late readiness', async () => {
    const startup = await createDesktopStartup({ root, failureViewMs: 3000 });
    startup.fail('<img src=x onerror=alert(1)>');
    startup.ready('http://127.0.0.1:11408/');
    const closed = startup.close({ allowFailureView: true });
    assert.equal(startup.close(), closed, 'closing is reserved before the asynchronous wait');
    const failure = await fetch(new URL('status', startup.url));
    assert.equal(failure.headers.get('connection'), 'close', 'terminal delivery drains a browser keep-alive connection');
    assert.deepEqual(await failure.json(), { state: 'error', instance: startup.instance, generation: startup.generation, message: '<img src=x onerror=alert(1)>' });
    await closed;
    await assert.rejects(fetch(startup.url), /fetch failed/);
});

test('unopened failure pages and successful startup listeners have bounded lifetimes', async () => {
    const failed = await createDesktopStartup({ root, failureViewMs: 20 });
    failed.fail('Synthetic failure');
    await failed.close({ allowFailureView: true });
    await assert.rejects(fetch(failed.url), /fetch failed/);
    const ready = await createDesktopStartup({ root, readyLifetimeMs: 20 });
    assert.throws(() => ready.ready('javascript:alert(1)'), /Invalid workspace/);
    ready.ready('http://127.0.0.1:11408/');
    await new Promise(resolve => setTimeout(resolve, 50));
    await ready.close();
    await assert.rejects(fetch(ready.url), /fetch failed/);
});
