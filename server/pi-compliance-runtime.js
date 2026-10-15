const fs = require('node:fs');
const path = require('node:path');
const { readProfileRuntime } = require('./pi-profile-runtime');
const { ComplianceLedger } = require('./pi-compliance-ledger');
const packageRoot = path.resolve(__dirname, '../pi-packages/compliance');
const extensionPath = path.join(packageRoot, 'extensions/compliance.ts');
const skillPath = path.join(packageRoot, 'skills');
function isComplianceResource(file) {
    if (typeof file !== 'string') return false;
    const resolved = path.resolve(file);
    return resolved === packageRoot || resolved.startsWith(packageRoot + path.sep);
}
// Native binding and the current protected ledger must agree. Environment alone,
// profile names, copied child environments and tool arguments grant no authority.
function complianceRuntime(manager, cwd, agentDir) {
    try {
        if (!process.env.PI_WEB_NAVIGATION_TOKEN || !manager?.getSessionFile()) return null;
        const profile = readProfileRuntime(manager, cwd, agentDir, path.join(fs.realpathSync.native(agentDir), 'sessions'));
        if (!profile) return null;
        const file = require('./pi-native-service').safeFile(agentDir, ['pivane-compliance', 'ledger.json']);
        const state = new ComplianceLedger().read(file);
        return state.settings.enabled && !state.setup && state.settings.profileId === profile.context.profileId ? state.settings : null;
    } catch { return null; }
}
module.exports = { complianceRuntime, isComplianceResource, extensionPath, skillPath };
