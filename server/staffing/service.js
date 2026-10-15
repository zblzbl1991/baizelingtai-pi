'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { StaffingStore } = require('./store');
const { fail, keys, id, LIMITS, validateInitial } = require('./validation');
const rules = require('./rules');
const adjustments = require('./adjustments');
const viewProjection = require('./views');
const { referenceForPlan } = require('./plan-reference');
const localToday = () => { const now = new Date(); return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-'); };
const BINDING_KEY = 'pivane-staffing:v1';
const PROFILE = Object.freeze({ name: '人员调配', description: '查询人员台账，准备人员安排，并由用户确认具体变更。',
    soul: '你是人员调配助手。使用最新台账查询人员。说明安排缺口。推荐不占用人员。具体变更由用户通过安排卡片确认。不得用聊天记忆判断人员空闲。',
    enabled: true, memory: { enabled: false, autoLearn: false }, skills: { learnedEnabled: false } });
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const stableSource = source => source && (source.kind === 'page' ? { kind: 'page', profileId: source.profileId } : { sessionId: source.sessionId, sessionPath: source.sessionPath, cwd: source.cwd, profileId: source.profileId });
const summary = state => ({ enabled: state.enabled, state: state.enabled ? state.phase : 'disabled',
    revision: state.revision, epoch: state.epoch, initialized: state.initialized, profileId: state.profileId, historyComplete: state.historyComplete,
    initialization: state.initializingRequestId ? { requestId: state.initializingRequestId,
        expectedRevision: state.operations[state.initializingRequestId]?.input?.expectedRevision } : null,
    counts: { people: state.people.length, projects: state.projects.length, occupancies: state.occupancies.length }, limits: LIMITS });

class StaffingService {
    constructor({ profiles, store = new StaffingStore(), isSuspended = () => false, today = localToday, imports = null } = {}) {
        this.profiles = profiles; this.store = store; this.isSuspended = isSuspended; this.today = today; this.imports = imports;
        this.busy = false; this.stopping = false; this.pending = null;
    }
    reserve(action) {
        if (this.busy || this.stopping || this.isSuspended()) fail('Staffing is busy, under maintenance or stopping', 409);
        this.busy = true;
        const pending = Promise.resolve().then(action); this.pending = pending;
        return pending.finally(() => { if (this.pending === pending) this.pending = null; this.busy = false; });
    }
    async dispose() { this.stopping = true; if (this.pending) await this.pending.catch(() => {}); }
    async status() { return { ...summary(await this.store.snapshot()), today: this.today() }; }
    async ledger() {
        const state = await this.store.snapshot();
        if (!state.enabled) fail('Staffing capability is disabled', 409);
        return { ...summary(state), today: this.today(), people: state.people, projects: state.projects, occupancies: state.occupancies };
    }
    async operation(requestId) {
        if (!id(requestId)) fail('Invalid staffing request ID');
        const state = await this.store.snapshot(), op = Object.hasOwn(state.operations, requestId) ? state.operations[requestId] : null;
        return op ? op.state === 'completed' ? { state: 'completed', result: op.result } : { state: 'pending', noReplay: true }
            : { state: 'unknown', noReplay: true };
    }
    async operationForSource(requestId, source) {
        if (!id(requestId)) fail('Invalid staffing request ID');
        const state = await this.requireSource(source), op = Object.hasOwn(state.operations, requestId) ? state.operations[requestId] : null;
        if (op && canonical(op.source) !== canonical(stableSource(source))) fail('Staffing operation source does not match', 403);
        const result = op ? op.state === 'completed' ? { state: 'completed', result: op.result } : { state: 'pending', noReplay: true }
            : { state: 'unknown', noReplay: true };
        const plan = op?.state === 'completed' && state.plans[op.result?.id];
        if (plan && canonical(plan.source) === canonical(stableSource(source))) {
            const reference = referenceForPlan(plan); if (reference) result.reference = reference;
        }
        return result;
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
            next.enabled = false; next.epoch++;
        }));
    }
    async requireReady() {
        const state = await this.store.snapshot();
        if (!state.enabled || !state.initialized || state.phase !== 'ready') fail('Staffing requires enablement and initial ledger review', 409);
        return state;
    }
    async pageSource({ phase = 'ready' } = {}) {
        const state = phase === 'initial' ? await this.store.snapshot() : await this.requireReady();
        if (!state.enabled || !state.profileId || phase === 'initial' && !['awaiting-import', 'awaiting-review', 'ready'].includes(state.phase)) fail('Staffing requires enablement', 409);
        return { kind: 'page', profileId: state.profileId };
    }
    async requireSource(source, { phase = 'ready' } = {}) {
        const state = phase === 'initial' ? await this.store.snapshot() : await this.requireReady();
        if (!state.enabled || phase === 'initial' && !['awaiting-import', 'awaiting-review', 'ready'].includes(state.phase)) fail('Staffing requires enablement', 409);
        if (source?.kind === 'page') {
            if (source.profileId !== state.profileId || Object.keys(source).some(key => !['kind', 'profileId'].includes(key))) fail('Invalid staffing page source', 403);
            return state;
        }
        if (!source || source.kind !== undefined || source.profileId !== state.profileId || ['sessionId', 'sessionPath', 'cwd'].some(key => typeof source[key] !== 'string' || !source[key] || source[key].length > 8192)
            || source.nativePlanIds !== undefined && (!Array.isArray(source.nativePlanIds) || source.nativePlanIds.some(value => !id(value)))) fail('Verified dedicated staffing session is required', 403);
        return state;
    }
    async views(input) { return viewProjection.project(await this.requireReady(), structuredClone(input)); }
    async prepareAdjustment(input, source) {
        input = structuredClone(input); source = structuredClone(source);
        this.validateRequest(input, [...adjustments.fields, 'allowCrossDepartment']);
        if (input.allowCrossDepartment !== undefined && (source?.kind !== 'page' || typeof input.allowCrossDepartment !== 'boolean' || input.kind !== 'replace')) fail('Cross-department permission requires the workspace page and current replacement plan', 403);
        return this.planMutation(input, 'prepare-adjustment', source, next => {
            if (Object.keys(next.plans).length >= LIMITS.operations) fail('Staffing plan limit reached', 413);
            const { allowCrossDepartment, ...changeInput } = input;
            const plan = { ...adjustments.build(next, changeInput, this.today()), id: randomUUID(), source: stableSource(source), epoch: next.epoch, revision: next.revision + 1, crossDepartment: input.allowCrossDepartment === true };
            plan.originId = plan.id; this.checkPlan(next, plan); next.plans[plan.id] = plan;
            return this.planProjection({ ...next, revision: next.revision + 1 }, plan);
        });
    }
    async prepareImport(input, source) {
        if (!this.imports) fail('Staffing import is unavailable', 503);
        return this.imports.prepare(this, structuredClone(input), structuredClone(source));
    }
    validateProject(project) {
        validateInitial({ people: [], projects: [project], occupancies: [], historyComplete: false });
    }
    async query(input, source) {
        input = structuredClone(input);
        keys(input, ['kind', 'project']);
        if (input.kind !== 'recommend') fail('Unknown staffing query');
        this.validateProject(input.project);
        const state = await this.requireSource(source), available = rules.candidates(state, input.project);
        const currentCoverage = rules.coverage(state, input.project);
        const existingTeam = state.occupancies.filter(row => row.projectId === input.project.id && row.kind === 'project' && rules.active(row));
        const needsDirect = currentCoverage.segments.some(row => row.missingDirect);
        const additionalNeeded = Math.max(needsDirect ? 1 : 0, ...currentCoverage.segments.map(row => row.missing));
        const direct = needsDirect && available.find(person => person.direct), selected = direct ? [direct] : [];
        for (const person of available) if (selected.length < additionalNeeded && !selected.includes(person)) selected.push(person);
        const proposed = { ...state, occupancies: [...state.occupancies, ...selected.map(person => ({ personId: person.id, projectId: input.project.id, kind: 'project', state: 'reserved', start: input.project.start, end: input.project.end }))] };
        const projectedCoverage = rules.coverage(proposed, input.project);
        return { revision: state.revision, project: input.project, candidates: available.slice(0, 200), totalCandidates: available.length,
            existingTeam, currentCoverage, additionalNeeded, selected, missing: Math.max(0, ...projectedCoverage.segments.map(row => row.missing)), missingDirect: projectedCoverage.segments.some(row => row.missingDirect),
            historyComplete: state.historyComplete, warning: state.historyComplete ? '' : '按已录入记录排序，历史不完整' };
    }
    planProjection(state, plan) {
        if (plan.kind === 'import') return this.imports.projection(state, plan, { today: this.today() });
        if (plan.kind !== 'assign') return adjustments.projection(state, plan);
        const people = plan.personIds.map(id => state.people.find(person => person.id === id));
        const proposed = { ...state, occupancies: [...state.occupancies, ...plan.personIds.map(personId => ({ personId, projectId: plan.project.id,
            kind: 'project', state: 'reserved', start: plan.project.start, end: plan.project.end }))] };
        return { ...structuredClone(plan), people, existingTeam: state.occupancies.filter(o => o.projectId === plan.project.id && o.kind === 'project' && rules.active(o)), candidates: rules.candidates(state, plan.project, plan.crossDepartment).slice(0, 200),
            coverage: plan.outcome?.coverage || rules.coverage(proposed, plan.project), currentRevision: state.revision,
            stale: !state.enabled || plan.epoch !== state.epoch || plan.revision !== state.revision,
            warning: state.historyComplete ? '' : '按已录入记录排序，历史不完整' };
    }
    async plan(planId, source) {
        if (!id(planId)) fail('Invalid staffing plan ID');
        const state = await this.requireSource(source, { phase: source?.kind === 'page' ? 'initial' : 'ready' }); let plan = state.plans[planId], hops = 0;
        while (plan?.supersededBy && hops++ < LIMITS.operations) plan = state.plans[plan.supersededBy];
        this.checkAuthority(state, plan, source);
        return this.planProjection(state, plan);
    }
    checkAuthority(state, plan, source) {
        if (!plan || canonical(plan.source) !== canonical(stableSource(source))) fail('Staffing plan source does not match', 403);
        if (source.nativePlanIds && !source.nativePlanIds.includes(plan.originId || plan.id)) fail('Staffing plan is not referenced on the current native branch', 403);
    }
    checkPlan(state, plan) {
        if (plan.kind === 'import') return this.imports.check(state, plan, { today: this.today() });
        if (plan.kind !== 'assign') return adjustments.check(state, plan, { today: this.today() });
        if (plan.project.lifecycle && plan.project.lifecycle.state !== 'active') fail('Closed projects do not accept new assignments', 409);
        const existing = state.projects.find(project => project.id === plan.project.id);
        if (existing && canonical(existing) !== canonical(plan.project)) fail('Project definition changed; prepare a project adjustment', 409);
        const available = new Set(rules.candidates(state, plan.project, plan.crossDepartment).map(person => person.id));
        if (plan.personIds.some(personId => !available.has(personId))) fail('Staffing person is unavailable or outside the allowed department', 409);
    }
    async planMutation(input, action, source, change, options = {}) {
        input = structuredClone(input); source = structuredClone(source);
        return this.reserve(async () => {
            const state = await this.requireSource(source, options), authorizedInput = { ...input, source: stableSource(source) }, previous = this.receipt(state, authorizedInput, action);
            if (previous?.state === 'completed') return previous.result;
            const prepared = options.preflight ? structuredClone(await options.preflight(state)) : undefined;
            return this.store.mutate(input.expectedRevision, next => {
                if (Object.keys(next.operations).length >= LIMITS.operations || next.history.length >= LIMITS.history) fail('Staffing history or operation limit reached', 413);
                const before = { people: structuredClone(next.people), projects: structuredClone(next.projects), occupancies: structuredClone(next.occupancies) };
                const result = change(next, prepared);
                next.operations[input.requestId] = { digest: digest({ action, input: authorizedInput }), source: stableSource(source), state: 'completed', result };
                const after = {};
                for (const field of ['people', 'projects', 'occupancies']) {
                    const old = new Map(before[field].map(row => [row.id, row])), current = new Map(next[field].map(row => [row.id, row]));
                    const changed = new Set([...old.keys(), ...current.keys()].filter(key => canonical(old.get(key)) !== canonical(current.get(key))));
                    before[field] = before[field].filter(row => changed.has(row.id)); after[field] = next[field].filter(row => changed.has(row.id)).map(row => structuredClone(row));
                }
                next.history.push({ requestId: input.requestId, action, at: new Date().toISOString(), planId: result.id || result.planId, before, after });
                return result;
            });
        });
    }
    async prepareChange(input, source) {
        input = structuredClone(input); source = structuredClone(source);
        this.validateRequest(input, ['project', 'personIds']); this.validateProject(input.project);
        if (!Array.isArray(input.personIds) || input.personIds.length > LIMITS.people || input.personIds.some(value => !id(value)) || new Set(input.personIds).size !== input.personIds.length) fail('Invalid staffing person IDs');
        return this.planMutation(input, 'prepare-assign', source, next => {
            if (Object.keys(next.plans).length >= LIMITS.operations) fail('Staffing plan limit reached', 413);
            const plan = { id: randomUUID(), kind: 'assign', project: structuredClone(input.project), personIds: [...input.personIds],
                source: stableSource(source), epoch: next.epoch, revision: next.revision + 1, crossDepartment: false };
            plan.originId = plan.id;
            this.checkPlan(next, plan); next.plans[plan.id] = plan;
            return this.planProjection({ ...next, revision: next.revision + 1 }, plan);
        });
    }
    async revisePlan(input, source) {
        input = structuredClone(input); source = structuredClone(source);
        this.validateRequest(input, ['planId', 'personIds', 'allowCrossDepartment']);
        if (!id(input.planId) || !Array.isArray(input.personIds) || input.personIds.length > LIMITS.people
            || input.personIds.some(value => !id(value)) || new Set(input.personIds).size !== input.personIds.length
            || typeof input.allowCrossDepartment !== 'boolean') fail('Invalid staffing plan adjustment');
        return this.planMutation(input, 'revise-plan', source, next => {
            const old = next.plans[input.planId];
            this.checkAuthority(next, old, source);
            if (old.kind !== 'assign') fail('Prepare a new adjustment to change this plan', 409);
            if (old.epoch !== next.epoch || old.revision !== next.revision) fail('Staffing plan changed; inspect a new plan', 409);
            if (Object.keys(next.plans).length >= LIMITS.operations) fail('Staffing plan limit reached', 413);
            const plan = { ...old, id: randomUUID(), personIds: [...input.personIds], crossDepartment: input.allowCrossDepartment, revision: next.revision + 1 };
            this.checkPlan(next, plan); old.supersededBy = plan.id; next.plans[plan.id] = plan;
            return this.planProjection({ ...next, revision: next.revision + 1 }, plan);
        });
    }
    async commitPlan(input, source) {
        input = structuredClone(input); source = structuredClone(source);
        this.validateRequest(input, ['planId', 'action']);
        if (!id(input.planId) || !['reserve', 'confirm', 'apply', 'apply-import'].includes(input.action)) fail('Invalid staffing plan confirmation');
        return this.planMutation(input, 'commit-plan', source, next => {
            const plan = next.plans[input.planId];
            this.checkAuthority(next, plan, source);
            if (plan.epoch !== next.epoch || plan.revision !== next.revision) fail('Staffing plan changed; inspect a new plan', 409);
            this.checkPlan(next, plan);
            if (plan.kind !== 'assign') {
                let imported;
                if (plan.kind === 'import') imported = this.imports.commit(next, plan, input.action, { today: this.today() });
                else { if (input.action !== 'apply') fail('Adjustment requires apply confirmation'); adjustments.apply(next, plan.patch); }
                const result = { ...summary({ ...next, revision: next.revision + 1 }), planId: plan.id, action: input.action, ...(imported || {}), ...(plan.project ? { coverage: rules.coverage(next, next.projects.find(row => row.id === plan.project.id)) } : {}), affectedProjects: adjustments.affected(next, plan) };
                plan.outcome = result; return result;
            }
            if (!['reserve', 'confirm'].includes(input.action)) fail('Assignment requires reserve or confirm');
            if (!next.projects.some(project => project.id === plan.project.id)) next.projects.push(structuredClone(plan.project));
            for (const personId of plan.personIds) next.occupancies.push({ id: randomUUID(), personId, projectId: plan.project.id, kind: 'project',
                start: plan.project.start, end: plan.project.end, state: input.action === 'reserve' ? 'reserved' : 'confirmed' });
            const result = { ...summary({ ...next, revision: next.revision + 1 }), planId: plan.id, action: input.action, coverage: rules.coverage(next, plan.project) };
            plan.outcome = result; return result;
        }, { phase: source?.kind === 'page' ? 'initial' : 'ready', preflight: async state => {
            const plan = state.plans[input.planId]; this.checkAuthority(state, plan, source);
            if (plan.kind === 'import') return this.imports.preflight?.(state, plan, source);
            if (!state.initialized || state.phase !== 'ready') fail('Staffing requires initial ledger review', 409);
        } });
    }
}
module.exports = { StaffingService, BINDING_KEY };
