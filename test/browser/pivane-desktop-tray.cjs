// Real Windows tray + controlled runner + service + browser, synthetic identity only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createApplication } = require('../desktop-launcher-fixture.cjs');
const { selectBrowserTargets } = require('./targets.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    if (process.platform !== 'win32') { console.log('SKIP Windows native tray assembly'); return; }
    const { root, base, env } = createApplication();
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
    fs.writeFileSync(path.join(root, '.pivane-launcher-stay'), 'synthetic assembly');
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(root, 'scripts/desktop-tray.ps1'), '-AppRoot', root, '-NodePath', process.execPath, '-NoOpen', '-SmokeTest'],
    { cwd: root, env: { ...env, PSModulePath: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { diagnostic = (diagnostic + value).slice(-8192); });
    const exited = new Promise(resolve => child.once('close', code => resolve(code)));
    const state = () => { try { return JSON.parse(fs.readFileSync(path.join(root, '.pivane-runtime/desktop/smoke-state.json'), 'utf8')); } catch { return null; } };
    const command = action => fs.writeFileSync(path.join(root, '.pivane-launcher-command.json'), JSON.stringify({ id: randomUUID(), action }));
    async function wait(predicate) {
        const until = Date.now() + 45000;
        while (Date.now() < until) {
            const current = state();
            if (current && predicate(current)) return current;
            if (child.exitCode !== null) throw Error(`Tray exited ${child.exitCode}: ${diagnostic}`);
            await pause(40);
        }
        throw Error(`Tray state timeout: ${JSON.stringify(state())} ${diagnostic}`);
    }
    const pageErrors = []; let retainedContext, workbenchClosed, failed = false;
    try {
        const initial = await wait(value => value.waitingUrl);
        const widths = selectBrowserTargets([1440, 390]);
        for (const width of widths) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
            try {
                const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
                let reads = 0;
                await page.route(new URL('status', initial.waitingUrl).href, async route => {
                    reads++; if (reads === 1) await route.abort('timedout'); else await route.continue();
                });
                await page.goto(initial.waitingUrl, { waitUntil: 'domcontentloaded' });
                await page.waitForFunction(() => document.getElementById('startup-title')?.textContent === '正在重新连接');
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
                const ready = await wait(value => value.state === 'ready' && !value.pending);
                const actual = await fetch(new URL('status', initial.waitingUrl)).then(response => response.json());
                assert.equal(actual.generation, ready.generation);
                await page.waitForURL(actual.url);
                assert.equal(await page.title(), '白泽灵台');
                assert.ok(reads >= 2, 'read-only recovery reaches actual current service');
                if(width===widths.at(-1)){
                    const created=await fetch(new URL('api/pi/sessions',actual.url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cwd:root,name:'Synthetic browser idle workbench'})});
                    assert.equal(created.status,201);const session=await created.json();
                    const socketOpened=page.waitForEvent('websocket',{predicate:socket=>socket.url().endsWith('/api/pi/ws')});
                    const workbench=new URL(actual.url);workbench.hash='/chat?'+new URLSearchParams({cwd:root,sessionId:session.id});
                    await page.goto(workbench.href);
                    const socket=await socketOpened;
                    workbenchClosed=new Promise(resolve=>socket.on('close',resolve));
                    await page.waitForFunction(()=>document.getElementById('pi-connection-text')?.textContent==='已连接');
                    // Finish bootstrap reads before obtaining a stop ticket bound to work activity.
                    await page.waitForLoadState('networkidle');
                    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
                    retainedContext=context;
                }
            } finally { if(context!==retainedContext)await context.close(); }
        }
        const first = await wait(value => value.state === 'ready' && !value.pending);
        let reviewed;
        for(let attempt=0;attempt<5;attempt++){
            const previous=state().reviewId;command('stop');
            reviewed=await wait(value=>{
                if(value.reviewId!==previous&&!value.pending)return true;
                // A periodic snapshot can occupy the tray between two smoke reports.
                // Re-ask only the read-only review; never replay stop execution.
                if(!value.pending&&!value.confirm)command('stop');
                return false;
            });
            if(reviewed.confirm)break;
            // Bootstrap resource reads may still be finishing after the socket
            // opens. A blocked review ends; explicitly ask again only once the
            // native read-only projection reports that work has finished.
            await wait(value=>value.blockers.startsWith('当前没有阻碍事项。')&&!value.pending);
        }
        assert.equal(reviewed.confirm,true,'an idle rendered workbench can be reviewed without closing its socket');
        command('confirm'); await wait(value => value.state === 'stopped');
        await workbenchClosed;
        await retainedContext.close();retainedContext=null;
        assert.equal(child.exitCode, null, 'actual service stop retains the native tray');
        const width = widths.at(-1);
        const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 900 });
        try {
            const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
            await page.goto(initial.waitingUrl);
            await page.waitForFunction(() => document.body.dataset.state === 'stopped');
            command('start');
            const second = await wait(value => value.state === 'ready' && value.generation !== first.generation);
            assert.equal(second.waitingUrl, initial.waitingUrl);
            const actual = await fetch(new URL('status', initial.waitingUrl)).then(response => response.json());
            await page.waitForURL(actual.url);
            assert.equal(await page.title(), '白泽灵台');
        } finally { await context.close(); }
        assert.deepEqual(pageErrors, []);
        console.log(JSON.stringify({ ok: true, realNativeTray: true, realControlledService: true, viewports: widths, stableEntryAcrossRestart: true, idleWorkbenchOpenThroughStop: true, pageErrors }));
    } catch (error) { failed = true; throw error; } finally {
        await browser.close();
        if (child.exitCode === null) command('finish');
        await exited;
        if (failed) {
            const report = path.join(root, '.pivane-runtime/desktop/smoke-result.json');
            if (fs.existsSync(report)) console.error(JSON.stringify({ nativeErrors: JSON.parse(fs.readFileSync(report, 'utf8')).filter(event => event.type === 'error') }));
        }
        fs.rmSync(base, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
