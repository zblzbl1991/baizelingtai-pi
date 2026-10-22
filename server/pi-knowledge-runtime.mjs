// Public SDK boundary for user-initiated, read-only WeKnora operations.
// The existing native MCP definitions retain transport/auth ownership. No model
// request, synthetic transcript entry, parallel session, or second client is made.
import { randomUUID, createHash } from 'node:crypto';
import { runToolCall } from '@earendil-works/pi-agent-core';
import { wrapRegisteredTool } from '@earendil-works/pi-coding-agent';

const registryKey = Symbol.for('pivane.knowledge-runtime.v1');
const registry = () => globalThis[registryKey] ??= new Map();
const fail = code => Object.assign(new Error(code), { code });
const keyOf = ctx => JSON.stringify([ctx.sessionManager.getSessionId(), ctx.cwd]);
const operations = {
    bases: ['list_knowledge_bases'], documents: ['list_documents', 'list_knowledge'],
    search: ['search_knowledge', 'hybrid_search'], read: ['read_document', 'get_knowledge'], chunks: ['list_chunks']
};
const rawNames = new Set(Object.values(operations).flat());
const has = (tool, field) => Object.hasOwn(tool.parameters?.properties || {}, field);
const needsBase = tool => tool?.parameters?.required?.includes('kb_id') || tool?.parameters?.required?.includes('knowledge_base_id') || tool?.raw === 'hybrid_search';

