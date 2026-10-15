const RULE_PACKAGE = Object.freeze({ id: 'pivane-compliance', version: '1.0.0', rules: [
    { id: 'documents-identity', roles: ['award-notice', 'contract', 'feasibility-report', 'feasibility-review', 'feasibility-approval'], predicate: 'required-roles-and-confirmed-identity' },
    { id: 'feasibility-numbers', roles: ['feasibility-review', 'feasibility-approval'], predicate: 'first-page-upper-number-or-confirmed-absence' },
    { id: 'contract-deadline', roles: ['award-notice', 'contract'], predicate: 'natural-day-difference', minimum: 0, maximum: 30 },
    { id: 'feasibility-order', roles: ['feasibility-report', 'feasibility-review'], predicate: 'strictly-before' }
] });
const DAY = 86400000;
function date(raw) {
    const match = /^(\d{4})(?:年|[-/.])(\d{1,2})(?:(?:月|[-/.])(\d{1,2})(?:日)?)?(?:月)?$/.exec(raw.trim());
    if (!match) return null; const year = +match[1], month = +match[2], day = match[3] ? +match[3] : 1;
    const start = Date.UTC(year, month - 1, day), d = new Date(start);
    if (year < 1900 || year > 2200 || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return { value: { start: d.toISOString().slice(0, 10), end: match[3] ? d.toISOString().slice(0, 10) : new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10) }, precision: match[3] ? 'day' : 'month' };
}
function evaluate(batch) {
    const documents = batch.documents, fields = batch.fields.map(field => field.humanValue ? { ...field, ...field.humanValue } : field), project = batch.projectSnapshot;
    return batch.rulePackage.rules.map(rule => {
        const result = { id: rule.id, conclusion: 'insufficient', execution: 'completed', reason: '', evidence: [], review: { status: 'unreviewed' } };
        const done = (conclusion, reason) => ({ ...result, conclusion, reason });
        if (project.applicability[rule.id] === false) return done('not-applicable', '审查人员已确认不适用');
        if (project.applicability[rule.id] !== true) return done('insufficient', '规则适用清单尚未确认');
        if (!project.identityConfirmed) return done('insufficient', '工程项目身份尚未确认');
        let required = rule.roles;
        if (rule.id === 'documents-identity') {
            if (batch.rulePackage.rules.some(r => r.id !== rule.id && project.applicability[r.id] == null)) return done('insufficient', '必需资料范围依赖的规则适用性尚未确认');
            required = [...new Set(batch.rulePackage.rules.filter(r => r.id !== rule.id && project.applicability[r.id] === true).flatMap(r => r.roles))];
        }
        const selected = required.map(role => documents.filter(d => d.assignment?.role === role));
        if (selected.some(group => group.length > 1)) return done('insufficient', '同类多份资料尚未明确唯一选用版本');
        if (selected.some(group => !group.length)) return done(rule.id === 'documents-identity' ? 'issue' : 'insufficient', '缺少必需资料：' + required.filter((_r, i) => !selected[i].length).join('、'));
        const used = selected.flat();
        result.sources = used.map(doc => ({ documentId: doc.id, role: doc.assignment.role, name: doc.name }));
        // A person may verify the exact inputs of a date rule without certifying
        // the unreadable document or replacing its parser/OCR execution record.
        const manualDates = ['contract-deadline', 'feasibility-order'].includes(rule.id) && used.every(doc => {
            const dates = fields.filter(field => field.documentId === doc.id && field.key === 'date');
            return dates.length === 1 && dates[0].humanValue?.status === 'known' && dates[0].humanValue?.value;
        });
        if (manualDates) result.manualInputs = fields.filter(field => used.some(doc => doc.id === field.documentId) && field.key === 'date').map(field => field.id);
        if (used.some(d => d.processing?.status === 'failed') && !manualDates) return { ...done('insufficient', '资料解析执行失败'), execution: 'failed' };
        if (used.some(d => d.processing?.status === 'unreadable')
            && !manualDates && !(rule.id === 'feasibility-numbers' && used.every(d => d.processing?.status !== 'unreadable' || d.assignment.numberAbsentConfirmed)))
            return done('insufficient', '资料读取不完整或需要识别，不能根据部分内容确定结论');
        if (used.some(d => !d.assignment.identityConfirmed)) return done('insufficient', '资料归属尚未人工核对');
        const conflictFields = fields.filter(field => used.some(d => d.id === field.documentId) && ['projectName', 'projectNumber', 'organization', 'year', 'phase'].includes(field.key)).filter(field => {
            const key = field.key, expected = project[key === 'projectName' ? 'name' : key === 'projectNumber' ? 'number' : key];
            return field.status === 'conflict' || field.status === 'known' && expected && field.raw !== expected;
        });
        result.evidence.push(...conflictFields.map(field => field.id));
        const conflicting = used.some(d => ['projectName', 'projectNumber', 'organization', 'year', 'phase'].some(key => {
            const expected = project[key === 'projectName' ? 'name' : key === 'projectNumber' ? 'number' : key], candidates = fields.filter(f => f.documentId === d.id && f.key === key);
            return candidates.some(f => f.status === 'conflict' || f.status === 'known' && expected && f.raw !== expected);
        }));
        if (conflicting) return done(rule.id === 'documents-identity' ? 'issue' : 'insufficient', '资料工程身份与档案冲突');
        if (rule.id === 'documents-identity') return done('passed', '必需资料已提供，归属与选用版本已人工核对');
        const values = (doc, key) => { const found = fields.filter(f => f.documentId === doc.id && f.key === key); result.evidence.push(...found.map(f => f.id)); return found.length === 1 && found[0].status === 'known' ? found[0] : null; };
        if (rule.id === 'feasibility-numbers') {
            let absent = false;
            for (const doc of used) {
                const value = values(doc, 'documentNumber');
                if (value && value.location.page === 1 && value.location.region === 'upper') continue;
                if (doc.assignment.numberAbsentConfirmed === true) absent = true;
                else return done('insufficient', '缺少可核实的发文首页上方文号；扫描或空文本不证明文号缺失');
            }
            return done(absent ? 'issue' : 'passed', absent ? '审查人员已核对发文首页并确认文号缺失' : '发文首页上方存在完整文号');
        }
        const first = values(used[0], 'date'), second = values(used[1], 'date');
        if (!first || !second || !first.value || !second.value) return done('insufficient', '日期缺失、来源冲突或精度不足');
        const min = (Date.parse(second.value.start) - Date.parse(first.value.end)) / DAY, max = (Date.parse(second.value.end) - Date.parse(first.value.start)) / DAY;
        result.range = { minimum: min, maximum: max, unit: 'natural-day' };
        if (rule.predicate === 'natural-day-difference') {
            if (min >= rule.minimum && max <= rule.maximum) return done('passed', `签订日期差 ${min} 至 ${max} 自然日，通知书当日为第零天`);
            if (max < rule.minimum) return done('issue', '合同提前签订候选问题');
            if (min > rule.maximum) return done('issue', '合同超过三十日签订候选问题');
            return done('insufficient', '日期可能区间跨越期限边界');
        }
        if (min > 0) return done('passed', '可研报告日期严格早于评审日期');
        if (max <= 0) return done('issue', '可研报告日期同日或晚于评审日期候选问题');
        return done('insufficient', '月份日期可能区间交叠，无法确定严格先后');
    });
}
module.exports = { RULE_PACKAGE, evaluate, date };
