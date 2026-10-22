// Manual Windows exact-package acceptance. Importing the CLI does not load an
// SDK, create a fixture, scan package inventories or launch native processes.
const fs = require('node:fs');
const path = require('node:path');

const SCENARIOS = Object.freeze(['normal', 'missing-signature', 'invalid-signature', 'foreign-key', 'target-changed',
    'corrupt-download', 'staged-mutation', 'unpublished-source', 'occupied-entry', 'unknown-cleanup', 'old-tray-held',
    'interrupt-prepared', 'interrupt-activating', 'interrupt-rollback', 'validation-failure', 'validation-timeout',
    'recovery-failure', 'repair-entry', 'repair-changed-entry', 'postcommit-preservation', 'legacy-refusal', 'committed-crash']);
const FLAGS = Object.freeze({ '--previous-archive': 'previousArchive', '--previous-sha256': 'previousSha256',
    '--previous-version': 'previousVersion', '--baseline-kind': 'baselineKind', '--archive': 'archive', '--sha256': 'sha256',
    '--signed-manifest': 'signedManifest', '--qa-trust': 'qaTrust', '--changed-manifest': 'changedManifest',
    '--output': 'output', '--browser': 'browser', '--playwright': 'playwright', '--scenario': 'scenario', '--retain-success': 'retainSuccess' });
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;
function parseOptions(args) {
    const result = {};
    for (let index = 0; index < args.length; index++) {
        const flag = args[index], key = FLAGS[flag];
        if (!key) throw Error('Unknown exact acceptance option: ' + flag);
        if (Object.hasOwn(result, key)) throw Error('Duplicate exact acceptance option: ' + flag);
        if (!args[index + 1] || args[index + 1].startsWith('--')) throw Error('Missing value for ' + flag);
        result[key] = args[++index];
    }
    for (const [flag, key] of Object.entries(FLAGS)) {
        if (!['changedManifest', 'retainSuccess'].includes(key) && !result[key]) throw Error('Missing ' + flag);
    }
    if (!SCENARIOS.includes(result.scenario)) throw Error('Unknown acceptance scenario');
    result.retainSuccess ||= 'no';
    if (!['yes', 'no'].includes(result.retainSuccess)) throw Error('Expected yes|no for --retain-success');
    if (!['synthetic-qa', 'published-new-protocol', 'historical-legacy'].includes(result.baselineKind)) throw Error('Explicit baseline kind is required');
    if (!VERSION.test(result.previousVersion)) throw Error('Invalid previous version');
    if (result.scenario === 'legacy-refusal' !== (result.baselineKind === 'historical-legacy')) throw Error('Historical legacy is only a refusal scenario');
    if (result.scenario === 'target-changed' && !result.changedManifest) throw Error('Missing --changed-manifest');
    for (const key of ['sha256', 'previousSha256']) if (!/^[a-f0-9]{64}$/.test(result[key])) throw Error('Expected lowercase SHA256 for ' + key);
    for (const key of ['previousArchive', 'archive', 'signedManifest', 'qaTrust', 'changedManifest', 'output', 'browser', 'playwright']) {
        if (!result[key]) continue;
        if (!path.isAbsolute(result[key])) throw Error('Expected absolute path for ' + key);
        result[key] = path.resolve(result[key]);
    }
    try { fs.lstatSync(result.output); throw Error('Output must be a fresh nonexistent directory'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (fs.realpathSync.native(path.dirname(result.output)) !== path.dirname(result.output)) throw Error('Output parent must be canonical');
    for (const key of ['previousArchive', 'archive', 'signedManifest', 'qaTrust', 'changedManifest', 'browser', 'playwright']) {
        if (result[key] && (result[key] === result.output || result[key].startsWith(result.output + path.sep))) throw Error('Output aliases an acceptance input');
    }
    if (result.previousArchive === result.archive) throw Error('Previous and candidate ZIP must be different exact artifacts');
    return Object.freeze(result);
}

module.exports = { parseOptions, SCENARIOS, validateInputs: options => require('./native-update-inputs.cjs').validateInputs(options) };
if (require.main === module) {
    Promise.resolve().then(async () => {
        const options = parseOptions(process.argv.slice(2));
        if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Native exact acceptance requires Windows x64');
        const inputs = module.exports.validateInputs(options);
        return require('./native-update-run.cjs').runAcceptance(options, inputs);
    }).then(result => { process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.exitCode; })
        .catch(error => { process.stderr.write(JSON.stringify({ status: 'failed', stage: 'acceptance', error: error.message }) + '\n'); process.exitCode = 1; });
}
