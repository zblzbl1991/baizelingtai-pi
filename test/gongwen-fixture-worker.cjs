const { generate } = require('../server/gongwen/worker');
process.once('message', async ({ input }) => {
    if (input.requestId === 'abort') { setInterval(() => {}, 1000); return; }
    const result = await generate(input);
    if (input.requestId === 'checkpoint') {
        process.send({ phase: 'document', bytes: result.bytes, input: result.input, rounds: 0, corrections: [] });
        setInterval(() => {}, 1000); return;
    }
    result.report.environmentClean = !Object.keys(process.env).some(name => /(?:TOKEN|API_KEY|NODE_OPTIONS|PI_CODING_AGENT_DIR|HTTP_PROXY)/.test(name));
    process.send({ phase: 'complete', ...result }, () => process.disconnect());
});
