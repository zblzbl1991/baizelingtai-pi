import { complianceRuntime } from './pi-compliance-runtime.js';
import { ENTRY, references } from './pi-deliverables.js';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { complianceRequest } from './pi-compliance-client.js';
export async function reportRequest(ctx: any, input: any) {
    if (ctx.mode !== 'rpc' || !complianceRuntime(ctx.sessionManager, ctx.cwd, getAgentDir())) throw new Error('合规专用会话资格无效');
    return postReportRequest(ctx, input);
}
async function postReportRequest(ctx: any, input: any) {
    return complianceRequest(ctx,{...input,operation:'reports'});
}
export async function deliverReport(pi: ExtensionAPI, ctx: any, input: any) {
    const sessionId = ctx.sessionManager.getSessionId(), sessionFile = ctx.sessionManager.getSessionFile(), leaf = ctx.sessionManager.getLeafId();
    const receipt = await reportRequest(ctx, { ...input, action: 'publish' });
    if (sessionId !== ctx.sessionManager.getSessionId() || sessionFile !== ctx.sessionManager.getSessionFile() || leaf !== ctx.sessionManager.getLeafId()) throw new Error('原生分支已变化，请核对原交付');
    const reference = receipt.reference;
    if (reference?.version !== 1 || !/^[a-f0-9]{64}$/.test(reference.id) || !/^[a-f0-9]{64}$/.test(reference.manifestRevision)) throw new Error('报告交付回执无效');
    const prior = references(ctx.sessionManager.getBranch()).find((r: any) => r.id === reference.id);
    if (prior && prior.manifestRevision !== reference.manifestRevision) throw new Error('原生交付修订冲突');
    if (!prior) pi.appendEntry(ENTRY, reference);
    // An exact native reference now exists. Only the server can grant an
    // already-accepted browser operation permission to settle after disable.
    return postReportRequest(ctx, { ...input, action: 'acknowledge' });
}
