const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const { readSafe, inside } = require('./pi-maintenance-files');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PATHS = ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_MEDIA_DATA_DIR', 'PI_MEDIA_CONFIG_DIR', 'PI_WEB_DEFERRED_FILE', 'PI_PROJECT_ROOTS',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PIVANE_NATIVE_QA_CHECKPOINTS', 'PIVANE_NATIVE_QA_RECEIPTS'];
const QA_KEYS = ['PIVANE_NATIVE_QA', 'PIVANE_NATIVE_QA_SCOPE', 'PIVANE_NATIVE_QA_RUN_ID', 'PIVANE_NATIVE_QA_SCENARIO', 'PIVANE_NATIVE_QA_CHECKPOINTS', 'PIVANE_NATIVE_QA_RECEIPTS'];
const SAFE = { PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' };
const BOUND_KEYS = [...PATHS, ...QA_KEYS, ...Object.keys(SAFE), 'PIVANE_DESKTOP_SMOKE_ROOT', 'PIVANE_INSTALLATION_ROOT'];
const sameStat = (left, right) => ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);
// A global ancestor's unrelated children may change while this scope is held.
// Its identity, type and permissions must still match; scoped objects retain
// the full before/after metadata check below.
const sameAncestor = (left, right) => ['dev', 'ino', 'mode', 'uid', 'gid'].every(key => left[key] === right[key]);
function openedPath(fd) {
    if (process.platform === 'win32') {
        // Node realpath can reject a drive-root HANDLE path as "C:". Retain the
        // exact kernel-reported drive root, never substitute a requested path.
        const kernel = require('./pi-win32-native').getWindowsNative().descriptorPath(fd);
        if (/^\\\\\?\\[A-Za-z]:\\$/.test(kernel)) return kernel.slice(4);
    }
    return descriptorPathSync(fd);
}
function exactKeys(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)); }
function canonical(name) {
    if (typeof name !== 'string' || name.length > 4096 || !path.isAbsolute(name) || path.normalize(name) !== name || fs.realpathSync.native(name) !== name) throw Error('Native QA paths must be canonical existing absolute paths');
    return name;
}
function privateWindowsPermissions(objects, paths, scratch) {
    // Read actual DACLs, not Node's synthetic Windows mode bits. Static .NET
    // methods avoid Get-Acl module loading and no code is compiled/executed from
    // the fixture. The fixed script consumes only the validated bounded list.
    const script = String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$assembly=[Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31BF3856AD364E35')
$json=[Web.Script.Serialization.JavaScriptSerializer]::new()
$allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')
$proof=[Text.StringBuilder]::new()
foreach($item in $json.DeserializeObject([Console]::In.ReadToEnd())) {
  if($item.directory) { $acl=[IO.Directory]::GetAccessControl($item.path,[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner) }
  else { $acl=[IO.File]::GetAccessControl($item.path,[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner) }
  if($item.privateObject) {
    if($allowed -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'Native QA owner is not private' }
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $allowed -notcontains $rule.IdentityReference.Value) { throw 'Native QA DACL is not private' }
    }
  }
  $null=$proof.Append($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner)).Append([char]0)
}
$sha=[Security.Cryptography.SHA256]::Create()
try { [Console]::Write(([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($proof.ToString())))).Replace('-','').ToLowerInvariant()) } finally { $sha.Dispose() }`;
    let output;
    try {
        output = execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
                windowsHide: true, timeout: 10000, maxBuffer: 8192, stdio: ['pipe', 'pipe', 'pipe'], input: JSON.stringify(objects.map(item => ({ path: item.name, directory: item.before.isDirectory(), privateObject: item.privateObject }))),
                encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot, HOME: paths.HOME, USERPROFILE: paths.USERPROFILE, APPDATA: paths.APPDATA,
                    LOCALAPPDATA: paths.LOCALAPPDATA, TEMP: scratch, TMP: scratch }
            });
    } catch { throw Error('Native QA private Windows permissions could not be verified'); }
    if (!/^[a-f0-9]{64}$/.test(output)) throw Error('Invalid native QA permission proof');
    return output;
}
function recordOf(file) {
    let value;
    try { value = JSON.parse(readSafe(file, 64 * 1024)); } catch { throw Error('Native QA sentinel is missing, changed or invalid'); }
    if (!exactKeys(value, ['schemaVersion', 'runId', 'root', 'scope', 'scenario', 'paths']) || value.schemaVersion !== 1 || !UUID.test(value.runId || '')
        || !exactKeys(value.paths, PATHS) || PATHS.some(key => typeof value.paths[key] !== 'string')
        || value.scenario !== undefined && !/^[a-z][a-z0-9-]{0,47}$/.test(value.scenario)) throw Error('Invalid native QA sentinel fields');
    return value;
}
function continuationEnvironment(root, environment = process.env) {
    if (!Object.keys(environment).some(key => /^PIVANE_NATIVE_QA/i.test(key) && environment[key] !== undefined)) return {};
    if (environment.PIVANE_NATIVE_QA !== '1' || !UUID.test(environment.PIVANE_NATIVE_QA_RUN_ID || '') || !environment.PIVANE_NATIVE_QA_SCOPE) throw Error('Invalid native QA opt-in');
    for (const key of Object.keys(environment)) {
        if (environment[key] === undefined) continue;
        if (BOUND_KEYS.includes(key.toUpperCase()) && key !== key.toUpperCase()
            || /^PIVANE_NATIVE_QA/i.test(key) && !QA_KEYS.includes(key) || /^NODE_|^(?:OPEN_?BROWSER|PIVANE_DESKTOP_SMOKE_OPEN_BROWSER|PI_WEB_CLI|PI_PACKAGE_DIR|BASH_ENV)$/i.test(key)
            || /(?:^|_)(?:API_KEY|API_TOKEN|AUTH|AUTHORIZATION|TOKEN|PASSWORD|SECRET|COOKIE|PRIVATE_KEY|CREDENTIALS|ACCESS_KEY|SECRET_KEY)(?:_|$)/i.test(key)) throw Error('Unsafe native QA environment field');
    }
    root = canonical(root); const scope = canonical(environment.PIVANE_NATIVE_QA_SCOPE);
    if (root === scope || !inside(scope, root)) throw Error('Native QA installation root is outside its private scope');
    const opened = new Map();
    function capture(name, directory) {
        if (opened.has(name)) { if (opened.get(name).before.isDirectory() !== directory) throw Error('Conflicting native QA path types'); return; }
        if (opened.size >= 256) throw Error('Native QA ancestor budget exceeded');
        if (fs.lstatSync(name).isSymbolicLink()) throw Error('Native QA aliases are forbidden');
        const fd = io.openReadSync(name);
        try {
            const before = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
            if ((directory ? !before.isDirectory() : !before.isFile()) || openedPath(fd) !== name || fs.realpathSync.native(name) !== name
                || !sameStat(before, fs.lstatSync(name, { bigint: true })) || !directory && before.size > 4n * 1024n ** 2n) throw Error('Unsafe native QA filesystem identity or budget');
            const privateObject = inside(scope, name);
            fs.accessSync(name, fs.constants.R_OK | (privateObject ? fs.constants.W_OK : 0));
            if (privateObject && process.platform !== 'win32' && (before.mode & 0o077n) !== 0n) throw Error('Native QA filesystem permissions are not private');
            opened.set(name, { name, fd, before, identity, privateObject });
        } catch (error) { fs.closeSync(fd); throw error; }
    }
    function hierarchy(name, directory) {
        canonical(name);
        for (let current = name, leaf = true;; current = path.dirname(current), leaf = false) {
            capture(current, leaf ? directory : true);
            if (current === path.dirname(current)) break;
        }
    }
    try {
        hierarchy(scope, true); hierarchy(root, true);
        const scopeMarker = path.join(scope, '.pivane-native-qa.json'), rootMarker = path.join(root, '.pivane-launcher-test');
        hierarchy(scopeMarker, false); hierarchy(rootMarker, false);
        const record = recordOf(scopeMarker), other = recordOf(rootMarker);
        const semantic = value => JSON.stringify([value.schemaVersion, value.runId, value.root, value.scope, value.scenario || 'normal', ...PATHS.map(key => value.paths[key])]);
        if (semantic(record) !== semantic(other) || record.root !== root || record.scope !== scope || record.runId !== environment.PIVANE_NATIVE_QA_RUN_ID) throw Error('Native QA root, run or sentinel binding mismatch');
        for (const key of PATHS) {
            const value = canonical(record.paths[key]);
            if (!inside(scope, value) || value === scope || key === 'PI_PROJECT_ROOTS' && value.includes(path.delimiter)) throw Error('Native QA path is outside its isolated scope');
            if (environment[key] !== undefined && environment[key] !== value) throw Error('Native QA path environment binding mismatch');
            hierarchy(value, key !== 'PI_WEB_DEFERRED_FILE');
        }
        if (record.paths.PIVANE_NATIVE_QA_CHECKPOINTS !== path.join(scope, 'checkpoints') || record.paths.PIVANE_NATIVE_QA_RECEIPTS !== path.join(scope, 'receipts')) throw Error('Native QA receipt paths must use the fixed scope locations');
        const scenario = record.scenario || 'normal';
        if (environment.PIVANE_NATIVE_QA_SCENARIO !== undefined && environment.PIVANE_NATIVE_QA_SCENARIO !== scenario
            || environment.PIVANE_DESKTOP_SMOKE_ROOT !== undefined && environment.PIVANE_DESKTOP_SMOKE_ROOT !== root
            || environment.PIVANE_INSTALLATION_ROOT !== undefined && environment.PIVANE_INSTALLATION_ROOT !== root
            || Object.keys(SAFE).some(key => environment[key] !== undefined && environment[key] !== SAFE[key])) throw Error('Native QA safe flag binding mismatch');
        const scratch = path.join(scope, 'permission-tmp');
        hierarchy(scratch, true);
        if (PATHS.some(key => record.paths[key] === scratch || inside(scratch, record.paths[key]))) throw Error('Native QA permission scratch cannot be an authorized application path');
        if (process.platform === 'win32') {
            const objects = [...opened.values()];
            if (privateWindowsPermissions(objects, record.paths, scratch) !== privateWindowsPermissions(objects, record.paths, scratch)) throw Error('Native QA Windows permissions changed during validation');
        }
        for (const item of opened.values()) {
            const same = item.privateObject && item.name !== scratch ? sameStat : sameAncestor;
            if (!same(item.before, fs.fstatSync(item.fd, { bigint: true })) || !same(item.before, fs.lstatSync(item.name, { bigint: true }))
                || io.identity(item.fd) !== item.identity || !io.sameIdentityAtPath(item.name, item.identity) || openedPath(item.fd) !== item.name) throw Error('Native QA filesystem changed during validation: ' + (item.privateObject ? path.relative(scope, item.name) : 'ancestor'));
        }
        return { ...Object.fromEntries(PATHS.map(key => [key, record.paths[key]])), PIVANE_NATIVE_QA: '1', PIVANE_NATIVE_QA_SCOPE: scope,
            PIVANE_NATIVE_QA_RUN_ID: record.runId, PIVANE_NATIVE_QA_SCENARIO: scenario, PIVANE_DESKTOP_SMOKE_ROOT: root, ...SAFE };
    } finally { for (const item of opened.values()) fs.closeSync(item.fd); }
}
module.exports = { continuationEnvironment };
