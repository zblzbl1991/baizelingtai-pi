import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import { complianceRuntime, isComplianceResource } from '../../../server/pi-compliance-runtime.js';
import { reportRequest, deliverReport } from '../../../server/pi-compliance-report-runtime.ts';
import { complianceRequest } from '../../../server/pi-compliance-client.js';

export default function compliance(pi: ExtensionAPI) {
    const eligible = (ctx: any) => ctx.mode === 'rpc' && Boolean(complianceRuntime(ctx.sessionManager, ctx.cwd, getAgentDir()));
    pi.on('session_start', (_event, ctx) => {
        if (!eligible(ctx)) return;
        pi.registerTool({ name: 'compliance_report', label: '合规批次报告',
            description: 'Generate fixed-revision HTML and XLSX reports, list/get generated reports, or explicitly deliver an existing report through this native session. list uses batchId and optional offset, returns up to50 opaque IDs/statuses and nextOffset; get reads details on demand. Generation is separate from delivery and independent artifact saving; never claim an unreviewed or incomplete batch passed. generate requires batchId,batchRevision,stable requestId,expectedRevision. deliver requires reportId,stable requestId,expectedRevision. After uncertainty query the original operation; do not create a replacement report or replay delivery.',
            parameters: Type.Object({ action: StringEnum(['generate', 'list', 'get', 'deliver']), batchId: Type.Optional(Type.String()), batchRevision: Type.Optional(Type.Integer({ minimum: 1 })), reportId: Type.Optional(Type.String()), requestId: Type.Optional(Type.String()), expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })), offset: Type.Optional(Type.Integer({minimum:0,maximum:500})) }),
            execute: async (_id, raw, signal, _update, context) => {
                if (!eligible(context)) throw new Error('合规专用会话资格无效'); signal?.throwIfAborted();
                const input = Object.fromEntries(Object.entries(raw).filter(([,value]) => value !== undefined));
                const result = input.action === 'deliver' ? await deliverReport(pi, context, input) : await reportRequest(context, input);
                return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { pivaneCompliance: result } };
            }
        });
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
                const input = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined && value !== null && value !== ''));
                const result = await complianceRequest(ctx,input,signal);
                return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { pivaneCompliance: result } };
            }
        });
        for (const operation of ['materials', 'checks', 'review']) {
            pi.registerTool({ name: operation === 'materials' ? 'compliance_materials' : operation === 'review' ? 'compliance_review' : 'compliance_check', label: operation === 'materials' ? '合规资料' : operation === 'review' ? '合规人工复核方案' : '合规检查',
                description: operation === 'materials'
                    ? 'Import explicitly selected files relative to this managed session cwd, or current native attachment IDs. Stable requestId and expectedRevision required for import. list returns opaque document IDs. The reviewer must confirm roles, identity and selected versions in the workbench before checking. Never set human confirmation yourself.'
                    : operation === 'review' ? 'Prepare a server-owned human review card, or query list/get/operation. Only the workbench user can confirm; never claim a proposal was applied. prepare requires batchId,batchRevision,stable requestId,expectedRevision and change: field(documentId,key,raw,location,reason) or conclusion(resultId,conclusion,reason). Date raw retains day/month precision. Cite exact source page/region or sheet/row/column and excerpt. For verified first-page upper number absence use documentNumber,raw:null,absent:true. get uses proposalId; list uses batchId and offset; operation queries original requestId after uncertainty and never replays it. Source native session is derived by server, never supplied.'
                    : 'Run the four deterministic rule groups against reviewer-selected snapshots, using the frozen configured image model only for extraction. run requires projectId, stable requestId and expectedRevision; optional budget limits pages, modelCalls and runMs. continue explicitly adds an allowance only for unstarted steps, never resends uncertain calls; pause stops scheduling after the actual current step settles. get requires batchId; evidence requires batchId and fieldId. Unknown, failed and uncertain checks are not passes. Never perform human confirmation.',
                parameters: Type.Object({ action: StringEnum(operation === 'materials' ? ['import', 'list'] : operation === 'review' ? ['prepare', 'list', 'get', 'operation'] : ['run', 'list', 'get', 'evidence', 'continue', 'pause']),
                    projectId: Type.Optional(Type.String()), batchId: Type.Optional(Type.String()), fieldId: Type.Optional(Type.String()),
                    proposalId: Type.Optional(Type.String()), batchRevision: Type.Optional(Type.Integer({minimum:1})),
                    change: Type.Optional(Type.Union([Type.Object({kind:Type.Literal('field'),documentId:Type.String(),key:StringEnum(['projectName','projectNumber','organization','year','phase','type','stage','applicability','date','documentNumber']),raw:Type.Union([Type.String(),Type.Null()]),absent:Type.Optional(Type.Boolean()),reason:Type.String(),location:Type.Object({page:Type.Optional(Type.Integer({minimum:1})),region:Type.Optional(StringEnum(['upper','body'])),sheet:Type.Optional(Type.String()),row:Type.Optional(Type.Integer({minimum:1})),column:Type.Optional(Type.Integer({minimum:1})),excerpt:Type.String()})}),Type.Object({kind:Type.Literal('conclusion'),resultId:Type.String(),conclusion:StringEnum(['passed','issue','insufficient','not-applicable']),reason:Type.String()})])),
                    requestId: Type.Optional(Type.String()), expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
                    offset: Type.Optional(Type.Integer({ minimum:0, maximum:operation === 'review' ? 2000 : 500 })),
                    budget: Type.Optional(Type.Object({ pages: Type.Integer({ minimum:1, maximum:2000 }), modelCalls: Type.Integer({ minimum:1, maximum:200 }), runMs: Type.Integer({ minimum:1000, maximum:3600000 }) })),
                    sources: Type.Optional(Type.Array(Type.Union([Type.Object({ kind: Type.Literal('file'), path: Type.String() }), Type.Object({ kind: Type.Literal('attachment'), id: Type.String() })]), { maxItems: 32 })) }),
                execute: async (_id, raw, signal, _update, ctx) => {
                    if (!eligible(ctx)) throw new Error('合规专用会话资格无效'); signal?.throwIfAborted();
                    const input = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
                    const result = await complianceRequest(ctx,{...input,operation},signal);
                    return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { pivaneCompliance: result } };
                }
            });
        }
    });
    pi.on('before_agent_start', (event, ctx) => {
        if (eligible(ctx)) return;
        pi.setActiveTools(pi.getActiveTools().filter(name => !name.startsWith('compliance_')));
        event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter(name => !name.startsWith('compliance_'));
        event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter(skill => !isComplianceResource(skill.filePath));
    });
}
