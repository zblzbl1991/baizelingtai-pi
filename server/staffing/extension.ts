import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { runtimeScope } from './runtime-scope.js';

export default async function (pi: ExtensionAPI) {
    const project = Type.Object({ id: Type.String(), name: Type.String(), owner: Type.String(), department: Type.String(), start: Type.String(), end: Type.String(), minimum: Type.Integer({ minimum: 1, maximum: 5000 }) }, { additionalProperties: false });
    let initialized = false;
    pi.on('session_start', async (_event, ctx) => {
        if (initialized || ctx.mode !== 'rpc') return;
        const initial = await runtimeScope({ sessionManager: ctx.sessionManager, cwd: ctx.cwd, agentDir: getAgentDir() });
        if (!initial.eligible) return;
        initialized = true;
        ctx.ui.notify(JSON.stringify({ pivaneStaffingLoaded: initial.epoch, sessionId: ctx.sessionManager.getSessionId() }));
        const definitions = [
            { name: 'staffing_query', action: 'query', description: 'Query current staffing ledger and recommend full-range available additions for the remaining headcount and direct-sign gaps. existingTeam is already assigned; selected contains only new additions. Recommendation does not occupy people. Returns workload order and headcount/direct-sign gaps.',
                parameters: Type.Object({ kind: Type.Literal('recommend'), project }, { additionalProperties: false }) },
            { name: 'staffing_prepare_change', action: 'prepare', description: 'Prepare an exact assignment, absence, formal confirmation, future replacement, date adjustment or release card for user review. For an existing project use only recommended new additions. formalize changes existing reserved records without adding people. Never commits or occupies personnel. User must use the workspace card to adjust and confirm. Cross-department permission cannot be granted by a tool.',
                parameters: Type.Union([
                    Type.Object({ requestId: Type.String({ maxLength: 80 }), expectedRevision: Type.Integer({ minimum: 0 }), project, personIds: Type.Array(Type.String(), { maxItems: 5000 }) }, { additionalProperties: false }),
                    Type.Object({ requestId: Type.String({ maxLength: 80 }), expectedRevision: Type.Integer({ minimum: 0 }), kind: Type.Literal('absence'), personId: Type.String(), absenceKind: Type.Union([Type.Literal('leave'), Type.Literal('training'), Type.Literal('unavailable')]), start: Type.String(), end: Type.String(), reason: Type.String() }, { additionalProperties: false }),
                    Type.Object({ requestId: Type.String({ maxLength: 80 }), expectedRevision: Type.Integer({ minimum: 0 }), kind: Type.Literal('formalize'), projectId: Type.String(), occupancyIds: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
                    Type.Object({ requestId: Type.String({ maxLength: 80 }), expectedRevision: Type.Integer({ minimum: 0 }), kind: Type.Literal('replace'), projectId: Type.String(), occupancyId: Type.String(), replacementPersonId: Type.String(), start: Type.String(), end: Type.String(), reason: Type.String() }, { additionalProperties: false }),
                    Type.Object({ requestId: Type.String({ maxLength: 80 }), expectedRevision: Type.Integer({ minimum: 0 }), kind: Type.Literal('release'), releaseKind: Type.Union([Type.Literal('withdraw'), Type.Literal('cancel'), Type.Literal('early-end')]), projectId: Type.String(), occupancyId: Type.Optional(Type.String()), effectiveDate: Type.String(), reason: Type.String() }, { additionalProperties: false }),
                    Type.Object({ requestId: Type.String({ maxLength: 80 }), expectedRevision: Type.Integer({ minimum: 0 }), kind: Type.Union([Type.Literal('reschedule'), Type.Literal('extend')]), projectId: Type.String(), start: Type.Optional(Type.String()), end: Type.String(), reason: Type.String() }, { additionalProperties: false })
                ]) },
            { name: 'staffing_operation_status', action: 'operation', description: 'Check the original staffing operation after an uncertain outcome. Do not replay an uncertain write.',
                parameters: Type.Object({ requestId: Type.String({ maxLength: 80 }) }, { additionalProperties: false }) }
        ];
        for (const definition of definitions) pi.registerTool({ name: definition.name, label: definition.name, description: definition.description,
            parameters: definition.parameters,
            execute: async (_id, raw, signal, _update, context) => {
                const scope = await runtimeScope({ sessionManager: context.sessionManager, cwd: context.cwd, agentDir: getAgentDir() });
                if (!scope.eligible || scope.epoch !== initial.epoch || JSON.stringify(scope.source) !== JSON.stringify(initial.source)) throw new Error('Dedicated staffing resources require reload');
                signal?.throwIfAborted();
                const origin = process.env.PI_WORKSPACE_INTERNAL_ORIGIN!, url = new URL('/api/pi/staffing/agent/' + definition.action, origin);
                if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid staffing service origin');
                const response = await fetch(url, { method: 'POST', redirect: 'error', signal,
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.PI_WEB_NAVIGATION_TOKEN}` }, body: JSON.stringify(raw) });
                const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Staffing request failed');
                return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(definition.action === 'prepare' ? { details: { pivaneStaffing: { version: 1, plan: result } } } : {}) };
            } });
    });
}
