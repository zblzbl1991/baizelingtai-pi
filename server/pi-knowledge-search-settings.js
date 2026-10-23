// Non-secret retrieval preferences live with their native MCP server entry.
// Keep validation shared by the settings service and the stdio execution host.
const ENV_KEY = 'WEKNORA_SEARCH_SETTINGS';
const defaults = Object.freeze({ knowledgeBaseIds: Object.freeze([]), limit: 5, vectorThreshold: 0.5, keywordThreshold: 0.3 });
const fields = Object.keys(defaults);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = () => Object.assign(new Error('MCP_KNOWLEDGE_INVALID_SETTINGS'), { code: 'MCP_KNOWLEDGE_INVALID_SETTINGS', statusCode: 400 });
function validate(value, strict = true) {
    if (!record(value) || strict && Object.keys(value).some(key => !fields.includes(key))) throw fail();
    const result = Object.fromEntries(fields.map(key => [key, value[key] === undefined ? defaults[key] : value[key]]));
    if (!Array.isArray(result.knowledgeBaseIds) || result.knowledgeBaseIds.length > 10
        || result.knowledgeBaseIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id))
        || new Set(result.knowledgeBaseIds).size !== result.knowledgeBaseIds.length
        || !Number.isInteger(result.limit) || result.limit < 1 || result.limit > 20
        || ['vectorThreshold', 'keywordThreshold'].some(key => typeof result[key] !== 'number' || !Number.isFinite(result[key]) || result[key] < 0 || result[key] > 1)) throw fail();
    return { ...result, knowledgeBaseIds: [...result.knowledgeBaseIds] };
}
function parse(text) {
    if (text === undefined || text === '') return {};
    if (typeof text !== 'string' || Buffer.byteLength(text) > 16384) throw fail();
    try { const value = JSON.parse(text); if (!record(value)) throw fail(); return value; } catch { throw fail(); }
}
function read(text) { return validate(parse(text), false); }
function serialize(value, previous) {
    // Preserve fields written by newer versions without exposing them in the DTO.
    let retained; try { retained = parse(previous); } catch { retained = {}; }
    const text = JSON.stringify({ ...retained, ...validate(value) });
    if (Buffer.byteLength(text) > 16384) throw fail();
    return text;
}
module.exports = { ENV_KEY, defaults, validate, read, serialize };
