// Passive evidence for isolated browser fixtures. Never log page text, request
// bodies, query strings, fragments, credentials or raw console/error messages.
const fs = require('node:fs'), path = require('node:path');

async function bounded(operation, ms) {
    let timer;
    try { return await Promise.race([operation(), new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: 'diagnostic-timeout' }), ms); })]); }
    catch { return { unavailable: 'page-unavailable' }; }
    finally { clearTimeout(timer); }
}

async function browserFailureDiagnostics(page, { name, width, locale }) {
    const started = performance.now(), phases = [], pending = new Map(); let omitted = 0;
    let selectors = ['#artifacts-tab', '.artifacts-star'];
    const phaseRecord = label => { if (phases.length === 30) phases.shift(); phases.push({ ms: Math.round(performance.now() - started), label }); };
    const resource = request => {
        try { const url = new URL(request.url()); return /^https?:$/.test(url.protocol)
            ? { host: url.host.slice(0, 100), path: url.pathname.slice(0, 180), type: request.resourceType() } : null; }
        catch { return null; }
    };
    page.on('request', request => { const value = resource(request); if (!value) return; if (pending.size >= 40) { omitted++; return; } pending.set(request, value); });
    page.on('requestfinished', request => pending.delete(request));
    page.on('requestfailed', request => pending.delete(request));
    page.on('domcontentloaded', () => phaseRecord('domcontentloaded'));
    page.on('load', () => phaseRecord('load'));
    await page.addInitScript(() => {
        const probes = [];
        const elements = selectors => selectors.slice(0, 6).map(selector => {
            const node = document.querySelector(selector), rect = node?.getBoundingClientRect(), style = node && getComputedStyle(node);
            return { selector, exists: Boolean(node), connected: node?.isConnected || false, disabled: node ? Boolean(node.disabled) : null,
                rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
                style: style ? { display: style.display, visibility: style.visibility } : null };
        });
        const begin = (label, selectors) => {
            const probe = { label, started: performance.now(), timer: null, frame1: null, frame2: null };
            if (probes.length === 8) probes.shift(); probes.push(probe);
            // These observe independent scheduling; they do not await or force a frame.
            setTimeout(() => { probe.timer = Math.round(performance.now() - probe.started); }, 0);
            requestAnimationFrame(() => { probe.frame1 = { ms: Math.round(performance.now() - probe.started), elements: elements(selectors) };
                requestAnimationFrame(() => { probe.frame2 = { ms: Math.round(performance.now() - probe.started), elements: elements(selectors) }; }); });
        };
        window.__fixtureFailureDiagnostic = { begin, snapshot(selectors) {
            const animations = document.getAnimations();
            return { readyState: document.readyState, visibility: document.visibilityState, hidden: document.hidden, focus: document.hasFocus(),
                width: innerWidth, height: innerHeight, fonts: document.fonts ? { status: document.fonts.status, count: document.fonts.size } : null,
                animations: { count: animations.length, running: animations.filter(animation => animation.playState === 'running').length },
                elements: elements(selectors), probes };
        } };
        begin('document:init', ['#artifacts-tab', '.artifacts-star']);
    });
    return {
        phase(label, nextSelectors) {
            if (nextSelectors) selectors = nextSelectors.slice(0, 6);
            phaseRecord(label);
            // Do not block the original action on diagnostic frame/timer delivery.
            void page.evaluate(({ label, selectors }) => window.__fixtureFailureDiagnostic?.begin(label, selectors), { label, selectors }).catch(() => {});
        },
        async failure() {
            phaseRecord('failure');
            const snapshot = await bounded(() => page.evaluate(selectors => window.__fixtureFailureDiagnostic?.snapshot(selectors), selectors), 2000);
            console.error('[DEBUG-browser-failure] ' + JSON.stringify({ name, width, locale, phases, pending: [...pending.values()], omitted, snapshot }));
            const directory = process.env.ARTIFACT_SCREENSHOT_DIR || process.env.PIVANE_TEST_SCREENSHOT_DIR;
            if (directory) {
                try { fs.mkdirSync(directory, { recursive: true }); await page.screenshot({ path: path.join(directory, `${name}-failure-${width}-${locale}.png`), timeout: 3000 }); }
                catch { console.error('[DEBUG-browser-failure] failure screenshot unavailable'); }
            }
        }
    };
}

module.exports = { browserFailureDiagnostics };
