// Run the same complete layout matrix in English within its own script budget.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { runSuite } = require('./pi-side-layout.cjs');
runSuite(['en-US'], () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] }))
    .catch(error => { console.error(error); process.exitCode = 1; });
