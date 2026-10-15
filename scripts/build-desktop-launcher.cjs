const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function main() {
    if (process.platform !== 'win32' || process.argv.length !== 2) throw Error('Build on Windows: node scripts/build-desktop-launcher.cjs');
    const windows = process.env.SystemRoot || process.env.SYSTEMROOT;
    const compiler = ['Framework64', 'Framework'].map(name => path.join(windows, 'Microsoft.NET', name, 'v4.0.30319', 'csc.exe')).find(file => fs.existsSync(file));
    if (!compiler) throw Error('Windows .NET Framework C# compiler was not found.');
    const appVersion = require('../package.json').version;
    if (!/^\d+\.\d+\.\d+$/.test(appVersion)) throw Error('This compiler build expects a three-part application version.');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-desktop-build-'));
    try {
        const version = path.join(temporary, 'VersionInfo.cs'), output = path.join(temporary, 'launcher.exe');
        fs.writeFileSync(version, `using System.Reflection;\n[assembly: AssemblyTitle("白泽灵台")]\n[assembly: AssemblyProduct("白泽灵台")]\n[assembly: AssemblyVersion("${appVersion}.0")]\n[assembly: AssemblyFileVersion("${appVersion}.0")]\n`);
        execFileSync(compiler, ['/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
            '/out:' + output, '/win32icon:' + path.join(root, 'public/brand/favicon.ico'),
            '/win32manifest:' + path.join(root, 'native/pivane-desktop-launcher.manifest'),
            path.join(root, 'native/pivane-desktop-launcher.cs'), version], { stdio: 'inherit', windowsHide: true });
        const metadata = { version: 1, appVersion, platform: 'win32', arch: 'anycpu', runtime: '.NET Framework 4',
            sourceSha256: hash(path.join(root, 'native/pivane-desktop-launcher.cs')),
            manifestSha256: hash(path.join(root, 'native/pivane-desktop-launcher.manifest')),
            iconSha256: hash(path.join(root, 'public/brand/favicon.ico')), compilerSha256: hash(compiler), binarySha256: hash(output) };
        fs.copyFileSync(output, path.join(root, '白泽灵台.exe'));
        fs.writeFileSync(path.join(root, 'native/pivane-desktop-launcher-build.json'), JSON.stringify(metadata, null, 2) + '\n');
        console.log(`Built 白泽灵台.exe (${fs.statSync(output).size} bytes)`);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
