// Run the self-contained Chromium regressions in test/browser serially. Scripts that
// read a *_URL variable get a loopback server with the same static and vendor mounts as
// server.js; their APIs stay mocked by the script. "pivane-browser: manual" scripts need a
// real isolated backend or release archive and are only run by hand.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sourceFiles } = require('./source-files.cjs');
const { testEnvironment } = require('./run-tests.cjs');
const root = path.resolve(__dirname, '..');
const usage = 'Usage: PLAYWRIGHT_MODULE=/path/to/playwright npm run test:browser -- [--list] [--target=desktop|all] [test/browser/file.cjs ...]';
const TIMEOUT_MS = 300000;

function selectBrowserTests(root, args, officeTarget) {
    let list = false, target = 'all';
    const selectors = [];
    for (const arg of args) {
        if (arg === '--list') list = true;
        else if (arg.startsWith('--target=')) target = require('../test/browser/targets.cjs').target(arg.slice(9));
        else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}\n${usage}`);
        else selectors.push(arg.replace(/\\/g, '/').replace(/^\.\//, ''));
    }
    const runnable = sourceFiles(root, 'browser').filter(file => {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        return /chromium\.launch/.test(source) && !/pivane-browser:\s*(?:manual|helper)\b/.test(source);
    });
    for (const selector of selectors) if (!runnable.includes(selector)) throw new Error(`Not a runnable browser test: ${selector}\n${usage}`);
    const policy = require('../server/office-preview/inventory').officePreviewPlatform(officeTarget);
    const selected = selectors.length ? runnable.filter(file => selectors.includes(file)) : runnable, skipped = [];
    const files = selected.filter(file => {
        if (policy.supported || !/pivane-browser:\s*office-native\b/.test(fs.readFileSync(path.join(root, file), 'utf8'))) return true;
        skipped.push({ file, reason: `not applicable: requires Windows x64 native Office engine (current ${policy.platform})` }); return false;
    });
    return { files, list, ...(target !== 'all' ? {target} : {}), ...(skipped.length ? { skipped } : {}) };
}

function staticServer() {
    const express = require('express'), app = express();
    for (const [route, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) {
        app.use('/vendor/' + route, express.static(path.join(root, 'node_modules', directory)));
    }
    for (const directory of ['legacy/build', 'cmaps', 'standard_fonts', 'wasm']) {
        app.use('/vendor/pdfjs/' + directory, express.static(path.join(root, 'node_modules/pdfjs-dist', directory), { index: false }));
    }
    app.use(express.static(path.join(root, 'public')));
    return new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
}

function runOne(file, env) {
    return new Promise(resolve => {
        const started = Date.now(), child = spawn(process.execPath, ['--require', path.join(root, 'test/browser/target-guard.cjs'), file], { cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const keep = data => { output = (output + data).slice(-64 * 1024); };
        child.stdout.on('data', keep); child.stderr.on('data', keep);
        const kill = () => { try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } };
        const timer = setTimeout(() => { output += `\nTimed out after ${TIMEOUT_MS / 1000}s`; kill(); }, TIMEOUT_MS);
        child.on('close', code => { clearTimeout(timer); kill(); resolve({ ok: code === 0, seconds: Math.round((Date.now() - started) / 1000), output }); });
    });
}

async function main(args) {
    const { files, list, target = 'all', skipped = [] } = selectBrowserTests(root, args);
    for (const item of skipped) console.log(`SKIP ${item.file}: ${item.reason}`);
    if (list) { console.log(files.join('\n')); return 0; }
    console.log('Browser target: ' + target);
    if (!files.length) { console.log(`0/0 browser tests passed; ${skipped.length} skipped`); return 0; }
    try { require.resolve(process.env.PLAYWRIGHT_MODULE || 'playwright'); } catch { throw new Error(`Playwright is not resolvable.\n${usage}`); }
    const server = await staticServer(), base = `http://127.0.0.1:${server.address().port}`;
    const failed = [];
    try {
        for (const file of files) {
            const env = { ...testEnvironment(process.env), PIVANE_TEST_HERMES_BUNDLE: require('../server/pi-bundled-capabilities').memoryBundle() };
            env.PIVANE_BROWSER_TARGET = target;
            env.PIVANE_TEST_SCREENSHOT_DIR = path.join(os.tmpdir(), 'pivane-browser', path.basename(file, '.cjs'));
            const source = fs.readFileSync(path.join(root, file), 'utf8');
            for (const [, name] of source.matchAll(/process\.env\.([A-Z0-9_]+_URL)\b/g)) env[name] = base;
            const audit = path.join(os.tmpdir(), 'pivane-browser-audit-' + require('node:crypto').randomUUID());
            env.PIVANE_BROWSER_AUDIT_FILE = audit;
            const result = await runOne(file, env);
            const contexts = fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
            fs.rmSync(audit, { force: true });
            if (target === 'desktop' && contexts.length === 0) { result.ok = false; result.output += '\nNo desktop browser context was executed'; }
            if (target === 'desktop') console.log('Desktop viewport audit: ' + contexts.map(row => row.width).join(',') + '; mobile=0');
            console.log(`${result.ok ? 'PASS' : 'FAIL'} ${file} (${result.seconds}s)`);
            if (!result.ok) { failed.push(file); console.log(result.output.trim().split('\n').slice(-30).join('\n')); }
        }
    } finally { server.close(); }
    console.log(`${files.length - failed.length}/${files.length} browser tests passed${failed.length ? '; failed: ' + failed.join(', ') : ''}${skipped.length ? '; ' + skipped.length + ' skipped' : ''}`);
    return failed.length ? 1 : 0;
}

module.exports = { selectBrowserTests };
if (require.main === module) {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
