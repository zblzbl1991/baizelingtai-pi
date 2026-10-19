const { officePreviewPlatform } = require('./inventory');
const { createOfficePreviewEngine } = require('./engine');
async function preflightOfficePreview({ root, requireAvailable = false, target } = {}) {
    const { supported, ...platformStatus } = officePreviewPlatform(target);
    if (!supported) return platformStatus;
    const engine = createOfficePreviewEngine({ root });
    try {
        const status = await engine.status();
        if (requireAvailable && !status.available) throw Object.assign(new Error(status.message), { code: status.code });
        return status;
    } finally { await engine.dispose(); }
}
module.exports = { preflightOfficePreview };
