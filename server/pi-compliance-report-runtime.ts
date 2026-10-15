import { complianceRuntime } from './pi-compliance-runtime.js';
import { ENTRY, references } from './pi-deliverables.js';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
export async function reportRequest(ctx: any, input: any) {
    if (ctx.mode !== 'rpc' || !complianceRuntime(ctx.sessionManager, ctx.cwd, getAgentDir())) throw new Error('合规专用会话资格无效');
    return postReportRequest(ctx, input);
}
async function postReportRequest(ctx: any, input: any) {
    if (ctx.mode !== 'rpc') throw new Error('合规专用会话资格无效');
    const origin = process.env.PI_WORKSPACE_INTERNAL_ORIGIN!, url = new URL('/api/pi/compliance/tool', origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid compliance service origin');
    const sessionId = ctx.sessionManager.getSessionId(), sessionFile = ctx.sessionManager.getSessionFile();
    const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.PI_WEB_NAVIGATION_TOKEN}` }, body: JSON.stringify({ ...input, operation: 'reports' }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '报告操作失败');
    if (sessionId !== ctx.sessionManager.getSessionId() || sessionFile !== ctx.sessionManager.getSessionFile()) throw new Error('会话已变化，请核对原操作回执');
    return result;
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
