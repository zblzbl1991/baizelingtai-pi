'use strict';
const { randomUUID } = require('node:crypto');
const { fail, keys, id, date, validateInitial } = require('./validation');
const rules = require('./rules');
const fields = ['kind', 'personId', 'absenceKind', 'start', 'end', 'reason'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function build(state, input) {
    if (input.kind !== 'absence') fail('Unknown staffing adjustment');
    keys(input, ['requestId', 'expectedRevision', ...fields]);
    if (!id(input.personId) || !state.people.some(p => p.id === input.personId) || !['leave', 'training', 'unavailable'].includes(input.absenceKind)
        || !date(input.start) || !date(input.end) || input.start > input.end || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500 || /[\x00-\x1f\x7f]/.test(input.reason)) fail('Invalid staffing absence');
    const row = { id: randomUUID(), personId: input.personId, kind: input.absenceKind, state: 'confirmed', start: input.start, end: input.end, reason: input.reason };
    return { kind: 'absence', personIds: [input.personId], change: { kind: 'absence' }, patch: { projects: [], occupancies: [{ after: row }] } };
}
function apply(state, patch) {
    for (const field of ['projects', 'occupancies']) for (const item of patch[field]) {
        const at = item.before ? state[field].findIndex(row => row.id === item.before.id) : -1;
        if (item.before && (at < 0 || !same(state[field][at], item.before))) fail('Staffing records changed; prepare a new plan', 409);
        if (!item.before && state[field].some(row => row.id === item.after.id)) fail('Staffing record ID already exists', 409);
        if (at >= 0) state[field][at] = structuredClone(item.after); else state[field].push(structuredClone(item.after));
    }
}
function check(state, plan) {
    const proposed = structuredClone(state); apply(proposed, plan.patch);
    validateInitial({ people: proposed.people, projects: proposed.projects, occupancies: proposed.occupancies, historyComplete: proposed.historyComplete });
}
function affected(state, plan) {
    const people = new Set(plan.personIds), ids = new Set(plan.patch?.projects.map(item => item.after.id) || []);
    for (const row of state.occupancies) if (row.kind === 'project' && people.has(row.personId)) ids.add(row.projectId);
    return state.projects.filter(p => ids.has(p.id)).map(project => ({ ...project, coverage: rules.coverage(state, project) }));
}
function projection(state, plan) {
    const proposed = structuredClone(state); if (!plan.outcome) apply(proposed, plan.patch);
    return { ...structuredClone(plan), people: state.people.filter(p => plan.personIds.includes(p.id)), affectedProjects: affected(proposed, plan),
        diff: structuredClone(plan.patch), currentRevision: state.revision, stale: !state.enabled || plan.epoch !== state.epoch || plan.revision !== state.revision };
}
module.exports = { fields, build, apply, check, affected, projection };
