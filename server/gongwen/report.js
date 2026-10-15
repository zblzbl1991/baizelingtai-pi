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
module.exports = { finish, markdown, LABELS };
