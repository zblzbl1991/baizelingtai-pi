'use strict';
const { randomUUID } = require('node:crypto');
const { fail, keys, id, date, validateInitial } = require('./validation');
const rules = require('./rules');
const fields = ['kind', 'personId', 'absenceKind', 'start', 'end', 'reason', 'projectId', 'occupancyIds', 'occupancyId', 'replacementPersonId', 'effectiveDate', 'releaseKind'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function split(before, start, end) {
    const parts = [];
    if (before.start < start) parts.push({ ...before, end: rules.iso(rules.day(start) - 1) });
    parts.push({ ...before, start, end, state: 'cancelled' });
    if (end < before.end) parts.push({ ...before, start: rules.iso(rules.day(end) + 1) });
    return parts.map((after, index) => index === 0 ? { before: structuredClone(before), after } : { after: { ...after, id: randomUUID() } });
}
function reason(input) { if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500 || /[\x00-\x1f\x7f]/.test(input.reason)) fail('A staffing change reason is required'); }
function build(state, input, today) {
    if (!date(today)) fail('Invalid staffing server calendar');
    if (input.kind === 'replace') {
        keys(input, ['requestId', 'expectedRevision', 'kind', 'projectId', 'occupancyId', 'replacementPersonId', 'start', 'end', 'reason']); reason(input);
        const project = state.projects.find(p => p.id === input.projectId), before = state.occupancies.find(o => o.id === input.occupancyId && o.projectId === input.projectId && o.kind === 'project' && rules.active(o));
        if (!project || project.lifecycle && project.lifecycle.state !== 'active' || !before || !id(input.replacementPersonId) || !state.people.some(p => p.id === input.replacementPersonId) || input.replacementPersonId === before.personId || !date(input.start) || !date(input.end) || input.start < today || input.start > input.end || input.start < before.start || input.end > before.end) fail('Replacement needs a valid future interval and a different person');
        const after = { id: randomUUID(), personId: input.replacementPersonId, projectId: project.id, kind: 'project', state: before.state, start: input.start, end: input.end, reason: input.reason };
        return { kind: 'adjust', project: structuredClone(project), personIds: [before.personId, input.replacementPersonId], change: { kind: 'replace', reason: input.reason }, patch: { projects: [], occupancies: [...split(before, input.start, input.end), { after }] } };
    }
    if (input.kind === 'release') {
        keys(input, ['requestId', 'expectedRevision', 'kind', 'projectId', 'occupancyId', 'effectiveDate', 'releaseKind', 'reason']); reason(input);
        const project = state.projects.find(p => p.id === input.projectId);
        if (!project || !['withdraw', 'cancel', 'early-end'].includes(input.releaseKind) || !date(input.effectiveDate) || input.effectiveDate < today || input.effectiveDate > project.end || input.releaseKind === 'early-end' && input.effectiveDate <= project.start) fail('Release requires a valid future date');
        const rows = state.occupancies.filter(o => o.projectId === project.id && o.kind === 'project' && rules.active(o) && o.end >= input.effectiveDate && (input.releaseKind !== 'withdraw' || o.id === input.occupancyId));
        if (input.releaseKind === 'withdraw' && !rows.length) fail('No matching future staffing assignment', 409);
        const after = input.releaseKind === 'withdraw' ? null : { ...project, lifecycle: { state: input.releaseKind === 'cancel' ? 'cancelled' : 'ended', effectiveDate: input.effectiveDate } };
        return { kind: 'release', project: structuredClone(after || project), personIds: [...new Set(rows.map(o => o.personId))], change: { kind: input.releaseKind, effectiveDate: input.effectiveDate, reason: input.reason }, patch: { projects: after ? [{ before: structuredClone(project), after }] : [], occupancies: rows.flatMap(o => split(o, o.start > input.effectiveDate ? o.start : input.effectiveDate, o.end)) } };
    }
    if (input.kind === 'formalize') {
        keys(input, ['requestId', 'expectedRevision', 'kind', 'projectId', 'occupancyIds']);
        const project = state.projects.find(p => p.id === input.projectId);
        if (!project || input.occupancyIds !== undefined && (!Array.isArray(input.occupancyIds) || !input.occupancyIds.length || input.occupancyIds.some(value => !id(value)))) fail('Invalid staffing formal confirmation');
        const rows = state.occupancies.filter(o => o.projectId === project.id && o.state === 'reserved' && (!input.occupancyIds || input.occupancyIds.includes(o.id)));
        if (!rows.length || input.occupancyIds && rows.length !== new Set(input.occupancyIds).size) fail('No matching reserved staffing assignments', 409);
        return { kind: 'formalize', project: structuredClone(project), personIds: [...new Set(rows.map(o => o.personId))], change: { kind: 'formalize' }, patch: { projects: [], occupancies: rows.map(before => ({ before: structuredClone(before), after: { ...before, state: 'confirmed' } })) } };
    }
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
    for (const entry of plan.patch.occupancies) {
        const after = entry.after;
        if (after.kind !== 'project' || !rules.active(after)) continue;
        const prior = state.occupancies.filter(o => o.personId === after.personId && o.projectId === after.projectId && o.kind === 'project' && rules.active(o));
        const person = state.people.find(p => p.id === after.personId), project = proposed.projects.find(p => p.id === after.projectId);
        if (!plan.crossDepartment && person.department !== project.department && !prior.length) fail('Staffing person is outside the allowed department', 409);
        for (const absence of proposed.occupancies.filter(o => o.personId === after.personId && o.kind !== 'project' && rules.active(o) && rules.overlaps(o, after))) {
            const start = absence.start > after.start ? absence.start : after.start, end = absence.end < after.end ? absence.end : after.end;
            if (!prior.some(o => o.start <= start && o.end >= end)) fail('Staffing replacement is unavailable', 409);
        }
    }
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
        diff: structuredClone(plan.patch), ...(plan.change?.effectiveDate ? { lastRequiredDate: rules.iso(rules.day(plan.change.effectiveDate) - 1) } : {}), currentRevision: state.revision, stale: !state.enabled || plan.epoch !== state.epoch || plan.revision !== state.revision };
}
module.exports = { fields, build, apply, check, affected, projection };
