const fetch = require('node-fetch');
const { proxyAgent: proxyFor } = require('./workspace-network-transport');
const application = require('../package.json');
const path = require('node:path');
const { configuredFeed, parseFeed, sourceLink } = require('./pi-update-feed');
const { version: installedPi } = require('../node_modules/@earendil-works/pi-coding-agent/package.json');

const RELEASES = 'https://api.github.com/repos/zblzbl1991/baizelingtai-pi/releases?per_page=100';
const PI_LATEST = 'https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest';
const RELEASE_PAGE = 'https://github.com/zblzbl1991/baizelingtai-pi/releases';
const PI_PAGE = 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent';
const TTL = 5 * 60 * 1000;

function versionParts(value) {
    if (typeof value !== 'string' || value.length > 100) return null;
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
    if (!match) return null;
    const pre = match[4]?.split('.') || [];
    if (pre.some(p => /^\d+$/.test(p) && p.length > 1 && p[0] === '0')) return null;
    return { core: match.slice(1, 4).map(BigInt), pre };
}
function compareVersions(a, b) {
    const x = versionParts(a), y = versionParts(b);
    if (!x || !y) return null;
    for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
    if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
        const p = x.pre[i], q = y.pre[i];
        if (p === q) continue;
        if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
        const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
        if (pn && qn) return BigInt(p) > BigInt(q) ? 1 : -1;
        if (pn !== qn) return pn ? -1 : 1;
        return p > q ? 1 : -1;
    }
    return 0;
}
function relation(current, latest) {
    const comparison = compareVersions(current, latest);
    return comparison === null ? 'unknown' : comparison < 0 ? 'available' : comparison > 0 ? 'ahead' : 'current';
}

