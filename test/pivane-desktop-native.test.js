const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const source = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function rootFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-native-'));
    for (const name of ['白泽灵台.exe', 'public/desktop-startup.html', 'public/desktop-startup.css', 'public/desktop-startup.js', 'public/brand/favicon.ico', 'public/brand/logo-horizontal.svg', 'public/brand/logo-horizontal-dark.svg', 'public/brand/logo-64.png']) {
        const from = path.join(source, name); if (!fs.existsSync(from)) continue;
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.copyFileSync(from, path.join(root, name));
    }
    t.after(async () => { await t.nativeStop?.(); fs.rmSync(root, { recursive: true, force: true }); });
    return root;
}
function powershell(script, env = {}) {
    return spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        env: { SystemRoot: process.env.SystemRoot, SystemDrive: process.env.SystemDrive, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}
async function waitFor(fn, child, output, timeout = 10000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = fn(); if (value) return value; if (child?.exitCode !== null && child?.exitCode !== undefined) throw Error(`Native exited ${child.exitCode}: ${output()}`); await pause(40); }
    throw Error(`Native timed out: ${output()}`);
}
test('native waiting host keeps one read-only address across service generations and rejects foreign hosts', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
    const root = rootFixture(t), instance = randomUUID();
    const child = powershell(`$ErrorActionPreference='Stop'; [Reflection.Assembly]::LoadFrom($env:FIXTURE_ROOT+'\\白泽灵台.exe') | Out-Null; $hoster=[PivaneStartupHost]::new($env:FIXTURE_ROOT,$env:FIXTURE_INSTANCE); [Console]::Out.WriteLine($hoster.Url); [Console]::Out.Flush(); try { while ($line=[Console]::ReadLine()) { $hoster.Update($line); [Console]::Out.WriteLine('updated'); [Console]::Out.Flush() } } finally { $hoster.Dispose() }`, { FIXTURE_ROOT: root, FIXTURE_INSTANCE: instance });
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    const exited = once(child, 'close'); t.nativeStop = async () => { child.stdin.end(); await exited; };
    const url = await waitFor(() => output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0], child, () => output);
    assert.match(await fetch(url).then(r => r.text()), new RegExp(`name="startup-instance" content="${instance}"`));
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    assert.equal((await fetch(new URL('/status', url), { headers: { Origin: 'http://foreign.example' } })).status, 403);
    assert.equal((await fetch(new URL('/missing', url))).status, 404);
    const head=await fetch(url,{method:'HEAD'}); assert.equal(head.status,200);assert.equal(await head.text(),'');assert.ok(Number(head.headers.get('content-length'))>100);
    const foreign=net.createConnection(Number(new URL(url).port),'127.0.0.1'); await once(foreign,'connect');let foreignResponse='';foreign.on('data',bytes=>foreignResponse+=bytes);foreign.write('GET /status HTTP/1.1\r\nHost: attacker.example\r\n\r\n');await once(foreign,'close');assert.ok(foreignResponse.includes('HTTP/1.1 403'));
    const slow=net.createConnection(Number(new URL(url).port),'127.0.0.1');await once(slow,'connect');const began=Date.now();slow.write('G');const trickle=setInterval(()=>slow.write('E'),350);try{await once(slow,'close');assert.ok(Date.now()-began<4500,'whole header deadline rejects slow trickle')}finally{clearInterval(trickle);slow.destroy()}
    let updates = 0;
    for (const [state, generation] of [['starting', randomUUID()], ['stopped', randomUUID()], ['ready', randomUUID()]]) {
        child.stdin.write(JSON.stringify({ state, instance, generation, ...(state === 'ready' ? { url: 'http://127.0.0.1:14444/' } : {}) }) + '\n');
        updates++;
        await waitFor(() => (output.match(/^updated\r?$/gm) || []).length === updates, child, () => output);
        assert.deepEqual(await fetch(new URL('status', url)).then(r => r.json()), { state, instance, generation, ...(state === 'ready' ? { url: 'http://127.0.0.1:14444/' } : {}) });
    }
    child.stdin.end(); assert.equal((await exited)[0], 0, output);
    await assert.rejects(fetch(url));
});

