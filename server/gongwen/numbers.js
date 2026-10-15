// Exact decimal arithmetic on printed values; never choose a replacement value.
// Percent rounding is bounded by half a printed unit per contributing value.
const totalLabel = text => /^(合\s*计|总\s*计|小\s*计)$/.test(text.trim());
function decimal(raw) {
    const match = /^(-?)(\d+(?:,\d{3})*)(?:\.(\d{1,8}))?([%％]?)$/.exec(raw.trim());
    if (!match) return null;
    const digits = match[2].replace(/,/g, '') + (match[3] || '');
    if (digits.length > 24) return null;
    return { value: BigInt(digits) * (match[1] ? -1n : 1n), scale: (match[3] || '').length, percent: Boolean(match[4]), raw };
}
const atScale = (value, scale) => value.value * 10n ** BigInt(scale - value.scale);
const abs = value => value < 0n ? -value : value;
function equalSum(parts, total, percent = false) {
    const scale = Math.max(total.scale, ...parts.map(value => value.scale));
    const difference = abs(parts.reduce((sum, value) => sum + atScale(value, scale), 0n) - atScale(total, scale));
    const rounding = percent ? [...parts, total].filter(value => !value.exact).reduce((sum, value) => sum + 10n ** BigInt(scale - value.scale), 0n) : 0n;
    return difference * 2n <= rounding;
}
function infer(head) {
    if (/占比|比例|比重|构成|[%％]/.test(head)) return 'percent';
    if (/率|增幅|单价|均价|平均|累计|余额|期初|期末/.test(head)) return null;
    if (/金额|预算|收入|支出|费用|[（(](?:万|亿)?元[）)]/.test(head)) return 'money';
    if (/数量|人数|人次|户数|家数|件数|项数|个数|[（(](?:人|个|项|家|件|台|套)[）)]/.test(head)) return 'integer';
    return null;
}
function checkTables(blocks) {
    const errors = [], hints = [];
    let index = 0;
    for (const table of blocks.filter(item => item.type === 'table')) {
        index++;
        const columns = table.numeric || table.head.flatMap((head, i) => { const kind = infer(head); return kind ? [{ column: i + 1, kind }] : []; });
        for (const definition of columns) {
            const col = definition.column - 1, percent = definition.kind === 'percent';
            const read = row => {
                const value = decimal(row[col]);
                if (!value || value.percent !== percent && value.percent || definition.kind === 'integer' && value.scale) return null;
                return value;
            };
            const numericRow = row => !/率|单价|均价|平均/.test(row[0]);
            table.rows.forEach((row, position) => {
                if (!totalLabel(row[0])) return;
                const total = read(row);
                const subtotal = /^小\s*计$/.test(row[0].trim());
                let start = position - 1;
                while (start >= 0 && !(subtotal ? totalLabel(table.rows[start][0]) : /^(合\s*计|总\s*计)$/.test(table.rows[start][0].trim()))) start--;
                let segment = table.rows.slice(start + 1, position).filter(numericRow);
                if (!segment.length && position === 0) segment = table.rows.slice(1).filter(row => !totalLabel(row[0]) && numericRow(row));
                const subtotals = segment.filter(row => /^小\s*计$/.test(row[0].trim()));
                if (!subtotal && subtotals.length) segment = subtotals;
                else segment = segment.filter(row => !totalLabel(row[0]));
                const parts = segment.map(read);
                const where = `第 ${index} 表「${row[0]}」行／「${table.head[col]}」列`;
                if (!total || !parts.length || parts.some(value => value === null)) {
                    hints.push({ rule: '严格数字覆盖', detail: `${where}有缺失、范围或非纯数字，未完整核对`, anchors: [row[0]] }); return;
                }
                if (!equalSum(parts, total, percent)) errors.push({ rule: '严格合计不符', detail: `${where}：分项 ${segment.map(r => r[col]).join(' + ')} 与合计 ${row[col]} 不符；未修改数字`, anchors: [row[0], row[col]] });
                if (percent && definition.complete && !equalSum(parts, { value: 100n, scale: 0, exact: true }, true)) errors.push({ rule: '完整百分比构成', detail: `${where}声明完整构成，分项和与 100% 超出显示精度舍入范围`, anchors: [row[0]] });
            });
            if (percent && definition.complete && !table.rows.some(row => totalLabel(row[0]))) {
                const parts = table.rows.map(read);
                if (parts.some(value => !value)) hints.push({ rule: '严格数字覆盖', detail: `第 ${index} 表完整占比列存在无法解析的数值`, anchors: [] });
                else if (!equalSum(parts, { value: 100n, scale: 0, exact: true }, true)) errors.push({ rule: '完整百分比构成', detail: `第 ${index} 表「${table.head[col]}」列声明完整构成，分项和与 100% 不符`, anchors: [] });
            }
        }
        const totalCol = table.head.findIndex(totalLabel);
        if (totalCol > 1 && table.head.slice(1, totalCol).some(head => /率|增幅|单价|均价|平均/.test(head) && !/占比|构成/.test(head))) {
            hints.push({ rule: '严格数字覆盖', detail: `第 ${index} 表合计列混有比率、单价或平均值，未自动加总不同口径`, anchors: [] });
        } else if (totalCol > 1) table.rows.forEach(row => {
            if (totalLabel(row[0]) || /率|单价|均价|平均|余额|期初|期末|累计/.test(row[0])) return;
            const total = decimal(row[totalCol]), parts = row.slice(1, totalCol).map(decimal);
            if (!total || parts.some(value => !value) || parts.some(value => value.percent !== total.percent)) {
                hints.push({ rule: '严格数字覆盖', detail: `第 ${index} 表「${row[0]}」合计列未完整核对`, anchors: [row[0]] }); return;
            }
            if (!equalSum(parts, total, total.percent)) errors.push({ rule: '严格合计列不符', detail: `第 ${index} 表「${row[0]}」分项 ${row.slice(1, totalCol).join(' + ')} 与合计 ${row[totalCol]} 不符；未修改数字`, anchors: [row[0]] });
        });
        if (!columns.length && totalCol < 0 && table.rows.some(row => totalLabel(row[0]))) hints.push({ rule: '严格数字覆盖', detail: `第 ${index} 表未识别金额／数量／占比列，请提供 numeric 列口径以严格核对`, anchors: [] });
    }
    return { errors, hints };
}
module.exports = { decimal, equalSum, checkTables };
