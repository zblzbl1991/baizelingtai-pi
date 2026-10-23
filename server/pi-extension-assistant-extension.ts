import { setPromptSection } from './pi-hook-prompt.js';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import { assistantProfile, assistantInstructions } from './pi-extension-assistant.js';
import { resolvePiCli } from './pi-rpc-client.js';

export function registerExtensionAssistant(pi: ExtensionAPI) {
    const profileFor = (ctx: any) => ctx.mode === 'rpc' && process.env.PI_WEB_NAVIGATION_TOKEN ? assistantProfile(ctx.sessionManager) : null;
    const request = async (action: string, ctx: any, data: object, signal?: AbortSignal) => {
        if (!profileFor(ctx)) throw new Error('This tool requires an extension assistant session');
        const origin = process.env.PI_EXTENSION_ASSISTANT_ORIGIN;
        const token = process.env.PI_EXTENSION_ASSISTANT_TOKEN;
        if (!origin || !token) throw new Error('Assistant management connection is unavailable; reopen this session after the backend is updated.');
        const target = new URL(`/api/pi/extension-assistant/${action}`, origin);
        if (target.origin !== origin || !['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid assistant management origin');
        let response;
        try {
            response = await fetch(target, { method: 'POST', redirect: 'error', signal,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ ...data, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() }) });
        } catch { throw new Error('Management response unavailable. An interrupted configuration or package request may still be running. Inspect inventory before attempting another change; do not replay it.'); }
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error || `Management HTTP ${response.status}`);
        const text = JSON.stringify(result);
        if (Buffer.byteLength(text) > 512 * 1024) throw new Error('Inventory exceeds 512 KiB; inspect resources in Settings.');
        return { content: [{ type: 'text' as const, text }], details: action === 'weknora-configure' ? { pivaneMcpConfiguration: result } : {} };
    };
    pi.on('before_agent_start', (event, ctx) => {
        const profile = profileFor(ctx);
        if (!profile) return;
        setPromptSection(event, 'pivane_extension_assistant', assistantInstructions({ profile, cwd: ctx.cwd,
            agentDir: getAgentDir(), cli: resolvePiCli(), tools: pi.getActiveTools(), trusted: ctx.isProjectTrusted() }));
    });
    pi.on('session_start', (_event, ctx) => {
        if (!profileFor(ctx)) return;
        pi.registerTool({
            name: 'extensions_inventory', label: 'Extension inventory',
            description: 'Read the actual configured packages/resources, trust and revision for this assistant’s installation scope. Does not install or reload. Output limited to 512 KiB.',
            parameters: Type.Object({}),
            execute: async (_id, _params, signal, _update, context) => request('inventory', context, {}, signal)
        });
        pi.registerTool({
            name: 'extensions_mcp_inventory', label: 'MCP configuration inventory',
            description: 'Read saved MCP configuration with secrets redacted and a fresh revision, in this assistant’s fixed scope. weknoraOtherScope reports a conflicting WeKnora scope. Does not connect or execute commands.',
            parameters: Type.Object({}, { additionalProperties: false }),
            execute: async (_id, _params, signal, _update, context) => request('mcp-inventory', context, {}, signal)
        });
        pi.registerTool({
            name: 'extensions_weknora_configure', label: 'Configure built-in WeKnora',
            description: 'Save the user-provided URL and API Key to the built-in WeKnora stdio MCP and enable it. Reads no stored secrets. Requires a fresh extensions_mcp_inventory revision. Confirms scope and URL without showing the key. Never installs a package, changes commands or reloads the active worker. Saved does not mean connected; after the turn reload resources in the idle session or open a new session, then check the native MCP connection. Never replay an uncertain write.',
            parameters: Type.Object({
                baseUrl: Type.String({ minLength: 1, maxLength: 2048, description: 'User-provided WeKnora HTTP(S) REST API base URL including /api/v1, without credentials, query or fragment.' }),
                apiKey: Type.String({ minLength: 1, maxLength: 8192, description: 'API Key explicitly supplied by the user for this configuration. Never echo it in prose or plans.' }),
                expectedRevision: Type.String({ minLength: 1, maxLength: 200 })
            }, { additionalProperties: false }),
            execute: async (_id, params, signal, _update, context) => {
                const profile = profileFor(context);
                if (!profile) throw new Error('This tool requires an extension assistant session');
                const english = profile.language === 'en';
                let url;
                try { url = new URL(params.baseUrl); } catch { throw new Error('MCP_WEKNORA_INVALID_URL'); }
                if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('MCP_WEKNORA_INVALID_URL');
                const title = english ? 'Configure built-in WeKnora' : '配置内置 WeKnora';
                const scope = profile.scope === 'global' ? (english ? 'All projects' : '所有项目') : (english ? 'Current project' : '当前项目');
                const description = `${english ? 'Scope' : '范围'}: ${scope}\nURL: ${url.href}\n${english ? 'Save the supplied key and enable WeKnora. The key is not displayed. Existing sessions require an idle resource reload; this does not verify the connection.' : '保存所提供的 Key 并启用 WeKnora，不显示密钥。已有会话需在空闲后重载资源，本次保存不验证连接。'}`;
                if (!await context.ui.confirm(title, description, { signal })) return { content: [{ type: 'text' as const, text: english ? 'Cancelled. No configuration was submitted.' : '已取消，没有提交配置。' }], details: { pivaneMcpConfiguration: { status: 'cancelled' } } };
                signal?.throwIfAborted();
                return request('weknora-configure', context, { ...params, confirmed: true }, signal);
            }
        });
        pi.registerTool({
            name: 'extensions_package', label: 'Manage Pi package',
            description: 'Install, update or remove one Pi package after source/license review. Displays an exact confirmation dialog. Uses native settings locks and a fresh inventory revision; never automatically replay an uncertain request. Does not install system dependencies or reload sessions.',
            parameters: Type.Object({
                action: StringEnum(['install', 'update', 'remove']),
                source: Type.String({ minLength: 1, maxLength: 1000 }),
                expectedRevision: Type.String({ minLength: 1, maxLength: 200 }),
                plan: Type.String({ minLength: 1, maxLength: 4000, description: 'Purpose, exact source/ref, license evidence, dependency changes and validation/removal plan in the user’s language. No secrets.' })
            }),
            execute: async (_id, params, signal, _update, context) => {
                const profile = profileFor(context);
                if (!profile) throw new Error('This tool requires an extension assistant session');
                const english = profile.language === 'en';
                const title = english ? 'Confirm package change' : '确认扩展包操作';
                const description = `${params.action}: ${params.source}\n${english ? 'Scope' : '范围'}: ${profile.scope}\n${english ? 'Deployment project' : '部署端项目'}: ${context.cwd}\n\n${params.plan}`;
                if (!await context.ui.confirm(title, description, { signal })) return { content: [{ type: 'text' as const, text: english ? 'Cancelled. No package operation was submitted.' : '已取消，没有提交包操作。' }], details: { pivanePackageOperation: { status: 'cancelled' } } };
                signal?.throwIfAborted();
                return request('package', context, { action: params.action, source: params.source, expectedRevision: params.expectedRevision, confirmed: true }, signal);
            }
        });
    });
}