test('native startup assets reject ancestor junctions, excess bytes and concurrent writers', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
    for (const mode of ['junction', 'budget', 'writer']) {
        const root = rootFixture(t);
        if (mode === 'junction') {
            const original = path.join(root, 'public', 'brand'), elsewhere = path.join(root, 'outside-brand');
            fs.renameSync(original, elsewhere); fs.symlinkSync(elsewhere, original, 'junction');
        }
        if (mode === 'budget') fs.writeFileSync(path.join(root, 'public/desktop-startup.js'), Buffer.alloc(131073));
        const script = `$ErrorActionPreference='Stop'; [Reflection.Assembly]::LoadFrom($env:FIXTURE_ROOT+'\\白泽灵台.exe') | Out-Null; $writer=$null; try {
            ${mode === 'writer' ? "$writer=[IO.File]::Open(($env:FIXTURE_ROOT+'\\public\\desktop-startup.js'),'Open','Write','ReadWrite'); $writer.WriteByte(65); $writer.Flush()" : ''}
            try { $hoster=[PivaneStartupHost]::new($env:FIXTURE_ROOT,[Guid]::NewGuid().ToString()); $hoster.Dispose(); [Console]::WriteLine('accepted') } catch { [Console]::WriteLine('rejected') }
        } finally { if($writer){$writer.Dispose()} }`;
        const child = powershell(script, { FIXTURE_ROOT: root }); let output = '';
        child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
        assert.equal((await once(child, 'close'))[0], 0, output);
        assert.match(output, /rejected/, mode + ': ' + output);
    }
});


