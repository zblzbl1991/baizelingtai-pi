'use strict';
const { createHash } = require('node:crypto');
const { StaffingStore } = require('./store');
const { fail, keys, id, LIMITS, validateInitial } = require('./validation');
const BINDING_KEY = 'pivane-staffing:v1';
const PROFILE = Object.freeze({ name: '人员调配', description: '查询人员台账，准备人员安排，并由用户确认具体变更。',
    soul: '你是人员调配助手。使用最新台账查询人员。说明安排缺口。推荐不占用人员。具体变更由用户通过安排卡片确认。不得用聊天记忆判断人员空闲。',
    enabled: true, memory: { enabled: false, autoLearn: false }, skills: { learnedEnabled: false } });
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const summary = state => ({ enabled: state.enabled, state: state.enabled ? state.phase : 'disabled',
    revision: state.revision, initialized: state.initialized, profileId: state.profileId, historyComplete: state.historyComplete,
    initialization: state.initializingRequestId ? { requestId: state.initializingRequestId,
        expectedRevision: state.operations[state.initializingRequestId]?.input?.expectedRevision } : null,
    counts: { people: state.people.length, projects: state.projects.length, occupancies: state.occupancies.length }, limits: LIMITS });

class StaffingService {
    constructor({ profiles, store = new StaffingStore(), isSuspended = () => false } = {}) {
        this.profiles = profiles; this.store = store; this.isSuspended = isSuspended;
        this.busy = false; this.stopping = false; this.pending = null;
    }
    reserve(action) {
        if (this.busy || this.stopping || this.isSuspended()) fail('Staffing is busy, under maintenance or stopping', 409);
        this.busy = true;
        const pending = Promise.resolve().then(action); this.pending = pending;
        return pending.finally(() => { if (this.pending === pending) this.pending = null; this.busy = false; });
    }
    async dispose() { this.stopping = true; if (this.pending) await this.pending.catch(() => {}); }
    async status() { return summary(await this.store.snapshot()); }
    async ledger() {
        const state = await this.store.snapshot();
        if (!state.enabled) fail('Staffing capability is disabled', 409);
        return { ...summary(state), people: state.people, projects: state.projects, occupancies: state.occupancies };
    }
    async operation(requestId) {
        if (!id(requestId)) fail('Invalid staffing request ID');
        const state = await this.store.snapshot(), op = Object.hasOwn(state.operations, requestId) ? state.operations[requestId] : null;
        return op ? op.state === 'completed' ? { state: 'completed', result: op.result } : { state: 'pending', noReplay: true }
            : { state: 'unknown', noReplay: true };
    }
    validateRequest(input, fields = []) {
        keys(input, ['requestId', 'expectedRevision', ...fields]);
        if (!id(input.requestId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('Request ID and expected revision are required');
    }
    receipt(state, input, action) {
        const hash = digest({ action, input });
        if (Object.hasOwn(state.operations, input.requestId)) {
            const op = state.operations[input.requestId];
            if (op.digest !== hash) fail('Staffing request ID was used with different parameters', 409);
            return op;
        }
        return null;
    }
    async mutate(input, action, update, pending = false) {
        const state = await this.store.snapshot(), previous = this.receipt(state, input, action);
        if (previous?.state === 'completed') return previous.result;
        if (previous?.state === 'pending') return summary(state);
        return this.store.mutate(input.expectedRevision, next => {
            if (Object.keys(next.operations).length >= LIMITS.operations || next.history.length >= LIMITS.history) fail('Staffing history or operation limit reached; export and arrange retention before continuing', 413);
            update(next);
            const result = summary({ ...next, revision: next.revision + 1 });
            next.operations[input.requestId] = { digest: digest({ action, input }), state: pending ? 'pending' : 'completed', ...(pending ? { input } : { result }) };
            next.history.push({ requestId: input.requestId, action, at: new Date().toISOString() });
            return result;
        });
    }
    async enable(input) {
        this.validateRequest(input);
        input = structuredClone(input);
        return this.reserve(async () => {
            const before = await this.store.snapshot(), receipt = this.receipt(before, input, 'enable');
            if (receipt?.state === 'completed') return receipt.result;
            if (before.phase === 'initializing' && before.initializingRequestId !== input.requestId) fail('Resume the original initialization operation', 409);
            if (before.profileId) return this.mutate(input, 'enable', next => { next.enabled = true; });
            const started = await this.mutate(input, 'enable', next => {
                next.enabled = true; next.phase = 'initializing'; next.initializingRequestId = input.requestId;
            }, true);
            const { profile } = await this.profiles.ensureManagedProfile(BINDING_KEY, PROFILE);
            return this.store.mutate(started.revision, next => {
                if (next.initializingRequestId !== input.requestId || !next.enabled) fail('Staffing initialization changed', 409);
                next.profileId = profile.id; next.phase = 'awaiting-import'; next.initializingRequestId = null;
                const result = summary({ ...next, revision: next.revision + 1 });
                next.operations[input.requestId] = { ...next.operations[input.requestId], state: 'completed', result };
                return result;
            });
        });
    }
    async initialize(input) {
        this.validateRequest(input, ['people', 'projects', 'occupancies', 'historyComplete']);
        input = structuredClone(input);
        const data = { people: input.people, projects: input.projects, occupancies: input.occupancies, historyComplete: input.historyComplete };
        validateInitial(data);
        return this.reserve(() => this.mutate(input, 'initialize', next => {
            if (!next.enabled || !next.profileId || next.initialized || !['awaiting-import', 'awaiting-review'].includes(next.phase)) fail('Staffing is not awaiting initial data', 409);
            Object.assign(next, structuredClone(data), { phase: 'awaiting-review' });
        }));
    }
    async confirmInitial(input) {
        this.validateRequest(input, ['reviewed']);
        input = structuredClone(input);
        if (input.reviewed !== true) fail('Explicit initial ledger review is required');
        return this.reserve(() => this.mutate(input, 'confirm-initial', next => {
            if (!next.enabled || next.phase !== 'awaiting-review') fail('Staffing is not awaiting review', 409);
            next.initialized = true; next.phase = 'ready';
        }));
    }
    async disable(input) {
        this.validateRequest(input);
        input = structuredClone(input);
        return this.reserve(() => this.mutate(input, 'disable', next => {
            if (next.phase === 'initializing') fail('Finish the original initialization before disabling', 409);
            next.enabled = false;
        }));
    }
    async requireReady() {
        const state = await this.store.snapshot();
        if (!state.enabled || !state.initialized || state.phase !== 'ready') fail('Staffing requires enablement and initial ledger review', 409);
        return state;
    }
}
module.exports = { StaffingService, BINDING_KEY };
