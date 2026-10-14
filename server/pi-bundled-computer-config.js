const path = require('node:path');
const scopeKey = Symbol.for('pivane/bundled-computer-config/v1');
const scopes = () => globalThis[scopeKey] ||= new Map();
function setComputerConfigScope(cwd, agentDir, trusted) { scopes().set(cwd, { agentDir, trusted: trusted === true }); }
function computerConfigScope(cwd) { return scopes().get(cwd); }
// Set before Pi imports the upstream helper modules. Native helpers belong to
// the actual managed identity, including isolated tests and portable installs.
function configureComputerHelpers(agentDir, env = process.env) {
    const directory = path.join(agentDir, 'helpers', 'pi-computer-use', '0.5.1');
    env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH ||= path.join(directory, 'windows-bridge.exe');
    env.PI_COMPUTER_USE_LINUX_HELPER_PATH ||= path.join(directory, 'linux-bridge');
    env.PI_COMPUTER_USE_HELPER_APP_PATH ||= path.join(directory, 'pi-computer-use.app');
}
module.exports = { configureComputerHelpers, setComputerConfigScope, computerConfigScope };
