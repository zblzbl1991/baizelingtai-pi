const { fail } = require('../pi-file-scope');
const { SCHEMA, matches } = require('./input');
const REVISION_SCHEMA = { type: 'object', additionalProperties: false, required: ['requestId', 'id'], properties: {
    requestId: SCHEMA.properties.requestId, id: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    action: { enum: ['inspect', 'revise'] }, layout: { type: 'boolean' }, title: SCHEMA.properties.title.anyOf[0]
} };
function validateRevision(raw) {
    let text;
    try { text = JSON.stringify(raw); } catch { /* invalid below */ }
    if (!text || Buffer.byteLength(text) > 4096) throw fail('公文修订参数无效', 400, 'GONGWEN_INPUT');
    const input = JSON.parse(text);
    if (!matches(input, REVISION_SCHEMA)) throw fail('公文修订仅接受附件 ID、操作和版式选项', 400, 'GONGWEN_INPUT');
    return { ...input, action: input.action || 'revise', layout: input.layout ?? true };
}
module.exports = { REVISION_SCHEMA, validateRevision };
