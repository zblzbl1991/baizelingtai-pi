import path from 'node:path';
// Upstream service seam: environment and file authorization belong to the host.
// No dotenv lookup and no instance-specific default address.
export function checkAuth(settings) {
    if (!settings.baseUrl || !settings.apiKey && !settings.allowAnonymous) throw Error('MCP_CONFIG_REQUIRED');
}
export async function inputFile(value) {
    if (!path.isAbsolute(value)) throw Error('MCP_ABSOLUTE_PATH_REQUIRED');
    return value; // Managed OcrClient.create reads verified bytes under project policy.
}
