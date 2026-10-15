// Real Excel/upload/plan/artifact services. Isolated identity, no real conversation.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), express = require('express'), { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..'), temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staffing-excel-browser-')));
const { PiProfileRegistry } = require('../../server/pi-profile-registry'), { StaffingService } = require('../../server/staffing/service');
const { StaffingExcelService } = require('../../server/staffing/excel-service'), { mountStaffingRoutes } = require('../../server/staffing/routes'), { mountStaffingExcelRoutes } = require('../../server/staffing/excel-routes');
const { ArtifactsService } = require('../../server/pi-artifacts'), { WorkspaceAccessService } = require('../../server/workspace-access-service');
async function run(browser, width) {
    const agent = path.join(temporary, String(width)); fs.mkdirSync(agent); process.env.PI_CODING_AGENT_DIR = agent;
    const staffing = new StaffingService({ profiles: new PiProfileRegistry({ resolveProject: value => value }) });
    const artifacts = new ArtifactsService({ store: { resolveProject: value => value }, supervisor: {}, libraryRoot: path.join(agent, 'artifacts') }), excel = new StaffingExcelService({ staffing, artifacts });
    const access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => '' });
    const app = express(); access.mount(app); app.use(express.json()); const router = express.Router(); router.use(access.middleware()); mountStaffingRoutes(router, staffing); mountStaffingExcelRoutes(router, excel); app.use('/api/pi', router);
    app.get('/fixture', (_req, res) => res.send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/pi-staffing.css"><link rel="stylesheet" href="/pi-staffing-excel.css"><style>*{box-sizing:border-box}body{margin:0;padding:12px;font-family:sans-serif}button,input{max-width:100%}</style></head><body><main id="staffing-tab"></main><script>window.PiWorkspaceRoute={current:()=>({tab:"staffing"})}</script><script src="/pi-staffing-excel.js"></script><script src="/pi-staffing.js"></script></body></html>'));
    app.use(express.static(path.join(root, 'public'))); const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN', hasTouch: width < 900 }), page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto('http://127.0.0.1:' + server.address().port + '/fixture', { waitUntil: 'domcontentloaded' });
        await page.locator('#staffing-enable').click();
        const file = page.locator('[data-staffing-excel-file]'); await file.waitFor();
        const bytes = excel.workbook({ people: [{ id: 'P1', name: '<img src=x onerror=alert(1)>', department: 'A', direct: true }], projects: [], occupancies: [], historyComplete: false });
        await file.setInputFiles({ name: 'staffing.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
        await page.locator('[data-staffing-excel-import]').click();
        await page.locator('[data-staffing-import-confirm]').waitFor();
        assert.equal((await staffing.ledger()).people.length, 0); assert.equal(await page.locator('.staffing-import-card img').count(), 0);
        await page.locator('[data-staffing-import-confirm]').click(); await page.locator('#staffing-reviewed').check(); await page.locator('#staffing-confirm-initial').click();
        await page.locator('[data-staffing-excel-export]').click(); await page.getByText(/已保存到成果/).waitFor();
        const saved = await artifacts.library.list(); assert.equal(saved.items.length, 1);
        assert.equal((await excel.inspect(Buffer.from((await artifacts.preview(saved.items[0].key)).base64, 'base64'))).data.people[0].id, 'P1');
        if (width < 680) assert.ok(await file.evaluate(node => parseFloat(getComputedStyle(node).fontSize)) >= 16);
        assert.deepEqual(await page.evaluate(() => ['body', '#staffing-tab', '.staffing-panel', '.staffing-excel'].filter(selector => { const node = document.querySelector(selector); return node && node.scrollWidth > node.clientWidth + 1; })), []);
        assert.deepEqual(errors, []);
        if (process.env.PIVANE_TEST_SCREENSHOT_DIR) { fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, `staffing-excel-${width}.png`) }); }
        console.log('staffing Excel ' + width + 'px passed');
    } catch (error) { console.error('Excel page state:', await page.locator('body').innerText(), 'pageerror:', errors); throw error; }
    finally { await context.close(); await excel.dispose(); await staffing.dispose(); await artifacts.dispose(); access.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
(async () => { const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
    try { for (const width of [1440, 393, 320]) await run(browser, width); } finally { await browser.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
