'use strict';
const fs = require('node:fs'), path = require('node:path');
const { StaffingStore } = require('./store');
const { readProfileRuntime } = require('../pi-profile-runtime');
const { readProfileBinding } = require('../pi-profile-state');
const { readRegistry } = require('../pi-profile-registry');
const { safeFile } = require('../pi-native-service');
const ownedRoot = fs.realpathSync.native(__dirname);
function isStaffingBinding(manager, agentDir) {
    const binding = readProfileBinding(manager);
    if (!binding?.profileId) return false;
    const managedId = readRegistry(safeFile(agentDir, ['pivane-profiles', 'profiles.json'])).state.managedProfiles?.['pivane-staffing:v1'];
    return Boolean(managedId && managedId === binding.profileId);
}
async function isStaffingSource(store, worker) {
    if (!worker.managed || worker.noSession || !worker.sessionPath || typeof store.getSession !== 'function') return false;
    const session = await store.getSession(worker.cwd, worker.sessionId);
    if (fs.realpathSync.native(session.path) !== fs.realpathSync.native(worker.sessionPath)) throw new Error('侧聊来源会话已变化，请重新打开。');
    const { SessionManager, getAgentDir } = await require('../pi-session-store').getSdk();
    const manager = SessionManager.open(session.path);
    if (manager.getSessionId() !== worker.sessionId || manager.getCwd() !== worker.cwd) throw new Error('侧聊来源归属已变化，请重新打开。');
    return isStaffingBinding(manager, getAgentDir());
}
function ownedResource(file, cwd) {
    try {
        const resolved = fs.realpathSync.native(path.resolve(cwd, file.replace(/^[!+-]/, '')));
        return resolved === ownedRoot || resolved.startsWith(ownedRoot + path.sep) || fs.statSync(resolved).isDirectory() && ownedRoot.startsWith(resolved + path.sep);
    } catch { return false; }
}
async function runtimeScope({ sessionManager, cwd, agentDir }) {
    if (process.env.PIVANE_PROFILE_AUTHORING_CONTEXT) return { eligible: false, bound: false };
    if (!sessionManager?.getSessionFile()) return { eligible: false, bound: false };
    const binding = readProfileBinding(sessionManager);
    if (!binding?.profileId) return { eligible: false, bound: false };
    let managed;
    try { managed = isStaffingBinding(sessionManager, agentDir); }
    catch { return { eligible: false, bound: false }; }
    if (!managed) return { eligible: false, bound: false };
    let state;
    try { state = await new StaffingStore().snapshot(); }
    catch { return { eligible: false, bound: true }; } // Only the dedicated profile depends on this optional ledger.
    const bound = Boolean(binding?.profileId && binding.profileId === state.profileId);
    if (!bound) return { eligible: false, bound: true };
    const profile = readProfileRuntime(sessionManager, cwd, agentDir, path.join(fs.realpathSync.native(agentDir), 'sessions'));
    const eligible = Boolean(state.enabled && state.initialized && state.phase === 'ready' && profile
        && !process.env.PIVANE_PROFILE_AUTHORING_CONTEXT && process.env.PI_WEB_NAVIGATION_TOKEN);
    return { bound, eligible, epoch: state.epoch, profileRevision: profile?.revision,
        source: { sessionId: sessionManager.getSessionId(), sessionPath: fs.realpathSync.native(sessionManager.getSessionFile()), cwd, profileId: binding.profileId } };
}
async function installRequestGuard(session, input, initialScope) {
    if (!initialScope.bound) return;
    const original = session.agent.streamFunction;
    // Host-owned public stream boundary runs before SDK cache warming and every provider continuation.
    // Extension callbacks are unsuitable: Pi catches their errors and continues the request.
    session.agent.streamFunction = async (...args) => {
        const expected = input.staffingScope || initialScope;
        const current = await runtimeScope(input);
        if (!current.eligible || !expected.eligible || current.epoch !== expected.epoch
            || current.profileRevision !== expected.profileRevision || JSON.stringify(current.source) !== JSON.stringify(expected.source)) {
            throw new Error('人员调配配置已变化。请重新加载会话资源后继续；未发送模型请求。');
        }
        return original(...args);
    };
}
module.exports = { runtimeScope, ownedResource, installRequestGuard, isStaffingSource };
