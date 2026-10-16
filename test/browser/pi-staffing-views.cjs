// Real page, card, HTTP, domain and private persistence with a synthetic identity.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname,'../..'), temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'staffing-views-')));
process.env.PI_CODING_AGENT_DIR = temporary;
const { PiProfileRegistry } = require('../../server/pi-profile-registry'), { StaffingService } = require('../../server/staffing/service');
const { mountStaffingRoutes } = require('../../server/staffing/routes'), { WorkspaceAccessService } = require('../../server/workspace-access-service');
async function run(browser,width) {
    const agent = path.join(temporary,String(width)); fs.mkdirSync(agent); process.env.PI_CODING_AGENT_DIR = agent;
    const service = new StaffingService({profiles:new PiProfileRegistry({resolveProject:value=>value}),today:()=> '2026-11-03'});
    const enabled = await service.enable({requestId:'enable',expectedRevision:0});
    const project = {id:'A',name:'Synthetic Project',owner:'Owner',department:'A',start:'2026-11-01',end:'2026-11-05',minimum:2};
    const pagingPeople = width === 1440 ? Array.from({length:120},(_,index)=>({id:'B'+String(index).padStart(3,'0'),name:'测'.repeat(160),department:'B',direct:false})) : [];
    const initial = await service.initialize({requestId:'initial',expectedRevision:enabled.revision,historyComplete:false,projects:[project],
        people:[{id:'D',name:'<Direct>',department:'A',direct:true},{id:'N',name:'<Direct>',department:'A',direct:false},{id:'R',name:'Replacement',department:'A',direct:true},
            ...['S1','S2'].map(id=>({id,name:'Replacement',department:'A',direct:true})),...pagingPeople],
        occupancies:[...['D','N'].map(personId=>({id:'O-'+personId,personId,projectId:'A',kind:'project',state:'reserved',start:project.start,end:project.end})),
            ...pagingPeople.flatMap(person=>Array.from({length:10},(_,index)=>({id:person.id+'-training-'+index,personId:person.id,kind:'training',state:'confirmed',start:'2026-11-03',end:'2026-11-03',reason:'训'.repeat(160)})))]});
    await service.confirmInitial({requestId:'review',expectedRevision:initial.revision,reviewed:true});
    const app = express(), access = new WorkspaceAccessService({filePath:path.join(agent,'access.json'),envToken:()=>''}); access.mount(app); app.use(express.json()); const router=express.Router();router.use(access.middleware());mountStaffingRoutes(router,service);app.use('/api/pi',router);
    app.get('/fixture.html',(_req,res)=>res.type('html').send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/pi-staffing.css"><style>:root{--surface-1:#f5f6f4;--surface-2:#fafbf9;--text-main:#29332e;--text-muted:#59675f;--line:#ccd4cd}*{box-sizing:border-box}body{font-family:system-ui;margin:0;background:var(--surface-1);color:var(--text-main)}button{min-height:36px}main{max-width:1100px;margin:auto}</style><script>window.PiWorkspaceRoute={current:()=>({tab:"staffing"})}</script></head><body><main id="staffing-tab"></main><script src="/pi-staffing-cards.js"></script><script src="/pi-staffing-views.js"></script><script src="/pi-staffing.js"></script></body></html>'));
    app.use(express.static(path.join(root,'public')));
    const server=http.createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening'); const origin='http://127.0.0.1:'+server.address().port;
    const context=await browser.newContext({viewport:{width,height:950},locale:'zh-CN',hasTouch:width<680}),page=await context.newPage(),errors=[]; page.on('pageerror',e=>errors.push(e.message)); page.setDefaultTimeout(15000);
    try {
        await page.goto(origin+'/fixture.html',{waitUntil:'domcontentloaded'});
        await page.locator('[data-staffing-view="projects"]').click();
        await page.locator('[data-staffing-project="A"]').waitFor();
        assert.match(await page.locator('[data-staffing-project="A"]').innerText(),/尚未全部正式确认/);
        for(const id of ['D','N'])assert.ok((await page.locator('[data-staffing-project="A"]').innerText()).includes('<Direct> · '+id+' · 2026-11-01 至 2026-11-05'),'same-name project members display IDs and exact intervals');
        await page.locator('[data-staffing-add-person="S2"]').waitFor();
        for(const id of ['R','S1','S2'])assert.ok((await page.locator('[data-staffing-add-person="'+id+'"]').locator('..').innerText()).includes('Replacement · '+id),'same-name, same-department, same-contract candidates display distinct IDs');
        if(process.env.PIVANE_TEST_SCREENSHOT_DIR)await page.locator('.staffing-views').screenshot({path:path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR,'staffing-identities-'+width+'.png')});
        await page.selectOption('#staffing-change-kind','absence');
        await page.selectOption('#staffing-change-person','D');
        await page.fill('#staffing-change-start','2026-11-03');await page.fill('#staffing-change-end','2026-11-03');await page.fill('#staffing-change-reason','Temporary leave');
        await page.click('#staffing-prepare-adjustment');
        await page.locator('[data-staffing-action="apply"]').waitFor();
        if(process.env.PIVANE_TEST_SCREENSHOT_DIR){fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR,{recursive:true});await page.locator('.staffing-plan-card').screenshot({path:path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR,'staffing-change-'+width+'.png')});}
        await page.locator('[data-staffing-action="apply"]').click();
        await page.locator('[data-staffing-project="A"]').filter({hasText:'缺直签'}).waitFor();
        if(process.env.PIVANE_TEST_SCREENSHOT_DIR)await page.locator('.staffing-view-results').screenshot({path:path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR,'staffing-project-gaps-'+width+'.png')});
        assert.equal(await page.locator('#staffing-tab img').count(),0);
        await page.selectOption('#staffing-change-kind','replace');
        for(const id of ['R','S1','S2'])assert.ok((await page.locator('#staffing-change-replacement option[value="'+id+'"]').textContent()).includes('Replacement · '+id),'replacement option visibly identifies same-name people');
        await page.selectOption('#staffing-change-project','A');await page.selectOption('#staffing-change-occupancy','O-D');await page.selectOption('#staffing-change-replacement','R');
        await page.fill('#staffing-change-start','2026-11-03');await page.fill('#staffing-change-end','2026-11-03');await page.fill('#staffing-change-reason','Cover leave');
        await page.click('#staffing-prepare-adjustment');await page.locator('[data-staffing-action="apply"]').click();
        await page.locator('[data-staffing-project="A"]').filter({hasText:'人数和直签已达标'}).waitFor();
        for(const interval of ['2026-11-01 至 2026-11-02','2026-11-04 至 2026-11-05'])assert.ok((await page.locator('[data-staffing-project="A"]').innerText()).includes('<Direct> · D · '+interval),'split assignments retain the same person ID and distinguish their date intervals');
        if(process.env.PIVANE_TEST_SCREENSHOT_DIR)await page.locator('[data-staffing-project="A"]').screenshot({path:path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR,'staffing-interval-identities-'+width+'.png')});
        await page.selectOption('#staffing-change-kind','formalize');await page.click('#staffing-prepare-adjustment');await page.locator('[data-staffing-action="apply"]').click();
        await page.locator('[data-staffing-project="A"]').filter({hasText:'全部人员已正式确认'}).waitFor();
        await page.locator('[data-staffing-view="availability"]').click();await page.fill('#staffing-view-start','2026-11-06');await page.fill('#staffing-view-end','2026-11-06');await page.click('#staffing-view-refresh');
        await page.locator('[data-staffing-available="D"]').waitFor();
        await page.locator('[data-staffing-view="people"]').click();await page.fill('#staffing-view-start','2026-11-03');await page.fill('#staffing-view-end','2026-11-03');await page.click('#staffing-view-refresh');
        await page.locator('[data-staffing-person-calendar="D"]').filter({hasText:'请假'}).waitFor();
        assert.ok(await page.locator('#staffing-change-start').evaluate(el=>parseFloat(getComputedStyle(el).fontSize))>=16);
        assert.deepEqual(await page.evaluate(()=>['body','#staffing-tab','.staffing-panel','.staffing-views'].filter(selector=>{const e=document.querySelector(selector);return e&&e.scrollWidth>e.clientWidth+1})),[]);
        if(process.env.PIVANE_TEST_SCREENSHOT_DIR){fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR,'staffing-views-'+width+'.png'),fullPage:true});}
        if(width === 1440) {
            await page.selectOption('#staffing-view-department','B');
            const response = page.waitForResponse(value=>value.url().includes('/staffing/views?')&&new URL(value.url()).searchParams.get('department')==='B');
            await page.click('#staffing-view-refresh'); const first = await (await response).json();
            assert.ok(first.nextOffset > 0 && first.nextOffset < 100, 'byte-bounded page is shorter than the requested row count');
            await page.locator('[data-staffing-person-calendar="B000"]').waitFor();
            const firstIds = await page.locator('[data-staffing-person-calendar]').evaluateAll(rows=>rows.map(row=>row.dataset.staffingPersonCalendar));
            assert.equal(firstIds.length,first.nextOffset);
            await page.getByRole('button',{name:'下一页',exact:true}).click();
            await page.locator('[data-staffing-person-calendar="'+pagingPeople[first.nextOffset].id+'"]').waitFor();
            const secondIds = await page.locator('[data-staffing-person-calendar]').evaluateAll(rows=>rows.map(row=>row.dataset.staffingPersonCalendar));
            assert.deepEqual([...firstIds,...secondIds],pagingPeople.map(person=>person.id),'next page starts at the server byte boundary without skipping people');
            await page.getByRole('button',{name:'上一页',exact:true}).click();await page.locator('[data-staffing-person-calendar="B000"]').waitFor();
            assert.deepEqual(await page.locator('[data-staffing-person-calendar]').evaluateAll(rows=>rows.map(row=>row.dataset.staffingPersonCalendar)),firstIds,'back returns to the actual previous offset');
        }
        assert.deepEqual(errors,[]);console.log('staffing views '+width+'px passed');
    } finally {await context.close();await service.dispose();access.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});try{for(const width of [1440,393,320])await run(browser,width);}finally{await browser.close();fs.rmSync(temporary,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
