// pivane-browser: helper — instrumentation loaded by the runner, never a scenario.
const fs = require('node:fs');
const { target } = require('./targets.cjs');
if (target() === 'desktop') {
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    const launch = chromium.launch.bind(chromium);
    function record(options = {}) {
        const width = options.viewport?.width ?? options.width ?? 1280;
        if (options.isMobile || width <= 900) throw Error('Desktop target attempted a mobile viewport: ' + width);
        if (process.env.PIVANE_BROWSER_AUDIT_FILE) fs.appendFileSync(process.env.PIVANE_BROWSER_AUDIT_FILE, JSON.stringify({ width, isMobile: !!options.isMobile }) + '\n');
    }
    function instrumentPage(page) {
        const resize = page.setViewportSize.bind(page);
        page.setViewportSize = async size => { record(size); return resize(size); };
        return page;
    }
    chromium.launch = async (...args) => {
        const browser = await launch(...args), create = browser.newContext.bind(browser), newBrowserPage = browser.newPage.bind(browser);
        browser.newPage = async options => { record(options); return instrumentPage(await newBrowserPage(options)); };
        browser.newContext = async options => {
            record(options);
            const context = await create(options);
            // The synthetic UI runner uses local/system fonts and never waits on
            // an incidental external font service. App external-resource tests remain intact.
            await context.route(/^https:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort());
            const newPage = context.newPage.bind(context);
            context.newPage = async (...pageArgs) => {
                return instrumentPage(await newPage(...pageArgs));
            };
            return context;
        };
        return browser;
    };
}
