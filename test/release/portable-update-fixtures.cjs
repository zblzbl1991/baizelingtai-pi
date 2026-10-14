// Derive an explicitly simulated older updater baseline from an exact candidate.
// This is not a reconstruction or replacement of an already released version.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { extract } = require('./gitlab-portable-update.cjs');
const tools = require('../../scripts/package-windows-portable.cjs');
const { hashFileSafe, hash } = require('../../server/pi-maintenance-files');
async function main(args) {
    const opts = {};
    for (let index = 0; index < args.length; index += 2) {
        const key = { '--archive': 'archive', '--sha256': 'sha256', '--output': 'output', '--baseline-version': 'version' }[args[index]];
        assert.ok(key && args[index + 1] && !opts[key], 'invalid fixture build options'); opts[key] = args[index + 1];
    }
    for (const key of ['archive', 'sha256', 'output', 'version']) assert.ok(opts[key]);
    assert.match(opts.version, /^\d+\.\d+\.\d+$/); assert.equal(hashFileSafe(opts.archive).sha256, opts.sha256);
    opts.output = path.resolve(opts.output); assert.ok(!fs.existsSync(opts.output)); fs.mkdirSync(opts.output, { recursive: true });
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'baizelingtai-baseline-build-')));
    const original = await extract(path.resolve(opts.archive), path.join(scratch, 'extract'));
    const old = path.join(path.dirname(original), tools.portableDirectoryName(opts.version)); fs.renameSync(original, old);
    const json = (name, data) => fs.writeFileSync(path.join(old, name), JSON.stringify(data, null, 2) + '\n');
    const pkg = JSON.parse(fs.readFileSync(path.join(old, 'package.json'))), targetVersion = pkg.version;
    assert.equal(require('../../server/pi-update-service').compareVersions(targetVersion, opts.version), 1);
    pkg.version = opts.version; json('package.json', pkg);
    const lock = JSON.parse(fs.readFileSync(path.join(old, 'package-lock.json'))); lock.version = opts.version; lock.packages[''].version = opts.version; json('package-lock.json', lock);
    const env = tools.portableEnvironment(old, path.join(scratch, 'compiler-data')); fs.mkdirSync(env.TEMP);
    execFileSync(path.join(old, 'runtime/node.exe'), [path.join(old, 'scripts/build-desktop-launcher.cjs')], { cwd: old, env, windowsHide: true, stdio: 'inherit' });
    const trial = JSON.parse(fs.readFileSync(path.join(old, 'TRIAL_MANIFEST.json')));
    trial.appVersion = opts.version; trial.simulation = true; trial.simulatedBaselineFrom = { version: targetVersion, archiveSha256: opts.sha256 };
    for (const file of trial.files) { const bytes = fs.readFileSync(path.join(old, file.path)); file.bytes = bytes.length; file.sha256 = hash(bytes); }
    json('TRIAL_MANIFEST.json', trial);
    const manifest = JSON.parse(fs.readFileSync(path.join(old, 'PORTABLE_MANIFEST.json')));
    json('PORTABLE_MANIFEST.json', { ...manifest, appVersion: opts.version, simulation: true, simulatedBaselineFrom: trial.simulatedBaselineFrom,
        files: tools.inventory(old).filter(file => file.path !== 'PORTABLE_MANIFEST.json') });
    const archive = path.join(opts.output, `${tools.portableDirectoryName(opts.version)}-simulation.zip`);
    tools.createPortableArchive(old, archive); const sha256 = hashFileSafe(archive).sha256, bytes = fs.statSync(archive).size;
    fs.writeFileSync(archive + '.sha256', `${sha256}  ${path.basename(archive)}\n`, { flag: 'wx' });
    const report = { simulation: true, baselineContainsNewUpdater: true, archive, sha256, bytes, version: opts.version, targetVersion, targetArchiveSha256: opts.sha256, scratch };
    fs.writeFileSync(path.join(opts.output, 'fixture-build.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.stack); process.exitCode = 1; });
