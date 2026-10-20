// Read-only exact-artifact contract validation. Extracts selected published code
// into a new synthetic identity; never launches the legacy service or GUI.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { privateDir, hashFileSafe, atomicJson } = require('../../server/pi-maintenance-files');
const EXPECTED = { bytes: 326606675, sha256: 'ec39ded0df23667e58800773b86db1a80bae7e032a1e85b894b3bd4b5fc341d9' };
async function main(archive, output) {
    if (process.platform !== 'win32' || !archive || !output) throw Error('Usage on Windows: node test/release/launcher-legacy-migration.cjs <exact-1.7.3.zip> <private-output>');
    archive = fs.realpathSync.native(archive);
    assert.deepEqual(hashFileSafe(archive, 1024 ** 3), EXPECTED, 'exact legacy artifact is required');
    const directory = privateDir(path.join(privateDir(path.resolve(output)), 'legacy-inspection-' + randomUUID()));
    const root = privateDir(path.join(directory, 'isolated-installation'));
    const selected = ['package.json', 'PORTABLE_MANIFEST.json', 'baizelingtai-portable.json', 'native/pivane-desktop-launcher.cs', 'server/pi-managed-launcher.js', 'server.js', 'scripts/desktop-tray.ps1'];
    const script = String.raw`$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($env:LEGACY_ARCHIVE)
try {
  foreach($relative in (ConvertFrom-Json $env:LEGACY_SELECTED)) {
    $entry=$zip.GetEntry('baizelingtai-1.7.3/'+$relative)
    if(-not $entry -or $entry.Length -gt 67108864) { throw 'Selected legacy code missing or exceeds budget' }
    $file=Join-Path $env:LEGACY_ROOT $relative
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null
    $input=$entry.Open(); $out=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $input.CopyTo($out); $out.Flush($true) } finally { $input.Dispose(); $out.Dispose() }
  }
} finally { $zip.Dispose() }`;
    execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        windowsHide: true, timeout: 120000, stdio: 'pipe', env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
            LEGACY_ARCHIVE: archive, LEGACY_ROOT: root, LEGACY_SELECTED: JSON.stringify(selected) }
    });
    const inventory = JSON.parse(fs.readFileSync(path.join(root, 'PORTABLE_MANIFEST.json')));
    for (const name of selected.filter(name => name !== 'PORTABLE_MANIFEST.json')) {
        const entry = inventory.files.find(file => file.path === name);
        assert.ok(entry, 'selected file must belong to exact portable inventory: ' + name);
        assert.deepEqual(hashFileSafe(path.join(root, name), 64 * 1024 ** 2), { bytes: entry.bytes, sha256: entry.sha256 });
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version, '1.7.3');
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'baizelingtai-portable.json')));
    const managedSource = fs.readFileSync(path.join(root, 'server/pi-managed-launcher.js'), 'utf8');
    assert.equal(metadata.launcherUpdateProtocol, undefined);
    assert.equal(managedSource.includes('requireShutdownProof'), false);
    const releaseId = randomUUID(), candidate = privateDir(path.join(root, '.pivane-runtime/releases', releaseId));
    // Only service-version metadata is synthetic. The 1.7.3 outer package and
    // launcher source above are actual bytes from the exact archive.
    atomicJson(path.join(candidate, 'package.json'), { name: 'pivane', version: '1.8.0', syntheticVersionMetadataOnly: true });
    atomicJson(path.join(root, '.pivane-runtime/state.json'), { version: 1, active: releaseId, job: { phase: 'succeeded', exitCode: 0, pid: null } });
    const agent = privateDir(path.join(root, 'synthetic-agent'));
    const session = path.join(agent, 'session.jsonl');
    fs.writeFileSync(session, '{"type":"session","version":3,"id":"preserve-session","timestamp":"2026-10-20T00:00:00Z","cwd":"synthetic"}\n{"type":"message","id":"branch-root","parentId":null,"timestamp":"2026-10-20T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"synthetic retained body"}],"timestamp":1792454401000}}\n');
    atomicJson(path.join(agent, 'bookmarks.json'), { sessionId: 'preserve-session', entryId: 'branch-root' });
    const dataProof = hashFileSafe(session), bookmarkProof = hashFileSafe(path.join(agent, 'bookmarks.json')),
        stateFile = path.join(root, '.pivane-runtime/state.json'), stateProof = hashFileSafe(stateFile);
    const scope = { schemaVersion: 1, runtimePaths: { PI_CODING_AGENT_DIR: agent, PI_MEDIA_DATA_DIR: path.join(root, 'synthetic-media'),
        PI_MEDIA_CONFIG_DIR: path.join(root, 'synthetic-media-config'), PI_WEB_DEFERRED_FILE: path.join(root, 'synthetic-deferred.json') },
        backupRoots: [root], backupDirectory: path.join(directory, 'offline-backup-not-created') };
    const scopeFile = path.join(directory, 'scope.json'); atomicJson(scopeFile, scope);
    const cli = path.resolve(__dirname, '../../scripts/repair-launcher.cjs');
    const env = { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP };
    const planned = spawnSync(process.execPath, [cli, 'legacy-plan', root, '--scope', scopeFile], { encoding: 'utf8', windowsHide: true, env });
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(planned.stdout);
    assert.equal(plan.outerVersion, '1.7.3'); assert.equal(plan.serviceVersion, '1.8.0'); assert.equal(plan.versionsDiffer, true);
    assert.equal(plan.blocker, 'LEGACY_CLEANUP_UNPROVEN'); assert.equal(plan.canMigrateAutomatically, false);
    const refused = spawnSync(process.execPath, [cli, 'migrate-legacy', root, '--scope', scopeFile, '--assume-stopped'], { encoding: 'utf8', windowsHide: true, env });
    assert.equal(refused.status, 1); assert.match(refused.stderr, /LEGACY_CLEANUP_UNPROVEN/);
    assert.deepEqual(hashFileSafe(session), dataProof); assert.deepEqual(hashFileSafe(stateFile), stateProof);
    assert.deepEqual(hashFileSafe(path.join(agent, 'bookmarks.json')), bookmarkProof);
    assert.deepEqual(hashFileSafe(archive, 1024 ** 3), EXPECTED, 'archive remains untouched');
    const report = { artifact: EXPECTED, extraction: 'selected-code-only', outerVersion: '1.7.3', serviceVersion: '1.8.0', serviceVersionIsSyntheticMetadata: true,
        launchedLegacyProcesses: false, migrationPerformed: false, automaticMigrationRejected: true, cleanupProtocolPresent: false,
        stateAndSyntheticSessionBytesPreserved: true, nativeSemanticMigrationAcceptance: 'not performed: no migration was executed', plan };
    atomicJson(path.join(directory, 'report.json'), report);
    console.log(JSON.stringify({ passed: true, directory, artifact: EXPECTED, automaticMigrationRejected: true, migrationPerformed: false }));
    return report;
}
if (require.main === module) main(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
