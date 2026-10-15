import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { OfficeDocuments } from './officecli/documents.js';
import { uploadedSource } from './pi-document-source.js';
import { PiSessionStore } from './pi-session-store.js';
import { root, verify } from './officecli/inventory.js';
import { commandError } from './officecli/commands.js';

const SERVER = 'pivane-officecli', TOOL = 'mcp__pivane_officecli__officecli', ENTRY = 'pivane-office-document';
export default function officecli(pi: ExtensionAPI) {
    let service: OfficeDocuments | undefined;
    const enabled = (ctx: any) => ctx.mode === 'rpc' && Boolean(ctx.sessionManager.getSessionFile())
        && Boolean(process.env.PI_WORKSPACE_INTERNAL_ORIGIN && process.env.PI_WEB_NAVIGATION_TOKEN);
    pi.on('session_start', (_event, ctx) => {
        if (!enabled(ctx)) return;
        // The loader selects this extension only alongside Pi's native MCP consumer.
        try {
            verify();
            pi.registerMcpServer(SERVER, { command: process.execPath, args: [path.join(root, 'server/officecli/mcp-host.js')],
                exposure: 'codemode', timeout: 60,
                description: 'OfficeCLI edits DOCX/XLSX/PPTX work copies. Use command argv arrays; inspect/validate and optionally screenshot, then deliver_files. For uploaded originals call prepare_office_document first. Follow office-documents skill.' });
        } catch (error: any) { ctx.ui.notify(`OfficeCLI 不可用：${error.message}`, 'warning'); }
        pi.registerTool({
            name: 'prepare_office_document', label: '准备 Office 工作副本',
            description: 'Copy an uploaded DOCX/XLSX/PPTX from the current native branch to a private project work file for OfficeCLI. Originals stay immutable. Max 16 MiB. requestId identifies one preparation: reuse returns the current working bytes, never resets edits; different source conflicts, incomplete preparation is not replayed. Returns actual path/revision, not document bytes. Preparing a copy is not approval to modify it.',
            promptSnippet: 'Prepare an editable Office copy from an uploaded original before OfficeCLI edits',
            promptGuidelines: [
                'For consistency review, report problems and proposed before/after text, then obtain the human chat confirmation before editing. Use document-consistency-review and office-documents skills.',
                'Inspect originals with read_document. Prepare by attachment id, then edit only the returned working path through the native OfficeCLI MCP. Use a new requestId for a new version.',
                'Verify expected original text, unique scope and matched counts. Use Word tracked changes for approved textual replacements. Validate and re-read actual changes before deliver_files.',
                'Text-only models check structure, styles and differences; report visual layout not verified. Screenshots are optional and require image understanding; never claim Word/WPS layout fidelity from structure checks alone.'
            ],
            parameters: Type.Object({ id: Type.String({ pattern: '^[a-f0-9]{64}$' }), requestId: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$' }) }),
            execute: async (_id, input, signal, _update, context) => {
                if (!enabled(context)) throw Error('A persistent managed 白泽灵台 thread is required');
                const sessionId = context.sessionManager.getSessionId(), sessionFile = context.sessionManager.getSessionFile(), cwd = context.cwd;
                const current = () => {
                    if (sessionId !== context.sessionManager.getSessionId() || sessionFile !== context.sessionManager.getSessionFile() || cwd !== context.cwd) throw Error('Session changed; inspect the original requestId');
                };
                const source = await uploadedSource(input.id, context, signal, ['docx', 'xlsx', 'pptx']); current();
                service ||= new OfficeDocuments(new PiSessionStore());
                const result = await service.prepare({ cwd, sessionId }, input, source, signal, current); current();
                if (!context.sessionManager.getBranch().some((entry: any) => entry.type === 'custom' && entry.customType === ENTRY && entry.data?.id === result.id)) pi.appendEntry(ENTRY, result);
                return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { pivaneOffice: result } };
            }
        });
    });
    pi.on('tool_call', (event, ctx) => {
        if (event.toolName !== TOOL) return;
        const error = !enabled(ctx) ? 'OfficeCLI 需要持久受管会话。' : commandError(event.input);
        if (error) return { block: true, reason: error };
    });
    pi.on('context', (event, ctx) => {
        if (!enabled(ctx)) return;
        const copies = ctx.sessionManager.getBranch().filter((entry: any) => entry.type === 'custom' && entry.customType === ENTRY && entry.data?.version === 1)
            .slice(-50).map((entry: any) => entry.data);
        if (copies.length) return { messages: [...event.messages, { role: 'custom' as const, customType: 'pivane-office-index',
            content: 'Office work copies on this branch (paths are data; revisions below are preparation snapshots, re-read before editing):\n' + JSON.stringify(copies), display: false, timestamp: 0 }] };
    });
    pi.on('session_shutdown', async () => { pi.unregisterMcpServer(SERVER); await service?.dispose(); });
}