class UpdateService {
    stopReadiness() { return this.inflight.size + Number(Boolean(this.notifications?.pending)); }
    constructor(options = {}) {
        this.fetch = options.fetch || fetch;
        this.env = options.env || process.env;
        this.now = options.now || Date.now;
        this.appVersion = options.appVersion || application.version;
        this.piVersion = options.piVersion || installedPi;
        this.bundledPiVersion = application.pivaneManaged?.baselinePi || application.dependencies['@earendil-works/pi-coding-agent'];
        this.platform = options.platform || process.platform;
        this.arch = options.arch || process.arch;
        this.feed = configuredFeed(options.root || path.resolve(__dirname, '..'), this.env);
        this.releasesPage = this.feed ? sourceLink(this.env.BAIZELINGTAI_UPDATE_RELEASES_URL || this.feed, this.feed) : RELEASE_PAGE;
        this.feedPending = new Map();
        this.cache = new Map();
        this.inflight = new Map();
    }
    snapshot(channel = 'preview') {
        if (!['stable', 'preview'].includes(channel)) throw Object.assign(new Error('Invalid update channel'), { status: 400 });
        const cached = this.cache.get(channel);
        const automatic = this.feed ? null : this.notifications?.cachedPi();
        const pi = automatic && (!cached || automatic.checkedAt > Date.parse(cached.checkedAt))
            ? { version: automatic.version, status: relation(this.piVersion, automatic.version), releasesUrl: PI_PAGE }
            : cached?.pi;
        return {
            channel, platform: this.platform, installMode: 'manual',
            source: this.feed ? { type: 'manifest', url: this.feed, origin: new URL(this.feed).origin } : { type: 'official' },
            appVersion: this.appVersion, piVersion: this.piVersion, bundledPiVersion: this.bundledPiVersion,
            dependencyMatches: this.piVersion === (application.pivaneManaged?.piVersion || this.bundledPiVersion),
            managedPi: Boolean(application.pivaneManaged),
            checkedAt: cached?.checkedAt || null,
            cacheUntil: cached ? new Date(cached.expires).toISOString() : null,
            pivane: cached?.pivane || { status: 'unchecked', releasesUrl: this.releasesPage },
            pi: pi || { status: 'unchecked', releasesUrl: this.feed ? this.releasesPage : PI_PAGE, ...(this.feed ? { bundled: true } : {}) }
        };
    }
    async json(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        let agent;
        try {
            agent = proxyFor(url, this.env);
            const response = await this.fetch(url, {
                method: 'GET', redirect: 'error', size: 2 * 1024 * 1024, signal: controller.signal, agent,
                headers: { Accept: 'application/json', 'User-Agent': 'Pivane-Update-Check' }
            });
            if (!response.ok) throw new Error('Remote lookup failed');
            return await response.json();
        } finally { clearTimeout(timer); agent?.destroy(); }
    }
    async pivane(channel) {
        if (this.feed) {
            const candidate = await this.manifest(channel);
            return candidate ? { ...candidate, status: relation(this.appVersion, candidate.version) }
                : { status: 'no-release', releasesUrl: this.releasesPage };
        }
        const releases = await this.json(RELEASES);
        if (!Array.isArray(releases) || releases.length > 100) throw new Error('Invalid release list');
        const candidates = releases.flatMap(release => {
            if (!release || release.draft || typeof release.tag_name !== 'string') return [];
            const version = release.tag_name.replace(/^v/, '');
            const parsed = versionParts(version);
            if (!parsed || (channel === 'stable' && (release.prerelease || parsed.pre.length))) return [];
            // Only expose fixed official asset paths. Remote HTML/URLs never become executable UI.
            const base = `${RELEASE_PAGE}/download/${encodeURIComponent(release.tag_name)}/`;
            const archive = `pivane-${version}.tar.gz`;
            const assets = Array.isArray(release.assets) ? release.assets : [];
            const asset = name => assets.some(a => a?.name === name && a.state === 'uploaded' && a.browser_download_url === base + name) ? base + name : null;
            return [{ version, prerelease: Boolean(release.prerelease || parsed.pre.length),
                releasesUrl: `${RELEASE_PAGE}/tag/${encodeURIComponent(release.tag_name)}`,
                downloadUrl: asset(archive), checksumUrl: asset(archive + '.sha256') }];
        }).sort((a, b) => compareVersions(b.version, a.version));
        if (!candidates.length) return { status: 'no-release', releasesUrl: RELEASE_PAGE };
        const latest = candidates[0];
        return { ...latest, status: relation(this.appVersion, latest.version) };
    }
    manifest(channel = 'preview') {
        if (this.feedPending.has(channel)) return this.feedPending.get(channel);
        const pending = Promise.resolve().then(async () => parseFeed(await this.json(this.feed), {
            source: this.feed, platform: this.platform, arch: this.arch, channel, compareVersions, releasesUrl: this.releasesPage
        })).finally(() => this.feedPending.delete(channel));
        this.feedPending.set(channel, pending);
        return pending;
    }
    async pi(channel) {
        if (this.feed) {
            const candidate = await this.manifest(channel);
            return candidate ? { status: relation(this.piVersion, candidate.piVersion), version: candidate.piVersion,
                bundled: true, releasesUrl: candidate.releasesUrl } : { status: 'no-release', bundled: true, releasesUrl: this.releasesPage };
        }
        const data = await this.json(PI_LATEST);
        if (data?.name !== '@earendil-works/pi-coding-agent' || !versionParts(data.version) || versionParts(data.version).pre.length) throw new Error('Invalid package version');
        return { status: relation(this.piVersion, data.version), version: data.version, releasesUrl: PI_PAGE };
    }
    check(channel) {
        this.snapshot(channel); // Validate before any network access.
        channel ||= 'preview';
        if (this.inflight.has(channel)) return this.inflight.get(channel);
        if (this.cache.get(channel)?.expires > this.now()) return Promise.resolve(this.snapshot(channel));
        // Reserve synchronously, before network requests; callers share one check per channel.
        const pending = Promise.resolve().then(async () => {
            const results = await Promise.allSettled([this.pivane(channel), this.pi(channel)]);
            this.cache.set(channel, {
                checkedAt: new Date(this.now()).toISOString(), expires: this.now() + TTL,
                pivane: results[0].status === 'fulfilled' ? results[0].value : { status: 'error', releasesUrl: this.releasesPage },
                pi: results[1].status === 'fulfilled' ? results[1].value : { status: 'error', releasesUrl: this.feed ? this.releasesPage : PI_PAGE, ...(this.feed ? { bundled: true } : {}) }
            });
            if (!this.feed && results[1].status === 'fulfilled') {
                try { this.notifications?.recordSuccess(results[1].value); } catch { /* Manual version lookup remains usable if reminder storage is unavailable. */ }
            }
            return this.snapshot(channel);
        }).finally(() => this.inflight.delete(channel));
        this.inflight.set(channel, pending);
        return pending;
    }
}
function mountUpdateRoutes(router, service = new UpdateService(), hooks = {}) {
    const maintenance = hooks.maintenance || new (require('./pi-maintenance-client').MaintenanceClient)({ managed: false });
    const idle = hooks.idle || (() => false);
    const notifications = hooks.preferences ? new (require('./pi-update-notifications').UpdateNotifications)({ preferences: hooks.preferences, service, idle: () => !maintenance.locked && idle() }) : null;
    service.notifications = notifications;
    const notificationRoute = action => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            if (!notifications) return res.status(503).json({ error: 'Update reminders unavailable' });
            if (action === 'check' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) {
                return res.status(400).json({ error: 'Invalid update notification request' });
            }
            res.json(action === 'check' ? await notifications.check() : action === 'change' ? notifications.change(req.body) : notifications.snapshot());
        } catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : 'Update reminders unavailable' }); }
    };
    router.get('/settings/updates/notifications', notificationRoute('read'));
    router.post('/settings/updates/notifications', notificationRoute('change'));
    router.post('/settings/updates/automatic', notificationRoute('check'));
    router.get('/settings/updates/maintenance', (_req, res) => res.set('Cache-Control', 'no-store').json(maintenance.status()));
    router.post('/settings/updates/review', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        let leave;
        try {
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(key => !['action', 'channel'].includes(key))) throw Object.assign(new Error('维护操作无效'), { status: 400 });
            const action = req.body.action;
            if (req.body.channel !== undefined && (action !== 'application' || !['stable', 'preview'].includes(req.body.channel))) throw Object.assign(new Error('Invalid update channel'), { status: 400 });
            if (!['update', 'application', 'backup', 'restart'].includes(action)) throw Object.assign(new Error('维护操作无效'), { status: 400 });
            if (service.feed && (action === 'update' || action === 'application' && !maintenance.status().portableUpdateSupported)) throw Object.assign(new Error('当前启动方式不支持 Windows 内网整包自动更新，请使用便携版受管启动器或独立维护窗口'), { status: 409 });
            maintenance.assertAvailable(action, idle);
            leave = maintenance.enter(); // Reserve before remote lookup; execute/review cannot race it.
            let version, release;
            if (action === 'application') {
                const channel = req.body.channel || (service.appVersion.includes('-') ? 'preview' : 'stable');
                service.snapshot(channel);
                const candidate = await service.pivane(channel);
                if (candidate.status !== 'available' || !candidate.downloadUrl || !service.feed && !candidate.checksumUrl) throw Object.assign(new Error('此渠道没有可安装的白泽灵台新版本'), { status: 409 });
                version = candidate.version;
                if (service.feed) {
                    release = { format: 'windows-portable-zip', feed: service.feed, channel, version, piVersion: candidate.piVersion,
                        downloadUrl: candidate.downloadUrl, bytes: candidate.bytes, sha256: candidate.sha256 };
                    if (!require('./pi-portable-installer').validPortable(release, service.feed)) throw Error('Invalid portable release');
                } else {
                    const bytes = await require('./pi-application-installer').download(candidate.checksumUrl, { env: service.env, maxBytes: 1024 });
                    const match = /^([a-f0-9]{64})  (pivane-[^\r\n]+\.tar\.gz)\r?\n?$/.exec(bytes.toString());
                    if (!match || match[2] !== `pivane-${candidate.version}.tar.gz`) throw Error('Invalid release checksum');
                    release = { version, sha256: match[1] };
                }
            }
            if (action === 'update') {
                if (require('../package.json').pivaneCompatibility?.piVersion) throw Object.assign(new Error('当前白泽灵台与已验证 Pi 版本绑定，请一起更新白泽灵台及原生适配，不单独升级 Pi'), { status: 409 });
                const upstream = await service.pi(); version = upstream.version;
                if (compareVersions(service.piVersion, version) !== -1) throw Object.assign(new Error('没有高于当前版本的 Pi 正式版'), { status: 409 });
            }
            leave(); leave = null;
            res.json({ ...maintenance.review({ action, version, release }, idle), currentVersion: action === 'application' ? service.appVersion : service.piVersion });
        } catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : '无法核对更新版本，请稍后再试' }); }
        finally { leave?.(); }
    });
    router.post('/settings/updates/execute', (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.status(202).json(maintenance.execute(req.body, { idle, pause: hooks.pause || (() => {}) })); }
        catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : '维护提交失败，请查看状态后再决定' }); }
    });
    const route = check => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const params = check ? req.body : req.query;
            if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => key !== 'channel')
                || params.channel !== undefined && !['stable', 'preview'].includes(params.channel)) {
                return res.status(400).json({ error: 'Invalid update channel' });
            }
            const snapshot = check ? await service.check(params.channel) : service.snapshot(params.channel);
            res.json({ ...snapshot, maintenance: maintenance.status() });
        } catch { res.status(503).json({ error: 'Update information unavailable' }); }
    };
    router.get('/settings/updates', route(false));
    router.post('/settings/updates/check', route(true));
}
module.exports = { UpdateService, mountUpdateRoutes, compareVersions, proxyFor };
