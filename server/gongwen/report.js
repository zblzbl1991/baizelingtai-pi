const LABELS = { checked: '规则机检通过', 'needs-input': '待补充草稿', 'needs-review': '待核对草稿', unchecked: '检查未完成', failed: '生成失败' };
const { REVIEWED } = require('./inventory');
function finish(input, checks, corrections = [], rounds = 0) {
    const totals = Object.fromEntries(['errors', 'hints', 'styles', 'faults'].map(key => [key, checks[key].length])); totals.corrections = corrections.length;
    // Markdown escaping can double the displayed text. Leave space for that
    // expansion and the fixed report metadata within the 256 KiB output budget.
    let remaining = 96 * 1024, truncated = false;
    const excerpt = (value, length) => {
        const text = String(value || '');
        if (text.length <= length) return text;
        truncated = true; return text.slice(0, length) + '…';
    };
    const project = (items, correction = false) => items.flatMap(item => {
        const record = correction ? { where: excerpt(item.where, 100), rules: item.rules,
            before: excerpt(item.before, 300), after: excerpt(item.after, 300) }
            : { ...item, detail: item.detail ? excerpt(item.detail, 1200) : undefined,
                anchors: (item.anchors || []).slice(0, 8).map(anchor => typeof anchor === 'string' ? excerpt(anchor, 160)
                    : { text: excerpt(anchor.text, 160), table: anchor.table }) };
        if (item.anchors?.length > 8) truncated = true;
        const size = Buffer.byteLength(JSON.stringify(record));
        if (size > remaining) { truncated = true; return []; }
        remaining -= size; return [record];
    });
    const displayed = { stages: checks.stages, faults: project(checks.faults), errors: project(checks.errors), hints: project(checks.hints),
        styles: project(checks.styles), corrections: project(corrections, true) };
    const status = checks.faults.length ? 'unchecked' : input.missing?.length ? 'needs-input'
        : truncated ? 'needs-review'
        : checks.errors.length || checks.hints.length ? 'needs-review' : 'checked';
    return { version: 1, kind: input.kind, title: [].concat(input.title).join(''), status, label: LABELS[status],
        machineChecks: checks.faults.length ? 'incomplete' : checks.errors.length ? 'failed' : 'passed',
        rendering: 'not-verified', fonts: ['方正小标宋简体', '仿宋（FangSong）', '黑体（SimHei）', '楷体（KaiTi）', '宋体（SimSun）'],
        missing: input.missing || [], ...displayed, totals, truncated, rounds,
        coverage: ['最终 DOCX 的体例、数字、文风规则；结构化表格的严格显示值核对',
            '正文同指标与正文／表格取值属于启发式提示；未覆盖的语义仍须人工核对',
            '未验证事实真实性、政治表述、签章或发文审批；Word/WPS 字体与分页未实机核验'],
        upstream: `gongwen-kit ${REVIEWED.version} / ${REVIEWED.commit}` };
}
const safe = value => String(value).replace(/[\r\n]+/g, ' ').replace(/[\\`*_\[\]<>]/g, char => '\\' + char);
function markdown(report, revision) {
    report = boundReport(report);
    const sections = [`# 公文检查报告`, '', `文档：${safe(report.title)}`, `版本：${revision}`, `状态：${report.label}`,
        `规则机检：${({ passed: '通过', failed: '未通过', incomplete: '未完成' })[report.machineChecks]}`,
        '版面实机核验：未完成（未验证当前文件的 Word/WPS 渲染）', '',
        `自动规范修正：${report.rounds} 轮，${report.corrections.length} 处；未猜改数字事实。`, ''];
    if (report.truncated) sections.push('报告包含节选或部分问题。完整修正记录保存在本版本的规范修正.json；原始与最终草稿源分别保留。',
        `检测总数：错误 ${report.totals.errors}，待核对提示 ${report.totals.hints}，风格提示 ${report.totals.styles}，修正 ${report.totals.corrections}。`, '');
    if (report.operation) sections.push('## 原稿检查与修订', '',
        `操作：${report.operation === 'inspect' ? '只检查，受检文件与原件字节一致' : '另存修订件'}；处理${report.editing === 'complete' ? '已完成' : '未完成'}。`,
        `版式直接调整：${report.layoutApplied ? '已执行' : '未执行'}。`,
        ...(report.layoutNotes || []).map(note => `- ${safe(note)}`),
        `批注：${report.comments?.placed || 0} 条已定位，${report.comments?.unplaced || 0} 条未定位。`,
        ...(report.reviewPending ? [`请在 Word/WPS 审阅中逐条接受或拒绝本轮修订（作者：${safe(report.revisionAuthor)}）。规则检查针对建议修订后的可见文本。`] : []),
        ...(report.originalSnapshot && report.editing !== 'complete' ? ['修复未完成，交付的是结构有效的受检原稿；未认定修复或检查通过。'] : []), '');
    if (report.format) {
        const format = report.format;
        sections.push('## 电子版式核验', '', `依据：${safe(format.standard)}；范围：${format.scope === 'normative' ? '明确适用的规范属性' : '保留原稿，仅作格式参考，不认定整篇合规'}。`,
            `电子属性：${safe(format.properties?.status)}；字体可用性：${safe(format.fontAvailability?.status)}；综合：${safe(format.status)}。`,
            '结构结论限于有界 XML、样式引用及已实现的关键属性；不是完整 Open XML SDK 校验或所有国标条款验收。',
            `逐项检查 ${format.total || 0} 项，展示 ${format.checks?.length || 0} 项${format.truncated ? '（已节选）' : ''}。`,
            ...(format.checks || []).map(item => `- [${safe(item.status)}] ${safe(item.id)} ${safe(JSON.stringify(item.location))}：预期 ${safe(JSON.stringify(item.expected))}；实际 ${safe(JSON.stringify(item.actual))}${item.reason ? '；' + safe(item.reason) : ''}`),
            ...(format.fontAvailability?.fonts || []).map(font => `- 字体 ${safe(font.requested)}：${safe(font.status)}。`),
            `预览：${safe(format.preview?.status || 'not-verified')}；HTML 与 Word/WPS 的实际显示分别验收。`, '');
    }
    if (report.formatChanges) sections.push('## 直接格式调整', '', '下列调整直接写入副本，不能通过拒绝文字修订撤回；可从原件恢复。文字修订另在 Word/WPS 审阅中处理。',
        `共 ${report.formatChangesTotal || 0} 项，展示 ${report.formatChanges.length} 项${report.formatChangesTruncated ? '（已节选；保存的格式调整记录也会标明生产侧节选）' : ''}。`,
        ...report.formatChanges.map(item => `- ${safe(item.where)}（${safe(item.property)}）：${safe(item.before)} → ${safe(item.after)}`), '');
    for (const [name, items] of [['待补充', report.missing], ['错误', report.errors], ['待核对提示', report.hints], ['风格提示', report.styles], ['检查故障', report.faults]]) {
        sections.push(`## ${name}`, '');
        if (!items.length) sections.push('无。', '');
        else sections.push(...items.map((item, i) => `- ${i + 1}. ${safe(typeof item === 'string' ? item : `${item.stage || ''} ${item.rule || ''}：${item.detail || item.message}`)}`), '');
    }
    sections.push('## 已自动修正', '', ...report.corrections.map(item => `- ${safe(item.where)}（${safe(item.rules.join('、'))}）：${safe(item.before)} → ${safe(item.after)}`),
        '', '## 字体与覆盖范围', '', `${report.fontScope === 'reference-only' ? '规范排版参考字体（本次保留原稿字体，并非原稿字体清单）' : '所需字体'}：${report.fonts.join('、')}。应用不捆绑字体。`, '',
        '标题字体不可用时，文档声明宋体备选；实际替代由打开软件决定，备选字体不代表小标宋验收通过。', '',
        ...report.coverage.map(value => `- ${value}`), '', `生成与检查组件：${report.upstream}`, '');
    return sections.join('\n');
}
function includeFormat(report, format) {
    report.format = format;
    if (format.properties.status === 'failed') {
        report.errors.push({ stage: '电子版式', rule: '最终生效属性', detail: '最终 DOCX 的适用电子属性存在偏差，见逐项格式检查。' });
        report.totals.errors++; report.machineChecks = report.faults.length ? 'incomplete' : 'failed';
        if (report.status === 'checked') { report.status = 'needs-review'; report.label = LABELS['needs-review']; }
    } else if (format.properties.status === 'incomplete') {
        report.faults.push({ stage: '电子版式', code: 'GONGWEN_FORMAT', message: '必要的最终属性核验未完成，见格式覆盖。' });
        report.totals.faults++; report.machineChecks = 'incomplete'; report.status = 'unchecked'; report.label = LABELS.unchecked;
    }
    if (format.fontAvailability.status !== 'available') {
        report.hints.push({ stage: '字体可用性', rule: format.fontAvailability.status === 'missing' ? '本机字体缺失' : '本机字体未知', detail: '字体声明和电子属性另行核验；本机字体不能确认完整可用，不代表其他打开设备的字体状态。' });
        report.totals.hints++;
        if (report.status === 'checked') { report.status = 'needs-review'; report.label = LABELS['needs-review']; }
    }
    return report;
}
function boundReport(report) {
    let shortened = false, remaining = 80 * 1024;
    const value = (item, depth = 0) => {
        if (typeof item === 'string') { if (item.length > 240) { shortened = true; return item.slice(0, 239) + '…'; } return item; }
        if (item === null || typeof item !== 'object') return item;
        if (depth > 5) { shortened = true; return '…'; }
        if (Array.isArray(item)) { if (item.length > 32) shortened = true; return item.slice(0, 32).map(part => value(part, depth + 1)); }
        const entries = Object.entries(item); if (entries.length > 32) shortened = true;
        return Object.fromEntries(entries.slice(0, 32).map(([key, part]) => [key.slice(0, 80), value(part, depth + 1)]));
    };
    const { errors, hints, styles, faults, corrections, format, formatChanges, ...metadata } = report;
    const result = value(metadata);
    const project = items => (items || []).flatMap(item => {
        const record = value(item), size = Buffer.byteLength(JSON.stringify(record));
        if (size > remaining) { shortened = true; return []; }
        remaining -= size; return [record];
    });
    for (const [key, items] of Object.entries({ errors, hints, styles, faults, corrections })) result[key] = project(items);
    if (format) {
        const { checks, ...summary } = format; result.format = value(summary);
        result.format.checks = project(checks); result.format.truncated ||= result.format.checks.length !== (checks || []).length;
        result.format.truncated ||= result.format.checks.some((item, i) => JSON.stringify(item) !== JSON.stringify(checks[i]));
    }
    if (formatChanges) {
        result.formatChanges = project(formatChanges);
        result.formatChangesTruncated ||= result.formatChanges.length !== formatChanges.length;
        result.formatChangesTruncated ||= result.formatChanges.some((item, i) => JSON.stringify(item) !== JSON.stringify(formatChanges[i]));
    }
    result.truncated ||= shortened;
    if (result.truncated && result.status === 'checked') { result.status = 'needs-review'; result.label = LABELS['needs-review']; }
    return result;
}
module.exports = { finish, markdown, LABELS, includeFormat, boundReport };
