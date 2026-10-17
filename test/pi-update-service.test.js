const test = require('node:test');
const assert = require('node:assert/strict');
const { UpdateService, mountUpdateRoutes, compareVersions, proxyFor } = require('../server/pi-update-service');
const { WorkspaceAccessService } = require('../server/workspace-access-service');
const express = require('express');
const fetch = require('node-fetch');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const release = (version, extra = {}) => ({ tag_name: 'v' + version, prerelease: version.includes('-'), draft: false,
    assets: ['', '.sha256'].map(suffix => ({ name: `pivane-${version}.tar.gz${suffix}`, state: 'uploaded',
        browser_download_url: `https://github.com/zblzbl1991/baizelingtai-pi/releases/download/v${version}/pivane-${version}.tar.gz${suffix}` })), ...extra });
const fixture = (releases, options = {}) => {
    const requests = [];
    const service = new UpdateService({ env: { BAIZELINGTAI_UPDATE_FEED_URL: '' }, appVersion: '1.0.0-rc.2', piVersion: options.piVersion || '0.85.1',
        fetch: async (url, opts) => {
            requests.push({ url, opts });
            return { ok: true, json: async () => url.includes('api.github.com') ? releases : { name: '@earendil-works/pi-coding-agent', version: '0.86.0' } };
        }, ...options });
    return { service, requests };
};

const feedSource = 'http://gitlab.example:8080/team/pivane/-/raw/main/updates/latest.json';

test('external application updates use the configured distribution repository', async () => {
    const { service, requests } = fixture([]);
    assert.equal(service.snapshot().pivane.releasesUrl, 'https://github.com/zblzbl1991/baizelingtai-pi/releases');
    await service.check();
    assert.deepEqual(requests.map(request => request.url), [
        'https://api.github.com/repos/zblzbl1991/baizelingtai-pi/releases?per_page=100',
        'https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest'
    ]);
});
const feed = (extra = {}) => ({ schemaVersion: 1, version: '1.8.0', piVersion: '1.1.0', platform: 'win32', arch: 'x64',
    channel: 'stable', publishedAt: '2026-10-12T00:00:00Z', package: 'pivane-1.8.0-windows-x64-portable.zip',
    sha256: 'a'.repeat(64), bytes: 1234, releasesUrl: 'http://gitlab.example:8080/team/pivane/-/releases/v1.8.0', ...extra });

test('configured intranet release page survives missing, inapplicable or failed manifests without external checks', async () => {
    const releasesUrl = 'http://gitlab.example:8080/team/pivane/-/releases';
    const env = { BAIZELINGTAI_UPDATE_FEED_URL: feedSource, BAIZELINGTAI_UPDATE_RELEASES_URL: releasesUrl };
    for (const mode of ['missing-link', 'inapplicable', 'error', 'manifest-link']) {
        const requests = [];
        const service = new UpdateService({ env, platform: mode === 'inapplicable' ? 'linux' : 'win32', arch: 'x64',
            fetch: async url => {
                requests.push(url);
                if (mode === 'error') throw Error('offline');
                return { ok: true, json: async () => feed(mode === 'manifest-link' ? {} : { releasesUrl: undefined }) };
            } });
        assert.equal(service.snapshot().pivane.releasesUrl, releasesUrl);
        const data = await service.check();
        assert.deepEqual(requests, [feedSource]);
        const expected = mode === 'manifest-link' ? feed().releasesUrl : releasesUrl;
        assert.equal(data.pivane.releasesUrl, expected);
        assert.equal(data.pi.releasesUrl, expected);
        assert.equal(data.pivane.status, mode === 'error' ? 'error' : mode === 'inapplicable' ? 'no-release' : 'available');
    }
    for (const url of ['https://other.example/releases', 'javascript:alert(1)',
        'http://user:secret@gitlab.example:8080/releases', releasesUrl + '?token=secret']) {
        assert.throws(() => new UpdateService({ env: { ...env, BAIZELINGTAI_UPDATE_RELEASES_URL: url } }), /Invalid update link/);
    }
});

