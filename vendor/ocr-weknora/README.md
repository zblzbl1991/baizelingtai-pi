# OCR / WeKnora service snapshot

User-supplied Node MCP 0.1.0 service/client sources, copied without changes. The supplied private project declares no public license; UNLICENSED records this status, not a grant of redistribution rights. Third-party notices retain their respective licenses.

Standalone servers and dotenv configuration are deliberately excluded. White-label managed configuration, file authorization and MCP schemas live in server/builtin-mcp/. The bundle replaces config.js with that managed boundary, and threads MCP cancellation into the WeKnora HTTP request. OCR cancellation and verified-byte upload are applied by the host.

Rebuild: copy upstream-package.json and upstream-package-lock.json to package.json and package-lock.json in a temporary directory, run npm ci there, then node scripts/build-builtin-mcp.cjs <temporary-node_modules>. The application uses its locked esbuild. Review generated clients.mjs and vendor/manifest.json together. No upstream service or credentials are required.
