// Conversion runs in a private environment and exits only after kit disposal.
const { pathToFileURL } = require('node:url');
const controller = new AbortController();
process.on('message', message => { if (message.cancel) controller.abort(); });
process.once('message', async ({ kit, inputPath, outputPath, limits }) => {
    let converter;
    try {
        const { createConverter } = await import(pathToFileURL(kit).href);
        converter = await createConverter({ fontMetadataCacheDirectory: false, timeoutMs: limits.timeoutMs, maxInputBytes: limits.maxSourceBytes,
            maxOutputBytes: limits.maxOutputBytes, maxArchiveEntries: limits.maxArchiveEntries, maxUncompressedBytes: limits.maxUncompressedBytes });
        const result = await converter.render({ inputPath, outputPath }, controller.signal);
        await converter.dispose(); converter = undefined;
        process.send({ ok: true, missingFonts: result.missingFonts }, () => process.disconnect());
    } catch (error) {
        try { await converter?.dispose(); } catch { /* original conversion failure is authoritative */ }
        process.send({ ok: false, code: typeof error.code === 'string' ? error.code : 'CONVERSION_FAILED' }, () => process.disconnect());
        process.exitCode = 1;
    }
});
