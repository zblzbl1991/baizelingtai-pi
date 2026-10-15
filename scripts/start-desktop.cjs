// Private LF-framed protocol with the Windows tray. Server output stays on stderr.
const controlled = process.argv.length === 5 && process.argv[2] === '--controlled' && process.argv[3] === '--generation' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(process.argv[4]);
const generation = controlled ? process.argv[4] : undefined;
const emit = value => process.stdout.write(JSON.stringify({ ...value, ...(controlled ? { generation } : {}) }) + '\n');
process.stdout.on('error', () => process.emit('SIGTERM'));
process.stderr.on('error', () => process.emit('SIGTERM'));
const root = require('node:path').resolve(__dirname, '..');
if (process.argv.length === 3 && process.argv[2] === '--identity') {
    emit({ root: require('node:fs').realpathSync.native(root), id: require('../server/pivane-desktop-launcher').installationId(root) });
}
else if (process.argv.length !== 2 && !controlled) { emit({ type: 'error', message: 'Usage: node scripts/start-desktop.cjs [--identity | --controlled --generation UUID]' }); process.exitCode = 1; }
else require('../server/pivane-desktop-launcher').startDesktop({ root, emit, controlled, generation }).catch(error => {
    const message = require('../server/pi-update-output').outputRedactor(process.env)(error.message);
    // Cleanup has completed. Flush the failure event, then release the parent pipe.
    // Unreported errors occur in preflight, before the service manager starts.
    // Once a child may exist, startDesktop reports the error and cleanup facts.
    if (!error.desktopReported) emit({ type: 'error', message, ...(controlled ? { clean: true } : {}) });
    process.stdout.write('', () => process.exit(1));
});
