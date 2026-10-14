const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { createDesktopStartup } = require('../server/pivane-desktop-startup');
const root = path.resolve(__dirname, '..');

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
    assert.deepEqual(await fetch(new URL('status', startup.url)).then(value => value.json()), { state: 'starting' });
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
    assert.deepEqual(await fetch(new URL('status', startup.url)).then(value => value.json()), { state: 'ready', url: 'http://127.0.0.1:11408/' });
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
    assert.deepEqual(await failure.json(), { state: 'error', message: '<img src=x onerror=alert(1)>' });
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
