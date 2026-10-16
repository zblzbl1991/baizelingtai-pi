const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sourceFiles, distributionFiles, verifyBundledMemory, verifyDesktopLauncher } = require('../scripts/source-files.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function put(root, name) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '// synthetic source\n');
}

test('source discovery includes nested modules and tests without following user data or old copies', t => {
    const root = fixture(t);
    for (const file of ['server/session/runtime.js', 'server/session/bridge.ts', 'server/old.js.bak',
        'public/chat/transport.js', 'public/chat/view.css', 'public/images/private.js', 'public/vendor/library.js',
        'public/legacy-workspace/chat.js', 'public/.private/record.js', 'server/pivane-staffing/ledger.js', 'server/pivane-queue/intentions.js', 'public/pivane-session-moves/record.js', 'server/pivane-uploads/original.js', 'test/session/runtime.test.js', 'test/browser/page.cjs', 'test/helpers/fixture.cjs',
        'pi-packages/gongwen/package.json', 'pi-packages/gongwen/runtime/extension.ts', 'pi-packages/gongwen/.private/credentials.json']) put(root, file);
    assert.deepEqual(sourceFiles(root, 'server'), ['server/session/bridge.ts', 'server/session/runtime.js']);
    assert.deepEqual(sourceFiles(root, 'public'), ['public/chat/transport.js', 'public/chat/view.css']);
    assert.deepEqual(sourceFiles(root, 'tests'), ['test/session/runtime.test.js']);
    assert.deepEqual(sourceFiles(root, 'browser'), ['test/browser/page.cjs']);
    assert.ok(sourceFiles(root, 'testSupport').includes('test/helpers/fixture.cjs'));
    assert.deepEqual(sourceFiles(root, 'packages'), ['pi-packages/gongwen/package.json', 'pi-packages/gongwen/runtime/extension.ts']);
    assert.throws(() => sourceFiles(root, 'unknown'), /Unknown/);
});

test('source discovery refuses linked code directories instead of silently omitting their tests or packaging targets', t => {
    const root = fixture(t), outside = fixture(t);
    put(root, 'server/main.js'); put(outside, 'secret.js');
    fs.symlinkSync(outside, path.join(root, 'server/linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => sourceFiles(root, 'server'), /symlink/);
});

test('release inventory requires the reviewed memory build even when installation scripts are skipped by an older updater', t => {
    const root = fixture(t);
    assert.throws(() => verifyBundledMemory(root), /run node scripts\/install.cjs/);
    put(root, 'server/profile-memory/upstream-bundle.mjs');
    assert.throws(() => verifyBundledMemory(root), /differs from the reviewed build/);
    fs.copyFileSync(path.resolve(__dirname, '../server/profile-memory/upstream-bundle.mjs'), path.join(root, 'server/profile-memory/upstream-bundle.mjs'));
    assert.doesNotThrow(() => verifyBundledMemory(root));
});

test('release inventory includes its own discovery and checking tools and excludes maintenance and user data', () => {
    const files = distributionFiles(path.resolve(__dirname, '..'));
    for (const file of ['scripts/source-files.cjs', 'scripts/check-syntax.cjs', 'scripts/run-tests.cjs',
        'server/pi-update-installer.js', 'test/source-files.test.js', 'pi-packages/media-workbench/skills/media-workbench/SKILL.md',
        'pi-packages/document-review/package.json', 'pi-packages/document-review/skills/document-consistency-review/SKILL.md',
        'docs/DOCUMENT_REVIEW.md',
        'pi-packages/gongwen/package.json', 'pi-packages/gongwen/skills/gongwen/SKILL.md', 'server/pi-gongwen-extension.ts',
        'scripts/desktop-tray.ps1', 'scripts/start-desktop.cjs', 'server/pivane-desktop-launcher.js',
        'server/pivane-desktop-startup.js', 'public/desktop-startup.html', 'public/desktop-startup.css', 'public/desktop-startup.js',
        'scripts/package-windows-portable.cjs', 'scripts/windows-portable-assets.json',
        '白泽灵台.exe', 'native/pivane-desktop-launcher.cs', 'native/pivane-desktop-launcher-build.json',
        '启动白泽灵台.vbs', '启动白泽灵台.cmd']) assert.ok(files.includes(file), file);
    assert.equal(new Set(files).size, files.length);
    assert.equal(files.some(file => /^(?:backups|docs\/local|\.pivane-runtime|node_modules)\//.test(file)), false);
    assert.equal(files.some(file => /^public\/(?:images|audio|videos|downloads|legacy-workspace)\//.test(file)), false);
    assert.equal(files.includes('AGENTS.local.md'), false);
    assert.ok(files.includes('config/officecli.json'));
    assert.ok(files.includes(require('../server/officecli/inventory').inventory().relative));
    assert.ok(files.includes('pi-packages/officecli/skills/office-documents/SKILL.md'));
    assert.throws(() => require('../scripts/check-docs.cjs').assertPublicPath('project/.pivane-office/work.docx'), /Private/);
    assert.equal(files.includes('.baizelingtai-update-build.json'), false);
    assert.throws(() => require('../scripts/check-docs.cjs').assertPublicPath('.baizelingtai-update-build.json'), /Private or invalid/);
    assert.throws(() => require('../scripts/check-docs.cjs').assertPublicPath('pivane-staffing/ledger.json'), /Private or invalid/);
    assert.equal(files.includes('native/pi-win32-fd.lib'), false);
});

test('desktop binary inventory rejects changed source and incorrect build metadata', t => {
    const root = fixture(t), original = path.resolve(__dirname, '..');
    for (const file of ['package.json', '白泽灵台.exe', 'native/pivane-desktop-launcher.cs',
        'native/pivane-desktop-launcher.manifest', 'native/pivane-desktop-launcher-build.json', 'public/brand/favicon.ico']) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.copyFileSync(path.join(original, file), path.join(root, file));
    }
    assert.doesNotThrow(() => verifyDesktopLauncher(root));
    fs.appendFileSync(path.join(root, 'native/pivane-desktop-launcher.cs'), '\n// synthetic change\n');
    assert.throws(() => verifyDesktopLauncher(root), /rebuild/);
    fs.copyFileSync(path.join(original, 'native/pivane-desktop-launcher.cs'), path.join(root, 'native/pivane-desktop-launcher.cs'));
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'native/pivane-desktop-launcher-build.json')));
    metadata.platform = 'synthetic'; fs.writeFileSync(path.join(root, 'native/pivane-desktop-launcher-build.json'), JSON.stringify(metadata));
    assert.throws(() => verifyDesktopLauncher(root), /rebuild/);
});
