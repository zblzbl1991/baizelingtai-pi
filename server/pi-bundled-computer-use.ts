import upstream from '../vendor/pi-computer-use/extensions/computer-use.ts';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { computerConfigScope } from './pi-bundled-computer-config.js';

export default function bundledComputerUse(pi: ExtensionAPI) {
    // Snapshot this runtime's trust when its session starts; later child loads
    // must not change which project configuration this instance may consume.
    let scope: { agentDir: string; trusted: boolean } | undefined;
    const configContext = (ctx: any, starting = false) => {
        scope ||= computerConfigScope(ctx.cwd) || { agentDir: getAgentDir(), trusted: false };
        return new Proxy(ctx, { get(context, key) {
            if (key === 'hasUI' && starting) return false;
            if (key === 'cwd' && !scope!.trusted) return scope!.agentDir;
            return Reflect.get(context, key);
        } });
    };
    return upstream(new Proxy(pi, { get(target, prop) {
        if (prop === 'on') return (event: string, handler: (...args: any[]) => any) => target.on(event as any,
            event === 'session_start' ? (data: any, ctx: any) => handler(data, configContext(ctx, true)) : handler);
        if (prop === 'registerCommand') return (name: string, command: any) => target.registerCommand(name,
            { ...command, handler: (args: string, ctx: any) => command.handler(args, configContext(ctx)) });
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
    } }));
}
