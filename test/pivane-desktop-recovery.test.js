const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function waitingPage(responses, instance = 'tray-one') {
    const elements = new Map(['startup-title', 'startup-detail', 'startup-hint'].map(id => [id, { textContent: '' }]));
    const timers = [], redirects = [], calls = [];
    const document = { title: '', body: { dataset: {} }, getElementById: id => elements.get(id),
        querySelector: () => ({ content: instance }) };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../public/desktop-startup.js'), 'utf8'), {
        document, Date, URL, AbortSignal, window: { location: { replace: url => redirects.push(url) } },
        fetch: async (...args) => { calls.push(args); const result = responses.shift(); if (result instanceof Error) throw result; return { ok: true, json: async () => result }; },
        setTimeout: (callback, ms) => timers.push({ callback, ms })
    });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    return { elements, timers, redirects, calls, document, flush, async next() { await flush(); assert.ok(timers.length); timers.shift().callback(); await flush(); } };
}

test('waiting browser recovers a transient status failure without launching or replaying operations', async () => {
    const page = waitingPage([Error('timeout'), { state: 'starting', instance: 'tray-one', generation: 'run-one' },
        { state: 'ready', instance: 'tray-one', generation: 'run-one', url: 'http://127.0.0.1:12345/' }]);
    await page.flush();
    assert.equal(page.elements.get('startup-title').textContent, '正在重新连接');
    await page.next(); await page.next();
    assert.deepEqual(page.redirects, ['http://127.0.0.1:12345/']);
    assert.equal(page.calls.length, 3);
    assert.ok(page.calls.every(([url, options]) => url === '/status' && !options.method));
});

test('waiting browser refuses another tray instance and follows an explicitly started new generation', async () => {
    const page = waitingPage([{ state: 'ready', instance: 'foreign', generation: 'other', url: 'http://127.0.0.1:12345/' },
        { state: 'error', instance: 'tray-one', generation: 'run-one', message: '<unsafe>' },
        { state: 'stopped', instance: 'tray-one', generation: 'run-one' },
        { state: 'starting', instance: 'tray-one', generation: 'run-two' },
        { state: 'ready', instance: 'tray-one', generation: 'run-two', url: 'http://127.0.0.1:12346/' }]);
    await page.flush(); assert.deepEqual(page.redirects, []);
    await page.next(); assert.equal(page.elements.get('startup-detail').textContent, '<unsafe>');
    await page.next(); assert.equal(page.elements.get('startup-title').textContent, '服务已停止');
    await page.next(); await page.next();
    assert.deepEqual(page.redirects, ['http://127.0.0.1:12346/']);
});
