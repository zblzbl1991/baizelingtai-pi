const path = require('node:path');
const fs = require('node:fs');
const { readSafe, atomicJson, hash } = require('./pi-maintenance-files');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function unproven() {
    return Object.assign(Error('上次服务清理结果未知，请通过独立维护流程处理'), { code: 'DESKTOP_OWNER_UNPROVEN' });
}
function ownerOf(state, root) {
    if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1) throw unproven();
    if (!has(state, 'desktopOwnerProtocol') && !has(state, 'desktopOwner')) return null;
    if (state.desktopOwnerProtocol !== 1 || !has(state, 'desktopOwner')) throw unproven();
    const owner = state.desktopOwner;
    if (owner === null) return null;
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)
        || Object.keys(owner).length !== 5 || Object.keys(owner).some(key => !['version', 'root', 'runnerGeneration', 'serviceGeneration', 'releaseId'].includes(key))
        || owner.version !== 1 || owner.root !== root || !UUID.test(owner.runnerGeneration || '') || !UUID.test(owner.serviceGeneration || '')
        || owner.releaseId !== null && !UUID.test(owner.releaseId || '')) throw unproven();
    return owner;
}
function stateOf(root) {
    if (fs.realpathSync.native(root) !== root || fs.lstatSync(root).isSymbolicLink()) throw unproven();
    const directory = path.join(root, '.pivane-runtime');
    let stat;
    try { stat = fs.lstatSync(directory); } catch (error) { if (error.code !== 'ENOENT') throw unproven(); }
    if (stat) {
        try { if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(directory) !== directory) throw unproven(); }
        catch { throw unproven(); }
    }
    const file = path.join(root, '.pivane-runtime/state.json');
    try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw unproven(); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, active: null, previous: null, job: null }; throw error; }
    try { return JSON.parse(readSafe(file)); } catch { throw unproven(); } // Existing/changed objects never downgrade to absence.
}
function assertStopped(root, state = stateOf(root)) { if (ownerOf(state, root)) throw unproven(); }
function sameOwner(left, right) {
    return left === null && right === null || left && right && ['version', 'root', 'runnerGeneration', 'serviceGeneration', 'releaseId'].every(key => left[key] === right[key]);
}
function replaceOwner(root, state, expected, next) {
    const current = stateOf(root);
    if (!sameOwner(ownerOf(current, root), expected)) throw unproven();
    const value = { ...current, ...state, desktopOwnerProtocol: 1, desktopOwner: next };
    atomicJson(path.join(root, '.pivane-runtime/state.json'), value);
    Object.assign(state, value);
}
function portableCapability(root) {
    try {
        const file = require('./pi-update-feed').portableMetadataFile(root), bytes = readSafe(file, 64 * 1024), value = JSON.parse(bytes);
        if (value.version !== 1 || value.platform !== 'win32' || value.arch !== 'x64' || value.launcherUpdateProtocol !== 1 || value.desktopOwnerProtocol !== 1) throw Error();
        const manifest = JSON.parse(readSafe(path.join(root, 'PORTABLE_MANIFEST.json'), 64 * 1024 ** 2));
        const pkg = JSON.parse(readSafe(path.join(root, 'package.json')));
        if (manifest.version !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' || manifest.appVersion !== pkg.version
            || typeof pkg.version !== 'string' || pkg.version.length > 80 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version)
            || !Array.isArray(manifest.files) || manifest.files.length > 100000) throw Error();
        const entries = manifest.files.filter(entry => entry.path === path.basename(file));
        if (entries.length !== 1 || entries[0].bytes !== bytes.length || entries[0].sha256 !== hash(bytes)) throw Error();
        return [path.basename(file), 'PORTABLE_MANIFEST.json'];
    } catch {
        throw Object.assign(Error('当前版本和更新包均须支持安全退出交接，请通过独立维护流程升级'), { code: 'DESKTOP_OWNER_PROTOCOL_REQUIRED' });
    }
}
module.exports = { ownerOf, stateOf, assertStopped, unproven, sameOwner, replaceOwner, portableCapability };