test('intranet checks share one manifest, report bundled Pi and never contact GitHub/npm even on failure', async () => {
    let now = 0;
    const requests = [];
    const service = new UpdateService({ appVersion: '1.7.0', piVersion: '1.1.0', platform: 'win32', arch: 'x64',
        env: { PIVANE_UPDATE_FEED_URL: feedSource }, now: () => now,
        fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => feed() }; } });
    service.notifications = { cachedPi: () => { throw Error('Must not use npm reminder cache'); }, recordSuccess: () => { throw Error('Must not write npm reminder'); } };
    assert.equal(service.snapshot().source.origin, 'http://gitlab.example:8080'); assert.equal(requests.length, 0);
    const first = service.check(); assert.equal(first, service.check());
    const data = await first;
    assert.equal(requests.length, 1); assert.equal(requests[0].url, feedSource);
    assert.equal(data.pivane.version, '1.8.0'); assert.equal(data.pivane.status, 'available');
    assert.equal(data.pivane.packageFormat, 'windows-portable-zip');
    assert.equal(data.pivane.downloadUrl, new URL(feed().package, feedSource).href);
    assert.equal(data.pi.bundled, true); assert.equal(data.pi.status, 'current');
    assert.equal(data.pivane.sha256, 'a'.repeat(64));
    now += 299999; await service.check(); assert.equal(requests.length, 1);
    now++; service.fetch = async url => { requests.push({ url }); throw Error('private error'); };
    const failed = await service.check();
    assert.equal(failed.pivane.status, 'error'); assert.equal(failed.pi.status, 'error');
    assert.equal(requests.length, 2); assert.ok(requests.every(r => r.url === feedSource));
    assert.ok(!JSON.stringify(failed).includes('private error'));
});

test('intranet manifest selects platform/channel and rejects invalid metadata or unrelated download origins', async () => {
    async function check(data, options = {}, channel = 'preview') {
        return new UpdateService({ env: { PIVANE_UPDATE_FEED_URL: feedSource }, platform: 'win32', arch: 'x64',
            fetch: async () => ({ ok: true, json: async () => data }), ...options }).check(channel);
    }
    assert.equal((await check(feed(), { platform: 'linux' })).pivane.status, 'no-release');
    assert.equal((await check(feed(), { arch: 'arm64' })).pivane.status, 'no-release');
    assert.equal((await check(feed({ version: '1.8.0-rc.1', channel: 'preview' }), {}, 'stable')).pivane.status, 'no-release');
    assert.equal((await check(feed({ version: '1.8.0-rc.1', channel: 'preview' }))).pivane.version, '1.8.0-rc.1');
    for (const extra of [{ schemaVersion: 2 }, { version: 'v1.8.0' }, { piVersion: '' }, { sha256: 'wrong' }, { bytes: 0 },
        { platform: 'linux' }, { channel: 'other' }, { version: '1.8.0-rc.1' }, { publishedAt: 'bad' },
        { package: 'https://other.example/app.zip' }, { package: '//evil.example/app.zip' }, { package: 'javascript:alert(1)' },
        { package: 'http://user:secret@gitlab.example:8080/app.zip' }, { package: 'app.tar.gz' },
        { package: 'app.zip?token=private' }, { releasesUrl: 'https://evil.example/page' }]) {
        const result = await check(feed(extra));
        assert.equal(result.pivane.status, 'error', JSON.stringify(extra)); assert.equal(result.pi.status, 'error');
        assert.equal(result.pivane.downloadUrl, undefined);
    }
});

