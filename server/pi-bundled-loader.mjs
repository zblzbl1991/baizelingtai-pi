import { fileURLToPath } from 'node:url';
import * as sdk from '@earendil-works/pi-coding-agent';
import bundled from './pi-bundled-resources.js';
import capabilities from './pi-bundled-capabilities.js';
import { configureComputerHelpers, setComputerConfigScope } from './pi-bundled-computer-config.js';
import bundledGuidance from './pi-bundled-guidance.mjs';
import { nativeExtensionFactories, selectedNativeBuiltins } from './pi-native-mcp.mjs';
import staffing from './staffing/runtime-scope.js';
// Use the locked native loader's path grammar before the realpath ownership gate.
const { resolvePath } = await import(new URL('./utils/paths.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
import compliance from './pi-compliance-runtime.js';

// Build the same native resource inventory used by Settings, then let Pi load
// only selected paths. Filtering happens before any third-party factory runs.
export async function managedLoaderOptions({ cwd, agentDir, settings, parsed, sessionManager }) {
    configureComputerHelpers(agentDir);
    setComputerConfigScope(cwd, agentDir, settings.isProjectTrusted());
    const { resolved, settingsView } = await bundled.resolveManagedResources(sdk, { cwd, agentDir, settings });
    const eligible = Boolean(compliance.complianceRuntime(sessionManager, cwd, agentDir));
    const scope = await staffing.runtimeScope({ cwd, agentDir, sessionManager });
    // Application staffing resources are selected here, never put in the global catalog/guidance.
    const permitted = file => {
        if (compliance.isComplianceResource(file)) return false;
        if (scope.eligible) return true;
        const source = file.trim().replace(/^[!+-]/, ''), resolved = resolvePath(source, cwd, { trim: true });
        if (staffing.ownedResource(resolved, cwd)) return false;
        const unicode = resolvePath(source, cwd, { trim: true, normalizeUnicodeSpaces: true });
        return unicode === resolved || !staffing.ownedResource(unicode, cwd);
    };
    const paths = type => resolved[type].filter(item => item.enabled && permitted(item.path)).map(item => item.path);
    const explicit = values => (values || []).filter(file => {
        if (!permitted(file)) return false;
        if (bundled.obsoleteMcpAdapter(file, cwd)) return false;
        const entry = bundled.identify(file, cwd);
        if (!entry) return true;
        return entry.mode === 'package' && bundled.packageAt(file)?.root === capabilities.packagePath(entry);
    });
    const adapters = new Map([
        ['../vendor/pi-subagents/index.js', './pi-bundled-subagents.mjs'],
        ['../vendor/pi-web-access/dist/index.js', './pi-bundled-web.mjs'],
        ['../vendor/pi-computer-use/extensions/computer-use.ts', './pi-bundled-computer-use.ts'],
    ].map(([source, adapter]) => [fileURLToPath(new URL(source, import.meta.url)), fileURLToPath(new URL(adapter, import.meta.url))]));
    const extensionPath = file => adapters.get(file) || file;
    const builtins = selectedNativeBuiltins(settingsView, parsed);
    const officeExtension = fileURLToPath(new URL('./pi-officecli-extension.ts', import.meta.url));
    return { settingsView, staffingScope: scope, options: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [...await nativeExtensionFactories(parsed), bundledGuidance],
        disabledBuiltinExtensions: parsed.noMcp ? ['mcp'] : undefined,
        noContextFiles: parsed.noContextFiles, systemPrompt: parsed.systemPrompt, appendSystemPrompt: parsed.appendSystemPrompt,
        additionalExtensionPaths: [...new Set([...(eligible && !parsed.noExtensions ? [compliance.extensionPath] : []), ...builtins, ...explicit(parsed.extensions), ...(parsed.noExtensions ? [] : paths('extensions')),
            ...(scope.eligible ? [fileURLToPath(new URL('./staffing/extension.ts', import.meta.url))] : [])])].filter(file => file !== officeExtension || builtins.includes('builtin:mcp')).map(extensionPath),
        additionalSkillPaths: [...new Set([...(eligible && !parsed.noSkills ? [compliance.skillPath] : []), ...explicit(parsed.skills), ...(parsed.noSkills ? [] : paths('skills')),
            ...(scope.eligible ? [fileURLToPath(new URL('./staffing/skills/staffing-management', import.meta.url))] : [])])],
        additionalPromptTemplatePaths: [...explicit(parsed.promptTemplates), ...(parsed.noPromptTemplates ? [] : paths('prompts'))],
        additionalThemePaths: [...explicit(parsed.themes), ...(parsed.noThemes ? [] : paths('themes'))],
    } };
}
export function reloadableLoader(loader, input, initialOptions) {
    return new Proxy({}, { get(_target, prop) {
        if (prop === 'reload') return async () => {
            await input.settings.reload();
            const { options, staffingScope } = await managedLoaderOptions(input);
            // Keep the native loader and its reload/cache lifecycle. These are the
            // resource arrays supplied by this adapter to its public constructor.
            for (const key of ['additionalExtensionPaths', 'additionalSkillPaths', 'additionalPromptTemplatePaths', 'additionalThemePaths']) {
                initialOptions[key].splice(0, initialOptions[key].length, ...options[key]);
            }
            await loader.reload();
            input.staffingScope = staffingScope;
        };
        const value = loader[prop]; return typeof value === 'function' ? value.bind(loader) : value;
    } });
}
