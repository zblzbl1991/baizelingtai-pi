const path = require('node:path');
const { ManagedLauncher } = require('./pi-managed-launcher');
function startManaged(root, { replace = false, foreground = replace } = {}) {
    require('./pi-local-env').loadLocalEnv(path.join(root, '.env'));
    let launcher, control, controlOpening, stopping = false;
    const dispose = async () => {
        stopping = true;
        await controlOpening?.catch(() => {});
        control?.retire(); await launcher?.close();
    };
    require('./pi-process-shutdown').registerProcessShutdown(dispose);
    try {
        const network = new (require('./workspace-network-service').WorkspaceNetworkService)({ root });
        const networkEnvironment = { ...process.env }; network.applyEnvironment(networkEnvironment);
        launcher = new ManagedLauncher({ root, networkEnvironment, requireShutdownProof: foreground,
            startupTimeoutMs: foreground ? 180000 : undefined,
            onUnexpectedExit: () => { void dispose().then(() => process.exit(1), () => process.exit(1)); } });
        launcher.entryReady = (async () => {
            const { openStartControl, replaceManaged } = require('./pi-start-control');
            if (replace && await replaceManaged(root)) console.log('旧实例已完成停机，正在启动白泽灵台。');
            if (stopping || launcher.closed) return;
            await launcher.start();
            if (!foreground || stopping || launcher.closed) return;
            controlOpening = openStartControl(root, async retire => {
                if (stopping || launcher.closed || launcher.status().busy) throw Error('Launcher is busy');
                const result = await launcher.desktopRequest('restart', {});
                if (result?.accepted !== true) throw Error('Restart was not accepted');
                stopping = true;
                retire();
                await launcher.close();
            }, error => process.exit(error ? 1 : 0));
            control = await controlOpening;
            if (stopping || launcher.closed) control.retire();
        })();
        launcher.entryReady.catch(error => {
            console.error('白泽灵台启动失败：', error.code === 'EADDRINUSE'
                ? '此目录正由其他实例使用。旧版、托盘或系统服务请先从原入口停止。' : error.message);
            void dispose().then(() => process.exit(1), () => process.exit(1));
        });
    } catch { console.error('baizelingtai maintenance state could not be opened; no update was attempted.'); process.exit(1); }
    return launcher;
}
function handoff(root) {
    if (process.argv.includes('--direct') || process.send && process.env.PI_MANAGED_LAUNCHER) return false;
    startManaged(root, { foreground: true }); return true;
}
module.exports = { startManaged, handoff };