test('portable source persists for distributed installs and explicit deployment configuration takes precedence', t => {
    const { configuredFeed } = require('../server/pi-update-feed');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-feed-config-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.equal(configuredFeed(root, {}), null);
    fs.writeFileSync(path.join(root, 'pivane-portable.json'), JSON.stringify({ version: 1, updateFeedUrl: feedSource }));
    assert.equal(configuredFeed(root, {}), feedSource);
    assert.equal(configuredFeed(root, { PIVANE_UPDATE_FEED_URL: '' }), null);
    const api = 'http://gitlab.example/api/v4/projects/20/repository/files/latest.json/raw?ref=main';
    assert.equal(configuredFeed(root, { PIVANE_UPDATE_FEED_URL: api }), api);
    assert.equal(configuredFeed(root, { BAIZELINGTAI_UPDATE_FEED_URL: api }), api);
    assert.equal(configuredFeed(root, { BAIZELINGTAI_UPDATE_FEED_URL: '', PIVANE_UPDATE_FEED_URL: api }), null);
    for (const url of ['file:///C:/update.json', 'http://user:secret@gitlab.example/feed', 'http://gitlab.example/feed?token=secret', 'http://gitlab.example/feed#secret']) {
        assert.throws(() => configuredFeed(root, { PIVANE_UPDATE_FEED_URL: url }), /feed URL/);
    }
    fs.writeFileSync(path.join(root, 'pivane-portable.json'), '{');
    assert.throws(() => configuredFeed(root, {}), /Cannot read/);
});

test('new baizelingtai metadata supports legacy installs without rewriting either file', t => {
    const { configuredFeed, portableMetadataFile } = require('../server/pi-update-feed');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baizelingtai-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'baizelingtai-portable.json'), legacy = path.join(root, 'pivane-portable.json');
    const bytes = JSON.stringify({ version: 1, updateFeedUrl: feedSource });
    fs.writeFileSync(file, bytes);
    assert.equal(portableMetadataFile(root), file); assert.equal(configuredFeed(root, {}), feedSource);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.equal(fs.existsSync(legacy), false);
    fs.writeFileSync(legacy, bytes);
    assert.throws(() => configuredFeed(root, {}), /Conflicting portable/);
    fs.unlinkSync(file);
    assert.equal(portableMetadataFile(root), legacy); assert.equal(configuredFeed(root, {}), feedSource);
    assert.equal(fs.readFileSync(legacy, 'utf8'), bytes);
});

