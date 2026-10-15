const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const inventory = require('../server/officecli/inventory');
const { install } = require('../scripts/install-officecli.cjs');
const { environment } = require('../server/officecli/mcp-host.cjs');
const { commandError } = require('../server/officecli/commands');
const { OfficeDocuments } = require('../server/officecli/documents');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-office-'))), agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = root; process.env.PI_OFFLINE = '1';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('managed OfficeCLI pins downloads, rejects tampered cache and retains credentials outside the child', async () => {
    const base = path.join(root, 'install'); fs.mkdirSync(path.join(base, 'config'), { recursive: true });
    const manifest = structuredClone(require('../config/officecli.json')), bytes = Buffer.from('synthetic binary');
    manifest.assets['win32-x64'].sha256 = inventory.digest(bytes);
    fs.writeFileSync(path.join(base, 'config/officecli.json'), JSON.stringify(manifest));
    let fetches = 0;
    const options = { base, key: 'win32-x64', fetchBytes: async url => { assert.match(url, /github.com\/iOfficeAI\/OfficeCLI\/releases\/download\/v1.0.157\//); fetches++; return bytes; } };
    const saved = await install(options); assert.equal(fetches, 1); assert.deepEqual(fs.readFileSync(saved.path), bytes);
    await install(options); assert.equal(fetches, 1);
    fs.writeFileSync(saved.path, 'tampered'); await assert.rejects(install(options), /checksum/); assert.equal(fetches, 1);
    assert.equal(inventory.target('linux', 'arm64', true), 'linux-musl-arm64'); assert.equal(inventory.target('darwin', 'x64', false), 'darwin-x64');
    assert.throws(() => inventory.inventory(base, 'win32-ia32'), /does not support/);
    const env = environment({ PATH: 'synthetic', OPENAI_API_KEY: 'secret', PI_WEB_NAVIGATION_TOKEN: 'secret', NODE_OPTIONS: 'unsafe', OFFICECLI_SKIP_UPDATE: '0' });
    assert.deepEqual(env, { PATH: 'synthetic', OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_NO_AUTO_RESIDENT: '1', OFFICECLI_BATCH_ALLOW_STDIN_REDIRECT: '1' });
});

test('OfficeCLI uses argv document commands and refuses unmanaged background/config/install commands', () => {
    assert.equal(commandError({ command: ['set', '中文 空格.docx', '/body/p[1]', '--find', '旧', '--replace', '新'] }), null);
    assert.equal(commandError({ command: ['view', 'x.pptx', 'screenshot'] }), null);
    for (const command of ['set x.docx / text=x', [], ['open', 'x.docx'], ['watch', 'x.docx'], ['install'], ['config', 'autoUpdate', 'true'], ['create', 'x.hwpx'], ['view', 'x.docx', 'pdf']]) assert.ok(commandError({ command }));
});

test('Office work copies preserve originals and modified bytes across reuse, isolate sessions and never replay partial preparation', async () => {
    const store = new (require('../server/pi-session-store').PiSessionStore)(), service = new OfficeDocuments(store);
    const bytes = require('./document-fixtures.cjs').zip(require('./document-fixtures.cjs').docxFiles());
    const ref = { id: 'a'.repeat(64), revision: inventory.digest(bytes), format: 'docx', name: '原件.docx', size: bytes.length };
    const source = { reference: ref, bytes, check: () => {} }, input = { id: ref.id, requestId: 'v1' }, context = { cwd, sessionId: 'fixture' };
    try {
        const preparing = service.prepare(context, input, source);
        await assert.rejects(service.prepare(context, input, source), { code: 'OFFICE_BUSY' });
        const saved = await preparing; assert.deepEqual(fs.readFileSync(saved.path), bytes);
        require('./private-file-helper.cjs').assertPrivateFile(saved.path);
        fs.writeFileSync(saved.path, 'synthetic edited bytes');
        const reused = await service.prepare(context, input, source);
        assert.equal(reused.reused, true); assert.equal(fs.readFileSync(saved.path, 'utf8'), 'synthetic edited bytes'); assert.deepEqual(source.bytes, bytes);
        const other = await service.prepare({ ...context, sessionId: 'other' }, input, source); assert.notEqual(other.path, saved.path);
        const changed = { ...source, reference: { ...ref, name: 'different.docx' } };
        await assert.rejects(service.prepare(context, input, changed), { code: 'OFFICE_CONFLICT' });
        fs.unlinkSync(path.join(path.dirname(saved.path), 'ready.json'));
        await assert.rejects(service.prepare(context, input, source), { code: 'OFFICE_INCOMPLETE' });
        await assert.rejects(service.prepare(context, { ...input, requestId: 'outside', path: '../x' }, source), { code: 'OFFICE_INPUT' });
        const denied = { ...source, check: () => { throw Object.assign(Error('branch changed'), { code: 'DOCUMENT_SCOPE' }); } };
        await assert.rejects(service.prepare(context, { ...input, requestId: 'denied' }, denied), { code: 'DOCUMENT_SCOPE' });
        assert.equal(fs.readFileSync(path.join(cwd, '.pivane-office/.gitignore'), 'utf8'), '*\n');
    } finally { await service.dispose(); }
    await assert.rejects(service.prepare(context, { ...input, requestId: 'closed' }, source), { code: 'OFFICE_BUSY' });
});
