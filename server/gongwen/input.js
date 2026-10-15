const { fail } = require('../pi-file-scope');
const MAX_INPUT = 128 * 1024;
const KINDS = ['notice', 'report', 'request', 'letter', 'minutes', 'rules', 'enterprise'];
const text = (maxLength = 4000) => ({ type: 'string', minLength: 1, maxLength, pattern: '^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]+$' });
const array = (items, maxItems, minItems = 0) => ({ type: 'array', items, maxItems, minItems });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const numericColumn = object({ column: integer(1, 12), kind: { enum: ['money', 'integer', 'decimal', 'percent'] },
    complete: { type: 'boolean' } }, ['column', 'kind']);
const block = { anyOf: [
    object({ type: { const: 'paragraph' }, text: text(6000) }, ['type', 'text']),
    object({ type: { const: 'heading' }, level: integer(1, 4), text: text() }, ['type', 'level', 'text']),
    object({ type: { const: 'table' }, caption: text(160), head: array(text(160), 12, 2),
        rows: array(array(text(512), 12, 2), 200, 1), widths: array(integer(200, 8844), 12, 2),
        numeric: array(numericColumn, 12) }, ['type', 'head', 'rows'])
] };
const blocks = array(block, 300, 1);
const SCHEMA = object({
    requestId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$' },
    kind: { enum: KINDS }, title: { anyOf: [text(160), array(text(80), 3, 1)] }, body: blocks,
    recipient: text(1000), unit: { anyOf: [text(240), array(text(240), 6, 1)] }, date: text(80),
    redhead: { type: 'boolean' }, agency: { anyOf: [text(240), array(text(240), 6, 1)] },
    docNo: text(120), signers: array(text(80), 8), copyNo: text(40), secret: text(80), urgency: text(40), preprinted: { type: 'boolean' },
    mark: text(240), issue: text(120), attendees: array(array(text(1000), 2, 2), 3),
    copyTo: array(text(240), 20), issuer: text(240), printDate: text(80), note: text(1000), sealed: { type: 'boolean' },
    attachments: array(object({ title: text(160), body: blocks, detachedNo: text(120) }, ['title', 'body']), 5),
    missing: array(text(160), 30)
}, ['requestId', 'kind', 'title', 'body']);

// A deliberately small validator for the same JSON Schema exported to Pi. It
// rejects unknown fields and runs again inside the credential-free child.
function matches(value, rule) {
    if (rule.anyOf) return rule.anyOf.some(candidate => matches(value, candidate));
    if ('const' in rule && value !== rule.const || rule.enum && !rule.enum.includes(value)) return false;
    if (rule.type === 'string') return typeof value === 'string' && (!rule.minLength || value.trim().length >= rule.minLength)
        && (!rule.maxLength || value.length <= rule.maxLength) && (!rule.pattern || new RegExp(rule.pattern, 'u').test(value));
    if (rule.type === 'boolean') return typeof value === 'boolean';
    if (rule.type === 'integer') return Number.isSafeInteger(value) && value >= rule.minimum && value <= rule.maximum;
    if (rule.type === 'array') return Array.isArray(value) && value.length >= rule.minItems && value.length <= rule.maxItems && value.every(item => matches(item, rule.items));
    if (rule.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
        && rule.required.every(key => Object.hasOwn(value, key))
        && Object.entries(value).every(([key, item]) => Object.hasOwn(rule.properties, key) && matches(item, rule.properties[key]));
    return true;
}
function validate(raw) {
    let serialized;
    try { serialized = JSON.stringify(raw); } catch { throw fail('公文参数无法序列化', 400, 'GONGWEN_INPUT'); }
    if (!serialized || Buffer.byteLength(serialized) > MAX_INPUT) throw fail('公文参数无效或超过 128 KiB，请缩小正文和表格', 400, 'GONGWEN_INPUT');
    const input = JSON.parse(serialized);
    if (!matches(input, SCHEMA)) throw fail('公文参数无效，请核对正文构件和字段', 400, 'GONGWEN_INPUT');
    if ([].concat(input.title).join('').length > 160) throw fail('公文标题合计最多 160 字符', 400, 'GONGWEN_INPUT');
    const all = [...input.body, ...(input.attachments || []).flatMap(item => item.body)];
    if (all.length > 500) throw fail('正文与附件合计最多 500 个构件', 413, 'GONGWEN_LIMIT');
    for (const item of all.filter(item => item.type === 'table')) {
        if (item.rows.some(row => row.length !== item.head.length) || item.widths && (item.widths.length !== item.head.length || item.widths.reduce((sum, n) => sum + n, 0) > 8844)
            || item.numeric?.some(col => col.column > item.head.length) || new Set(item.numeric?.map(col => col.column)).size !== (item.numeric?.length || 0)) throw fail('表格列数、宽度或数字列定义无效', 400, 'GONGWEN_INPUT');
    }
    if (input.attendees?.some(row => !['出席', '请假', '列席'].includes(row[0]))) throw fail('纪要名单标签只能为出席、请假、列席', 400, 'GONGWEN_INPUT');
    return input;
}
function prepare(raw) {
    const input = validate(raw), missing = new Set(input.missing || []);
    const fill = (key, label) => { if (!input[key]) { input[key] = `【待补充${label}】`; missing.add(label); } };
    fill('unit', '落款单位'); fill('date', '成文日期');
    if (['notice', 'report', 'request'].includes(input.kind)) fill('recipient', '主送机关');
    if (input.redhead) {
        fill('agency', '发文机关');
        if (input.kind === 'minutes') { fill('mark', '纪要名称'); fill('issue', '期号'); }
        else fill('docNo', '发文字号');
        if (input.kind === 'request' && !input.signers?.length) { input.signers = ['【待补充签发人】']; missing.add('签发人'); }
    }
    const placeholders = JSON.stringify(input).match(/【待补充[^】]*】|\[待补充[^\]]*\]|×{2,}/g) || [];
    placeholders.forEach(value => missing.add(value));
    input.missing = [...missing];
    return input;
}
module.exports = { SCHEMA, KINDS, MAX_INPUT, validate, prepare, matches };
