const { diagnoseInstallation, restoreEntry } = require('../server/pi-launcher-repair');
const { planLegacyMigration, refuseLegacyMigration } = require('../server/pi-launcher-legacy');
const { readSafe } = require('../server/pi-maintenance-files');
async function main(args) {
    const [command, root, id] = args;
    if (command === 'diagnose' && args.length === 2) return diagnoseInstallation(root);
    if (command === 'restore-entry' && (args.length === 3 || args.length === 4 && args[3] === '--replace-changed')) return restoreEntry(root, id, { replaceChanged: args[3] === '--replace-changed' });
    if (command === 'legacy-plan' && args.length === 4 && id === '--scope') {
        let scope;
        try { scope = JSON.parse(readSafe(args[3], 1024 * 1024)); } catch { throw Error('Invalid migration scope file; use the documented JSON shape without credentials'); }
        return planLegacyMigration(root, scope);
    }
    if (command === 'migrate-legacy') return refuseLegacyMigration();
    if (command === 'rollback-handoff' && args.length === 3) return require('../server/pi-launcher-update-helper').main(['rollback-handoff', root, id]);
    throw Error('Usage: repair-launcher.cjs diagnose <root> | restore-entry <root> <id> [--replace-changed] | rollback-handoff <root> <id> | legacy-plan <root> --scope <file>');
}
if (require.main === module) main(process.argv.slice(2)).then(result => { if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n'); }).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
