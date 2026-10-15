'use strict';
const MAX_LEDGER = 8 * 1024 * 1024;
const LIMITS = Object.freeze({ people: 5000, projects: 5000, occupancies: 20000, operations: 10000, history: 20000 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (value, max = 160) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1900-01-01' && value <= '9999-12-31'
    && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const dates = value => date(value.start) && date(value.end) && value.start <= value.end;
function keys(value, allowed) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('Unknown or invalid staffing fields'); }
function rows(value, name, validate) {
    if (!Array.isArray(value) || value.length > LIMITS[name]) fail(`Invalid staffing ${name} or record limit exceeded`);
    const seen = new Set();
    for (const row of value) {
        if (!object(row) || !id(row.id) || seen.has(row.id) || !validate(row)) fail(`Invalid or duplicate staffing ${name}`);
        seen.add(row.id);
    }
}
function validateInitial(data) {
    keys(data, ['people', 'projects', 'occupancies', 'historyComplete']);
    if (typeof data.historyComplete !== 'boolean') fail('History completeness must be specified');
    rows(data.people, 'people', row => { keys(row, ['id', 'name', 'department', 'direct']); return text(row.name) && text(row.department) && typeof row.direct === 'boolean'; });
    rows(data.projects, 'projects', row => { keys(row, ['id', 'name', 'department', 'owner', 'start', 'end', 'minimum']);
        return text(row.name) && text(row.department) && text(row.owner) && dates(row) && Number.isSafeInteger(row.minimum) && row.minimum > 0 && row.minimum <= LIMITS.people; });
    const people = new Set(data.people.map(row => row.id)), projects = new Map(data.projects.map(row => [row.id, row]));
    rows(data.occupancies, 'occupancies', row => {
        keys(row, ['id', 'personId', 'projectId', 'kind', 'state', 'start', 'end', 'reason']);
        const project = projects.get(row.projectId);
        return people.has(row.personId) && dates(row) && ['reserved', 'confirmed', 'cancelled'].includes(row.state)
            && (row.kind === 'project' ? project && row.start >= project.start && row.end <= project.end
                : ['leave', 'training', 'unavailable'].includes(row.kind) && row.projectId === undefined)
            && (row.reason === undefined || text(row.reason, 500));
    });
    const byPerson = new Map();
    const assignments = data.occupancies.filter(row => row.kind === 'project' && row.state !== 'cancelled').sort((a, b) => a.start.localeCompare(b.start));
    for (const row of assignments) {
        const priorEnd = byPerson.get(row.personId);
        if (priorEnd && row.start <= priorEnd) fail('Overlapping initial project assignments');
        byPerson.set(row.personId, row.end);
    }
}
function emptyLedger() { return { version: 1, revision: 0, enabled: false, initialized: false, phase: 'awaiting-import',
    profileId: null, initializingRequestId: null, people: [], projects: [], occupancies: [], historyComplete: false,
    operations: {}, history: [] }; }
function validateLedger(state) {
    if (!object(state) || state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
        || typeof state.enabled !== 'boolean' || typeof state.initialized !== 'boolean'
        || !['initializing', 'awaiting-import', 'awaiting-review', 'ready'].includes(state.phase)
        || !(state.profileId === null || /^[a-f0-9-]{36}$/.test(state.profileId))
        || !(state.initializingRequestId === null || id(state.initializingRequestId))
        || !object(state.operations) || Object.keys(state.operations).length > LIMITS.operations
        || !Array.isArray(state.history) || state.history.length > LIMITS.history
        || Object.entries(state.operations).some(([key, op]) => !id(key) || !object(op) || !/^[a-f0-9]{64}$/.test(op.digest)
            || !['pending', 'completed'].includes(op.state) || op.state === 'completed' && !object(op.result))
        || state.history.some(event => !object(event) || !id(event.requestId) || !text(event.action) || !text(event.at))) fail('Invalid staffing ledger');
    validateInitial({ people: state.people, projects: state.projects, occupancies: state.occupancies, historyComplete: state.historyComplete });
    if (state.phase === 'ready' && !state.initialized || state.initialized && (state.phase !== 'ready' || !state.profileId)
        || state.phase === 'awaiting-review' && !state.profileId
        || state.phase === 'initializing' && (!state.enabled || state.profileId || !state.initializingRequestId
            || state.operations[state.initializingRequestId]?.state !== 'pending')
        || state.phase !== 'initializing' && state.initializingRequestId !== null) fail('Invalid staffing initialization state');
}
module.exports = { MAX_LEDGER, LIMITS, fail, keys, id, validateInitial, emptyLedger, validateLedger };
