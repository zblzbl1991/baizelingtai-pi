const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PiMcpSettingsService } = require('../server/pi-mcp-settings-service');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-mcp-')), agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
    fs.mkdirSync(agent); fs.mkdirSync(cwd); fs.mkdirSync(path.join(cwd, '.pi'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let trusted = false;
    const sdk = { getAgentDir: () => agent, ProjectTrustStore: class { getEntry() { return { decision: trusted }; } } };
    const service = new PiMcpSettingsService({ resolveProject: input => { if (input !== cwd) throw new Error('private path'); return fs.realpathSync(cwd); } }, { getSdk: async () => sdk });
    const write = (name, data) => fs.writeFileSync(path.join(agent, name), JSON.stringify(data));
    const save = async input => service.save({ cwd, scope: 'global', confirmed: true, expectedRevision: (await service.snapshot(cwd)).revision, ...input });
    return { root, agent, cwd, write, save, service, trust: () => { trusted = true; } };
}

test('built-in presets are disabled, independent, private and cannot overwrite existing configuration', async t => {
    const f = fixture(t);
    const { presets } = require('../server/pi-builtin-mcp');
    assert.deepEqual((await f.service.snapshot(f.cwd)).builtinPresets, presets);
    for (const builtin of ['ocr', 'weknora']) await f.save({ action: 'builtin', builtin });
    const disk = JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json')));
    assert.deepEqual(Object.keys(disk.mcpServers), ['pivane-ocr', 'pivane-weknora']);
    for (const [name, config] of Object.entries(disk.mcpServers)) {
        assert.equal(config.type, 'stdio'); assert.equal(config.enabled, false); assert.equal(config.command, process.execPath);
        assert.ok(fs.existsSync(config.args[0])); assert.equal(config.args[1], name.slice(7));
        assert.ok(Object.values(config.env).every(value => value === ''));
    }
    await f.save({ action: 'patch', name: 'pivane-weknora', patch: { env: { WEKNORA_API_KEY: { op: 'replace', value: 'synthetic-secret' } }, enabled: true } });
    const dto = await f.service.snapshot(f.cwd);
    assert.ok(!JSON.stringify(dto).includes('synthetic-secret'));
    assert.equal(dto.servers.find(s => s.name === 'pivane-ocr').enabled, false);
    assert.equal(dto.servers.find(s => s.name === 'pivane-weknora').enabled, true);
    await assert.rejects(f.save({ action: 'builtin', builtin: 'ocr' }), { code: 'MCP_BUILTIN_EXISTS' });
    await assert.rejects(f.save({ action: 'builtin', builtin: 'shell' }), { code: 'MCP_UNKNOWN_BUILTIN' });
    await assert.rejects(f.save({ action: 'builtin', builtin: 'ocr', config: {} }), { code: 'MCP_INVALID_EDIT' });
    require('./private-file-helper.cjs').assertPrivateFile(path.join(f.agent, 'mcp.json'));
});
test('conversational WeKnora configuration creates the builtin atomically and preserves other settings', async t => {
    const f = fixture(t);
    f.write('mcp.json', { future: 7, mcpServers: { other: { command: 'synthetic', env: { PRIVATE: 'unrelated-secret' } } } });
    const configure = async extra => f.service.configureWeKnora({ cwd: f.cwd, scope: 'global', confirmed: true,
        expectedRevision: (await f.service.snapshot(f.cwd)).revision, baseUrl: 'https://weknora.example.invalid/api/v1/', apiKey: 'synthetic-chat-key', ...extra });
    const result = await configure();
    assert.deepEqual(result, { ok: true, server: 'pivane-weknora', scope: 'global', enabled: true, requiresRuntimeRestart: true, connectionStatus: 'not_checked' });
    let disk = JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json')));
    assert.equal(disk.future, 7); assert.equal(disk.mcpServers.other.env.PRIVATE, 'unrelated-secret');
    assert.equal(disk.mcpServers['pivane-weknora'].env.WEKNORA_BASE_URL, 'https://weknora.example.invalid/api/v1');
    assert.equal(disk.mcpServers['pivane-weknora'].env.WEKNORA_API_KEY, 'synthetic-chat-key');
    disk.mcpServers['pivane-weknora'].future = { retained: true };
    disk.mcpServers['pivane-weknora'].env.EXTRA = 'keep'; disk.mcpServers['pivane-weknora'].exposure = 'hidden';
    f.write('mcp.json', disk);
    await configure({ apiKey: 'synthetic-replacement' });
    disk = JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json')));
    assert.deepEqual(disk.mcpServers['pivane-weknora'].future, { retained: true });
    assert.equal(disk.mcpServers['pivane-weknora'].env.EXTRA, 'keep'); assert.equal(disk.mcpServers['pivane-weknora'].exposure, 'hidden');
    assert.doesNotMatch(JSON.stringify(await f.service.snapshot(f.cwd)), /synthetic-chat-key|synthetic-replacement|unrelated-secret/);
    require('./private-file-helper.cjs').assertPrivateFile(path.join(f.agent, 'mcp.json'));
});

test('knowledge preferences use private native saves, retain credentials and unknown fields, and reject stale revisions', async t => {
    const f = fixture(t), { ENV_KEY } = require('../server/pi-knowledge-search-settings');
    await f.save({ action: 'builtin', builtin: 'weknora' });
    await f.save({ action: 'patch', name: 'pivane-weknora', patch: { env: { WEKNORA_API_KEY: { op: 'replace', value: 'synthetic-knowledge-secret' }, [ENV_KEY]: { op: 'replace', value: JSON.stringify({ future: { retained: true } }) } } } });
    const value = { knowledgeBaseIds: ['kb-1', 'kb-2'], limit: 8, vectorThreshold: 0.75, keywordThreshold: 0.4 };
    const prior = (await f.service.snapshot(f.cwd)).revision;
    assert.equal((await f.save({ action: 'knowledge', name: 'pivane-weknora', knowledgeSettings: value })).requiresRuntimeRestart, true);
    const disk = JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json')));
    assert.equal(disk.mcpServers['pivane-weknora'].env.WEKNORA_API_KEY, 'synthetic-knowledge-secret');
    assert.deepEqual(JSON.parse(disk.mcpServers['pivane-weknora'].env[ENV_KEY]), { future: { retained: true }, ...value });
    const snapshot = await f.service.snapshot(f.cwd);
    assert.equal(snapshot.capabilities.knowledgeSearchSettings, true);
    assert.deepEqual(snapshot.servers[0].knowledgeSettings, { supported: true, valid: true, value });
    assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-knowledge-secret|retained/);
    await assert.rejects(f.service.save({ cwd: f.cwd, scope: 'global', expectedRevision: prior, confirmed: true, action: 'knowledge', name: 'pivane-weknora', knowledgeSettings: value }), { code: 'MCP_CHANGED' });
    require('./private-file-helper.cjs').assertPrivateFile(path.join(f.agent, 'mcp.json'));
});