test('public intranet HTTP transport checks JSON and refuses redirects; ZIP cannot enter the legacy installer', async t => {
    const source = express(); let mode = 'json', lookups = 0;
    source.get('/latest.json', (_req, res) => {
        lookups++;
        if (mode === 'redirect') return res.redirect('/login');
        if (mode === 'html') return res.type('html').send('<html>Sign in</html>');
        res.json(feed({ package: 'portable.zip', releasesUrl: undefined }));
    });
    const remote = source.listen(0, '127.0.0.1'); await once(remote, 'listening');
    const sourceUrl = `http://127.0.0.1:${remote.address().port}/latest.json`;
    let now = 0;
    const service = new UpdateService({ env: { PIVANE_UPDATE_FEED_URL: sourceUrl }, platform: 'win32', arch: 'x64', now: () => now });
    const app = express(); app.use(express.json()); const router = express.Router(); mountUpdateRoutes(router, service); app.use('/api/pi', router);
    const local = app.listen(0, '127.0.0.1'); await once(local, 'listening');
    t.after(async () => { for (const server of [local, remote]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
    assert.equal((await service.check()).pivane.version, '1.8.0'); assert.equal(lookups, 1);
    for (const value of ['redirect', 'html']) {
        mode = value; now += 300000;
        assert.equal((await service.check()).pivane.status, 'error');
    }
    const before = lookups;
    for (const action of ['application', 'update']) {
        const response = await fetch(`http://127.0.0.1:${local.address().port}/api/pi/settings/updates/review`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
        assert.equal(response.status, 409); assert.ok((await response.json()).error.includes('Windows'));
    }
    assert.equal(lookups, before);
});

test('automatic update routes share authenticated preferences, enforce Origin and reject execution input', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-auto-updates-'));
    const preferences = new (require('../server/workspace-preferences-service').WorkspacePreferencesService)({ filePath: path.join(root, 'preferences.json') });
    const access = new WorkspaceAccessService({ filePath: path.join(root, 'access.json'), envToken: () => 'fixture-token-only' });
    const { service, requests } = fixture([]);
    const app = express(); app.use(express.json());
    const router = express.Router(); router.use(access.middleware()); mountUpdateRoutes(router, service, { preferences, idle: () => true }); app.use('/api/pi', router);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { access.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}/api/pi/settings/updates`;
    const headers = { Authorization: 'Bearer fixture-token-only', 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/automatic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(base + '/automatic', { method: 'POST', headers: { ...headers, Origin: 'https://evil.invalid' }, body: '{}' })).status, 403);
    assert.equal((await fetch(base + '/notifications', { headers })).headers.get('cache-control'), 'no-store');
    assert.equal(requests.length, 0);
    for (const body of ['[]', '{"command":"update"}', '{"version":"1.0.0"}']) assert.equal((await fetch(base + '/automatic', { method: 'POST', headers, body })).status, 400);
    const a = await fetch(base + '/automatic', { method: 'POST', headers, body: '{}' });
    assert.equal((await a.json()).available, true); assert.equal(requests.length, 1); assert.ok(requests[0].url.includes('registry.npmjs.org'));
    const snapshot = await fetch(base, { headers }); assert.equal((await snapshot.json()).pi.version, '0.86.0'); assert.equal(requests.length, 1);
    await fetch(base + '/automatic', { method: 'POST', headers, body: '{}' }); assert.equal(requests.length, 1);
    const changed = await fetch(base + '/notifications', { method: 'POST', headers, body: '{"enabled":false}' });
    assert.equal((await changed.json()).enabled, false);
});

test('update comparisons respect SemVer prerelease numbers, build metadata, invalid and ahead versions', () => {
    for (const [a, b, expected] of [['1.0.0-rc.10', '1.0.0-rc.2', 1], ['1.0.0', '1.0.0-rc.10', 1],
        ['1.0.0-alpha', '1.0.0-alpha.1', -1], ['1.0.0-9', '1.0.0-alpha', -1], ['1.0.0+abc', '1.0.0+def', 0],
        ['0.99.0', '0.100.0', -1], ['1.0.0-01', '1.0.0', null], ['1.0', '1.0.0', null], ['v1.0.0', '1.0.0', null],
        ['99999999999999999999.0.0', '99999999999999999998.0.0', 1]]) assert.equal(compareVersions(a, b), expected, `${a}/${b}`);
});

test('local update snapshots never contact sources; stable and preview are distinct and asset links are fixed', async () => {
    const { service, requests } = fixture([release('2.0.0', { draft: true }), release('1.0.0-rc.10'), release('1.0.0-rc.3'), release('0.9.0'), release('../../unsafe')]);
    assert.equal(service.snapshot().pivane.status, 'unchecked');
    assert.equal(service.snapshot().channel, 'preview'); assert.equal(requests.length, 0);
    const preview = await service.check('preview');
    assert.equal(preview.pivane.version, '1.0.0-rc.10'); assert.equal(preview.pivane.status, 'available');
    assert.ok(preview.pivane.downloadUrl.endsWith('pivane-1.0.0-rc.10.tar.gz'));
    assert.equal(preview.pi.status, 'available'); assert.equal(preview.dependencyMatches, false, 'the fixture represents an older runtime than the 0.86 workspace bundle');
    const stable = await service.check('stable');
    assert.equal(stable.pivane.version, '0.9.0'); assert.equal(stable.pivane.status, 'ahead');
    assert.equal((await service.check()).pivane.version, '1.0.0-rc.10', 'default lookup includes prereleases even for stable local versions');
    for (const { opts } of requests) {
        assert.equal(opts.redirect, 'error'); assert.equal(opts.size, 2 * 1024 * 1024);
        assert.deepEqual(Object.keys(opts.headers).sort(), ['Accept', 'User-Agent']);
    }
});

test('concurrent checks and repeated failure checks are coalesced and cached for five minutes', async () => {
    let now = 0;
    const { service, requests } = fixture([release('1.0.0-rc.2')], { now: () => now });
    const first = service.check('preview'); assert.equal(first, service.check('preview'));
    const [a, b] = await Promise.all([first, service.check('preview')]);
    assert.deepEqual(a, b); assert.equal(requests.length, 2); assert.equal(a.pivane.status, 'current');
    now += 299999; await service.check('preview'); assert.equal(requests.length, 2);
    now += 1; await service.check('preview'); assert.equal(requests.length, 4);
    assert.equal(service.inflight.size, 0);
});

test('missing stable releases, partial failure and mismatched dependencies remain explicit without raw errors', async () => {
    const empty = fixture([release('1.0.0-rc.3')]);
    assert.equal((await empty.service.check('stable')).pivane.status, 'no-release');
    let calls = 0;
    const { service } = fixture([], { piVersion: '0.84.0', fetch: async url => {
        calls++;
        if (url.includes('github')) throw new Error('secret proxy password must not appear');
        return { ok: true, json: async () => ({ name: '@earendil-works/pi-coding-agent', version: '0.86.0' }) };
    } });
    const result = await service.check('stable');
    assert.equal(result.pivane.status, 'error'); assert.equal(result.pi.status, 'available');
    assert.equal(result.dependencyMatches, false); assert.ok(!JSON.stringify(result).includes('secret'));
    await service.check('stable'); assert.equal(calls, 2);
});

test('invalid remote payloads and hostile release URLs never become download links', async () => {
    const bad = release('1.1.0'); bad.assets[0].browser_download_url = 'https://evil.invalid/payload';
    const result = await fixture([bad]).service.check('stable');
    assert.equal(result.pivane.downloadUrl, null); assert.ok(result.pivane.checksumUrl);
    for (const data of [{ message: 'failure' }, null, '1.2.3']) {
        const { service } = fixture([], { fetch: async () => ({ ok: true, json: async () => data }) });
        const r = await service.check('stable'); assert.equal(r.pivane.status, 'error'); assert.equal(r.pi.status, 'error');
    }
    assert.throws(() => fixture([]).service.check('https://evil.invalid'), /channel/);
});

test('update transport honors explicit HTTP proxies and NO_PROXY without exposing proxy configuration', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:8080' };
    const agent = proxyFor('https://api.github.com', env); assert.ok(agent); agent.destroy();
    for (const value of ['*', 'api.github.com', '.github.com', '*.github.com', 'api.github.com:443']) {
        assert.equal(proxyFor('https://api.github.com', { ...env, NO_PROXY: value }), undefined);
    }
    assert.equal(proxyFor('https://api.github.com', {}), undefined);
    assert.throws(() => proxyFor('https://api.github.com', { HTTPS_PROXY: 'socks://localhost' }));
});

test('update endpoints enforce workspace identity, Origin, strict channels and no-store without writing data', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-updates-test-'));
    const access = new WorkspaceAccessService({ filePath: path.join(root, 'access.json'), envToken: () => 'fixture-token-only' });
    const { service, requests } = fixture([release('1.1.0')]);
    const app = express(); app.use(express.json());
    const router = express.Router(); router.use(access.middleware()); mountUpdateRoutes(router, service); app.use('/api/pi', router);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { access.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const auth = { Authorization: 'Bearer fixture-token-only', 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/api/pi/settings/updates')).status, 401);
    assert.equal((await fetch(base + '/api/pi/settings/updates/check', { method: 'POST', headers: { ...auth, Origin: 'https://evil.invalid' }, body: '{}' })).status, 403);
    const local = await fetch(base + '/api/pi/settings/updates', { headers: auth });
    assert.equal(local.status, 200); assert.equal(local.headers.get('cache-control'), 'no-store');
    assert.equal((await local.json()).checkedAt, null); assert.equal(requests.length, 0);
    for (const query of ['?channel=bad', '?channel[]=stable', '?url=https://evil.invalid']) assert.equal((await fetch(base + '/api/pi/settings/updates' + query, { headers: auth })).status, 400);
    for (const body of ['[]', '{"channel":null}', '{"channel":"stable","command":"install"}']) {
        assert.equal((await fetch(base + '/api/pi/settings/updates/check', { method: 'POST', headers: auth, body })).status, 400);
    }
    const checked = await fetch(base + '/api/pi/settings/updates/check', { method: 'POST', headers: auth, body: '{"channel":"stable"}' });
    assert.equal(checked.status, 200); assert.equal((await checked.json()).pivane.status, 'available');
    assert.equal(requests.length, 2); assert.deepEqual(fs.readdirSync(root), []);
});
