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
            { name: 'staffing_query', action: 'query', description: 'Query current staffing ledger and recommend a full-range available team. Recommendation does not occupy people. Returns workload order and headcount/direct-sign gaps.',
                parameters: Type.Object({ kind: Type.Literal('recommend'), project }, { additionalProperties: false }) },
            { name: 'staffing_prepare_change', action: 'prepare', description: 'Prepare an exact staffing plan card for user review. Never commits or occupies personnel. User must use the workspace card to adjust and confirm. Cross-department permission cannot be granted by a tool.',
                parameters: Type.Object({ requestId: Type.String({ maxLength: 80 }), expectedRevision: Type.Integer({ minimum: 0 }), project, personIds: Type.Array(Type.String(), { maxItems: 5000 }) }, { additionalProperties: false }) },
            { name: 'staffing_operation_status', action: 'operation', description: 'Check the original staffing operation after an uncertain outcome. Do not replay an uncertain write.',
                parameters: Type.Object({ requestId: Type.String({ maxLength: 80 }) }, { additionalProperties: false }) },
            { name: 'staffing_prepare_import', action: 'import', description: 'Prepare a source-bound difference card from an attached standard staffing XLSX. Does not update the ledger. The user confirms the exact differences in the card.',
                parameters: Type.Object({ requestId: Type.String({ maxLength: 80 }), expectedRevision: Type.Integer({ minimum: 0 }), attachmentId: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, { additionalProperties: false }) },
            { name: 'staffing_export', action: 'export', description: 'On explicit user request, export the current ledger revision to a standard XLSX and independently save it to artifacts. Report generated, available and saved phases accurately.',
                parameters: Type.Object({ requestId: Type.String({ maxLength: 80 }), expectedRevision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }) },
            { name: 'staffing_export_status', action: 'export-status', description: 'Query the original export result after an uncertain outcome. Never replay an uncertain export.',
                parameters: Type.Object({ requestId: Type.String({ maxLength: 80 }) }, { additionalProperties: false }) },
            { name: 'staffing_ledger_status', action: 'ledger-status', description: 'Read the latest ledger revision and record counts before preparing an Excel import or requesting an export.',
                parameters: Type.Object({}, { additionalProperties: false }) }
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
                return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(['prepare', 'import'].includes(definition.action) ? { details: { pivaneStaffing: { version: 1, plan: result } } } : {}) };
            } });
    });
}
