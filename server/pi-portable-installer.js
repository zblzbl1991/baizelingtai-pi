const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const fetch = require('node-fetch');
const { privateDir, readSafe, hashFileSafe, atomicJson, hash } = require('./pi-maintenance-files');
const { configuredFeed, sourceLink, parseFeed, portableMetadataFile } = require('./pi-update-feed');
const MAX_ZIP = 1024 ** 3;

function supported(root) {
    if (process.platform !== 'win32' || process.arch !== 'x64') return false;
    try {
        const metadata = JSON.parse(readSafe(portableMetadataFile(root)));
        return metadata.version === 1 && metadata.platform === 'win32' && metadata.arch === 'x64'
            && fs.existsSync(path.join(root, 'runtime/node.exe'));
    } catch { return false; }
}
function validPortable(release, feed) {
    try {
        return release?.format === 'windows-portable-zip' && release.feed === feed && configuredFeed('', { BAIZELINGTAI_UPDATE_FEED_URL: feed }) === feed
            && sourceLink(release.downloadUrl, feed) === release.downloadUrl && new URL(release.downloadUrl).pathname.endsWith('.zip')
            && /^[a-f0-9]{64}$/.test(release.sha256) && Number.isSafeInteger(release.bytes) && release.bytes > 0 && release.bytes <= MAX_ZIP
            && ['stable', 'preview'].includes(release.channel) && require('./pi-update-service').compareVersions(release.version, release.version) === 0
            && require('./pi-update-service').compareVersions(release.piVersion, release.piVersion) === 0;
    } catch { return false; }
}
async function downloadPortable(release, file, { env, signal, request = fetch } = {}) {
    if (!validPortable(release, release.feed)) throw Error('Invalid portable release');
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 10 * 60 * 1000);
    const agent = require('./workspace-network-transport').proxyAgent(release.downloadUrl, env || process.env);
    try {
        const response = await request(release.downloadUrl, { redirect: 'error', signal: controller.signal, agent,
            headers: { 'User-Agent': 'Baizelingtai-Portable-Update' } });
        if (!response.ok) { response.body?.destroy(); throw Error('Portable download failed'); }
        let bytes = 0; const digest = createHash('sha256');
        const meter = new Transform({ transform(chunk, _encoding, done) {
            bytes += chunk.length;
            if (bytes > release.bytes) return done(Error('Portable ZIP byte count mismatch'));
            digest.update(chunk); done(null, chunk);
        } });
        // The destination is new and inherits the launcher's private staging DACL.
        await pipeline(response.body, meter, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
        if (bytes !== release.bytes || digest.digest('hex') !== release.sha256) throw Error('Portable ZIP bytes or SHA256 mismatch');
        const proof = hashFileSafe(file, MAX_ZIP);
        if (proof.bytes !== release.bytes || proof.sha256 !== release.sha256) throw Error('Portable ZIP changed');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); agent?.destroy(); }
}

