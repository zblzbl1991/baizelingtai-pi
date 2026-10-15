const { checkTables } = require('./numbers');
const docCheck = require('../../vendor/gongwen-kit/checks/check-doc');
const numberCheck = require('../../vendor/gongwen-kit/checks/check-num');
const { scan } = require('../../vendor/gongwen-kit/checks/style-scan');
const { editsFor } = require('../../vendor/gongwen-kit/lib/fix/text-rules');
const unquote = text => text.replace(/「[^」\n]*」/g, '　').replace(/“[^”\n]*”/g, '　');
async function inspect(file, input, implementations = {}) {
    const errors = [], hints = [], styles = [], faults = [], stages = [];
    let extracted;
    const run = async (stage, action) => {
        try { await action(); stages.push({ stage, completed: true }); }
        catch { faults.push({ stage, code: 'GONGWEN_CHECK', message: `${stage}程序未完成；不能认定通过` }); stages.push({ stage, completed: false }); }
    };
    await run('体例', async () => {
        extracted = await (implementations.readDocx || docCheck.readDocx)(file);
        errors.push(...(implementations.doc || docCheck.check)(file, extracted).map(item => ({ ...item, stage: '体例' })));
    });
    await run('数字', async () => {
        const result = await (implementations.numbers || numberCheck.check)(file);
        errors.push(...result.map(item => ({ ...item, stage: '数字' })));
        hints.push(...(result.hints || []).map(item => ({ ...item, stage: '数字' })));
        const strict = checkTables([...input.body, ...(input.attachments || []).flatMap(item => item.body)]);
        errors.push(...strict.errors.map(item => ({ ...item, stage: '严格数字' })));
        hints.push(...strict.hints.map(item => ({ ...item, stage: '严格数字' })));
    });
    await run('文风', async () => {
        const data = extracted || await docCheck.readDocx(file);
        const result = (implementations.style || scan)(unquote(data.paras.map(item => item.text).join('\n')));
        errors.push(...result.norm.map(detail => ({ stage: '文风', rule: '规范文风', detail, anchors: result.anchors || [] })));
        styles.push(...result.style.map(detail => ({ stage: '文风', rule: '风格提示', detail, anchors: [] })));
    });
    return { errors, hints, styles, faults, stages };
}
// Only modify the generated source, never facts or an uploaded Word file.
// Upstream's protected ranges retain quotations, titles of cited works and URLs.
function correct(input) {
    const copy = structuredClone(input), changes = [];
    const edit = (value, ctx, where) => {
        if (typeof value !== 'string') return value;
        const edits = editsFor(value, ctx);
        let result = value;
        for (const item of [...edits].reverse()) result = result.slice(0, item.start) + item.text + result.slice(item.end);
        if (result !== value) changes.push({ where, rules: [...new Set(edits.map(item => item.rule))], before: value, after: result });
        return result;
    };
    const blocks = (items, prefix) => items.map((item, i) => {
        if (item.type === 'table') return item; // Numeric cells, captions and labels are not silently edited.
        return { ...item, text: edit(item.text, { heading: item.type === 'heading', numbered: item.type === 'heading' }, `${prefix}${i + 1}`) };
    });
    copy.body = blocks(copy.body, '正文构件 ');
    copy.attachments = copy.attachments?.map((item, i) => ({ ...item, body: blocks(item.body, `附件 ${i + 1} 构件 `) }));
    for (const key of ['date', 'docNo', 'printDate', 'note']) if (copy[key]) copy[key] = edit(copy[key], {}, key);
    return { input: copy, changes };
}
module.exports = { inspect, correct };
