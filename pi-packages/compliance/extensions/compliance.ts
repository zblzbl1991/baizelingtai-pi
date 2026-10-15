import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import { complianceRuntime, isComplianceResource } from '../../../server/pi-compliance-runtime.js';

export default function compliance(pi: ExtensionAPI) {
    const eligible = (ctx: any) => ctx.mode === 'rpc' && Boolean(complianceRuntime(ctx.sessionManager, ctx.cwd, getAgentDir()));
    pi.on('session_start', (_event, ctx) => {
        if (!eligible(ctx)) return;
        pi.registerTool({ name: 'compliance_project', label: '工程项目档案',
            description: 'Read and maintain the engineering project archive for compliance review. list returns up to 50 project summaries, current revision and nextOffset; use offset to continue. get requires projectId and returns fields on demand. create/update require a stable requestId, expectedRevision from the latest read, and project fields. Keep unknown fields null. Ask the reviewer to verify identity and applicability; never infer confirmation from a document. Reuse the exact requestId after an uncertain result; a changed payload needs a new requestId.',
            promptSnippet: 'Read and maintain the engineering project archive for compliance review',
            parameters: Type.Object({ action: StringEnum(['list', 'get', 'create', 'update']), projectId: Type.Optional(Type.String()),
                offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 500 })),
                requestId: Type.Optional(Type.String()), expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
                project: Type.Optional(Type.Object({ name: Type.String(), number: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    organization: Type.Optional(Type.Union([Type.String(), Type.Null()])), year: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    phase: Type.Optional(Type.Union([Type.String(), Type.Null()])), type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    stage: Type.Optional(Type.Union([Type.String(), Type.Null()])), identityConfirmed: Type.Optional(Type.Boolean()),
                    applicability: Type.Optional(Type.Object(Object.fromEntries(['documents-identity', 'feasibility-numbers', 'contract-deadline', 'feasibility-order'].map(key => [key, Type.Optional(Type.Union([Type.Boolean(), Type.Null()]))]))))
                })) }),
            execute: async (_id, raw, signal, _update, ctx) => {
                if (!eligible(ctx)) throw new Error('合规能力已停用，或当前会话不是已绑定的专用助手');
                signal?.throwIfAborted();
                const origin = process.env.PI_WORKSPACE_INTERNAL_ORIGIN!, url = new URL('/api/pi/compliance/tool', origin);
                if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid compliance service origin');
                const sessionFile = ctx.sessionManager.getSessionFile(), sessionId = ctx.sessionManager.getSessionId();
                const input = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined && value !== null && value !== ''));
                const response = await fetch(url, { method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.PI_WEB_NAVIGATION_TOKEN}` }, body: JSON.stringify(input) });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || '合规操作失败');
                if (sessionId !== ctx.sessionManager.getSessionId() || sessionFile !== ctx.sessionManager.getSessionFile()) throw new Error('合规会话已变化，请查询原操作回执');
                return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { pivaneCompliance: result } };
            }
        });
    });
    pi.on('before_agent_start', (event, ctx) => {
        if (eligible(ctx)) return;
        pi.setActiveTools(pi.getActiveTools().filter(name => !name.startsWith('compliance_')));
        event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter(name => !name.startsWith('compliance_'));
        event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter(skill => !isComplianceResource(skill.filePath));
    });
}