async function unpackPortable(archive, directory, version, signal) {
    if (process.platform !== 'win32') throw Error('Portable updates require Windows');
    if (fs.existsSync(directory)) throw Error('Portable destination already exists');
    const proof = hashFileSafe(archive, MAX_ZIP);
    // Validate the entire central directory before writing anything, using the
    // same open ZIP for extraction. Reject aliases, links, devices and data files.
    const script = String.raw`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling',$false)
[AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths',$false)
$zip=[IO.Compression.ZipFile]::OpenRead($env:BAIZELINGTAI_STAGE_ZIP)
try {
    $prefix='baizelingtai-'+$env:BAIZELINGTAI_STAGE_VERSION+'/'
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [long]$total=0
    if ($zip.Entries.Count -gt 100000) { throw 'ZIP entry budget exceeded' }
    foreach ($entry in $zip.Entries) {
        $name=$entry.FullName
        $type=($entry.ExternalAttributes -shr 16) -band 61440
        if (-not $name.StartsWith($prefix,[StringComparison]::Ordinal) -or $name -match '[\\:\x00-\x1f\x7f]' -or $type -notin @(0,16384,32768) -or ($entry.ExternalAttributes -band 1024)) { throw 'Unsafe ZIP entry' }
        $relative=$name.Substring($prefix.Length).TrimEnd('/')
        if ($relative) {
            foreach ($part in $relative.Split('/')) {
                if (-not $part -or $part -in @('.','..') -or $part -match '[. ]$|[<>"|?*]|^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)') { throw 'Unsafe ZIP path' }
            }
            if (-not $seen.Add($relative)) { throw 'Duplicate ZIP entry' }
            if ($relative -match '(^|/)(\.git|\.pivane-runtime|\.env)(/|$)' -or $relative -match '^(data|backups)(/|$)|^auth\.json$|^PI_.*\.json$|^public/(images|videos|audio)/') { throw 'ZIP contains runtime data' }
        } elseif (-not $name.EndsWith('/')) { throw 'Invalid ZIP root' }
        if ($entry.Length -gt 536870912 -or ($name.EndsWith('/') -and $entry.Length)) { throw 'ZIP file budget exceeded' }
        $total += $entry.Length
        if ($total -gt 4294967296) { throw 'ZIP expanded budget exceeded' }
    }
    $destination='\\?\'+[IO.Path]::GetFullPath($env:BAIZELINGTAI_STAGE_DIRECTORY)
    [IO.Directory]::CreateDirectory($destination) | Out-Null
    foreach ($entry in $zip.Entries) {
        $relative=$entry.FullName.Substring($prefix.Length).TrimEnd('/')
        if (-not $relative) { continue }
        $target=$destination+'\'+$relative.Replace('/','\')
        if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
        $input=$entry.Open(); $output=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try {
            $buffer=New-Object byte[] 262144; [long]$copied=0
            while (($count=$input.Read($buffer,0,$buffer.Length)) -gt 0) {
                $copied += $count
                if ($copied -gt $entry.Length) { throw 'ZIP expanded bytes exceed declared length' }
                $output.Write($buffer,0,$count)
            }
            if ($copied -ne $entry.Length) { throw 'ZIP expanded byte count mismatch' }
            $output.Flush($true)
        } finally { $output.Dispose(); $input.Dispose() }
    }
} finally { $zip.Dispose() }`;
    await new Promise((resolve, reject) => {
        let failure;
        const child = execFile(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
            { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 10 * 60 * 1000, signal,
                env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, BAIZELINGTAI_STAGE_ZIP: archive,
                    BAIZELINGTAI_STAGE_DIRECTORY: directory, BAIZELINGTAI_STAGE_VERSION: version } },
            error => { failure ||= error; });
        child.once('error', error => { failure ||= error; });
        // AbortError may arrive before exit. Keep staging occupied until the
        // extractor and both output pipes have actually closed.
        child.once('close', code => failure || code !== 0
            ? reject(Error('Portable ZIP extraction failed: unsafe paths, invalid archive or cancelled process')) : resolve());
        // PowerShell can keep reading piped stdin after a terminating script
        // error. EOF is essential for rejection to await actual process exit.
        child.stdin.end();
    });
    if (JSON.stringify(hashFileSafe(archive, MAX_ZIP)) !== JSON.stringify(proof)) throw Error('Portable ZIP changed during extraction');
    privateDir(directory);
    const manifest = JSON.parse(readSafe(path.join(directory, 'PORTABLE_MANIFEST.json'), 64 * 1024 * 1024));
    if (manifest.version !== 1 || manifest.appVersion !== version || manifest.platform !== 'win32' || manifest.arch !== 'x64'
        || !Array.isArray(manifest.files) || manifest.files.length > 100000) throw Error('Portable inventory mismatch');
    const files = new Map();
    function visit(relative = '') {
        for (const item of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
            const name = relative ? relative + '/' + item.name : item.name;
            if (item.isSymbolicLink()) throw Error('Portable links are forbidden');
            if (item.isDirectory()) visit(name);
            else if (item.isFile()) files.set(name, true);
            else throw Error('Unsupported portable entry');
        }
    }
    visit(); files.delete('PORTABLE_MANIFEST.json');
    if (files.size !== manifest.files.length) throw Error('Portable inventory file count mismatch');
    for (const [index, entry] of manifest.files.entries()) {
        if (!files.delete(entry.path)) throw Error('Portable inventory path mismatch');
        const actual = hashFileSafe(path.join(directory, entry.path), 512 * 1024 ** 2);
        if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw Error('Portable inventory hash mismatch');
        if (index % 128 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    return manifest;
}

async function stagePortable({ root, installationRoot = root, directory, release, env, signal, progress = () => {}, onOutput = () => {} }) {
    release = JSON.parse(JSON.stringify(release));
    const feed = configuredFeed(root, env);
    if (!supported(root) || !validPortable(release, feed)) throw Error('Portable update source or installation mismatch');
    const signatures = require('./pi-update-signatures');
    signatures.verifyReleaseSignature(release, installationRoot);
    const sourceManifest = JSON.parse(readSafe(path.join(root, 'TRIAL_MANIFEST.json'), 16 * 1024 ** 2));
    const verifySource = async () => {
        if (!Array.isArray(sourceManifest.files) || sourceManifest.files.length > 20000) throw Error('Current source baseline unavailable');
        for (const [index, entry] of sourceManifest.files.entries()) {
            if (typeof entry.path !== 'string' || entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(entry.path)) throw Error('Invalid source baseline path');
            const proof = hashFileSafe(path.join(root, entry.path), 128 * 1024 ** 2);
            if (proof.sha256 !== entry.sha256 || proof.bytes !== entry.bytes) throw Error('Current program has unpublished changes; use independent maintenance');
            if (index % 128 === 0) await new Promise(resolve => setImmediate(resolve));
        }
    };
    await verifySource();
    const verifyTarget = async () => {
        signatures.verifyReleaseSignature(release, installationRoot);
        const service = new (require('./pi-update-service').UpdateService)({ root, installationRoot, env });
        const candidate = await service.manifest(release.channel);
        if (!candidate || ['version', 'piVersion', 'downloadUrl', 'sha256', 'bytes'].some(key => candidate[key] !== release[key])
            || !candidate.signedManifest || !signatures.releaseSignaturePayload(candidate.signedManifest).equals(signatures.releaseSignaturePayload(release.signedManifest))
            || JSON.stringify(candidate.signedManifest.signature) !== JSON.stringify(release.signedManifest.signature)) throw Error('Portable target changed; check and confirm again');
    };
    await verifyTarget();
    if (require('./pi-update-service').compareVersions(release.version, JSON.parse(readSafe(path.join(root, 'package.json'))).version) !== 1) throw Error('Portable version must increase');
    progress('downloading');
    const archive = path.join(privateDir(path.dirname(directory)), path.basename(directory) + '.zip');
    await downloadPortable(release, archive, { env, signal });
    if (signal?.aborted) throw Error('Portable staging cancelled');
    progress('extracting');
    await unpackPortable(archive, directory, release.version, signal);
    if (signal?.aborted) throw Error('Portable staging cancelled');
    const pkg = JSON.parse(readSafe(path.join(directory, 'package.json'))), lockBytes = readSafe(path.join(directory, 'package-lock.json'), 16 * 1024 ** 2);
    const lock = JSON.parse(lockBytes), pi = pkg.dependencies?.['@earendil-works/pi-coding-agent'];
    if (pkg.name !== 'pivane' || pkg.version !== release.version || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version
        || pi !== release.piVersion || JSON.parse(readSafe(path.join(directory, 'node_modules/@earendil-works/pi-coding-agent/package.json'))).version !== pi
        || !supported(directory)) throw Error('Portable package identity mismatch');
    progress('verifying');
    const probe = privateDir(path.join(path.dirname(directory), path.basename(directory) + '-probe'));
    const probeEnv = require('./pi-update-installer').installEnvironment(env, probe);
    Object.assign(probeEnv, { PI_UPDATE_PROBE: probe, PI_CODING_AGENT_DIR: path.join(probe, 'agent'), PI_PROJECT_ROOTS: probe,
        PI_MEDIA_DATA_DIR: path.join(probe, 'media'), PI_MEDIA_CONFIG_DIR: path.join(probe, 'media-lab'), PI_WEB_DEFERRED_FILE: path.join(probe, 'deferred.json'),
        PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', PI_WORKSPACE_BASE_URL: 'http://127.0.0.1:1' });
    await require('./pi-update-installer').runNode([path.join(directory, 'server/pi-update-probe.js')], { cwd: probe, env: probeEnv, signal, timeout: 90000, onOutput, secretEnv: env });
    await verifySource();
    await verifyTarget();
    atomicJson(path.join(directory, 'PI_INSTALL_COMPLETE.json'), { version: pi, appVersion: pkg.version, format: release.format,
        archiveSha256: release.sha256, signedRelease: release, completedAt: new Date().toISOString(), lockSha256: hash(lockBytes) });
}
module.exports = { supported, validPortable, downloadPortable, unpackPortable, stagePortable };
