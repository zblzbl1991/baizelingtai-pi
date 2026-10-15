'use strict';
const { referenceForPlan } = require('./plan-reference');
const MAX_TOOL_TEXT = 64 * 1024, MAX_CARD_DETAILS = 64 * 1024;
function coverage(value) {
    if (!value) return undefined;
    return { satisfied: value.satisfied, allConfirmed: value.allConfirmed, segmentCount: value.segments?.length || 0,
        missing: Math.max(0, ...(value.segments || []).map(segment => segment.missing)), missingDirect: (value.segments || []).some(segment => segment.missingDirect) };
}
function planSummary(plan) {
    return { id: plan.id, kind: plan.kind, revision: plan.revision, project: plan.project,
        ...(plan.kind === 'assign' ? { selectedCount: plan.personIds?.length, existingTeamCount: plan.existingTeam ? new Set(plan.existingTeam.map(row => row.personId)).size : undefined }
            : { affectedPersonCount: plan.personIds?.length, change: plan.change }),
        coverage: coverage(plan.coverage), affectedProjectCount: plan.affectedProjects?.length,
        counts: plan.counts, totalChanges: plan.totalChanges, stale: plan.stale, warning: plan.warning,
        previewsOmitted: true, review: 'workspace-card' };
}
function operationSummary(result) {
    return { revision: result.revision, planId: result.planId, action: result.action, counts: result.counts, imported: result.imported,
        coverage: coverage(result.coverage), affectedProjectCount: result.affectedProjects?.length, previewsOmitted: true };
}
function toolResult(action, result) {
    const reference = ['prepare', 'import'].includes(action) ? referenceForPlan(result)
        : action === 'operation' && result.state === 'completed' ? referenceForPlan(result.reference) : null;
    let summary = result;
    if (action === 'query') summary = { revision: result.revision, project: result.project,
        selected: result.selected.map(person => ({ id: person.id, direct: person.direct, workDays: person.workDays })), selectedCount: result.selected.length,
        existingTeam: result.existingTeam.map(row => ({ id: row.id, personId: row.personId, start: row.start, end: row.end, state: row.state })),
        existingTeamCount: new Set(result.existingTeam.map(row => row.personId)).size, additionalNeeded: result.additionalNeeded,
        candidates: result.candidates.slice(0, 20), totalCandidates: result.totalCandidates,
        missing: result.missing, missingDirect: result.missingDirect, historyComplete: result.historyComplete, warning: result.warning, previewsOmitted: true };
    else if (['prepare', 'import'].includes(action)) summary = planSummary(result);
    else if (action === 'operation' && result.state === 'completed') summary = { state: result.state,
        result: reference ? planSummary(result.result) : operationSummary(result.result) };
    const text = JSON.stringify(summary);
    if (Buffer.byteLength(text, 'utf8') > MAX_TOOL_TEXT) throw new Error('Staffing result exceeds the 64 KiB tool text budget. No complete team was returned. Review a smaller scope in the staffing workspace.');
    if (['prepare', 'import'].includes(action) && !reference) throw new Error('Staffing service returned no verified plan reference. Query the original operation; do not replay preparation.');
    const details = reference ? { pivaneStaffing: { version: 2, reference } } : undefined;
    if (details && Buffer.byteLength(JSON.stringify(details), 'utf8') > MAX_CARD_DETAILS) throw new Error('Staffing card reference exceeds its metadata budget. Query the original operation; do not replay preparation.');
    return { content: [{ type: 'text', text }], ...(details ? { details } : {}) };
}
module.exports = { toolResult };
