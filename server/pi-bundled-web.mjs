import upstream from '../vendor/pi-web-access/dist/index.js';

// RPC tools finish inside the native tool operation. TUI curator workflows and
// detached page fetching would otherwise outlive Supervisor's active turn.
export function webApi(pi) {
    return new Proxy(pi, { get(target, prop) {
        if (prop === 'registerCommand' || prop === 'registerShortcut') return () => {};
        if (prop === 'registerTool') return tool => {
            if (tool.label !== 'Web Search') return target.registerTool(tool);
            const properties = { ...tool.parameters.properties };
            delete properties.includeContent; delete properties.workflow;
            return target.registerTool({ ...tool,
                parameters: { ...tool.parameters, properties },
                description: tool.description + ' Read full pages with fetch_content after searching.',
                execute: (id, params, ...rest) => tool.execute(id, { ...params, includeContent: false, workflow: 'none' }, ...rest) });
        };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
}
export default function bundledWeb(pi) { return upstream(webApi(pi)); }
