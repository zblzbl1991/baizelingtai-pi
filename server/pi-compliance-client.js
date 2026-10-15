// One managed HTTP transport. Callers retain their resource eligibility checks;
// accepted report acknowledgement intentionally relies on the server's grant.
async function complianceRequest(ctx, input, signal) {
    if(ctx.mode!=='rpc')throw new Error('合规专用会话资格无效');
    signal?.throwIfAborted();
    const origin=process.env.PI_WORKSPACE_INTERNAL_ORIGIN, url=new URL('/api/pi/compliance/tool',origin);
    if(url.origin!==origin||!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid compliance service origin');
    const sessionFile=ctx.sessionManager.getSessionFile(),sessionId=ctx.sessionManager.getSessionId();
    const response=await fetch(url,{method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.PI_WEB_NAVIGATION_TOKEN}`},body:JSON.stringify(input)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'合规操作失败');
    if(sessionFile!==ctx.sessionManager.getSessionFile()||sessionId!==ctx.sessionManager.getSessionId())throw new Error('会话已变化，请查询原操作回执');
    return result;
}
module.exports={complianceRequest};
