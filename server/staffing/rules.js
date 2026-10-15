'use strict';
// Inclusive calendar intervals. All projections share these rules, including absence coverage.
const day = date => Date.parse(date + 'T00:00:00Z') / 86400000;
const iso = value => new Date(value * 86400000).toISOString().slice(0, 10);
const active = row => row.state !== 'cancelled';
const overlaps = (a, b) => a.start <= b.end && b.start <= a.end;
function unionDays(intervals) {
    intervals.sort((a, b) => a[0] - b[0]); let total = 0, end = -Infinity;
    for (const [start, stop] of intervals) { total += Math.max(0, stop - Math.max(start, end + 1) + 1); end = Math.max(end, stop); }
    return total;
}
function workload(state, personId, start) {
    const stop = day(start) - 1, begin = stop - 89;
    return unionDays(state.occupancies.filter(row => row.personId === personId && row.kind === 'project' && active(row))
        .map(row => [Math.max(begin, day(row.start)), Math.min(stop, day(row.end))]).filter(([a, b]) => a <= b));
}
function candidates(state, project, crossDepartment = false) {
    return state.people.filter(person => (crossDepartment || person.department === project.department)
        && !state.occupancies.some(row => row.personId === person.id && active(row) && overlaps(row, project)))
        .map(person => ({ ...person, workDays: workload(state, person.id, project.start) }))
        .sort((a, b) => a.workDays - b.workDays || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
function coverage(state, project) {
    const assignments = state.occupancies.filter(row => row.projectId === project.id && row.kind === 'project' && active(row) && overlaps(row, project));
    const assignedIds = new Set(assignments.map(row => row.personId));
    const absent = state.occupancies.filter(row => row.kind !== 'project' && assignedIds.has(row.personId) && active(row) && overlaps(row, project));
    const begin = day(project.start), stop = day(project.end) + 1, events = new Map([[begin, []], [stop, []]]);
    for (const [rows, kind] of [[assignments, 'assigned'], [absent, 'absent']]) for (const row of rows) {
        for (const [at, delta] of [[Math.max(begin, day(row.start)), 1], [Math.min(stop, day(row.end) + 1), -1]]) {
            if (!events.has(at)) events.set(at, []); events.get(at).push({ personId: row.personId, kind, delta });
        }
    }
    const boundaries = [...events.keys()].sort((a, b) => a - b), people = new Map(state.people.map(person => [person.id, person]));
    const counts = new Map(); let count = 0, direct = 0;
    const segments = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
        for (const event of events.get(boundaries[i])) {
            const person = counts.get(event.personId) || { assigned: 0, absent: 0 };
            const before = person.assigned > 0 && person.absent === 0;
            person[event.kind] += event.delta; counts.set(event.personId, person);
            const after = person.assigned > 0 && person.absent === 0;
            if (before !== after) { const delta = after ? 1 : -1; count += delta; if (people.get(event.personId)?.direct) direct += delta; }
        }
        const start = iso(boundaries[i]), end = iso(boundaries[i + 1] - 1);
        const result = { start, end, count, direct, missing: Math.max(0, project.minimum - count), missingDirect: direct === 0 };
        const previous = segments.at(-1);
        if (previous && ['count', 'direct', 'missing', 'missingDirect'].every(key => previous[key] === result[key])) previous.end = end;
        else segments.push(result);
    }
    return { segments, satisfied: segments.every(row => !row.missing && !row.missingDirect),
        allConfirmed: assignments.length > 0 && assignments.every(row => row.state === 'confirmed') };
}
module.exports = { day, iso, active, overlaps, unionDays, workload, candidates, coverage };
