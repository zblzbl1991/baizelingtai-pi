'use strict';
const { fail, keys, id, date } = require('./validation');
const rules = require('./rules');
function project(state, input) {
    keys(input, ['kind', 'department', 'start', 'end', 'personId', 'offset', 'limit']);
    const offset = input.offset ?? 0, limit = input.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('Invalid staffing view page');
    if (input.department !== undefined && (typeof input.department !== 'string' || !input.department.trim() || input.department.length > 160)) fail('Invalid staffing department');
    if (input.personId !== undefined && !id(input.personId)) fail('Invalid staffing person ID');
    const slice = rows => ({ total: rows.length, offset, limit, rows: rows.slice(offset, offset + limit) });
    const common = { revision: state.revision, historyComplete: state.historyComplete, warning: state.historyComplete ? '' : '按已录入记录排序，历史不完整' };
    if (input.kind === 'projects') {
        const data = slice(state.projects.filter(p => !input.department || p.department === input.department));
        return { ...common, ...data, projects: data.rows.map(p => ({ ...p, team: state.occupancies.filter(o => o.projectId === p.id && rules.active(o)), coverage: rules.coverage(state, p) })) };
    }
    if (input.kind === 'history') { const data = slice([...state.history].reverse()); return { ...common, ...data, events: data.rows.reverse() }; }
    if (!date(input.start) || !date(input.end) || input.start > input.end) fail('Staffing view needs valid inclusive dates');
    if (input.kind === 'availability') {
        if (!input.department) fail('Choose a staffing department');
        const data = slice(rules.candidates(state, { department: input.department, start: input.start, end: input.end }));
        return { ...common, ...data, people: data.rows };
    }
    if (input.kind === 'people') {
        const data = slice(state.people.filter(p => (!input.personId || p.id === input.personId) && (!input.department || p.department === input.department)));
        return { ...common, ...data, people: data.rows.map(p => ({ ...p, workDays: rules.workload(state, p.id, input.start), occupancies: state.occupancies.filter(o => o.personId === p.id && rules.overlaps(o, input)).map(o => ({ ...o, projectName: state.projects.find(project => project.id === o.projectId)?.name })) })) };
    }
    fail('Unknown staffing view');
}
module.exports = { project };
