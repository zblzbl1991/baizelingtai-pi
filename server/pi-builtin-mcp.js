const path = require('node:path');
const presets = Object.freeze([
    { id: 'ocr', name: 'pivane-ocr', title: 'OCR', env: ['OCR_BASE_URL', 'OCR_API_KEY'] },
    { id: 'weknora', name: 'pivane-weknora', title: 'WeKnora', env: ['WEKNORA_BASE_URL', 'WEKNORA_API_KEY'] }
]);
function builtinConfig(id) {
    const preset = presets.find(item => item.id === id);
    if (!preset) throw Object.assign(new Error('MCP_UNKNOWN_BUILTIN'), { code: 'MCP_UNKNOWN_BUILTIN', statusCode: 400 });
    return { type: 'stdio', command: process.execPath, args: [path.join(__dirname, 'builtin-mcp/host.mjs'), id],
        enabled: false, exposure: 'direct', timeout: 120,
        description: `${preset.title} · 白泽灵台内置 stdio`, env: Object.fromEntries(preset.env.map(key => [key, ''])) };
}
function matchesBuiltinConfig(id, config) {
    const expected = builtinConfig(id);
    return config?.type === 'stdio' && config.command === expected.command
        && Array.isArray(config.args) && config.args.length === expected.args.length
        && config.args.every((arg, index) => arg === expected.args[index])
        && config.cwd === undefined && config.url === undefined;
}
module.exports = { presets, builtinConfig, matchesBuiltinConfig };
