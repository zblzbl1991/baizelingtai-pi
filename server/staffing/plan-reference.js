'use strict';
// Only native results of these host-owned tools can introduce a plan reference.
const tools = new Set(['staffing_prepare_change', 'staffing_prepare_import', 'staffing_operation_status']);
function referenceForPlan(plan) {
    if (!plan || !['assign', 'absence', 'formalize', 'adjust', 'release', 'import'].includes(plan.kind) || !/^[a-f0-9-]{36}$/.test(plan.id || '')
        || !Number.isSafeInteger(plan.revision) || plan.revision < 1 || plan.originId !== undefined && !/^[a-f0-9-]{36}$/.test(plan.originId)
        || plan.source?.kind !== undefined
        || ['cwd', 'sessionId'].some(key => typeof plan.source?.[key] !== 'string' || !plan.source[key] || plan.source[key].length > 8192)) return null;
    return { id: plan.id, originId: plan.originId || plan.id, kind: plan.kind, revision: plan.revision, source: { cwd: plan.source.cwd, sessionId: plan.source.sessionId } };
}
function referenceFromMessage(message) {
    if (message?.role !== 'toolResult' || message.isError || !tools.has(message.toolName)) return null;
    const typed = message.details?.pivaneStaffing;
    const reference = typed?.version === 2 ? referenceForPlan(typed.reference)
        : typed?.version === 1 && message.toolName !== 'staffing_operation_status' ? referenceForPlan(typed.plan) : null;
    if (message.toolName === 'staffing_prepare_change' && !['assign', 'absence', 'formalize', 'adjust', 'release'].includes(reference?.kind)
        || message.toolName === 'staffing_prepare_import' && reference?.kind !== 'import') return null;
    return reference;
}
module.exports = { referenceForPlan, referenceFromMessage };
