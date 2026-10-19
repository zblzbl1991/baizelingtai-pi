const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { distributionFiles } = require('../scripts/source-files.cjs');
const { unpack } = require('../server/pi-application-installer');
const { tarInvocation } = require('../scripts/package-tar.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('the actual release producer roundtrips its public inventory and Chinese filenames through native tar and strict application unpacking', {timeout:120000}, t => {
    const root = fs.realpathSync.native(path.resolve(__dirname,'..'));
    const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'pivane-package-roundtrip-')));
    t.after(() => {
        const allowed = fs.realpathSync.native(os.tmpdir()) + path.sep + 'pivane-package-roundtrip-';
        assert.ok(temporary.startsWith(allowed));
        fs.rmSync(temporary,{recursive:true,force:true});
    });
    const snapshot = path.join(temporary,'source'), destination = path.join(temporary,'unpacked');
    const files = distributionFiles(root), expected = new Map();
    for (const file of files) {
        const bytes = fs.readFileSync(path.join(root,file)), target = path.join(snapshot,file);
        fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,bytes,{flag:'wx'});
        expected.set(file,hash(bytes));
    }
    // Only the documentation checker reads the already-installed dependency.
    // The snapshot has no node_modules and the actual packer is not mocked.
    const output = execFileSync(process.execPath,[path.join(snapshot,'scripts/package-trial.cjs'),'--release'],{
        cwd:snapshot,env:{...process.env,NODE_PATH:path.join(root,'node_modules')},encoding:'utf8',windowsHide:true,timeout:90000
    });
    const produced = JSON.parse(output), bytes = fs.readFileSync(produced.archive);
    assert.equal(produced.sha256,hash(bytes));
    // Exercise both release acceptance's stripped layout and portable packaging's
    // unstripped snapshot extraction with the shared native reader policy.
    for (const stripped of [true,false]) {
        const native = path.join(temporary,stripped?'native-stripped':'native'); fs.mkdirSync(native);
        const command = tarInvocation([stripped?'-xzf':'-xf',produced.archive,'-C',native,...(stripped?['--strip-components=1']:[])]);
        execFileSync(command.file,command.args,{windowsHide:true});
        const extracted = stripped ? native : path.join(native,'pivane-'+require('../package.json').version);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(extracted,'TRIAL_MANIFEST.json'))).files.map(file=>file.path),[...files].sort());
        for (const file of files) assert.equal(hash(fs.readFileSync(path.join(extracted,file))),expected.get(file),file);
    }
    const manifest = unpack(bytes,require('../package.json').version,destination);
    assert.equal(manifest.files.length,files.length);
    assert.deepEqual(manifest.files.map(file=>file.path),[...files].sort());
    for (const file of manifest.files) assert.equal(file.sha256,expected.get(file.path),file.path);
    for (const file of ['白泽灵台.exe','启动白泽灵台.cmd','启动白泽灵台.vbs','vendor/gongwen-kit/docs/依据.md']) {
        assert.ok(fs.statSync(path.join(destination,file)).isFile(),file);
        assert.equal(hash(fs.readFileSync(path.join(destination,file))),expected.get(file),file);
    }
});
