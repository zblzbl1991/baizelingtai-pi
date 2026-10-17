const { createOfficePreviewEngine } = require('./engine');
async function preflightOfficePreview({ root, requireAvailable = false } = {}) {
    const engine = createOfficePreviewEngine({ root });
    try {
        const status = await engine.status();
        if (requireAvailable && !status.available) throw Object.assign(new Error(status.message), { code: status.code });
        return status;
    } finally { await engine.dispose(); }
}
module.exports = { preflightOfficePreview };