function trayFixture(t, mode = 'ready') {
    const root = rootFixture(t); fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, '.pivane-runtime/desktop'), { recursive: true });
    fs.writeFileSync(path.join(root, '.pivane-launcher-test'), 'synthetic native instance');
    fs.writeFileSync(path.join(root, '.pivane-launcher-stay'), 'retain tray after injected failure');
    fs.writeFileSync(path.join(root, 'scripts/start-desktop.cjs'), `
        const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
        if (process.argv.includes('--identity')) { emit({ root:${JSON.stringify(root)}, id:${JSON.stringify(path.basename(root))} }); }
        else {
            const generation = process.argv[process.argv.indexOf('--generation')+1];
            const event = (type, rest={}) => emit({ type, generation, ...rest });
            event('starting', {logFile:${JSON.stringify(path.join(root, 'service.log'))}});
            setTimeout(() => { event('ready', {url:'http://127.0.0.1:12345/',versions:{appVersion:'9.8.7',engineVersion:'0.85.1'}}); ${mode === 'unknown' ? 'setTimeout(() => process.exit(0),400)' : ''} }, ${['slow','race'].includes(mode) ? 2000 : 200});
            let uncertain=false;let executeCount=0; let buffer=''; process.stdin.on('data', chunk => {
                buffer += chunk; let at; while((at=buffer.indexOf('\\n'))>=0) {
                    const value=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
                    if(value.generation!==generation) continue;
                    if(value.type==='snapshot'&&uncertain){event('stop-accepted',{id:value.id,operationId:'synthetic-operation'});setTimeout(()=>{event('stopped',{clean:true});process.exit(0)},200);continue;}
                    if(value.type==='snapshot') event('snapshot',{id:value.id,complete:true,revision:'one',blockers:[],scheduled:{futureCount:2,latestCount:1}});
                    if(value.type==='review-stop') event('stop-review',{id:value.id,complete:true,revision:'one',blockers:${mode === 'blocked' ? "[{type:'sidechat',count:1,label:'侧聊连接',cwd:'synthetic-project',sessionId:'synthetic-session'}]" : '[]'},scheduled:{futureCount:2,latestCount:1},${mode === 'blocked' ? '' : "ticket:'synthetic-ticket',"}expiresAt:Date.now()+30000});
                    if(value.type==='stop'&&${mode === 'race'}){event('ready',{url:'http://127.0.0.1:12345/'});event('error',{id:value.id,code:'DESKTOP_REVIEW_REQUIRED',message:'Review service blockers before stopping.'});continue;}
                    if(value.type==='execute-stop'||value.type==='stop') {
                        executeCount++;if(${mode === 'uncertain'}&&value.type==='execute-stop'){uncertain=true;event('error',{id:value.id,code:'DESKTOP_TRANSPORT_UNKNOWN',message:'Synthetic unknown acknowledgement'});continue;}
                        event('stop-accepted',{id:value.id,operationId:'synthetic-operation'});
                        event('ready',{url:'http://127.0.0.1:9999/'}); // late readiness cannot override stopping
                        setTimeout(()=>{event('stopped',{clean:true});process.exit(0)},600);
                    }
                }
            });
            process.stdin.on('end',()=>{event('stopped',{clean:true});process.exit(0)});
        }
    `);
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(source,'scripts/desktop-tray.ps1'), '-AppRoot', root, '-NodePath', process.execPath, '-NoOpen', '-SmokeTest'], {
        env:{SystemRoot:process.env.SystemRoot,SystemDrive:process.env.SystemDrive,PATH:process.env.PATH,TEMP:process.env.TEMP,TMP:process.env.TMP,PI_CODING_AGENT_DIR:path.join(root,'agent'),PI_MEDIA_DATA_DIR:path.join(root,'media'),PI_WEB_DEFERRED_FILE:path.join(root,'deferred.json')},windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output=''; child.stdout.on('data', chunk => output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    const exited=once(child,'close');
    const read=()=>{try{return JSON.parse(fs.readFileSync(path.join(root,'.pivane-runtime/desktop/smoke-state.json'),'utf8'))}catch{return null}};
    const command=action=>fs.writeFileSync(path.join(root,'.pivane-launcher-command.json'),JSON.stringify({id:randomUUID(),action}));
    t.nativeStop=async()=>{if(child.exitCode===null){command('finish');await exited}};
    return {root,child,exited,command,read,wait: predicate=>waitFor(()=>{const state=read();return state&&predicate(state)&&state},child,()=>output),output:()=>output};
}
test('native compact management stays hidden, preserves tray through two runs, and requires a separate stop confirmation', {skip:process.platform!=='win32',timeout:30000},async t=>{
    const run=trayFixture(t), first=await run.wait(s=>s.state==='ready'&&!s.pending);
    assert.equal(first.visible,false,'default entry leaves management hidden');
    assert.match(first.versions,/9\.8\.7/); assert.match(first.versions,/0\.85\.1/);
    run.command('show');await run.wait(s=>s.visible);
    run.command('updates');await run.wait(s=>s.detail.includes('设置 → 版本与更新'));
    const address=first.waitingUrl;
    const duplicate=spawn('powershell.exe',['-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',path.join(source,'scripts/desktop-tray.ps1'),'-AppRoot',run.root,'-NodePath',process.execPath,'-SmokeTest'],{env:{SystemRoot:process.env.SystemRoot,SystemDrive:process.env.SystemDrive,PATH:process.env.PATH,TEMP:process.env.TEMP,TMP:process.env.TMP,PI_CODING_AGENT_DIR:path.join(run.root,'agent'),PI_MEDIA_DATA_DIR:path.join(run.root,'media'),PI_WEB_DEFERRED_FILE:path.join(run.root,'deferred.json')},windowsHide:true,stdio:'ignore'});
    assert.equal((await once(duplicate,'close'))[0],0);
    await waitFor(()=>fs.existsSync(path.join(run.root,'.pivane-runtime/desktop/smoke-open-1.json')),run.child,run.output);
    assert.equal(run.read().generation,first.generation,'duplicate entry uses current runner');
    run.command('show');await run.wait(s=>s.visible);
    run.command('minimize');await run.wait(s=>!s.visible);
    run.command('show');await run.wait(s=>s.visible);
    run.command('hide');await run.wait(s=>!s.visible);
    run.command('stop');await run.wait(s=>s.confirm&&!s.pending);
    assert.equal((await fetch(new URL('status',address)).then(r=>r.json())).state,'ready','workspace stays usable during confirmation');
    run.command('confirm');await run.wait(s=>s.state==='stopping');
    run.command('open');await run.wait(s=>s.visible&&s.state==='stopping');
    const stopped=await run.wait(s=>s.state==='stopped');
    assert.equal(stopped.canStart,true);assert.equal(run.child.exitCode,null,'stop retains tray');
    assert.equal((await fetch(new URL('status',address)).then(r=>r.json())).state,'stopped');
    run.command('open');const second=await run.wait(s=>s.state==='ready'&&s.generation!==first.generation&&!s.pending);
    assert.equal(second.waitingUrl,address);assert.notEqual(second.pid,first.pid);
    run.command('capture');await waitFor(()=>fs.existsSync(path.join(run.root,'.pivane-runtime/desktop/management.png')),run.child,run.output);
    if(process.env.NATIVE_DESKTOP_EVIDENCE){fs.mkdirSync(process.env.NATIVE_DESKTOP_EVIDENCE,{recursive:true});fs.copyFileSync(path.join(run.root,'.pivane-runtime/desktop/management.png'),path.join(process.env.NATIVE_DESKTOP_EVIDENCE,'management.png'));}
    run.command('exit');await run.wait(s=>s.confirm&&!s.pending);run.command('confirm');
    assert.equal((await run.exited)[0],0,run.output());
    const report=JSON.parse(fs.readFileSync(path.join(run.root,'.pivane-runtime/desktop/smoke-result.json'),'utf8'));
    assert.equal(report.filter(e=>e.type==='ready').length,2,'late readiness ignored');
    assert.equal(report.filter(e=>e.type==='exited'&&e.exitCode===0).length,2);
    await assert.rejects(fetch(address));
});
test('native stop blockers end the request without waiting or queuing shutdown', {skip:process.platform!=='win32',timeout:15000},async t=>{
    const run=trayFixture(t,'blocked');await run.wait(s=>s.state==='ready'&&!s.pending);run.command('stop');
    const blocked=await run.wait(s=>s.blockers.includes('synthetic-session')&&!s.pending);
    assert.equal(blocked.confirm,false);assert.equal(blocked.state,'ready');assert.match(blocked.blockers,/latest/);
    assert.match(blocked.blockers,/服务停止期间无法执行/);assert.match(blocked.blockers,/按原宽限补最近一次/);
});
test('native unexpected runner exit remains unknown and disables new starts', {skip:process.platform!=='win32',timeout:15000},async t=>{
    const run=trayFixture(t,'unknown');const unknown=await run.wait(s=>s.state==='unknown');
    assert.equal(unknown.canStart,false);run.command('start');await pause(250);
    assert.equal(run.read().generation,unknown.generation);assert.equal(run.read().state,'unknown');
});

test('native startup stop waits for runner cleanup without entering the ready workspace', {skip:process.platform!=='win32',timeout:15000},async t=>{
    const run=trayFixture(t,'slow');await run.wait(s=>s.state==='starting');run.command('stop');await run.wait(s=>s.state==='stopping');
    const stopped=await run.wait(s=>s.state==='stopped');assert.equal(stopped.canStart,true);assert.equal(run.child.exitCode,null);
    run.command('exit');assert.equal((await run.exited)[0],0,run.output());
    const report=JSON.parse(fs.readFileSync(path.join(run.root,'.pivane-runtime/desktop/smoke-result.json'),'utf8'));
    assert.equal(report.filter(e=>e.type==='ready').length,0);
});

test('native startup stop handed to an already-ready runner continues through review and confirmation', {skip:process.platform!=='win32',timeout:15000},async t=>{
    const run=trayFixture(t,'race');await run.wait(s=>s.state==='starting');run.command('exit');
    const review=await run.wait(s=>s.confirm&&!s.pending);
    assert.equal(review.state,'ready');assert.equal(review.canStart,false);
    run.command('confirm');assert.equal((await run.exited)[0],0,run.output());
});



test('native uncertain execute preserves exit intent and queries acceptance without replay', {skip:process.platform!=='win32',timeout:15000},async t=>{
    const run=trayFixture(t,'uncertain');await run.wait(s=>s.state==='ready'&&!s.pending);run.command('exit');await run.wait(s=>s.confirm&&!s.pending);run.command('confirm');await run.wait(s=>s.state==='unknown');
    assert.equal((await run.exited)[0],0,run.output());
    const report=JSON.parse(fs.readFileSync(path.join(run.root,'.pivane-runtime/desktop/smoke-result.json'),'utf8'));
    assert.ok(report.some(e=>e.type==='error'&&e.message.includes('unknown acknowledgement')));
    assert.equal(report.filter(e=>e.type==='stop-accepted').length,1);assert.equal(report.filter(e=>e.type==='exited').length,1);
});
