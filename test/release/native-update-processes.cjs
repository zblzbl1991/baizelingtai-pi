const path = require('node:path');
const { spawn } = require('node:child_process');
const EXACT_HANDLE = String.raw`Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text; using Microsoft.Win32.SafeHandles;
public sealed class ExactQaProcess : IDisposable {
 [DllImport("kernel32.dll",SetLastError=true)] static extern SafeWaitHandle OpenProcess(uint a,bool i,uint p);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(SafeWaitHandle h,out long c,out long e,out long k,out long u);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(SafeWaitHandle h,uint f,StringBuilder n,ref uint s);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(SafeWaitHandle h,uint m);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(SafeWaitHandle h,uint code);
 SafeWaitHandle h;
 public ExactQaProcess(uint pid,string stamp,string executable,bool terminate){
  h=OpenProcess(terminate?0x101001u:0x101000u,false,pid); long c,e,k,u; uint size=32768;var name=new StringBuilder((int)size);
  if(h.IsInvalid||!GetProcessTimes(h,out c,out e,out k,out u)||c.ToString(System.Globalization.CultureInfo.InvariantCulture)!=stamp
    ||!QueryFullProcessImageName(h,0,name,ref size)||!String.Equals(name.ToString(),executable,StringComparison.OrdinalIgnoreCase)||WaitForSingleObject(h,0)!=258){h.Dispose();throw new Exception("Exact expected process identity/executable unavailable");}
 }
 public void Wait(uint timeout){if(WaitForSingleObject(h,timeout)!=0)throw new Exception("Exact process exit remains unknown");}
 public void Terminate(){if(!TerminateProcess(h,1))throw new Exception("Exact fixture termination failed");Wait(30000);}
 public void Dispose(){h.Dispose();}
}
'@`;
function launch(executable, args, env, { cwd, input = '', timeoutMs = 180000 } = {}) {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-1024 * 1024); });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-1024 * 1024); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
    const closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    let timer;
    // An observation timeout never kills an application or retries a mutation.
    const result = Promise.race([closed, new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            child.unref(); child.stdout.unref?.(); child.stderr.unref?.(); child.stdin.unref?.();
            reject(Error('Owned QA command outcome is unknown after timeout; preserve PID ' + child.pid));
        }, timeoutMs);
    })]).finally(() => clearTimeout(timer));
    return { child, closed, result };
}
async function run(executable, args, env, options) {
    const result = await launch(executable, args, env, options).result;
    if (result.code !== 0) throw Error('Owned QA command failed: ' + result.stderr.slice(-1024));
    return result;
}
function powershell(script, env, options) {
    return run(path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], env, options);
}
async function entryCommand(executable, args, env, cwd) {
    const child = spawn(executable, args, { env, cwd, windowsHide: true, stdio: 'ignore' });
    child.unref();
    let timer;
    const code = await Promise.race([new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('Native entry outcome is unknown; preserve owned PID ' + child.pid)), 30000); })]).finally(() => clearTimeout(timer));
    if (code !== 0) throw Error('Native entry command exited unsuccessfully: ' + code);
    // This proves only that the short-lived entry command exited. Readiness and
    // final app exit come from fresh tray receipts and independently held HANDLEs.
    return { entryPid: child.pid, entryExitCode: code };
}
function startFixedEntry(root, env) { return entryCommand(path.join(root, '白泽灵台.exe'), [], env, root); }
async function createShortcut(root, directory, env) {
    await run(path.join(root, '白泽灵台.exe'), ['--create-shortcut', directory], env, { cwd: root, timeoutMs: 30000 });
    const shortcut = path.join(directory, '白泽灵台.lnk');
    await powershell("$ErrorActionPreference='Stop'; $s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut($env:PIVANE_QA_SHORTCUT); if($l.TargetPath -ne $env:PIVANE_QA_FIXED_ENTRY -or $l.WorkingDirectory -ne $env:PIVANE_QA_ROOT){throw 'Original shortcut target changed'}", {
        ...env, PIVANE_QA_SHORTCUT: shortcut, PIVANE_QA_FIXED_ENTRY: path.join(root, '白泽灵台.exe'), PIVANE_QA_ROOT: root
    });
    return shortcut;
}
async function openShortcut(root, shortcut, env) {
    const script = "$ErrorActionPreference='Stop'; $s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut($env:PIVANE_QA_SHORTCUT); if($l.TargetPath -ne $env:PIVANE_QA_FIXED_ENTRY -or $l.WorkingDirectory -ne $env:PIVANE_QA_ROOT){throw 'Original shortcut target changed'}; Start-Process -FilePath $env:PIVANE_QA_SHORTCUT -WindowStyle Hidden";
    await entryCommand(path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        ...env, PIVANE_QA_SHORTCUT: shortcut, PIVANE_QA_FIXED_ENTRY: path.join(root, '白泽灵台.exe'), PIVANE_QA_ROOT: root
    }, root);
}
async function holdEntry(file, env) {
    const script = "$ErrorActionPreference='Stop'; $s=[IO.File]::Open($env:PIVANE_QA_ENTRY,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try{[Console]::WriteLine('ready');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null}finally{$s.Dispose()}";
    const child = spawn(path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { env: { SystemRoot: env.SystemRoot, TEMP: env.TEMP, TMP: env.TMP, PIVANE_QA_ENTRY: file }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', value => { text += value; }); child.stderr.on('data', value => { text += value; });
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code })); });
    const until = Date.now() + 15000;
    while (!text.includes('ready')) {
        if (Date.now() >= until || child.exitCode !== null) throw Error('Synthetic file holder did not acquire its exact file: ' + text.slice(-256));
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { pid: child.pid, release: async () => { child.stdin.end('\n'); return closed; } };
}
async function interruptHelper(receipt, env) {
    if (receipt.state !== 'paused' || !Number.isSafeInteger(receipt.pid) || !receipt.execPath.startsWith(path.join(receipt.root, '.pivane-runtime/activation') + path.sep)
        || !receipt.execPath.endsWith(path.join('helper', 'runtime', 'node.exe'))) throw Error('Only a paused exact synthetic helper may be interrupted');
    if (!/^[0-9]{16,19}$/.test(receipt.creationTime || '')) throw Error('Helper receipt lacks its original exact FILETIME');
    const result = await powershell("$ErrorActionPreference='Stop';\n" + EXACT_HANDLE + "\n$held=[ExactQaProcess]::new([uint32]$env:PIVANE_QA_PID,$env:PIVANE_QA_STAMP,$env:PIVANE_QA_EXEC,$true);try{$held.Terminate();@{pid=[int]$env:PIVANE_QA_PID;creationTime=$env:PIVANE_QA_STAMP;path=$env:PIVANE_QA_EXEC;exited=$true;method='same-held-terminable-HANDLE'}|ConvertTo-Json -Compress}finally{$held.Dispose()}", {
        SystemRoot: env.SystemRoot, TEMP: env.TEMP, TMP: env.TMP, PIVANE_QA_PID: String(receipt.pid), PIVANE_QA_EXEC: receipt.execPath, PIVANE_QA_STAMP: receipt.creationTime
    }, { timeoutMs: 30000 });
    const proof = JSON.parse(result.stdout);
    if (proof.exited !== true) throw Error('Synthetic helper interruption was not confirmed');
    return proof;
}
async function witnessExit(receipt, env) {
    if (!Number.isSafeInteger(receipt.pid) || !receipt.execPath.startsWith(receipt.root + path.sep) || !/^[0-9]{16,19}$/.test(receipt.creationTime || '')) throw Error('An actual isolated process receipt with original FILETIME is required');
    const script = "$ErrorActionPreference='Stop';\n" + EXACT_HANDLE + "\n$held=[ExactQaProcess]::new([uint32]$env:PIVANE_QA_PID,$env:PIVANE_QA_STAMP,$env:PIVANE_QA_EXEC,$false);try{[Console]::WriteLine((@{event='held';pid=[int]$env:PIVANE_QA_PID;creationTime=$env:PIVANE_QA_STAMP}|ConvertTo-Json -Compress));[Console]::Out.Flush();$held.Wait(600000);[Console]::WriteLine('exited')}finally{$held.Dispose()}";
    const child = spawn(path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { env: { SystemRoot: env.SystemRoot, TEMP: env.TEMP, TMP: env.TMP, PIVANE_QA_PID: String(receipt.pid), PIVANE_QA_EXEC: receipt.execPath, PIVANE_QA_STAMP: receipt.creationTime }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '', held;
    child.stdout.on('data', bytes => { output += bytes; const line = output.split(/\r?\n/)[0]; try { const value = JSON.parse(line); if (value.event === 'held') held = value; } catch {} });
    child.stderr.on('data', bytes => { error = (error + bytes).slice(-1024); });
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 && /\nexited\r?\n$/.test(output)
        ? resolve({ ...held, exited: true, method: 'held-Windows-HANDLE' }) : reject(Error('Exact service exit unavailable: ' + error))); });
    closed.catch(() => {});
    const until = Date.now() + 15000;
    while (!held) { if (Date.now() >= until || child.exitCode !== null) throw Error('Could not hold the isolated service HANDLE'); await new Promise(resolve => setTimeout(resolve, 50)); }
    return { held, exited: closed };
}
function witnessServiceExit(receipt, env) {
    if (receipt.point !== 'service-live') throw Error('An actual service-live receipt is required');
    return witnessExit(receipt, env);
}
function witnessHelperExit(receipt, env) {
    if (receipt.state !== 'paused' || !receipt.execPath.endsWith(path.join('helper', 'runtime', 'node.exe'))) throw Error('An actual paused helper receipt is required');
    return witnessExit(receipt, env);
}
async function teardownUnknownOwners(current, serviceProof, env) {
    if (serviceProof?.exited !== true || serviceProof.method !== 'held-Windows-HANDLE' || !current.components?.processes?.length) throw Error('Unknown child prevents forced fixture teardown');
    const identities = current.components.processes.map((value, index) => ({ ...value, executable: index === 0 ? current.components.nodePath : current.trayPath }));
    if (identities.some(item => !/^[0-9]{16,19}$/.test(item.creationTime || '') || typeof item.executable !== 'string' || !path.isAbsolute(item.executable))) throw Error('Original runner/tray FILETIME and executable paths are required');
    const result = await powershell("$ErrorActionPreference='Stop';\n" + EXACT_HANDLE + "\n$items=ConvertFrom-Json $env:PIVANE_QA_IDENTITIES;$held=@();try{foreach($item in $items){$held+=,[ExactQaProcess]::new([uint32]$item.pid,[string]$item.creationTime,[string]$item.executable,$true)};foreach($p in $held){$p.Terminate()};@{status='forced-fixture-teardown';productCleanProof=$false;method='same-held-terminable-HANDLE';identities=$items}|ConvertTo-Json -Compress -Depth 4}finally{foreach($p in $held){$p.Dispose()}}", {
        SystemRoot: env.SystemRoot, TEMP: env.TEMP, TMP: env.TMP, PIVANE_QA_IDENTITIES: JSON.stringify(identities)
    }, { timeoutMs: 30000 });
    return JSON.parse(result.stdout);
}
module.exports = { launch, run, powershell, createShortcut, startFixedEntry, openShortcut, holdEntry, interruptHelper, witnessServiceExit, witnessHelperExit, teardownUnknownOwners };
