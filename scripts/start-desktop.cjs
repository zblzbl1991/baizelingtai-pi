// Private LF-framed protocol with the Windows tray. Server output stays on stderr.
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
process.stdout.on('error', () => process.emit('SIGTERM'));
process.stderr.on('error', () => process.emit('SIGTERM'));
const root = require('node:path').resolve(__dirname, '..');
if (process.argv.length === 3 && process.argv[2] === '--identity') {
    emit({ root: require('node:fs').realpathSync.native(root), id: require('../server/pivane-desktop-launcher').installationId(root) });
}
else if (process.argv.length !== 2) { emit({ type: 'error', message: 'Usage: node scripts/start-desktop.cjs [--identity]' }); process.exitCode = 1; }
else require('../server/pivane-desktop-launcher').startDesktop({ root, emit }).catch(error => {
    const message = require('../server/pi-update-output').outputRedactor(process.env)(error.message);
    // Cleanup has completed. Flush the failure event, then release the parent pipe.
    process.stdout.write(error.desktopReported ? '' : JSON.stringify({ type: 'error', message }) + '\n', () => process.exit(1));
});
