const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { isInternalCommand } = require('./pivane-compat');
const fail = code => Object.assign(new Error(code), { code, statusCode: 409 });
const actions = new Set(['snapshot', 'reconnect', 'login', 'logout', 'knowledge-catalog', 'knowledge-read']);
function validateRequest(input) {
    if (input?.action === 'knowledge-catalog' || input?.action === 'knowledge-read') {
        const keys = input.action === 'knowledge-catalog' ? ['action', 'runtimeId']
            : ['action', 'runtimeId', 'server', 'confirmed', 'expectedRevision', 'operation', 'kbId', 'documentId', 'query', 'page', 'offset', 'contentOffset'];
        if (Object.keys(input).some(key => !keys.includes(key)) || typeof input.runtimeId !== 'string' || !input.runtimeId || input.runtimeId.length > 128
            || input.action === 'knowledge-read' && (input.confirmed !== true || !/^[A-Za-z0-9_-]{1,256}$/.test(input.server || '')
                || !/^[a-f0-9]{64}$/.test(input.expectedRevision || '') || !['bases', 'documents', 'search', 'read', 'chunks'].includes(input.operation)
                || ['kbId', 'documentId', 'query'].some(key => input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > (key === 'query' ? 4000 : 512)))
                || input.page !== undefined && (!Number.isInteger(input.page) || input.page < 1 || input.page > 10000)
                || input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > 1000000)
                || input.contentOffset !== undefined && (!Number.isInteger(input.contentOffset) || input.contentOffset < 0 || input.contentOffset > 100000000))) throw fail('MCP_INVALID_ACTION');
        return input;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['action', 'server', 'confirmed', 'runtimeId'].includes(key))
        || !actions.has(input.action) || typeof input.runtimeId !== 'string' || input.runtimeId.length > 128
        || input.action !== 'snapshot' && (input.confirmed !== true || typeof input.server !== 'string'
            || !/^[A-Za-z0-9_-]{1,256}$/.test(input.server))
        || input.action === 'snapshot' && input.server !== undefined) throw fail('MCP_INVALID_ACTION');
    return input;
}
// Only a request/result slot and transient OAuth link; never a connection or session store.
class PiMcpRuntimeControl {
    constructor(worker) { this.worker = worker; this.pending = new Map(); this.authorization = null; }
    get busy() { return this.pending.size > 0; }
    handle(result) {
        if (typeof result?.pivaneMcp !== 'string') return false;
        const slot = this.pending.get(result.pivaneMcp);
        if (slot) {
            if (result.authorization) {
                const value = result.authorization;
                try {
                    const url = new URL(value.url);
                    if (slot.action === 'login' && value.server === slot.server && ['http:', 'https:'].includes(url.protocol)
                        && !url.username && !url.password && url.href.length <= 8192) {
                        this.authorization = { server: slot.server, url: url.href, runtimeId: this.worker.shell.runtimeId };
                        this.worker._broadcast({ type: 'gateway_mcp_authorization', authorization: this.authorization });
                    }
                } catch { /* Invalid authorization metadata is never presented. */ }
            } else slot.result = result;
        }
        return true; // Unknown/late private replies are intercepted too.
    }
    async request(input) {
        input = validateRequest(input);
        const w = this.worker;
        if (w.noSession || !w.managed || w.disposed || w.restarting || input.runtimeId !== w.shell.runtimeId) throw fail('MCP_RUNTIME_CHANGED');
        if (this.busy || w.resourceResults.size || w.contextCapture || w.historyPending || w.historyWriting || w.modelChangesPending
            || w.modelChangeUncertain || w.modelCatalog.inflight || w.retainsBackgroundWork()) throw fail('MCP_RUNTIME_BUSY');
        // exclusive() synchronously reserves ownership before any readiness/RPC awaits.
        return w.exclusive(async () => {
            const id = randomUUID(), slot = { action: input.action, server: input.server, result: null };
            this.pending.set(id, slot);
            try {
                const raw = await w.client.request('get_commands');
                const command = raw.commands?.find(item => item.source === 'extension'
                    && (item.sourceInfo?.path || item.path) === path.join(__dirname, 'pi-web-session-extension.ts')
                    && isInternalCommand(item.name) && item.description?.includes('mcp-v1')
                    && (!input.action.startsWith('knowledge-') || item.description.includes('knowledge-v1')));
                if (!command) throw fail('MCP_NATIVE_HANDLER_UNAVAILABLE');
                if (w.disposed || input.runtimeId !== w.shell.runtimeId) throw fail('MCP_RUNTIME_CHANGED');
                // No timeout: browser disconnect is not native cancellation or permission to replay.
                await w.client.request('prompt', { message: `/${command.name} ${JSON.stringify({ mode: 'mcp', id,
                    token: w.navigationToken, input: (({ runtimeId, ...request }) => request)(input) })}` }, null);
                if (!slot.result?.success) throw fail(/^MCP_[A-Z_]+$/.test(slot.result?.code || '') ? slot.result.code : 'MCP_NATIVE_ACTION_FAILED');
                if (w.disposed || input.runtimeId !== w.shell.runtimeId) throw fail('MCP_RUNTIME_CHANGED');
                return { ...slot.result.data, runtimeId: w.shell.runtimeId };
            } finally {
                this.pending.delete(id);
                this.authorization = null;
                w._broadcast({ type: 'gateway_mcp_authorization', authorization: null });
            }
        });
    }
}
module.exports = { PiMcpRuntimeControl, validateRequest };
