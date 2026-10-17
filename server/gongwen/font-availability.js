const path = require('node:path');
const { spawn } = require('node:child_process');
const FAMILIES = ['方正小标宋简体', '仿宋', '黑体', '楷体', '宋体'];
const aliases = { 仿宋: ['FangSong'], 黑体: ['SimHei'], 楷体: ['KaiTi'], 宋体: ['SimSun'] };
// Runs as a directly owned child of GongwenProcess, not as a grandchild of the
// killable DOCX worker. Cancellation waits for this process's actual close.
async function probeFontAvailability({ signal, platform = process.platform, systemRoot = process.env.SystemRoot } = {}) {
    signal?.throwIfAborted();
    const unknown = () => ({ status: 'unknown', fonts: FAMILIES.map(requested => ({ requested, status: 'unknown' })), evidence: '本机字体枚举未完成' });
    if (platform !== 'win32' || !systemRoot || !path.isAbsolute(systemRoot)) return unknown();
    const executable = path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const script = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Drawing;$f=[System.Drawing.Text.InstalledFontCollection]::new();try{ConvertTo-Json -Compress -InputObject @($f.Families|ForEach-Object{$_.Name})}finally{$f.Dispose()}';
    return new Promise((resolve, reject) => {
        let child, timer, output = '', failed = false, size = 0;
        const stop = () => { failed = true; child?.kill(); };
        try {
            child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
                windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
                env: { SystemRoot: systemRoot, LANG: 'C.UTF-8', PSModulePath: path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/Modules') }
            });
        } catch { resolve(unknown()); return; }
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', data => { size += Buffer.byteLength(data); if (size > 256 * 1024) stop(); else output += data; });
        child.stderr.on('data', data => { size += data.length; if (size > 256 * 1024) stop(); });
        child.once('error', () => { failed = true; });
        signal?.addEventListener('abort', stop, { once: true });
        timer = setTimeout(stop, 5000);
        child.once('close', code => {
            clearTimeout(timer); signal?.removeEventListener('abort', stop);
            if (signal?.aborted) { reject(signal.reason); return; }
            if (failed || code !== 0) { resolve(unknown()); return; }
            try {
                const names = JSON.parse(output.replace(/^\uFEFF/, ''));
                if (!Array.isArray(names) || names.length > 8192 || names.some(name => typeof name !== 'string' || name.length > 240)) throw Error();
                const installed = new Set(names.map(name => name.toLowerCase()));
                const fonts = FAMILIES.map(requested => ({ requested, status: [requested, ...(aliases[requested] || [])].some(name => installed.has(name.toLowerCase())) ? 'available' : 'missing' }));
                resolve({ status: fonts.some(font => font.status === 'missing') ? 'missing' : 'available', fonts, evidence: '本机 InstalledFontCollection 字体族；不证明实际软件选字或字形覆盖' });
            } catch { resolve(unknown()); }
        });
        if (signal?.aborted) stop();
    });
}
module.exports = { probeFontAvailability };
