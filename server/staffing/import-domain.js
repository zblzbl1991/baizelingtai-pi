'use strict';
const { keys, fail, id, validateInitial, LIMITS } = require('./validation');
const { isDeepStrictEqual: same } = require('node:util');
const { active, overlaps, day, unionDays } = require('./rules');
const collections = ['people', 'projects', 'occupancies'];
function merged(state, plan) {
    const data = { historyComplete: plan.import.historyComplete };
    for (const name of collections) {
        const records = new Map((plan.import.mode === 'initialize' ? [] : state[name]).map(row => [row.id, row]));
        for (const row of plan.import.upserts[name]) records.set(row.id, structuredClone(row)); data[name] = [...records.values()];
    }
    return data;
}
function validate(plan) {
    const value = plan.import; keys(value, ['mode', 'formatVersion', 'upload', 'sourceRevision', 'historyComplete', 'upserts', 'counts']);
    if (!['initialize', 'merge'].includes(value.mode) || value.formatVersion !== 1 || !Number.isSafeInteger(value.sourceRevision) || value.sourceRevision < 0 || typeof value.historyComplete !== 'boolean') fail('Invalid import plan');
    keys(value.upload, ['id', 'revision']); if (!/^[a-f0-9]{64}$/.test(value.upload.id) || !/^[a-f0-9]{64}$/.test(value.upload.revision)) fail('Invalid import source');
    if (plan.outcome) {
        if (value.upserts !== undefined || !value.counts) fail('Invalid completed import plan');
        keys(value.counts, collections); if (collections.some(name => !Number.isSafeInteger(value.counts[name]) || value.counts[name] < 0 || value.counts[name] > LIMITS[name])) fail('Invalid import counts');
    } else {
        keys(value.upserts, collections);
        for (const name of collections) if (!Array.isArray(value.upserts[name]) || value.upserts[name].length > LIMITS[name]
            || value.upserts[name].some(row => !row || !id(row.id)) || new Set(value.upserts[name].map(row => row.id)).size !== value.upserts[name].length) fail('Invalid import records');
    }
}
function check(state, plan, { today } = {}) {
    validate(plan); if (plan.outcome) return;
    if (plan.import.mode === 'initialize' ? state.initialized || !['awaiting-import', 'awaiting-review'].includes(state.phase) : !state.initialized || state.phase !== 'ready') fail('Import mode does not match ledger phase', 409);
    const data = merged(state, plan); validateInitial(data);
    if (plan.import.mode === 'merge') {
        for (const row of plan.import.upserts.occupancies) {
            const old = state.occupancies.find(item => item.id === row.id); if (!old || same(old, row)) continue;
            if (old.state === 'cancelled' && row.state !== 'cancelled' || row.end > old.end) fail('Import cannot implicitly restore released occupancy; use an explicit adjustment', 409);
            const yesterday = require('./rules').iso(require('./rules').day(today) - 1);
            if (old.start < today && (row.state === 'cancelled' || row.start !== old.start || row.end < yesterday && row.end < old.end || ['personId', 'projectId', 'kind'].some(k => old[k] !== row[k]))) fail('Import cannot rewrite elapsed occupancy', 409);
        }
        for (const row of plan.import.upserts.occupancies) {
            if (row.kind !== 'project' || row.state === 'cancelled' || same(state.occupancies.find(item => item.id === row.id), row)) continue;
            const person = data.people.find(item => item.id === row.personId), project = data.projects.find(item => item.id === row.projectId);
            if (person.department !== project.department) fail('Cross-department import requires an explicit staffing plan with borrowing permission', 409);
            for (const absence of data.occupancies.filter(item => item.personId === row.personId && item.kind !== 'project' && active(item) && overlaps(item, row))) {
                const begin = Math.max(day(row.start), day(absence.start)), end = Math.min(day(row.end), day(absence.end));
                const existing = state.occupancies.filter(item => item.personId === row.personId && item.projectId === row.projectId && item.kind === 'project' && active(item))
                    .map(item => [Math.max(begin, day(item.start)), Math.min(end, day(item.end))]).filter(([start, stop]) => start <= stop);
                if (unionDays(existing) !== end - begin + 1) fail('Imported assignment includes unavailable days; record absence and use an explicit adjustment', 409);
            }
        }
        for (const row of plan.import.upserts.projects) {
            const old = state.projects.find(item => item.id === row.id);
            if (old?.lifecycle && old.lifecycle.state !== 'active' && !same(old.lifecycle, row.lifecycle)) fail('Import cannot reopen or rewrite a closed project', 409);
            if (row.lifecycle?.effectiveDate && row.lifecycle.effectiveDate < today && !same(old?.lifecycle, row.lifecycle)) fail('Use an explicit adjustment for historical project closure', 409);
        }
    }
}
function projection(state, plan) {
    const changes = plan.import.upserts ? collections.flatMap(kind => plan.import.upserts[kind].map(after => ({ kind, before: state[kind].find(row => row.id === after.id) || null, after }))) : [];
    if (plan.import.upserts && plan.import.mode === 'initialize') for (const kind of collections) for (const before of state[kind]) if (!plan.import.upserts[kind].some(row => row.id === before.id)) changes.push({ kind, before, after: null });
    const projected = structuredClone(plan); delete projected.import.upserts;
    const visible = []; let bytes = 0; for (const change of changes) { bytes += Buffer.byteLength(JSON.stringify(change)); if (visible.length >= 200 || bytes > 64000) break; visible.push(change); }
    return { ...projected, currentRevision: state.revision, stale: !state.enabled || plan.epoch !== state.epoch || plan.revision !== state.revision,
        historyCompleteChange: { before: state.historyComplete, after: plan.import.historyComplete },
        changes: visible, totalChanges: changes.length, counts: plan.import.counts || Object.fromEntries(collections.map(name => [name, plan.import.upserts[name].length])),
        warning: plan.import.mode === 'merge' && plan.import.sourceRevision < plan.revision - 1 ? '导入文件版本较旧。请核对全部差异。' : '' };
}
function commit(state, plan, action, options) {
    if (action !== 'apply-import') fail('Import requires apply-import confirmation'); check(state, plan, options);
    const counts = Object.fromEntries(collections.map(name => [name, plan.import.upserts[name].length]));
    Object.assign(state, merged(state, plan)); if (plan.import.mode === 'initialize') state.phase = 'awaiting-review';
    delete plan.import.upserts; plan.import.counts = counts; return { imported: counts };
}
module.exports = { validate, check, projection, commit, merged };
