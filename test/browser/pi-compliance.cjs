const { selectBrowserTargets } = require('./targets.cjs');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..'), temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-compliance-browser-')));
const agent = path.join(temporary, 'agent'), cwd = path.join(temporary, 'project'); fs.mkdirSync(agent); fs.mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = temporary; process.env.PI_OFFLINE = '1';
const { PiSessionStore } = require('../../server/pi-session-store'), { PiProfileRegistry } = require('../../server/pi-profile-registry');
const { ComplianceService, mountCompliance } = require('../../server/pi-compliance'), { WorkspaceAccessService } = require('../../server/workspace-access-service');
const store = new PiSessionStore(), profiles = new PiProfileRegistry(store); store.profiles = profiles;
const documents = new (require('../../server/pi-document-uploads').DocumentUploads)({ store, supervisor: { getActiveWorker: () => null, removing: new Set(), moving: new Set() } });
const models = [{ provider: 'fixture', id: 'text', name: '文本样例', input: ['text'], available: true }, { provider: 'fixture', id: 'vision', name: '图像样例', input: ['text', 'image'], available: true }];
let browserModelCalls=0,failRecognition=false,recognitionGate;
const service = new ComplianceService({ store, profiles, documents, createModelRuntime: async () => ({ getAvailable: async () => models,
    completeSimple:async()=>{browserModelCalls++;await recognitionGate;if(failRecognition)throw new Error('synthetic uncertain response');return {stopReason:'stop',content:[{type:'text',text:JSON.stringify({fields:[{key:'date',raw:'2026-08-01',status:'known',excerpt:'日期：2026-08-01',rect:[0,0,90,20]}]})}],usage:{input:10,output:3,cost:{total:0}}};} }) });
