const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { createApplication } = require('./desktop-launcher-fixture.cjs');

test('an explicit desktop identity does not require loading the optional SDK default resolver', { timeout: 90000 }, async () => {
    const { root, base, env } = createApplication();
    const hook = path.join(base, 'unavailable-default-resolver.cjs');
    // Fault injection at the external SDK boundary, leaving all application
    // modules real. The service is a synthetic owned process, with no model.
    fs.writeFileSync(hook, `require('node:module').registerHooks({resolve(specifier,context,next){
        if(specifier==='@earendil-works/pi-coding-agent')throw Error('SDK default resolver unavailable');
        return next(specifier,context);
    }});`);
    fs.writeFileSync(path.join(root, 'server.js'), `const http=require('node:http'),nonce=process.env.PI_MANAGED_LAUNCHER;
        const server=http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end('{"authenticated":false}');});
        process.on('message',message=>{if(message.nonce===nonce&&message.type==='maintenance-shutdown')
            server.close(()=>process.send({type:'maintenance-shutdown-complete',nonce},()=>process.exit(0)));});
        server.listen(0,'127.0.0.1',()=>process.send({type:'maintenance-ready',nonce,port:server.address().port,
            healthUrl:'http://127.0.0.1:'+server.address().port+'/api/access/status',appVersion:require('./package.json').version,
            capabilities:{shutdownProof:true}}));`);
    const child = spawn(process.execPath, ['--require', hook, path.join(root, 'scripts/start-desktop.cjs'), '--controlled', '--generation', randomUUID()],
        { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'close'); let output = '', diagnostic = '';
    child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => diagnostic = (diagnostic + bytes).slice(-4096));
    try {
        let ready; const until = Date.now() + 45000;
        while (Date.now() < until && child.exitCode === null) {
            ready = output.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(value => value.type === 'ready');
            if (ready) break;
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        assert.ok(ready, output + diagnostic);
        assert.equal(ready.agentDir, env.PI_CODING_AGENT_DIR);
        assert.equal((await fetch(ready.url)).status, 200);
    } finally {
        child.stdin.end(); await exited;
        await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
});
