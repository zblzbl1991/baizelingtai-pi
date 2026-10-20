const fs = require('node:fs');
const path = require('node:path');
const { readSafe, inside } = require('./pi-maintenance-files');
const { acquireInstallationLock } = require('./pi-installation-lock');
const RUNTIME_PATHS = ['PI_CODING_AGENT_DIR', 'PI_MEDIA_DATA_DIR', 'PI_MEDIA_CONFIG_DIR', 'PI_WEB_DEFERRED_FILE'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function explicitPath(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file) throw Error('Migration scope requires explicit absolute normalized paths');
    for (let existing = file;; existing = path.dirname(existing)) {
        try {
            if (fs.lstatSync(existing).isSymbolicLink() || fs.realpathSync.native(existing) !== existing) throw Error('Migration scope aliases require independent inspection');
            break;
        } catch (error) { if (error.code !== 'ENOENT' || existing === path.dirname(existing)) throw error; }
    }
    return file;
}
function packageVersion(directory) {
    const pkg = JSON.parse(readSafe(path.join(directory, 'package.json')));
    if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw Error('Unknown legacy package version');
    return pkg.version;
}
async function planLegacyMigration(root, scope) {
    root = fs.realpathSync.native(root);
    if (scope?.schemaVersion !== 1 || !scope.runtimePaths || Object.keys(scope.runtimePaths).some(key => !RUNTIME_PATHS.includes(key))
        || RUNTIME_PATHS.some(key => typeof scope.runtimePaths[key] !== 'string') || !Array.isArray(scope.backupRoots)
        || !scope.backupRoots.length || scope.backupRoots.length > 100) throw Error('Explicit migration runtime paths and backup roots are required');
    for (const value of Object.values(scope.runtimePaths)) explicitPath(value);
    const roots = [...new Set(scope.backupRoots.map(explicitPath))], backup = explicitPath(scope.backupDirectory);
    if (Object.values(scope.runtimePaths).some(file => !roots.some(base => inside(base, file)))) throw Error('Migration backup scope does not cover every original runtime path');
    if (roots.some(base => inside(base, backup) || inside(backup, base)) || inside(root, backup)) throw Error('Offline backup must be outside installation and every data scope');
    const owner = await acquireInstallationLock(root);
    try {
        const outerVersion = packageVersion(root);
        let state;
        try { fs.lstatSync(path.join(root, '.pivane-runtime/state.json')); state = JSON.parse(readSafe(path.join(root, '.pivane-runtime/state.json'))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; state = { version: 1, active: null }; }
        if (state.version !== 1 || state.active !== null && state.active !== undefined && !uuid.test(state.active)) throw Error('Unknown legacy installation state');
        let serviceRoot = root;
        if (state.active) {
            serviceRoot = path.join(root, '.pivane-runtime/releases', state.active);
            if (fs.realpathSync.native(serviceRoot) !== serviceRoot) throw Error('Legacy active program alias is unsafe');
        }
        const serviceVersion = packageVersion(serviceRoot);
        return { status: 'offline-maintenance-required', canMigrateAutomatically: false, blocker: 'LEGACY_CLEANUP_UNPROVEN', root, outerVersion, serviceVersion,
            versionsDiffer: outerVersion !== serviceVersion, runtimePaths: { ...scope.runtimePaths },
            backup: { required: true, roots, directory: backup, completeMarkerRequired: true, nativeSessionValidationRequired: true },
            changes: [
                { path: path.join(root, '.pivane-runtime/releases/<new-id>'), action: 'add independently verified signed complete program' },
                { path: path.join(root, '白泽灵台.exe'), action: 'replace only after independently established stopped maintenance and complete backup' },
                { path: path.join(root, '.pivane-runtime/state.json'), action: 'preserve unknown fields and original runtime paths; set selected release under offline maintenance' },
                { path: path.join(root, 'config/update-trust.json'), action: 'install independently trusted public keys; never trust a remote declaration' },
                { path: path.join(root, 'repair'), action: 'install independently verified repair closure' }
            ],
            preserves: ['native-session-id-time-branches-bookmarks-body', 'media-history-prompts', 'absolute-runtime-paths', 'original-shortcuts'],
            next: ['Normal stop and kernel absence alone do not prove legacy cleanup', 'Enter independent offline maintenance; preserve exact installation and data backups',
                'Verify signed target and native data semantics before changing entry/state', 'See docs/LAUNCHER_REPAIR.md; no mutation has been performed'] };
    } finally { await owner.close(); }
}
function refuseLegacyMigration() { throw Error('LEGACY_CLEANUP_UNPROVEN: automatic legacy migration is unavailable; use the explicit offline maintenance plan without inferring cleanup from PID/window disappearance'); }
module.exports = { planLegacyMigration, refuseLegacyMigration };
