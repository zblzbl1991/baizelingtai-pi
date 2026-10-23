const { startManaged } = require('../server/pi-server-entry');
if (['slow-start', 'short-budget'].includes(process.argv[3])) {
    // Scale the production readiness budgets so cold-import regressions take
    // seconds to reproduce, without changing the entry point's actual choice.
    const original = global.setTimeout;
    global.setTimeout = (callback, delay, ...args) => original(callback,
        [45000, 180000].includes(delay) ? process.argv[3] === 'short-budget' ? 50 : delay / 50 : delay, ...args);
}
const launcher = startManaged(process.argv[2], { replace: process.argv[3] !== 'service' });
launcher.entryReady.then(() => console.log('ENTRY_READY'), () => {});
process.stdin.once('data', () => {
    // Only synthetic/isolated test children: bound cleanup if startup itself
    // blocks the service's event loop and cannot receive its shutdown IPC.
    setTimeout(() => launcher.child?.kill(), 10000).unref();
    process.emit('SIGTERM');
});
process.stdin.unref();
