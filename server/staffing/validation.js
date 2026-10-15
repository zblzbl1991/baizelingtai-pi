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
    rows(data.projects, 'projects', row => { keys(row, ['id', 'name', 'department', 'owner', 'start', 'end', 'minimum', 'lifecycle']);
        if (row.lifecycle !== undefined) { keys(row.lifecycle, ['state', 'effectiveDate']); if (!['active', 'cancelled', 'ended'].includes(row.lifecycle.state) || (row.lifecycle.state === 'active' ? row.lifecycle.effectiveDate !== undefined : !date(row.lifecycle.effectiveDate) || row.lifecycle.effectiveDate > row.end || row.lifecycle.state === 'ended' && row.lifecycle.effectiveDate <= row.start)) return false; }
        return text(row.name) && text(row.department) && text(row.owner) && dates(row) && Number.isSafeInteger(row.minimum) && row.minimum > 0 && row.minimum <= LIMITS.people; });
    const people = new Set(data.people.map(row => row.id)), projects = new Map(data.projects.map(row => [row.id, row]));
    rows(data.occupancies, 'occupancies', row => {
        keys(row, ['id', 'personId', 'projectId', 'kind', 'state', 'start', 'end', 'reason']);
        const project = projects.get(row.projectId);
        return people.has(row.personId) && dates(row) && ['reserved', 'confirmed', 'cancelled'].includes(row.state)
            && (row.kind === 'project' ? project && (row.state === 'cancelled' || row.start >= project.start && row.end <= project.end && (!project.lifecycle || project.lifecycle.state === 'active' || row.end < project.lifecycle.effectiveDate))
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
function validatePatch(plan, state) {
    keys(plan.patch, ['projects', 'occupancies']); keys(plan.change, ['kind', 'effectiveDate', 'reason']);
    if (!['absence', 'formalize', 'replace', 'reschedule', 'extend', 'withdraw', 'cancel', 'early-end'].includes(plan.change.kind)
        || plan.change.effectiveDate !== undefined && !date(plan.change.effectiveDate)
        || plan.change.reason !== undefined && !text(plan.change.reason, 500)) fail('Invalid staffing adjustment');
    if (plan.project) validateInitial({ people: [], projects: [plan.project], occupancies: [], historyComplete: false });
    for (const field of ['projects', 'occupancies']) {
        const items = plan.patch[field];
        if (!Array.isArray(items) || items.length > LIMITS[field] || new Set(items.map(item => item?.after?.id)).size !== items.length) fail('Invalid staffing adjustment patch');
        for (const item of items) {
            keys(item, ['before', 'after']);
            if (!object(item.after) || item.before !== undefined && (!object(item.before) || item.before.id !== item.after.id)) fail('Invalid staffing adjustment records');
            for (const row of [item.before, item.after].filter(Boolean)) {
                if (field === 'projects') validateInitial({ people: [], projects: [row], occupancies: [], historyComplete: false });
                else validateInitial({ people: state.people, projects: row.kind === 'project' ? [{ id: row.projectId, name: 'History', department: 'History', owner: 'History', minimum: 1, start: '1900-01-01', end: '9999-12-31' }] : [], occupancies: [row], historyComplete: false });
            }
        }
    }
}
function emptyLedger() { return { version: 1, revision: 0, epoch: 0, plans: {}, enabled: false, initialized: false, phase: 'awaiting-import',
    profileId: null, initializingRequestId: null, people: [], projects: [], occupancies: [], historyComplete: false,
    operations: {}, history: [] }; }
function validateLedger(state) {
    if (!object(state)) fail('Invalid staffing ledger');
    // Version 1 initial ledgers predate plans; normalize without a separate migration.
    state.epoch ??= 0; state.plans ??= {};
    if (!object(state) || state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
        || !Number.isSafeInteger(state.epoch) || state.epoch < 0 || !object(state.plans) || Object.keys(state.plans).length > LIMITS.operations
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
    for (const [planId, plan] of Object.entries(state.plans)) {
        if (!id(planId) || !object(plan) || plan.id !== planId || !['assign', 'absence', 'formalize', 'adjust', 'release', 'import'].includes(plan.kind) || !Number.isSafeInteger(plan.epoch) || plan.epoch < 0 || plan.epoch > state.epoch
            || !Number.isSafeInteger(plan.revision) || plan.revision < 1 || plan.revision > state.revision || !object(plan.source) || !(plan.source.kind === 'page' ? Object.keys(plan.source).every(key => ['kind', 'profileId'].includes(key)) && text(plan.source.profileId) : plan.source.kind === undefined && text(plan.source.sessionId) && text(plan.source.sessionPath, 8192) && text(plan.source.cwd, 8192) && text(plan.source.profileId))
            || plan.kind !== 'import' && (!Array.isArray(plan.personIds) || plan.personIds.length > LIMITS.people || new Set(plan.personIds).size !== plan.personIds.length
            || plan.personIds.some(value => !id(value)) || typeof plan.crossDepartment !== 'boolean')
            || plan.originId !== undefined && !id(plan.originId) || plan.supersededBy !== undefined && (!id(plan.supersededBy) || plan.supersededBy === plan.id)
            || plan.outcome !== undefined && (!object(plan.outcome) || plan.outcome.planId !== plan.id || !['reserve', 'confirm', 'apply', 'apply-import'].includes(plan.outcome.action))) fail('Invalid staffing plan');
        if (plan.kind === 'assign') validateInitial({ people: [], projects: [plan.project], occupancies: [], historyComplete: false });
        else if (plan.kind === 'import') require('./import-domain').validate(plan, state);
        else validatePatch(plan, state);
        if (plan.supersededBy) {
            const target = Object.hasOwn(state.plans, plan.supersededBy) && state.plans[plan.supersededBy];
            if (!target || target.revision <= plan.revision || target.originId !== plan.originId || plan.outcome
                || ['kind', 'sessionId', 'sessionPath', 'cwd', 'profileId'].some(key => target.source?.[key] !== plan.source[key])) fail('Invalid staffing plan chain');
        }
        if (plan.outcome && (!Number.isSafeInteger(plan.outcome.revision) || plan.outcome.revision <= plan.revision || plan.outcome.revision > state.revision)) fail('Invalid staffing plan outcome');
    }
    if (state.phase === 'ready' && !state.initialized || state.initialized && (state.phase !== 'ready' || !state.profileId)
        || state.phase === 'awaiting-review' && !state.profileId
        || state.phase === 'initializing' && (!state.enabled || state.profileId || !state.initializingRequestId
            || state.operations[state.initializingRequestId]?.state !== 'pending')
        || state.phase !== 'initializing' && state.initializingRequestId !== null) fail('Invalid staffing initialization state');
}
module.exports = { MAX_LEDGER, LIMITS, fail, keys, id, date, validateInitial, emptyLedger, validateLedger };
