const { xml } = require('../pi-document-parser');
const { checkTables } = require('./numbers');
const kids = (n, name) => (n?.children || []).filter(c => typeof c === 'object' && (!name || c.name === name));
const all = (n, name) => kids(n).flatMap(c => [...(c.name === name ? [c] : []), ...all(c, name)]);
const visible = n => n.name === 'del' || n.name === 'moveFrom' ? '' : n.name === 't'
    ? n.children.filter(c => typeof c === 'string').join('') : kids(n).map(visible).join('');
function inspectTables(documentXml) {
    const tables = all(xml(Buffer.from(documentXml)), 'tbl'), errors = [], hints = [];
    if (tables.length > 500) throw Error('公文表格超过检查预算');
    tables.forEach((table, index) => {
        const rows = kids(table, 'tr'), cells = rows.map(row => kids(row, 'tc'));
        const skip = reason => hints.push({ rule: '严格数字覆盖', detail: `第 ${index + 1} 表${reason}，未按完整数表严格核对`, anchors: [] });
        if (all(table, 'tbl').length || all(table, 'gridSpan').length || all(table, 'vMerge').length || all(table, 'hMerge').length) { skip('含嵌套或合并单元格'); return; }
        if (!all(rows[0], 'tblHeader').length) { skip('未声明表头'); return; }
        const head = cells[0]?.map(visible), body = cells.slice(1).map(row => row.map(visible));
        if (!head || head.length < 2 || head.length > 12 || body.length > 200 || !body.length || body.some(row => row.length !== head.length)) { skip('行列超限或形状不规则'); return; }
        const checked = checkTables([{ type: 'table', head, rows: body }]);
        const project = hit => ({ ...hit, detail: hit.detail.replace(/第 1 表/g, `第 ${index + 1} 表`),
            anchors: hit.anchors.map(text => ({ text, table: index })) });
        errors.push(...checked.errors.map(project)); hints.push(...checked.hints.map(project));
    });
    return { errors, hints };
}
module.exports = { inspectTables };
