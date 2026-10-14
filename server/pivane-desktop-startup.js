const http = require('node:http');
const path = require('node:path');
const { randomInt } = require('node:crypto');
const { readSafe } = require('./pi-maintenance-files');

// A loopback-only waiting page belongs to this desktop launch, not the workspace
// port. It never discovers an existing process or accepts service control commands.
async function createDesktopStartup({ root, reservedPorts = [], failureViewMs = 5000, readyLifetimeMs = 120000 } = {}) {
    const files = new Map([
        ['/', ['desktop-startup.html', 'text/html; charset=utf-8']],
        ['/startup.css', ['desktop-startup.css', 'text/css; charset=utf-8']],
        ['/startup.js', ['desktop-startup.js', 'text/javascript; charset=utf-8']],
        ['/brand.png', ['brand/logo-64.png', 'image/png']],
        ['/brand-horizontal.svg', ['brand/logo-horizontal.svg', 'image/svg+xml']],
        ['/brand-horizontal-dark.svg', ['brand/logo-horizontal-dark.svg', 'image/svg+xml']]
    ].map(([route, [file, type]]) => [route, { bytes: readSafe(path.join(root, 'public', file), 128 * 1024), type }]));
    let state = { state: 'starting' }, url, closing, retirement;
    let viewed;
    const failureViewed = new Promise(resolve => { viewed = resolve; });
    const server = http.createServer({ maxHeaderSize: 8192 }, (request, response) => {
        if (closing) response.setHeader('Connection', 'close');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        if (!url || request.headers.host !== new URL(url).host || request.headers.origin && request.headers.origin !== new URL(url).origin) {
            response.writeHead(403); response.end(); return;
        }
        if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
        if (request.url === '/status') {
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            // Wait for a browser to receive failure before closing its local page.
            if (state.state === 'error' && request.method === 'GET') response.once('finish', viewed);
            response.end(request.method === 'HEAD' ? undefined : JSON.stringify(state));
            return;
        }
        const file = files.get(request.url);
        if (!file) { response.writeHead(404); response.end(); return; }
        response.setHeader('Content-Type', file.type);
        response.end(request.method === 'HEAD' ? undefined : file.bytes);
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.setTimeout(5000, socket => socket.destroy());
    // ManagedLauncher reserves one port in 40000..59999 for the installation
    // lock. Keep temporary HTTP listeners outside that range to avoid self-conflict.
    for (let attempt = 0; attempt < 32; attempt++) {
        try {
            await new Promise((resolve, reject) => {
                const failed = error => { server.off('listening', listening); reject(error); };
                const listening = () => { server.off('error', failed); resolve(); };
                server.once('error', failed); server.once('listening', listening);
                server.listen(attempt === 0 ? 0 : randomInt(60000, 65536), '127.0.0.1');
            });
        } catch (error) { if (error.code === 'EADDRINUSE') continue; throw error; }
        const port = server.address().port;
        if ((port < 40000 || port >= 60000) && !reservedPorts.includes(port)) { url = `http://127.0.0.1:${port}/`; break; }
        await new Promise(resolve => server.close(resolve));
    }
    if (!url) throw Error('Unable to allocate the desktop startup page port.');
    server.on('error', () => { /* Request failures never turn startup into readiness. */ });
    function close({ allowFailureView = false } = {}) {
        if (!closing) closing = Promise.resolve().then(async () => {
            clearTimeout(retirement);
            if (allowFailureView && state.state === 'error') {
                let timer;
                try { await Promise.race([failureViewed, new Promise(resolve => { timer = setTimeout(resolve, failureViewMs); })]); }
                finally { clearTimeout(timer); }
            }
            await new Promise((resolve, reject) => {
                // Existing keep-alive clients can keep polling after close() stops
                // accepting new connections. Bound disposal of our own HTTP sockets.
                const drain = setTimeout(() => server.closeAllConnections(), 5000);
                server.close(error => { clearTimeout(drain); error ? reject(error) : resolve(); });
                server.closeIdleConnections();
            });
        });
        return closing;
    }
    return {
        url,
        ready(target) {
            const parsed = new URL(target);
            if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw Error('Invalid workspace URL.');
            if (state.state !== 'starting' || closing) return;
            state = { state: 'ready', url: parsed.href };
            retirement = setTimeout(() => { void close().catch(() => {}); }, readyLifetimeMs);
            retirement.unref();
        },
        fail(message) { if (state.state === 'starting') state = { state: 'error', message: String(message).slice(0, 2048) }; },
        close
    };
}

module.exports = { createDesktopStartup };
