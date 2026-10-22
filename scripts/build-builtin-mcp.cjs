// Rebuild reviewed upstream services, not standalone servers or configuration loaders.
// Install vendor/ocr-weknora/upstream-package{,-lock}.json as package{,-lock}.json
// in an isolated directory, npm ci there, then pass its node_modules below.
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
async function build(dependencyDirectory) {
    const root = path.resolve(__dirname, '..'), directory = path.join(root, 'vendor/ocr-weknora');
    await require('esbuild').build({
        stdin: { contents: 'export { OcrClient, OcrError } from "./client.ts"; export { OcrService } from "./service.ts"; export { WeKnoraClient, WeKnoraError } from "./weknora-client.ts"; export { WeKnoraService } from "./weknora-service.ts";', resolveDir: directory },
        outfile: path.join(directory, 'clients.mjs'), bundle: true, minify: true, platform: 'node', target: 'node22', format: 'esm',
        nodePaths: [path.resolve(dependencyDirectory)],
        banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
        plugins: [{ name: 'managed-boundary', setup(api) {
            api.onResolve({ filter: /^\.\/config\.js$/ }, () => ({ path: '../../server/builtin-mcp/vendor-config.mjs', external: true }));
            api.onLoad({ filter: /weknora-client\.ts$/ }, args => {
                const source = fs.readFileSync(args.path, 'utf8'), anchor = 'signal: AbortSignal.timeout(timeoutMs)';
                if (source.split(anchor).length !== 2) throw Error('Upstream cancellation seam changed');
                return { loader: 'ts', contents: 'import { currentSignal } from "../../server/builtin-mcp/context.mjs";\n' + source.replace(anchor, 'signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...currentSignal()])') };
            });
            api.onResolve({ filter: /server\/builtin-mcp\/context\.mjs$/ }, args => ({ path: args.path, external: true }));
        } }]
    });
    const output = path.join(directory, 'clients.mjs');
    const manifestPath = path.join(root, 'vendor/manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath));
    // Never inventory arbitrary maintainer files or environment configuration.
    const names = ['README.md', 'LICENSE', 'THIRD-PARTY-LICENSES.txt', 'package.json', 'upstream-package.json', 'upstream-package-lock.json',
        'client.ts', 'service.ts', 'weknora-client.ts', 'weknora-service.ts', 'clients.mjs'].sort();
    const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const pkg = { name: 'textin-intranet-mcp-node', directory: 'ocr-weknora', version: '0.1.0', source: 'user-supplied Node MCP sources; see README.md',
        sha256: digest(output), license: 'UNLICENSED', files: names.map(name => ({ path: `vendor/ocr-weknora/${name}`, sha256: digest(path.join(directory, name)) })) };
    manifest.packages = [...manifest.packages.filter(item => item.name !== pkg.name), pkg];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
if (require.main === module) build(process.argv[2] || 'node_modules').catch(() => { process.stderr.write('Built-in MCP build failed; check isolated upstream dependencies.\n'); process.exitCode = 1; });
module.exports = { build };