test('knowledge settings validate bounds, project trust, service identity and malformed saved preferences without writing', async t => {
    const f = fixture(t), { ENV_KEY, defaults } = require('../server/pi-knowledge-search-settings');
    await f.save({ action: 'builtin', builtin: 'weknora' });
    const before = fs.readFileSync(path.join(f.agent, 'mcp.json'), 'utf8');
    for (const change of [{ limit: 0 }, { limit: 21 }, { limit: null }, { vectorThreshold: NaN }, { keywordThreshold: 1.1 }, { knowledgeBaseIds: ['name with space'] }, { knowledgeBaseIds: ['kb-1', 'kb-1'] }, { knowledgeBaseIds: Array.from({ length: 11 }, (_, i) => `kb-${i}`) }, { arbitrary: true }]) {
        await assert.rejects(f.save({ action: 'knowledge', name: 'pivane-weknora', knowledgeSettings: { ...defaults, ...change } }), { code: 'MCP_KNOWLEDGE_INVALID_SETTINGS' });
    }
    assert.equal(fs.readFileSync(path.join(f.agent, 'mcp.json'), 'utf8'), before);
    await assert.rejects(f.save({ action: 'knowledge', name: 'unknown', knowledgeSettings: defaults }), { code: 'MCP_KNOWLEDGE_UNSUPPORTED' });
    await assert.rejects(f.save({ action: 'knowledge', scope: 'project', name: 'pivane-weknora', knowledgeSettings: defaults }), { code: 'MCP_PROJECT_UNTRUSTED' });
    const disk = JSON.parse(before); disk.mcpServers['pivane-weknora'].env[ENV_KEY] = 'invalid-private-content'; f.write('mcp.json', disk);
    const dto = await f.service.snapshot(f.cwd);
    assert.equal(dto.servers[0].knowledgeSettings.valid, false); assert.doesNotMatch(JSON.stringify(dto), /invalid-private-content/);
    await f.save({ action: 'knowledge', name: 'pivane-weknora', knowledgeSettings: defaults });
    assert.equal((await f.service.snapshot(f.cwd)).servers[0].knowledgeSettings.valid, true);
    f.trust();
    await f.save({ action: 'builtin', builtin: 'ocr' });
    await assert.rejects(f.save({ action: 'knowledge', name: 'pivane-ocr', knowledgeSettings: defaults }), { code: 'MCP_KNOWLEDGE_UNSUPPORTED' });
    const projectConfig = require('../server/pi-builtin-mcp').builtinConfig('weknora');
    projectConfig.env.WEKNORA_API_KEY = 'synthetic-project-key';
    fs.writeFileSync(path.join(f.cwd, '.pi', 'mcp.json'), JSON.stringify({ future: 1, mcpServers: { 'project-weknora': projectConfig, 'pivane-weknora': { enabled: true } } }));
    await f.save({ action: 'knowledge', scope: 'project', name: 'project-weknora', knowledgeSettings: { ...defaults, knowledgeBaseIds: ['kb-project'], limit: 3 } });
    const projectSnapshot = await f.service.snapshot(f.cwd, 'project');
    assert.deepEqual(projectSnapshot.servers.find(item => item.name === 'project-weknora').knowledgeSettings.value.knowledgeBaseIds, ['kb-project']);
    assert.doesNotMatch(JSON.stringify(projectSnapshot), /synthetic-project-key/);
    await assert.rejects(f.save({ action: 'knowledge', scope: 'project', name: 'pivane-weknora', knowledgeSettings: defaults }), { code: 'MCP_KNOWLEDGE_UNSUPPORTED' });
    const projectDisk = JSON.parse(fs.readFileSync(path.join(f.cwd, '.pi', 'mcp.json')));
    assert.equal(projectDisk.future, 1); assert.equal(projectDisk.mcpServers['project-weknora'].env.WEKNORA_API_KEY, 'synthetic-project-key');
    require('./private-file-helper.cjs').assertPrivateFile(path.join(f.cwd, '.pi', 'mcp.json'));
});
test('conversational WeKnora rejects stale revisions, scope changes, replaced commands and credential references', async t => {
    const f = fixture(t);
    const input = { cwd: f.cwd, scope: 'global', confirmed: true, expectedRevision: (await f.service.snapshot(f.cwd)).revision,
        baseUrl: 'http://127.0.0.1:1/api/v1', apiKey: 'synthetic-only' };
    for (const extra of [{ baseUrl: 'file:///tmp/private' }, { baseUrl: 'https://user:secret@example.invalid' },
        { baseUrl: 'https://example.invalid?key=secret' }, { apiKey: '!echo secret' }, { apiKey: '${SECRET}' }, { apiKey: '\nsecret' }, { apiKey: '' }, { apiKey: 'xxx' },
        { confirmed: false }, { command: 'evil' }]) await assert.rejects(f.service.configureWeKnora({ ...input, ...extra }), /^Error: MCP_/);
    assert.equal(fs.existsSync(path.join(f.agent, 'mcp.json')), false);
    f.write('mcp.json', { mcpServers: { 'pivane-weknora': { command: 'synthetic-other-server' } } });
    await assert.rejects(f.service.configureWeKnora(input), { code: 'MCP_CHANGED' });
    input.expectedRevision = (await f.service.snapshot(f.cwd)).revision;
    await assert.rejects(f.service.configureWeKnora(input), { code: 'MCP_WEKNORA_BUILTIN_CONFLICT' });
    fs.unlinkSync(path.join(f.agent, 'mcp.json'));
    fs.writeFileSync(path.join(f.cwd, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { 'pivane-weknora': { enabled: false } } }));
    input.expectedRevision = (await f.service.snapshot(f.cwd)).revision;
    await assert.rejects(f.service.configureWeKnora(input), { code: 'MCP_WEKNORA_SCOPE_CONFLICT' });
    fs.unlinkSync(path.join(f.cwd, '.pi', 'mcp.json'));
    input.expectedRevision = (await f.service.snapshot(f.cwd)).revision;
    await assert.rejects(f.service.configureWeKnora({ ...input, scope: 'project' }), { code: 'MCP_PROJECT_UNTRUSTED' });
    f.trust(); input.expectedRevision = (await f.service.snapshot(f.cwd)).revision;
    await f.service.configureWeKnora({ ...input, scope: 'project' });
    assert.equal(fs.existsSync(path.join(f.agent, 'mcp.json')), false);
    assert.equal((await f.service.snapshot(f.cwd, 'project')).servers[0].enabled, true);
});
test('saved GET is redacted and never evaluates references; explicit secret edits retain unknown fields', async t => {
    const f = fixture(t), marker = path.join(f.root, 'executed');
    f.write('mcp.json', { future: { preserved: true }, mcpServers: { local: { command: `!touch ${marker}`, args: ['secret-token'], env: { KEY: 'literal' }, unknown: 'unknown-secret', exposure: 'direct' }, remote: { url: 'https://user:secret@example.invalid/mcp?token=secret', headers: { Authorization: 'secret' }, oauth: { clientSecret: 'secret' } } } });
    const dto = await f.service.snapshot(f.cwd), text = JSON.stringify(dto);
    for (const secret of ['secret-token', 'literal', 'unknown-secret', 'touch', 'example.invalid']) assert.ok(!text.includes(secret));
    assert.equal(dto.servers[0].config.command, null); assert.deepEqual(dto.servers[0].secretFields['env.KEY'], { present: true }); assert.ok(!fs.existsSync(marker));
    await f.save({ action: 'upsert', name: 'local', config: { command: { op: 'keep' }, args: { op: 'replace', value: ['new'] }, env: { KEY: { op: 'remove' }, NEXT: { op: 'replace', value: '${NEXT}' } } } });
    const disk = JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json')));
    assert.equal(disk.mcpServers.local.unknown, 'unknown-secret'); assert.deepEqual(disk.future, { preserved: true }); assert.deepEqual(disk.mcpServers.local.args, ['new']); assert.deepEqual(disk.mcpServers.local.env, { NEXT: '${NEXT}' });
    require('./private-file-helper.cjs').assertPrivateFile(path.join(f.agent, 'mcp.json'));
    for (const config of [{ command: null }, { command: { op: 'keep', value: 'bad' } }, { env: { NEW: { op: 'keep' } } }, { exposure: 'invalid' }, { type: 'sse' }]) await assert.rejects(f.save({ action: 'upsert', name: 'local', config }), /^Error: MCP_/);
    await f.save({ action: 'patch', name: 'remote', patch: { headers: { Authorization: { op: 'keep' } }, oauth: { clientSecret: { op: 'remove' } } } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json'))).mcpServers.remote.headers.Authorization, 'secret');
});
test('raw revisions include both scopes, settings and trust; trust, locks, parse and concurrent saves fail closed', async t => {
    const f = fixture(t); f.write('mcp.json', { mcpServers: {} });
    let dto = await f.service.snapshot(f.cwd);
    f.write('settings.json', { defaultProjectTrust: 'never' });
    await assert.rejects(f.service.save({ cwd: f.cwd, scope: 'global', confirmed: true, action: 'preferences', autoEnableCodemode: false, expectedRevision: dto.revision }), { code: 'MCP_CHANGED' });
    await assert.rejects(f.save({ scope: 'project', action: 'preferences', autoEnableCodemode: false }), { code: 'MCP_PROJECT_UNTRUSTED' });
    f.trust(); await f.save({ scope: 'project', action: 'preferences', autoEnableCodemode: false });
    assert.equal((await f.service.snapshot(f.cwd, 'project')).autoEnableCodemode.value, false);
    fs.mkdirSync(path.join(f.agent, 'mcp.json.lock'));
    await assert.rejects(f.save({ action: 'preferences', autoEnableCodemode: true }), { code: 'MCP_BUSY' });
    fs.rmdirSync(path.join(f.agent, 'mcp.json.lock'));
    dto = await f.service.snapshot(f.cwd);
    const input = { cwd: f.cwd, scope: 'global', confirmed: true, action: 'preferences', autoEnableCodemode: true, expectedRevision: dto.revision };
    const pending = f.service.save(input); await assert.rejects(f.service.save(input), { code: 'MCP_BUSY' }); await pending;
    f.write('mcp.json', { mcpServers: { invalid: { type: 'sse', url: 'https://secret.invalid' } } });
    assert.equal((await f.service.snapshot(f.cwd)).servers[0].valid, false);
    fs.writeFileSync(path.join(f.agent, 'mcp.json'), '{bad-secret'); await assert.rejects(f.service.snapshot(f.cwd), { code: 'MCP_INVALID_JSON' });
    fs.unlinkSync(path.join(f.agent, 'mcp.json')); fs.symlinkSync(path.join(f.root, 'missing'), path.join(f.agent, 'mcp.json')); await assert.rejects(f.service.snapshot(f.cwd));
});
test('namespace collisions are rejected across scopes and existing native losers are marked invalid', async t => {
    const f = fixture(t), local = { command: 'synthetic' }; f.trust();
    const add = name => ({ action: 'upsert', name, config: { command: { op: 'replace', value: 'synthetic' } } });
    f.write('mcp.json', { mcpServers: { 'dev-radius': local } });
    await assert.rejects(f.save(add('dev_radius')), { code: 'MCP_NAMESPACE_CONFLICT' });
    await assert.rejects(f.save({ ...add('dev_radius'), scope: 'project' }), { code: 'MCP_NAMESPACE_CONFLICT' });
    await f.save({ ...add('dev-radius'), scope: 'project' }); // exact-name project override remains supported
    f.write('mcp.json', { mcpServers: {} });
    await assert.rejects(f.save(add('dev_radius')), { code: 'MCP_NAMESPACE_CONFLICT' });
    fs.writeFileSync(path.join(f.cwd, '.pi/mcp.json'), '{}');
    f.write('mcp.json', { mcpServers: { 'dev-radius': local, dev_radius: local } });
    const rows = (await f.service.snapshot(f.cwd)).servers;
    assert.equal(rows[0].valid, true); assert.equal(rows[1].valid, false);
    assert.equal(rows[1].error, 'MCP_NAMESPACE_CONFLICT');
    assert.deepEqual(rows[1].config, {});
    const { loadNativeMcpConfig } = await import('../server/pi-native-mcp.mjs');
    const native = loadNativeMcpConfig({ cwd: f.cwd, agentDir: f.agent, projectTrusted: true });
    assert.deepEqual(native.servers.map(row => row.name), ['dev-radius']);
    await f.save({ action: 'patch', name: 'dev-radius', patch: { description: 'Unrelated edit' } });
    await f.save({ action: 'remove', name: 'dev_radius' });
    assert.equal((await f.service.snapshot(f.cwd)).servers.length, 1);
    // Native skips project provider auth even when stdio retains an ignored URL.
    f.write('mcp.json', {});
    const ignored = { type: 'stdio', command: 'synthetic', url: 'https://example.invalid', auth: { provider: 'fixture' } };
    fs.writeFileSync(path.join(f.cwd, '.pi/mcp.json'), JSON.stringify({ mcpServers: { 'dev-radius': ignored } }));
    await f.save({ ...add('dev_radius'), scope: 'project' });
    const project = (await f.service.snapshot(f.cwd, 'project')).servers;
    assert.equal(project[0].valid, false); assert.equal(project[1].valid, true);
    assert.deepEqual(loadNativeMcpConfig({ cwd: f.cwd, agentDir: f.agent, projectTrusted: true }).servers.map(row => row.name), ['dev_radius']);
});

test('changes during asynchronous validation/context fail before writing', async t => {
    const f = fixture(t); f.write('mcp.json', {});
    const dto = await f.service.snapshot(f.cwd), context = f.service.context.bind(f.service);
    f.service.context = async cwd => { const ctx = await context(cwd); f.write('trust.json', { changed: true }); return ctx; };
    await assert.rejects(f.service.save({ cwd: f.cwd, scope: 'global', confirmed: true, action: 'preferences', autoEnableCodemode: false, expectedRevision: dto.revision }), { code: 'MCP_CHANGED' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json'))), {});
});
test('Pi 1.0 fields retain secrets and unknown members while native URL and callback rules apply', async t => {
    const f = fixture(t), marker = path.join(f.root, 'oauth-executed');
    f.write('mcp.json', { mcpServers: { remote: { url: 'https://example.invalid/mcp', description: '<script>docs</script>', exposure: 'codemode-deferred', toolExposure: { find: 'codemode-deferred' }, oauth: { clientName: `!touch ${marker}`, authServerMetadataUrl: 'https://private.invalid/metadata?secret=hidden', future: 'private-future' }, auth: { provider: 'fixture-provider', future: 'private-auth' } } } });
    let dto = await f.service.snapshot(f.cwd), remote = dto.servers[0];
    assert.equal(remote.config.description, '<script>docs</script>');
    assert.equal(remote.exposure, 'codemode'); assert.equal(remote.config.toolExposure.find, 'codemode');
    assert.equal(remote.config.auth.provider, 'fixture-provider'); assert.equal(remote.config.auth.future, null);
    for (const key of ['clientName', 'authServerMetadataUrl']) { assert.equal(remote.config.oauth[key], null); assert.deepEqual(remote.secretFields[`oauth.${key}`], { present: true }); }
    assert.ok(!JSON.stringify(dto).includes('private.invalid')); assert.ok(!fs.existsSync(marker));
    await f.save({ action: 'patch', name: 'remote', patch: { description: 'Search docs', oauth: { clientName: { op: 'keep' }, authServerMetadataUrl: { op: 'replace', value: 'http://[::1]/metadata' } }, auth: { provider: 'new-provider' } } });
    let disk = JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json'))).mcpServers.remote;
    assert.equal(disk.oauth.clientName, `!touch ${marker}`); assert.equal(disk.oauth.future, 'private-future'); assert.equal(disk.auth.future, 'private-auth');
    for (const patch of [
        { description: 'x'.repeat(4097) }, { description: 42 },
        { oauth: { clientName: { op: 'replace', value: '' } } },
        { oauth: { authServerMetadataUrl: { op: 'replace', value: 'http://example.invalid/metadata' } } },
        { oauth: { authServerMetadataUrl: { op: 'replace', value: '${METADATA_URL}' } } },
        { oauth: { callbackUrl: { op: 'replace', value: 'http://localhost:1234/callback' }, callbackPort: 5678 } },
        { url: { op: 'replace', value: 'http://example.invalid/mcp' } },
        { type: 'stdio', command: { op: 'replace', value: 'mock' } },
        { auth: { provider: '' } }, { auth: { future: 'changed' } },
        { oauth: { clientName: 'plain-value' } }
    ]) await assert.rejects(f.save({ action: 'patch', name: 'remote', patch }), /^Error: MCP_/);
    await f.save({ action: 'patch', name: 'remote', patch: { description: null, oauth: { clientName: { op: 'remove' }, authServerMetadataUrl: { op: 'remove' } }, auth: null } });
    disk = JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json'))).mcpServers.remote;
    assert.equal(disk.description, undefined); assert.deepEqual(disk.oauth, { future: 'private-future' }); assert.equal(disk.auth, undefined);
});
test('provider auth is global HTTP only; newly selected providers cannot override an Authorization header', async t => {
    const f = fixture(t); f.trust();
    f.write('mcp.json', { mcpServers: { remote: { url: 'https://example.invalid/mcp', headers: { aUtHoRiZaTiOn: '${MOCK}' }, auth: { provider: 'existing' }, oauth: { clientName: 'retained' } } } });
    await f.save({ action: 'patch', name: 'remote', patch: { enabled: false } });
    await assert.rejects(f.save({ action: 'patch', name: 'remote', patch: { auth: { provider: 'different' } } }), { code: 'MCP_AUTH_HEADER_CONFLICT' });
    await f.save({ action: 'patch', name: 'remote', patch: { headers: { aUtHoRiZaTiOn: { op: 'remove' } }, auth: { provider: 'different' } } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json'))).mcpServers.remote.oauth.clientName, 'retained');
    for (const url of ['https://example.invalid/mcp', 'http://localhost/mcp', 'http://127.0.0.1/mcp', 'http://[::1]/mcp']) {
        await f.save({ action: 'upsert', name: 'allowed', config: { url: { op: 'replace', value: url }, auth: { provider: 'fixture' } } });
        await assert.rejects(f.save({ scope: 'project', action: 'upsert', name: 'blocked', config: { url: { op: 'replace', value: url }, auth: { provider: 'fixture' } } }), { code: 'MCP_INVALID_SERVER' });
    }
    await assert.rejects(f.save({ action: 'upsert', name: 'stdio', config: { command: { op: 'replace', value: 'mock' }, auth: { provider: 'fixture' } } }), { code: 'MCP_INVALID_SERVER' });
    fs.writeFileSync(path.join(f.cwd, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { blocked: { url: 'https://example.invalid/mcp', auth: { provider: 'fixture' } } } }));
    const dto = await f.service.snapshot(f.cwd, 'project'); assert.equal(dto.servers[0].valid, false); assert.deepEqual(dto.servers[0].config, {});
    await assert.rejects(f.save({ scope: 'project', action: 'patch', name: 'blocked', patch: { enabled: false } }), { code: 'MCP_INVALID_SERVER' });
    await f.save({ scope: 'project', action: 'patch', name: 'blocked', patch: { auth: null } });
    assert.equal((await f.service.snapshot(f.cwd, 'project')).servers[0].valid, true);
});

test('Pi 1.0.2 project partial overrides follow native merge without disclosing or copying global credentials', async t => {
    const f = fixture(t); f.trust();
    const global = { url: 'https://private.invalid/mcp', headers: { Authorization: 'synthetic-secret' }, auth: { provider: 'global-provider' }, toolExposure: { echo: 'direct' }, timeout: 42 };
    f.write('mcp.json', { mcpServers: { remote: global } });
    const projectFile = path.join(f.cwd, '.pi/mcp.json');
    fs.writeFileSync(projectFile, JSON.stringify({ mcpServers: { remote: { enabled: false } } }));
    const { loadNativeMcpConfig } = await import('../server/pi-native-mcp.mjs');
    let dto = await f.service.snapshot(f.cwd, 'project'), remote = dto.servers[0];
    assert.equal(remote.valid, true); assert.equal(remote.override, true); assert.equal(remote.enabled, false); assert.equal(remote.transport, 'http');
    assert.equal(remote.timeout, 42); assert.deepEqual(remote.config, { enabled: false }); assert.deepEqual(remote.secretFields, {});
    assert.doesNotMatch(JSON.stringify(dto), /private.invalid|synthetic-secret|global-provider/);
    const native = () => loadNativeMcpConfig({ cwd: f.cwd, agentDir: f.agent, projectTrusted: true });
    assert.deepEqual(native().servers[0].config, { ...global, enabled: false });
    await f.save({ scope: 'project', action: 'patch', name: 'remote', patch: { enabled: true, exposure: 'direct', toolExposure: { echo: 'hidden' } } });
    assert.deepEqual(native().servers[0].config, { ...global, enabled: true, exposure: 'direct', toolExposure: { echo: 'hidden' } });
    assert.deepEqual(JSON.parse(fs.readFileSync(projectFile)).mcpServers.remote, { enabled: true, exposure: 'direct', toolExposure: { echo: 'hidden' } });
    await f.save({ scope: 'project', action: 'patch', name: 'remote', patch: { enabled: null, exposure: null, toolExposure: null } });
    assert.deepEqual(native().servers[0].config, global);
    assert.deepEqual(JSON.parse(fs.readFileSync(projectFile)).mcpServers.remote, {});
    for (const patch of [{ timeout: 10 }, { description: 'ignored' }, { env: { KEY: { op: 'replace', value: 'no' } } }, { auth: { provider: 'no' } }, { exposure: 'invalid' }]) {
        await assert.rejects(f.save({ scope: 'project', action: 'patch', name: 'remote', patch }), { code: 'MCP_INVALID_SERVER' });
        assert.deepEqual(JSON.parse(fs.readFileSync(projectFile)).mcpServers.remote, {});
    }
    for (const entry of [{ enabled: false, extra: 'private' }, { enabled: 'false' }]) {
        fs.writeFileSync(projectFile, JSON.stringify({ mcpServers: { remote: entry } }));
        assert.equal((await f.service.snapshot(f.cwd, 'project')).servers[0].valid, false);
        assert.deepEqual(native().servers[0].config, global);
    }
    fs.writeFileSync(projectFile, JSON.stringify({ mcpServers: { missing: { enabled: false } } }));
    assert.equal((await f.service.snapshot(f.cwd, 'project')).servers[0].valid, false);
    assert.deepEqual(loadNativeMcpConfig({ cwd: f.cwd, agentDir: f.agent, projectTrusted: false }).servers[0].config, global);
    // A colliding global loser is not a valid base for a project override.
    f.write('mcp.json', { mcpServers: { 'dev-radius': global, dev_radius: global } });
    fs.writeFileSync(projectFile, JSON.stringify({ mcpServers: { dev_radius: { enabled: false } } }));
    assert.equal((await f.service.snapshot(f.cwd, 'project')).servers[0].valid, false);
});

test('manually configured CIMD survives unrelated web edits and native validation remains authoritative', async t => {
    const f = fixture(t);
    f.write('mcp.json', { mcpServers: { remote: { url: 'https://example.invalid/mcp', oauth: { clientRegistration: 'cimd', callbackUrl: 'http://localhost:1234/callback', future: 'retained-private' } } } });
    const dto = await f.service.snapshot(f.cwd);
    assert.equal(dto.servers[0].valid, true); assert.equal(dto.servers[0].config.oauth.clientRegistration, null);
    await f.save({ action: 'patch', name: 'remote', patch: { enabled: false } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.agent, 'mcp.json'))).mcpServers.remote.oauth.clientRegistration, 'cimd');
    for (const patch of [{ oauth: { clientId: { op: 'replace', value: 'not-cimd' } } }, { oauth: { clientName: { op: 'replace', value: 'not-cimd' } } }, { oauth: { callbackUrl: { op: 'replace', value: 'http://[::1]:1234/callback' } } }])
        await assert.rejects(f.save({ action: 'patch', name: 'remote', patch }), { code: 'MCP_INVALID_SERVER' });
});
