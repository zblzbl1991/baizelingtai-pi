const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function createApplication({ diagnostic = () => {} } = {}) {
    const began = performance.now();
    const phase = (name, detail = {}) => diagnostic({ phase: name, elapsedMs: Math.round(performance.now() - began), ...detail });
    phase('fixture-start');
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-desktop-')));
    const root = path.join(base, '白泽 灵台 & 测试'); fs.mkdirSync(root);
    const source = path.resolve(__dirname, '..');
    const files = require('../scripts/source-files.cjs').distributionFiles(source);
    phase('fixture-inventory-ready', { files: files.length });
    for (const file of files) {
        const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(source, file), target);
    }
    phase('fixture-copy-complete');
    fs.symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(path.join(root, '.pivane-launcher-test'), 'synthetic instance\n');
    const env = {};
    for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'HOME', 'LANG']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { HOST: '127.0.0.1', PORT: '0', PI_CODING_AGENT_DIR: path.join(base, 'agent'),
        PI_MEDIA_CONFIG_DIR: path.join(base, 'media-lab'), PI_MEDIA_DATA_DIR: path.join(base, 'media'), PI_PROJECT_ROOTS: base,
        PI_WEB_DEFERRED_FILE: path.join(base, 'deferred.json'), PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' });
    phase('fixture-ready');
    return { base, root, env };
}
module.exports = { createApplication };
