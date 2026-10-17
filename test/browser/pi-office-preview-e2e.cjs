// Real browser/gateway/native-session/Office-engine chain; no API or WebSocket mocks.
// pivane-browser: office-native
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { startOfficePreviewServer } = require('../office-preview-real-server.cjs');
const { runMatrix } = require('./pi-office-real-helper.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
async function main() {
    const output = process.env.PIVANE_TEST_SCREENSHOT_DIR || path.join(os.tmpdir(), 'pivane-office-preview-e2e'); fs.mkdirSync(output, { recursive: true });
    const fixture = await startOfficePreviewServer(), matrix = [];
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
        await runMatrix(browser, fixture, 1440, matrix, output); await runMatrix(browser, fixture, 1024, matrix, output);
        assert.equal(matrix.length, 48);
        assert.equal(fixture.providerRequests.length, 0);
    } finally { fs.writeFileSync(path.join(output, 'matrix.json'), JSON.stringify({ matrix, providerRequests: fixture.providerRequests }, null, 2)); await browser?.close(); await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