const token = 'synthetic-compliance-browser-token', access = new WorkspaceAccessService({ filePath: path.join(agent, 'access.json'), envToken: () => token });
async function run(browser, origin, width, theme) {
    const fixtureDirectory=path.join(temporary,'files-'+width);fs.mkdirSync(fixtureDirectory);
    const fixtureFiles=files=>files.map(file=>{const target=path.join(fixtureDirectory,file.name);fs.writeFileSync(target,file.buffer);return target;});
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: width < 900 ? 852 : 1000 }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], sessions = [{ id: 'ordinary', cwd, name: '普通会话', messageCount: 0 }]; let active = 'ordinary', loseImport = false, busyImport = true, holdEvidence = false, releaseEvidence, importPosts = 0;
    const pendingFonts=new Map(), businessResponses=[],startupResponses=[],consoleErrors=[]; let holdBatchId, releaseBatch, batchRequested, busySettings=true, acceptedSettings=true, busyProject=true, busyChat=true, settingsPosts=0,loseBatch=false,batchPosts=0,lostBatchRequest,lostBatchResponse,releaseRecognition;
    page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text().slice(0,500));});
    page.on('response',response=>{const url=new URL(response.url());if(url.origin===origin&&(url.pathname.endsWith('.js')||url.pathname.startsWith('/api/pi/')))startupResponses.push({path:url.pathname,status:response.status()});});
    page.on('response',async response=>{const request=response.request(),pathname=new URL(response.url()).pathname;if(request.method()!=='GET'&&pathname.startsWith('/api/pi/compliance'))try{const value=await response.json();businessResponses.push({path:pathname,status:response.status(),input:pathname.endsWith('/batches')?JSON.parse(request.postData()):undefined,revision:value.revision,error:value.error,settings:value.extractionModel,batch:value.batch&&{id:value.batch.id,revision:value.batch.revision,configuration:value.batch.configurationSnapshot,execution:value.batch.execution,documents:value.batch.documents.map(d=>({id:d.id,name:d.name,assignment:d.assignment,processing:d.processing}))}});}catch{}});
    page.on('request',request=>{if(request.resourceType()==='font'){const url=new URL(request.url());pendingFonts.set(request,url.origin+url.pathname);}});
    for(const event of ['requestfinished','requestfailed'])page.on(event,request=>pendingFonts.delete(request));
    page.setDefaultTimeout(60000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, token, theme }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'ordinary'); sessionStorage.setItem('pi.web.token', token); localStorage.setItem('pi.workspace.theme', theme); }, { cwd, token, theme });
    await page.addInitScript(()=>{window.syntheticReadErrors=[];const read=FileReader.prototype.readAsDataURL;FileReader.prototype.readAsDataURL=function(file){this.addEventListener('error',()=>window.syntheticReadErrors.push({name:file.name,size:file.size,error:this.error?.name,message:this.error?.message}),{once:true});return read.call(this,file);};});
    if (width < 900) await page.addInitScript(() => { Object.defineProperty(crypto,'randomUUID',{value:undefined}); Object.defineProperty(crypto,'subtle',{value:undefined}); });
    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.abort());
    await page.route('**/api/**', async route => {
        const req = route.request(), endpoint = new URL(req.url()).pathname, json = data => route.fulfill({ json: data });
        if(endpoint==='/api/pi/compliance/settings'&&req.method()==='PUT') {
            settingsPosts++;
            if(busySettings){busySettings=false;return route.fulfill({status:409,json:{error:'设置请求尚未接纳',code:'COMPLIANCE_BUSY',operationAccepted:false}});}
            if(acceptedSettings){acceptedSettings=false;await route.fetch();return route.fulfill({status:409,json:{error:'设置请求已接纳，请查询原回执',code:'COMPLIANCE_BUSY',operationAccepted:true}});}
        }
        if(endpoint==='/api/pi/compliance/projects'&&req.method()==='POST'&&busyProject){busyProject=false;return route.fulfill({status:409,json:{error:'工程请求尚未接纳',code:'COMPLIANCE_BUSY',operationAccepted:false}});}
        if(endpoint==='/api/pi/compliance/sessions'&&req.method()==='POST'&&busyChat){busyChat=false;return route.fulfill({status:409,json:{error:'原生聊天请求尚未接纳',code:'COMPLIANCE_BUSY',operationAccepted:false}});}
        if(endpoint.startsWith('/api/pi/compliance/projects/')&&endpoint.endsWith('/batches')&&req.method()==='POST'){
            batchPosts++;
            if(loseBatch){loseBatch=false;lostBatchRequest=JSON.parse(req.postData());lostBatchResponse=route.fetch();lostBatchResponse.catch(()=>{});
                for(let n=0;n<300;n++){const response=await fetch(origin+'/api/pi/compliance/operations/'+lostBatchRequest.requestId,{headers:{Authorization:'Bearer '+token}});if(response.ok&&(await response.json()).status==='pending')return route.abort();await new Promise(resolve=>setTimeout(resolve,50));}
                throw new Error('actual check job did not publish its pending receipt');
            }
        }
        if(holdBatchId && endpoint === '/api/pi/compliance/batches/'+holdBatchId && req.method()==='GET') {
            holdBatchId=null; const response=await route.fetch();batchRequested();await new Promise(resolve=>{releaseBatch=()=>route.fulfill({response}).then(resolve);});return;
        }
        if (endpoint.startsWith('/api/pi/compliance') && endpoint.endsWith('/documents') && req.method() === 'POST') {
            importPosts++; if (busyImport) { busyImport = false; return route.fulfill({status:409,json:{error:'另一项资料导入仍在执行，尚未接纳本次导入',code:'COMPLIANCE_BUSY',operationAccepted:false}}); } if (loseImport) { loseImport = false; await route.fetch(); return route.abort(); }
        }
        if (endpoint.includes('/compliance/batches/') && endpoint.includes('/evidence/') && holdEvidence) {
            holdEvidence = false; const response = await route.fetch(); await new Promise(resolve => { releaseEvidence = () => { route.fulfill({response}).then(resolve); }; }); return;
        }
        if (endpoint === '/api/pi/compliance/sessions' && req.method() === 'POST') {
            const response = await route.fetch(), data = await response.json(); sessions.push(data); return route.fulfill({ response, json: data });
        }
        if (endpoint.startsWith('/api/pi/compliance') || endpoint === '/api/pi/profiles') return route.continue();
        if (endpoint === '/api/pi/status') return json({ ok: true, sessionWorkflows: true, projectRoots: [temporary] });
        if (endpoint === '/api/pi/projects') return json({ projects: [{ cwd, name: 'Synthetic compliance', sessionCount: sessions.length }], roots: [temporary] });
        if (endpoint === '/api/pi/sessions') return json({ sessions });
        if (endpoint === '/api/pi/activity') return json({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (endpoint === '/api/pi/settings/models') return json({ models, providers: [{ id: 'fixture', name: '合成服务' }], preferences: {} });
        if (endpoint.endsWith('/deferred')) return json({ jobs: [] });
        if (endpoint.endsWith('/workflow')) return json({ leafId: 'leaf', prompts: [], versions: [] });
        if (req.method() !== 'GET') throw new Error('Unexpected browser write: ' + endpoint);
        return json(endpoint.includes('history') ? [] : {});
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const cmd = JSON.parse(raw), state = { model: models[0], thinkingLevel: 'off', isStreaming: false, isCompacting: false };
        const send = data => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
        if (cmd.type === 'open_session') { active = cmd.sessionId; return send({ session: sessions.find(session => session.id === active), state, messages: { messages: [] }, stats: {}, models: { models }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } }); }
        if (cmd.type === 'get_messages') return send({ messages: [] });
        if (cmd.type === 'get_state') return send(state);
        if (cmd.type === 'get_session_stats') return send({});
        throw new Error('Unexpected RPC: ' + cmd.type);
    }));
    try {
        await page.goto(origin + '/#/settings?tab=builtins', { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction(() => document.querySelector('#compliance-enabled')?.getBoundingClientRect().width > 0, null, { timeout: 60000 });
        assert.equal(new URL(page.url()).hash, '#/extensions?tab=builtins', 'legacy settings bookmarks open business tools');
        assert.equal(await page.locator('#extensions-nav [data-extensions-tab="builtins"]').getAttribute('aria-current'), 'page');
        await page.locator('#extensions-nav [data-extensions-tab="extensions"]').click();
        await page.locator('#extensions-nav [data-extensions-tab="builtins"]').click();
        await page.locator('#compliance-enabled').waitFor();
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        console.log(`compliance ${width}: settings ready`);
        await page.locator('#compliance-enabled').waitFor(); assert.equal(await page.locator('#compliance-enabled').isChecked(), false);
        await page.locator('#compliance-enabled').check(); await page.locator('#compliance-main-model').selectOption('fixture/text'); await page.locator('#compliance-extraction-model').selectOption('');
        await page.locator('#compliance-save').click();await page.waitForFunction(()=>document.querySelector('#compliance-settings-status')?.textContent.includes('设置请求尚未接纳'));
        await page.locator('#compliance-save').click();await page.waitForFunction(()=>document.querySelector('#compliance-settings-status')?.textContent.includes('设置请求已接纳'));
        await page.locator('#compliance-save').click(); await page.locator('#compliance-open-chat').waitFor({ state: 'visible' });assert.equal(settingsPosts,2,'accepted settings error recovers its durable receipt without a third POST');
        console.log(`compliance ${width}: enabled`);
        assert.match(await page.locator('#compliance-settings-status').textContent(), /已启用/);
        assert.match(await page.locator('#compliance-settings-status').textContent(), /部分可用/);
        const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
        const setting = await (await fetch(origin + '/api/pi/compliance', { headers: auth })).json();
        assert.equal((await fetch(origin + '/api/pi/compliance/settings', { method: 'PUT', headers: auth, body: JSON.stringify({ requestId: 'other-settings-' + width, expectedRevision: setting.revision, enabled: true }) })).status, 200);
        await page.locator('#compliance-extraction-model').selectOption('fixture/vision'); await page.locator('#compliance-save').click();
        await page.waitForFunction(() => document.querySelector('#compliance-settings-status')?.textContent.includes('已变化'));
        await page.locator('#compliance-save').click();
        await page.waitForFunction(() => document.querySelector('#compliance-settings-status')?.textContent.includes('已启用') && document.querySelector('#compliance-settings-status')?.textContent.includes('本地条件可用'));
        assert.equal((await (await fetch(origin + '/api/pi/compliance', { headers: auth })).json()).extractionModel.modelId, 'vision');
        await page.locator('#compliance-open-chat').click();await page.getByText('原生聊天请求尚未接纳',{exact:true}).waitFor();
        await page.locator('#compliance-open-chat').click();
        await page.locator('#pi-compliance-open').waitFor({ state: 'visible' }); assert.notEqual(active, 'ordinary');
        console.log(`compliance ${width}: dedicated chat ready`);
        await page.locator('#pi-input').fill('保留我的草稿');
        const triggerState=await page.locator('#pi-compliance-open').evaluate(el=>{
            const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
            return {rect:rect.toJSON(),hidden:el.hidden,disabled:el.disabled,display:style.display,visibility:style.visibility,transform:style.transform,
                ancestors:[...function*(start){for(let p=start;p;p=p.parentElement)yield p;}(el)].map(p=>({tag:p.tagName,id:p.id,hidden:p.hidden,inert:p.inert,rect:p.getBoundingClientRect().toJSON(),display:getComputedStyle(p).display})),
                overlays:document.elementsFromPoint(rect.x+rect.width/2,rect.y+rect.height/2).map(p=>({id:p.id,tag:p.tagName})),animations:document.getAnimations().filter(a=>a.playState==='running').length,hash:location.hash,
                fonts:{status:document.fonts.status,faces:[...document.fonts].map(font=>({family:font.family,status:font.status}))}};});
        fs.writeFileSync(path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR||os.tmpdir(),'compliance-trigger-'+width+'.json'),JSON.stringify({active,sessions,triggerState,pendingFonts:[...pendingFonts.values()]},null,2));
        await page.screenshot({path:path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR||os.tmpdir(),'compliance-trigger-'+width+'.png'),timeout:10000}).catch(error=>console.warn('Optional trigger diagnostic screenshot: '+error.message));
        await page.locator('#pi-compliance-open').click();
        await page.locator('#compliance-project-new').click(); await page.locator('#compliance-project-name').fill('工程 <script> ' + width);
        await page.locator('#compliance-project-number').fill('C-' + width); await page.locator('#compliance-project-confirmed').check();
        await page.getByLabel('合同签订期限', { exact: true }).selectOption('yes');
        await page.getByLabel('资料缺失与归属', { exact: true }).selectOption('yes');
        await page.getByLabel('可研评审及批复文号', { exact: true }).selectOption('no');
        await page.getByLabel('可研与评审时序', { exact: true }).selectOption('no');
        const projectState = await (await fetch(origin + '/api/pi/compliance/projects', { headers: auth })).json();
        assert.equal((await fetch(origin + '/api/pi/compliance/projects', { method: 'POST', headers: auth, body: JSON.stringify({ requestId: 'other-project-' + width, expectedRevision: projectState.revision, project: { name: '另一个聊天的工程' } }) })).status, 200);
        await page.locator('#compliance-project-save').click();
        await page.waitForFunction(()=>document.querySelector('#compliance-project-status')?.textContent.includes('工程请求尚未接纳'));await page.locator('#compliance-project-save').click();
        await page.waitForFunction(() => document.querySelector('#compliance-project-status')?.textContent.includes('已变化'));
        await page.locator('#compliance-project-save').click();
        await page.waitForFunction(width => document.querySelector('#pi-compliance-drawer').textContent.includes('C-' + width), width);
        assert.equal(await page.locator('#compliance-project-organization').inputValue(), '');
        assert.match(await page.locator('#compliance-project-status').textContent(), /已保存/);
        console.log(`compliance ${width}: project saved`);
        const name = '工程 <script> ' + width;
        await page.locator('#compliance-upload').setInputFiles(fixtureFiles(['中标通知书', '合同'].map((title, index) => ({ name: title + '.csv', buffer: Buffer.from(`项目名称,项目编号,日期\n${name},C-${width},2026-08-${index ? '31' : '01'}\n`) }))));
        await page.locator('#compliance-import-upload').click();
        await page.waitForFunction(() => document.querySelector('#compliance-material-status')?.textContent.includes('尚未接纳本次导入'));
        assert.equal(await page.locator('[data-compliance-document]').count(),0,'definite busy rejects without publishing any document');
        loseImport = width > 900;
        await page.locator('#compliance-import-upload').click();
        if (width > 900) { await page.waitForFunction(() => document.querySelector('#compliance-material-status')?.textContent.includes('Failed') || document.querySelector('#compliance-material-status')?.textContent.includes('fetch')); await page.locator('#compliance-import-upload').click(); }
        await page.waitForFunction(() => document.querySelectorAll('[data-compliance-document]').length === 2);
        assert.equal(importPosts,3,'definite busy permits an explicit retry; lost response recovers receipt without resending');
        for (const [title, role] of [['中标通知书.csv', 'award-notice'], ['合同.csv', 'contract']]) {
            const row = page.locator('[data-compliance-document]').filter({ hasText: title });
            await row.locator('select').selectOption(role); await row.getByLabel('归属已核对').check(); await row.getByLabel('选用于新批次').check(); await row.getByRole('button', { name: '保存资料核对' }).click();
            await page.waitForFunction(() => document.querySelector('#compliance-material-status')?.textContent.includes('已保存资料核对'));
        }
        await page.locator('#compliance-run-check').click();
        await page.waitForFunction(() => document.querySelector('#compliance-results')?.textContent.includes('合同签订期限：通过'));
        if (width > 900) {
            holdEvidence = true; await page.locator('#compliance-results').getByRole('button',{name:'查看证据'}).first().click();
            await page.waitForTimeout(50); assert.equal(typeof releaseEvidence,'function'); await page.locator('#pi-compliance-close').click(); releaseEvidence();
            await page.waitForTimeout(50); assert.equal(await page.locator('#pi-compliance-drawer').isVisible(),false);
            await page.locator('#pi-compliance-open').click(); await page.waitForFunction(() => document.querySelector('#compliance-results')?.textContent.includes('合同签订期限：通过'));
        }
        await page.locator('#compliance-results').getByRole('button', { name: '查看证据' }).first().click();
        await page.waitForFunction(()=>document.querySelector('#compliance-evidence')?.textContent.includes('2026-08-01')); assert.match(await page.locator('#compliance-evidence').textContent(), /2026-08-01/);
        assert.equal(await page.locator('#pi-compliance-drawer').evaluate(el => [...el.querySelectorAll('input,select,textarea')].every(input => input.getBoundingClientRect().width <= el.clientWidth)), true);
        assert.equal(await page.locator('#pi-input').inputValue(),'保留我的草稿');
        await page.locator('#compliance-budget-pages').fill('1');
        await page.locator('#compliance-run-check').click();
        await page.waitForFunction(()=>document.querySelector('#compliance-execution')?.textContent.includes('页数预算已用完'));
        assert.match(await page.locator('#compliance-execution').textContent(),/实际费用未知/);
        await page.locator('#compliance-continue').click();
        await page.waitForFunction(()=>document.querySelector('#compliance-execution')?.textContent.includes('执行完成'));
        assert.match(await page.locator('#compliance-results').textContent(),/合同签订期限：通过/);
        const projects=(await(await fetch(origin+'/api/pi/compliance/projects',{headers:auth})).json()).projects;
        const project=projects.find(p=>p.number==='C-'+width), history=(await(await fetch(origin+'/api/pi/compliance/projects/'+project.id+'/batches',{headers:auth})).json()).batches;
        const oldBatch=history[0].id,newBatch=history.at(-1).id;assert.notEqual(oldBatch,newBatch);
        holdBatchId=oldBatch;const requested=new Promise(resolve=>{batchRequested=resolve;});
        const historySelect=page.locator('.compliance-materials label').filter({hasText:'历史批次'}).locator('select');await historySelect.selectOption(oldBatch);await requested;
        await historySelect.selectOption(newBatch);await page.waitForFunction(id=>document.querySelector('#compliance-results')?.textContent.includes(id),newBatch);
        const late=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/pi/compliance/batches/'+oldBatch);await releaseBatch();await late;await page.waitForTimeout(80);
        assert.ok((await page.locator('#compliance-results').textContent()).includes(newBatch),'a late old batch response cannot replace the user’s latest selected batch or its report/review operations');
        // External model boundary is synthetic here; real runtime/provider request
        // capture and process-kill recovery are exercised at their approved seam.
        for(const title of ['中标通知书.csv','合同.csv']){const row=page.locator('[data-compliance-document]').filter({hasText:title});await row.getByLabel('选用于新批次').uncheck();await row.getByRole('button',{name:'保存资料核对'}).click();await page.waitForFunction(()=>document.querySelector('#compliance-material-status')?.textContent.includes('已保存资料核对'));}
        const canvas=require('@napi-rs/canvas').createCanvas(100,80);canvas.getContext('2d').fillRect(5,5,30,20);
        const scanSources=[{name:'扫描通知书.png',mimeType:'image/png',buffer:canvas.toBuffer('image/png')}];canvas.getContext('2d').fillRect(60,5,20,20);scanSources.push({name:'扫描合同.png',mimeType:'image/png',buffer:canvas.toBuffer('image/png')});
        await page.locator('#compliance-upload').setInputFiles(fixtureFiles(scanSources));
        await page.locator('#compliance-import-upload').click();await page.waitForFunction(()=>document.querySelectorAll('[data-compliance-document]').length===4);
        for(const [title,role] of [['扫描通知书.png','award-notice'],['扫描合同.png','contract']]){const row=page.locator('[data-compliance-document]').filter({hasText:title});await row.locator('select').selectOption(role);await row.getByLabel('归属已核对').check();await row.getByLabel('选用于新批次').check();await row.getByRole('button',{name:'保存资料核对'}).click();await page.waitForFunction(()=>document.querySelector('#compliance-material-status')?.textContent.includes('已保存资料核对'));}
        const configure=async ref=>{const latest=await(await fetch(origin+'/api/pi/compliance',{headers:auth})).json();const saved=await fetch(origin+'/api/pi/compliance/settings',{method:'PUT',headers:auth,body:JSON.stringify({requestId:'browser-model-'+width+'-'+require('node:crypto').randomUUID(),expectedRevision:latest.revision,enabled:true,extractionModel:ref})});assert.equal(saved.status,200);await page.getByRole('button',{name:'刷新资料和批次',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#compliance-material-status')?.textContent.includes('已刷新'));await page.locator('#compliance-run-check').click();};
        await page.locator('#compliance-budget-pages').fill('200');
        await configure(null);await page.waitForFunction(()=>document.querySelector('#compliance-results')?.textContent.includes('未配置扫描识别模型'));
        await page.locator('#compliance-budget-calls').fill('1');
        recognitionGate=new Promise(resolve=>{releaseRecognition=resolve;});loseBatch=true;const postsBeforePending=batchPosts,batchesBeforePending=(await(await fetch(origin+'/api/pi/compliance/projects/'+project.id+'/batches',{headers:auth})).json()).batches.length;
        await configure({provider:'fixture',modelId:'vision'});
        await page.waitForFunction(()=>/Failed|fetch/.test(document.querySelector('#compliance-material-status')?.textContent||''));
        const pendingKey='pivane.compliance.operation:'+project.id+':/projects/'+project.id+'/batches';
        for(let attempt=0;attempt<2;attempt++){
            const queried=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/pi/compliance/operations/'+lostBatchRequest.requestId);
            await page.locator('#compliance-run-check').click();assert.equal((await(await queried).json()).status,'pending');
            await page.waitForFunction(()=>document.querySelector('#compliance-run-check')?.matches(':enabled'));
            assert.equal(await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)||'null')?.requestId,pendingKey),lostBatchRequest.requestId,'a pending original check keeps its operation ID until the durable terminal receipt');
            assert.equal(batchPosts,postsBeforePending+1,'repeated clicks only query the accepted original check');
        }
        releaseRecognition();recognitionGate=null;assert.equal((await lostBatchResponse).status(),200);
        await page.locator('#compliance-run-check').click();
        if(width<900){await page.waitForFunction(()=>document.querySelector('#compliance-material-status')?.textContent.includes('原操作已核对'));await page.getByRole('button',{name:'刷新资料和批次',exact:true}).click();}
        await page.waitForFunction(()=>document.querySelector('#compliance-execution')?.textContent.includes('模型调用预算已用完'));
        assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),pendingKey),null);assert.equal(batchPosts,postsBeforePending+1);
        assert.equal((await(await fetch(origin+'/api/pi/compliance/projects/'+project.id+'/batches',{headers:auth})).json()).batches.length,batchesBeforePending+1,'receipt recovery does not create a second batch');
        await page.locator('#compliance-execution').scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR||os.tmpdir(),'compliance-scan-budget-'+width+'.png')});
        await page.locator('#compliance-continue').click();await page.waitForFunction(()=>document.querySelector('#compliance-results')?.textContent.includes('合同签订期限：通过'));
        await page.locator('#compliance-results').getByRole('button',{name:'查看证据'}).first().click();await page.waitForFunction(()=>document.querySelector('#compliance-evidence')?.textContent.includes('扫描')&&document.querySelector('#compliance-evidence')?.textContent.includes('第 1 页'));assert.match(await page.locator('#compliance-evidence').textContent(),/第 1 页/);
        await page.screenshot({path:path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR||os.tmpdir(),'compliance-scan-evidence-'+width+'.png')});
        await page.locator('#compliance-budget-calls').fill('20');failRecognition=true;await page.locator('#compliance-run-check').click();await page.waitForFunction(()=>document.querySelector('#compliance-execution > strong')?.textContent.startsWith('请求待核对'));await page.waitForFunction(()=>document.querySelector('#compliance-material-status')?.textContent.includes('已保存检查进度'));const uncertainCalls=browserModelCalls;
        await page.locator('#compliance-continue').click();await page.waitForFunction(()=>document.querySelector('#compliance-material-status')?.textContent.includes('已保存继续执行'));assert.equal(browserModelCalls,uncertainCalls,'continuation never replays uncertain model calls');failRecognition=false;
        assert.equal(await page.locator('#pi-compliance-drawer script').count(), 0);
        assert.ok(await page.locator('#compliance-project-name').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 16));
        await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR || os.tmpdir(), 'compliance-' + width + '.png') });
        assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false);
        assert.equal(await page.locator('#pi-compliance-drawer').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
        await page.locator('#pi-compliance-close').click();
        await page.evaluate(() => { location.hash = '#/settings?tab=builtins'; });
        await page.locator('#compliance-enabled').waitFor({ state: 'visible' }); await page.locator('#compliance-enabled').uncheck(); await page.locator('#compliance-save').click();
        await page.waitForFunction(() => document.querySelector('#compliance-settings-status')?.textContent.includes('已停用'));
        assert.equal(await page.locator('#compliance-open-chat').isVisible(), false);
        await page.evaluate(() => { location.hash = '#/chat'; }); assert.equal(await page.locator('#pi-compliance-open').isVisible(), false);
        assert.deepEqual(errors, []); console.log(`compliance ${width} ${theme}: actual authenticated settings, dedicated session, project drawer, persistence and disable passed`);
    } catch (error) {fs.writeFileSync(path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR||os.tmpdir(),'compliance-business-'+width+'.json'),JSON.stringify({businessResponses,startupResponses,consoleErrors,startup:await page.evaluate(()=>({readyState:document.readyState,title:document.title,body:document.body.innerText.slice(0,1500),settings:document.querySelector('#compliance-settings-status')?.textContent||null})),execution:await page.evaluate(()=>document.querySelector('#compliance-execution')?.textContent||null)},null,2)); console.error({ errors, url: page.url(), message: error.message, status:await page.evaluate(()=>document.querySelector('#compliance-material-status')?.textContent||null),fileErrors:await page.evaluate(()=>window.syntheticReadErrors).catch(()=>null) }); await page.screenshot({path:path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR||os.tmpdir(),'compliance-failure-'+width+'.png'),timeout:10000}).catch(()=>{});throw error; }
    finally { releaseRecognition?.();recognitionGate=null;await lostBatchResponse?.catch(()=>{});await context.close(); }
}
(async () => {
    const app = express();
    for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', directory)));
    app.use(express.static(path.join(root, 'public')));
    access.mount(app); app.use(express.json({ limit: '32mb' }));
    const router = express.Router(); router.use(access.middleware()); mountCompliance(router, service);
    router.get('/profiles', async (_req, res) => res.json(await profiles.list())); app.use('/api/pi', router);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR || os.tmpdir(), { recursive: true });
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const width of selectBrowserTargets((process.env.PIVANE_COMPLIANCE_WIDTHS || '1440,393').split(',').map(Number))) await run(browser, `http://127.0.0.1:${server.address().port}`, width, width < 900 ? 'dark' : 'daylight'); }
    finally { await browser.close(); await service.dispose(); await documents.dispose(); access.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