function catalog(session) {
    const callable = new Set(session.getCallableToolNames()), servers = new Map();
    for (const info of session.getAllTools()) {
        if (!callable.has(info.name) || info.sourceInfo?.path !== 'builtin:mcp') continue;
        const definition = session.getToolDefinition(info.name);
        const match = /^([A-Za-z0-9_-]+)\/([a-z_]+)$/.exec(definition?.label || '');
        if (!match || !rawNames.has(match[2]) || !info.namespace?.aliases?.includes(match[1])) continue;
        const [server, raw] = match.slice(1);
        if (!servers.has(server)) servers.set(server, []);
        servers.get(server).push({ name: info.name, raw, parameters: info.parameters, exposure: info.exposure });
    }
    const entries = [...servers].map(([name, tools]) => ({ name, tools }));
    const revision = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    return { revision, servers: entries.map(({ name, tools }) => ({ name,
        searchRequiresBase: !!needsBase(tools.find(tool => tool.raw === 'search_knowledge') || tools.find(tool => tool.raw === 'hybrid_search')), operations: Object.fromEntries(
        Object.entries(operations).map(([op, names]) => [op, names.map(raw => tools.find(tool => tool.raw === raw)).find(Boolean)?.name || null])) })), entries };
}
export function argumentsFor(tool, input) {
    const raw = tool.raw;
    // The supplied 0.7 REST bridge shares tool names with newer WeKnora MCPs,
    // but has a different schema. Choose arguments from the advertised schema.
    if (raw === 'list_knowledge_bases' && has(tool, 'page')) return { page: input.page || 1, page_size: 20 };
    if (raw === 'list_documents' && has(tool, 'kb_id') && !has(tool, 'knowledge_base_id')) return { kb_id: input.kbId, page: input.page || 1, page_size: 20 };
    if (raw === 'search_knowledge' && has(tool, 'kb_id') && !has(tool, 'knowledge_base_ids')) return { query: input.query, kb_id: input.kbId, limit: 10 };
    if (raw === 'read_document' && has(tool, 'content_offset')) return { knowledge_id: input.documentId, page: input.page || 1, page_size: 20, content_offset: input.contentOffset || 0 };
    switch (raw) {
    case 'list_knowledge_bases': return {};
    case 'list_documents': return { knowledge_base_id: input.kbId, page: input.page || 1, page_size: 20 };
    case 'list_knowledge': return { kb_id: input.kbId, page: input.page || 1, page_size: 20 };
    case 'search_knowledge': return { query: input.query, limit: 10, ...(input.kbId ? { knowledge_base_ids: [input.kbId] } : {}) };
    case 'hybrid_search': return { kb_id: input.kbId, query: input.query, match_count: 10 };
    case 'read_document': return { knowledge_id: input.documentId, offset: input.offset || 0, limit: 20 };
    case 'get_knowledge': return { knowledge_id: input.documentId };
    case 'list_chunks': return { knowledge_id: input.documentId, page: input.page || 1, page_size: 20 };
    default: throw fail('MCP_KNOWLEDGE_UNAVAILABLE');
    }
}
function valueOf(result) {
    // Native MCP returns its complete CallToolResult as structuredContent.
    const envelope = result.structuredContent;
    if (envelope && Object.hasOwn(envelope, 'structuredContent')) return envelope.structuredContent;
    const text = (envelope?.content || result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    try { return JSON.parse(text); } catch { return text; }
}
export function installKnowledgeRuntime(session) {
    const ctx = session.extensionRunner.createContext(), key = keyOf(ctx);
    if (registry().has(key)) throw fail('MCP_DUPLICATE_RUNTIME');
    let busy = false;
    const entry = async input => {
        if (!session.isIdle || busy) throw fail('MCP_RUNTIME_BUSY');
        busy = true; // Own before awaiting hooks/transport; a disconnect cannot release this.
        try {
            const snapshot = catalog(session);
            if (input.action === 'knowledge-catalog') return { revision: snapshot.revision, servers: snapshot.servers };
            if (input.expectedRevision !== snapshot.revision) throw fail('MCP_KNOWLEDGE_CHANGED');
            const server = snapshot.entries.find(item => item.name === input.server);
            const tool = operations[input.operation]?.map(raw => server?.tools.find(tool => tool.raw === raw)).find(Boolean);
            if (!tool) throw fail('MCP_KNOWLEDGE_UNAVAILABLE');
            if (['documents'].includes(input.operation) && !input.kbId || needsBase(tool) && !input.kbId
                || input.operation === 'search' && !input.query?.trim()
                || ['read', 'chunks'].includes(input.operation) && !input.documentId) throw fail('MCP_KNOWLEDGE_INPUT_REQUIRED');
            const definition = session.getToolDefinition(tool.name), runner = session.extensionRunner;
            const wrapped = wrapRegisteredTool({ definition }, runner);
            // runToolCall emits no transcript/events. Pi's own agent hooks still
            // validate permissions and normalize results, just as on model calls.
            const outcome = await runToolCall({ type: 'toolCall', id: `knowledge-${randomUUID()}`, name: tool.name,
                arguments: argumentsFor(tool, input) }, { tools: [wrapped],
                context: { messages: session.messages, tools: session.agent.state.tools },
                beforeToolCall: session.agent.beforeToolCall, afterToolCall: session.agent.afterToolCall });
            if (outcome.isError || outcome.result.isError || outcome.result.structuredContent?.isError) throw fail('MCP_KNOWLEDGE_READ_FAILED');
            const value = valueOf(outcome.result);
            if (Buffer.byteLength(JSON.stringify(value) ?? 'null') > 320 * 1024) throw fail('MCP_RESPONSE_TOO_LARGE');
            return { server: input.server, operation: input.operation, tool: tool.name, revision: snapshot.revision, value };
        } finally { busy = false; }
    };
    registry().set(key, entry);
    const dispose = session.dispose;
    session.dispose = function (...args) {
        if (registry().get(key) === entry) registry().delete(key);
        return dispose.apply(this, args);
    };
}
export async function requestKnowledgeRuntime(ctx, input) {
    const entry = registry().get(keyOf(ctx));
    if (!entry || ctx.mode !== 'rpc' || !ctx.isIdle()) throw fail('MCP_RUNTIME_CHANGED');
    return entry(input);
}
