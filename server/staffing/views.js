'use strict';
const { fail, keys, id, date } = require('./validation');
const rules = require('./rules');
function project(state, input) {
    keys(input, ['kind', 'department', 'start', 'end', 'personId', 'offset', 'limit']);
    const offset = input.offset ?? 0, limit = input.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('Invalid staffing view page');
    if (input.department !== undefined && (typeof input.department !== 'string' || !input.department.trim() || input.department.length > 160)) fail('Invalid staffing department');
    if (input.personId !== undefined && !id(input.personId)) fail('Invalid staffing person ID');
    const common = { revision: state.revision, historyComplete: state.historyComplete, warning: state.historyComplete ? '' : '按已录入记录排序，历史不完整' };
    // A row stays complete. Reduce the number of rows, never its people or
    // intervals. A single oversized row needs a narrower query or Excel review.
    const page = (all, field, map = row => row, reverse = false) => {
        const rows = [], projected = [];
        const result = () => ({ ...common, total: all.length, offset, limit,
            nextOffset: offset + rows.length < all.length ? offset + rows.length : null,
            rows: reverse ? [...rows].reverse() : rows, [field]: reverse ? [...projected].reverse() : projected });
        for (const row of all.slice(offset, offset + limit)) {
            rows.push(row); projected.push(map(row));
            if (Buffer.byteLength(JSON.stringify(result()), 'utf8') > 512 * 1024) {
                rows.pop(); projected.pop();
                if (!rows.length) fail('A complete staffing record exceeds the 512 KiB page budget; narrow the date range or review an Excel export', 413);
                break;
            }
        }
        return result();
    };
    if (input.kind === 'projects') {
        return page(state.projects.filter(p => !input.department || p.department === input.department), 'projects', p => ({ ...p,
            team: state.occupancies.filter(o => o.projectId === p.id && rules.active(o)), coverage: rules.coverage(state, p) }));
    }
    if (input.kind === 'history') return page([...state.history].reverse(), 'events', row => row, true);
    if (!date(input.start) || !date(input.end) || input.start > input.end) fail('Staffing view needs valid inclusive dates');
    if (input.kind === 'availability') {
        if (!input.department) fail('Choose a staffing department');
        return page(rules.candidates(state, { department: input.department, start: input.start, end: input.end }), 'people');
    }
    if (input.kind === 'people') {
        return page(state.people.filter(p => (!input.personId || p.id === input.personId) && (!input.department || p.department === input.department)), 'people', p => ({ ...p,
            workDays: rules.workload(state, p.id, input.start), occupancies: state.occupancies.filter(o => o.personId === p.id && rules.overlaps(o, input))
                .map(o => ({ ...o, projectName: state.projects.find(project => project.id === o.projectId)?.name })) }));
    }
    fail('Unknown staffing view');
}
module.exports = { project };
