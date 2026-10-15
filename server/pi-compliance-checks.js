const { randomUUID } = require('node:crypto');
const { fail, request, fingerprint, pendingCount } = require('./pi-compliance-ledger');
const { RULE_PACKAGE, evaluate, date } = require('./pi-compliance-rules');
const ROLES = ['award-notice', 'contract', 'feasibility-report', 'feasibility-review', 'feasibility-approval', 'register', 'unknown'];
const LABELS = { projectName: ['项目名称', '工程项目名称', 'Project name'], projectNumber: ['项目编号', '工程项目编号', 'Project number'], organization: ['单位', '建设单位'], year: ['年度'], phase: ['期次'], date: ['日期', '签订日期', '合同签订日期', '中标通知书日期', '报告日期', '评审日期', '批复日期', 'Date'], documentNumber: ['文号', '发文字号', 'Document number'] };
const only = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw fail('检查参数无效'); };
const keyFor = label => Object.keys(LABELS).find(key => LABELS[key].includes(label.trim()));
const columnOf = (cell, index) => cell.column || (cell.address ? [...cell.address.match(/^[A-Z]+/)[0]].reduce((n,c) => n*26+c.charCodeAt(0)-64,0) : index+1);
function candidates(documentId, entries) {
    const output = [];
    for (const key of Object.keys(LABELS)) {
        const values = entries.filter(e => e.key === key), distinct = [...new Set(values.map(v => v.raw.trim()))];
        if (!values.length) continue;
        const raw = distinct.join(' / '), parsed = key === 'date' ? date(raw) : null;
        output.push({ id: randomUUID(), documentId, key, raw, value: key === 'date' ? parsed?.value || null : distinct.length === 1 ? raw : null,
            precision: parsed?.precision || null, status: distinct.length > 1 ? 'conflict' : key === 'date' && !parsed ? 'unknown' : 'known',
            location: values[0].location, candidates: values.map(v => ({ raw: v.raw, location: v.location })) });
    }
    return output;
}
class ComplianceChecks {
    constructor(service, documents) { this.service = service; this.documents = documents; this.jobs = new Map(); }
    assign(documentId, input) {
        only(input, ['requestId', 'expectedRevision', 'role', 'identityConfirmed', 'selected', 'numberAbsentConfirmed']); request(input);
        if (!ROLES.includes(input.role) || typeof input.identityConfirmed !== 'boolean' || typeof input.selected !== 'boolean' || input.numberAbsentConfirmed !== undefined && typeof input.numberAbsentConfirmed !== 'boolean') throw fail('请明确核对资料角色、归属和选用版本');
        return this.service.reserve(() => this.service.ledger.commit('assignment:' + documentId, input, state => {
            this.service.assertEnabled(state); const document = (state.documents || []).find(d => d.id === documentId); if (!document) throw fail('资料不存在', 404);
            document.assignment = { role: input.role, identityConfirmed: input.identityConfirmed, selected: input.selected, numberAbsentConfirmed: input.numberAbsentConfirmed === true };
            return { ok: true, document };
        }));
    }
    async extract(document) {
        if (!this.documents?.pool) throw fail('共享文档解析服务不可用', 503);
        const { base64 } = await this.service.materials.content(document.id), bytes = Buffer.from(base64, 'base64'), entries = [], pool = this.documents.pool;
        if (!['pdf', 'xlsx', 'csv'].includes(document.format)) return { fields: [], processing: { status: 'unreadable', reason: '图片需要配置扫描识别；当前没有执行 OCR' } };
        const info = await pool.run(bytes, document.format, { action: 'inspect' }); let complete = true, pageCount = 0;
        if (document.format === 'pdf') {
            if (info.total > 200) return { fields: [], processing: { status: 'unreadable', reason: '文本检查最多二百页，请缩小范围' } };
            for (let start = 1; start <= info.total; start += 10) {
                const data = await pool.run(bytes, 'pdf', { action: 'read', start, count: 10, provenance: true }); complete &&= !data.truncated;
                for (const page of data.items) {
                    pageCount++; const location = { page: page.index, region: 'body', excerpt: page.text.slice(0, 2000) };
                    for (const line of page.text.split(/\r?\n/)) {
                        const matched = /^\s*([^:：]{1,40})\s*[:：]\s*(.{1,300}?)\s*$/.exec(line); const key = matched && keyFor(matched[1]);
                        if (key && key !== 'documentNumber') entries.push({ key, raw: matched[2], location });
                    }
                    if (page.index === 1 && !page.provenanceTruncated) {
                        const upper = (page.runs || []).filter(run => run.region === 'upper'), text = upper.map(run => run.text).join(' ');
                        const number = /(?:文号|发文字号)\s*[:：]\s*([^\s]{1,30}[〔\[（(]\d{4}[〕\]）)]\s*\d+\s*号)/.exec(text);
                        if (number) entries.push({ key: 'documentNumber', raw: number[1], location: { page: 1, region: 'upper', viewport: page.viewport, rects: upper.map(run => run.rect).slice(0, 100), excerpt: text.slice(0, 2000) } });
                    }
                }
            }
        } else {
            for (const sheet of info.sheets) {
                let headers;
                for (let start = 1; start <= 10000; start += 100) {
                    const data = await pool.run(bytes, document.format, { action: 'read', sheet: document.format === 'xlsx' ? sheet.name : undefined, start, count: 100, columns: 50 });
                    complete &&= !data.truncated;
                    for (const row of data.rows) {
                        if (row.index === 1) { headers = row.cells.map((cell, index) => ({ column: columnOf(cell,index), key: keyFor(cell.value), address: cell.address })); continue; }
                        if (!headers) { complete = false; continue; }
                        row.cells.forEach((cell, index) => {
                            const column = columnOf(cell,index), header = headers.find(h => h.column === column);
                            if (header?.key && cell.value?.trim() && !cell.formula && ['s', 'str', 'inlineStr'].includes(cell.type) && !cell.truncated)
                                entries.push({ key: header.key, raw: cell.value.trim(), location: { sheet: sheet.name, row: row.index, column, address: cell.address || null, excerpt: cell.value.slice(0, 2000) } });
                        });
                    }
                    if (!data.nextStart) break; if (start + 100 > 10000) complete = false;
                }
            }
        }
        const fields = candidates(document.id, entries);
        if (!complete) fields.forEach(field => { field.status = 'unknown'; field.value = null; });
        return { fields, processing: { status: complete ? 'completed' : 'unreadable', reason: complete ? '仅提取明确标签及固定表头，未匹配内容保留未知' : '文本超过完整读取预算，不能据截断内容确定结论', pages: pageCount } };
    }
    async ready() {
        if (!this.initializing) { this.recovering=true; this.initializing = (async () => {
            const { root } = await this.service.ledger.paths(true);
            this.lease = await require('./pi-compliance-lock').acquire(root, 'jobs');
            await this.service.ledger.transact(state => {
                for (const batch of state.batches || []) if (batch.execution.status === 'running') {
                    batch.execution.status = 'needs-review'; batch.execution.reason = 'restart';
                    for (const step of batch.execution.steps || []) if (step.status === 'running') { step.status = 'uncertain'; step.reason = '服务中断，请求结果待核对，未自动重发'; }
                    batch.revision++;
                }
            });
        })().finally(()=>{this.recovering=false;}); }
        return this.initializing;
    }
    async dispose() { await Promise.allSettled([...this.jobs.values()].map(j => j.promise)); await this.initializing?.catch(() => {}); await this.lease?.close(); }
    budget(input, defaults = { pages: 200, modelCalls: 20, runMs: 600000 }) {
        const value = input === undefined ? defaults : input; only(value, ['pages','modelCalls','runMs']);
        for (const [key, maximum] of [['pages',2000],['modelCalls',200],['runMs',3600000]])
            if (!Number.isSafeInteger(value[key]) || value[key] < (key === 'runMs' ? 1000 : 1) || value[key] > maximum) throw fail('预算须为页数 1–2000、模型调用 1–200、运行毫秒 1000–3600000');
        return structuredClone(value);
    }
    launch(projectId, action) {
        if (this.jobs.has(projectId) || this.jobs.size >= 2 || this.service.closed || this.service.isSuspended()) throw fail('该工程项目已有检查，或实例检查额度已占用',409,'COMPLIANCE_BUSY');
        const job = {}; this.jobs.set(projectId,job);
        job.promise = Promise.resolve().then(action).catch(async error => {
            if(this.lease) await this.service.ledger.transact(state=>{
                for(const batch of state.batches||[])if(batch.projectId===projectId&&batch.execution.status==='running'){
                    batch.execution.status='needs-review';batch.execution.reason='checkpoint-failed';batch.revision++;
                    for(const step of batch.execution.steps||[])if(step.status==='running'){step.status='uncertain';step.reason='检查点写入失败，请求结果待核对，未自动重发';}
                }
            }).catch(()=>{});
            throw error;
        }).finally(() => this.jobs.delete(projectId));
        return job.promise;
    }
    async checkpoint(batch, update) {
        return this.service.ledger.transact(state => {
            const index = state.batches.findIndex(b => b.id === batch.id);
            if (index < 0 || state.batches[index].revision !== batch.revision) throw fail('检查批次已变化，请重新核对',409,'COMPLIANCE_STALE');
            batch.execution.pauseRequested ||= state.batches[index].execution.pauseRequested;
            batch.execution.stopReason = state.batches[index].execution.stopReason || batch.execution.stopReason;
            batch.revision++; batch.results = evaluate(batch); batch.review = {status:'unreviewed'};
            state.batches[index] = structuredClone(batch); update?.(state);
        });
    }
    create(projectId, input, worker) {
        only(input,['requestId','expectedRevision','budget']); request(input); const budget = this.budget(input.budget);
        return this.launch(projectId, async () => {
            await this.ready(); const ledger = this.service.ledger;
            const state = await ledger.snapshot(), prior = ledger.receipt(state,'batch:' + projectId,input); if (prior) return prior;
            const pending = Object.hasOwn(state.checkOperations || {},input.requestId) ? state.checkOperations[input.requestId] : null;
            if (pending) {
                if (pending.fingerprint !== fingerprint('batch:' + projectId,input)) throw fail('操作编号已用于不同内容',409,'COMPLIANCE_CONFLICT');
                return {status:'pending',batch:(state.batches || []).find(b=>b.id===pending.batchId),revision:state.revision};
            }
            const batch = { id:randomUUID(),revision:1,projectId,projectSnapshot:structuredClone(this.service.materials.project(state,projectId)),
                documents:structuredClone((state.documents||[]).filter(d=>d.projectId===projectId&&d.assignment?.selected)),rulePackage:structuredClone(RULE_PACKAGE),
                configurationSnapshot:{mainModel:state.settings.mainModel,extractionModel:state.settings.extractionModel,parserVersion:'local-labeled-1'},
                fields:[],results:[],execution:{status:'running',reason:null,budget,usage:{pages:0,modelCalls:0,imageBytes:0,elapsedMs:0,inputTokens:null,outputTokens:null,cost:{actual:null,estimate:null,currency:'USD',basis:'unknown'}},steps:[]},review:{status:'unreviewed'},createdAt:new Date().toISOString() };
            for (const doc of batch.documents) {
                doc.processing={status:'unreadable',reason:'尚未处理'};
                batch.execution.steps.push({id:randomUUID(),documentId:doc.id,hash:doc.hash,kind:['pdf','xlsx','csv'].includes(doc.format)?'text':'recognition',page:1,status:'pending'});
            }
            await this.service.reserve(()=>ledger.transact(current=>{
                const old=ledger.receipt(current,'batch:' + projectId,input);if(old)throw fail('操作已完成，请查询回执',409);
                ledger.assertRevision(current,input);this.service.assertEnabled(current);current.batches||=[];if(current.batches.length>=500)throw fail('检查批次达到五百上限',413);
                if(Object.keys(current.checkOperations||{}).length>=500||Object.keys(current.receipts).length+pendingCount(current,input.requestId)>=10000)throw fail('未完成检查操作达到上限',413);
                current.batches.push(structuredClone(batch));current.checkOperations||={};
                Object.defineProperty(current.checkOperations,input.requestId,{value:{batchId:batch.id,kind:'batch:' + projectId,fingerprint:fingerprint('batch:' + projectId,input)},enumerable:true,writable:true,configurable:true});
            }));
            return this.run(batch,input,'batch:' + projectId,worker);
        });
    }
    async continue(batchId,input,worker) {
        only(input,['requestId','expectedRevision','budget']); request(input); const allowance=this.budget(input.budget);
        await this.ready(); const saved=await this.get(batchId);
        return this.launch(saved.batch.projectId,async()=>{
            const ledger=this.service.ledger,state=await ledger.snapshot(),kind='batch-continue:' + batchId,prior=ledger.receipt(state,kind,input); if(prior)return prior;
            if(Object.hasOwn(state.checkOperations || {},input.requestId)) {
                if(state.checkOperations[input.requestId].fingerprint!==fingerprint(kind,input))throw fail('操作编号冲突',409,'COMPLIANCE_CONFLICT');
                return {status:'pending',...(await this.get(batchId))};
            }
            const batch=structuredClone((state.batches||[]).find(b=>b.id===batchId));
            if(!['paused','needs-review'].includes(batch.execution.status))throw fail('当前批次没有可继续的暂停步骤',409);
            await this.service.reserve(()=>ledger.transact(current=>{
                ledger.receipt(current,kind,input);this.service.assertEnabled(current);ledger.assertRevision(current,input);
                if(current.batches.find(b=>b.id===batchId).revision!==batch.revision)throw fail('批次已变化',409,'COMPLIANCE_STALE');
                for(const key of ['pages','modelCalls','runMs'])batch.execution.budget[key]+=allowance[key];
                if(batch.execution.budget.pages>10000||batch.execution.budget.modelCalls>1000||batch.execution.budget.runMs>86400000)throw fail('累计批次预算达到上限',413);
                batch.execution.status='running';batch.execution.reason=null;batch.execution.pauseRequested=false;batch.execution.stopReason=null;batch.revision++;
                current.batches[current.batches.findIndex(b=>b.id===batchId)]=structuredClone(batch);
                current.checkOperations||={};if(Object.keys(current.checkOperations).length>=500||Object.keys(current.receipts).length+pendingCount(current,input.requestId)>=10000)throw fail('检查操作记录达到上限',413);Object.defineProperty(current.checkOperations,input.requestId,{value:{batchId,kind,fingerprint:fingerprint(kind,input)},enumerable:true,writable:true,configurable:true});
            }));
            return this.run(batch,input,kind,worker);
        });
    }
    pause(batchId,input) {
        only(input,['requestId','expectedRevision']);request(input);
        return this.service.reserve(()=>this.service.ledger.commit('batch-pause:' + batchId,input,state=>{
            const batch=(state.batches||[]).find(b=>b.id===batchId);if(!batch)throw fail('检查批次不存在',404);
            if(batch.execution.status!=='running')throw fail('当前批次没有运行中的步骤',409);
            batch.execution.pauseRequested=true;batch.execution.stopReason||='requested';return {ok:true,batchId,status:'pausing'};
        }));
    }
    async run(batch,input,kind,worker) {
        const execution=batch.execution,usage=execution.usage,started=performance.now(),beforeElapsed=usage.elapsedMs,ledger=this.service.ledger;
        const elapsed=()=>{usage.elapsedMs=beforeElapsed+Math.ceil(performance.now()-started);};
        for(let index=0;index<execution.steps.length;index++) {
            if(execution.status!=='running')break;const step=execution.steps[index];if(step.status!=='pending')continue;
            const state=await ledger.snapshot(),persisted=state.batches.find(b=>b.id===batch.id);elapsed();
            let pause=this.service.closed?'shutdown':!state.settings.enabled?'disabled':this.service.isSuspended()?'maintenance':persisted.execution.pauseRequested?(persisted.execution.stopReason||'requested'):usage.elapsedMs>=execution.budget.runMs?'budget-time':null;
            if(!pause&&step.kind==='recognition'&&usage.modelCalls>=execution.budget.modelCalls)pause='budget-modelCalls';
            if(!pause&&usage.pages>=execution.budget.pages)pause='budget-pages';
            if(pause){execution.status='paused';execution.reason=pause;break;}
            const doc=batch.documents.find(d=>d.id===step.documentId);
            if(step.kind==='recognition'&&!batch.configurationSnapshot.extractionModel){
                try { await this.service.materials.content(doc.id); step.status='blocked';step.reason='未配置扫描识别模型；文本检查仍可使用';doc.processing={status:'unreadable',reason:step.reason}; }
                catch(error){step.status='failed';step.reason=String(error.message).slice(0,500);doc.processing={status:'failed',reason:step.reason};}
                continue;
            }
            let pageCost=1;
            try {
                if(step.kind==='text'&&doc.format==='pdf') {
                    const {base64}=await this.service.materials.content(doc.id);const info=await this.documents.pool.run(Buffer.from(base64,'base64'),'pdf',{action:'inspect'});pageCost=info.total;
                }
                if(usage.pages+pageCost>execution.budget.pages){execution.status='paused';execution.reason='budget-pages';break;}
                step.status='running';step.startedAt=new Date().toISOString();usage.pages+=pageCost;

                await this.checkpoint(batch);
                if(step.kind==='text') {
                    const extracted=await this.extract(doc);doc.processing=extracted.processing;batch.fields.push(...extracted.fields);
                    const role=doc.assignment.role, needed=['feasibility-review','feasibility-approval'].includes(role)?['date','documentNumber']:['award-notice','contract','feasibility-report'].includes(role)?['date']:[];
                    const missing=needed.filter(key=>!extracted.fields.some(f=>f.key===key&&f.status==='known'));
                    if(doc.format==='pdf'&&batch.configurationSnapshot.extractionModel&&(!extracted.fields.length||missing.length||extracted.processing.status==='unreadable')) {
                        const last=missing.length===1&&missing[0]==='documentNumber'?1:pageCost;
                        for(let page=1;page<=last;page++)execution.steps.push({id:randomUUID(),documentId:doc.id,hash:doc.hash,kind:'recognition',page,status:'pending'});
                        doc.processing={status:'unreadable',reason:'扫描页面待识别'};
                    }
                } else {
                    const {base64}=await this.service.materials.content(doc.id);
                    const image=await this.documents.pool.run(Buffer.from(base64,'base64'),doc.format,{page:step.page},{render:true});
                    const output=await require('./pi-compliance-recognition').recognize(this.service,batch,doc,image,async()=>{const now=await ledger.snapshot();elapsed();const reason=this.service.closed?'shutdown':!now.settings.enabled?'disabled':now.batches.find(b=>b.id===batch.id).execution.pauseRequested?(now.batches.find(b=>b.id===batch.id).execution.stopReason||'requested'):this.service.isSuspended()?'maintenance':usage.elapsedMs>=execution.budget.runMs?'budget-time':null;if(reason){execution.status='paused';execution.reason=reason;throw fail('当前步骤已保存，未启动模型请求',409,'COMPLIANCE_STEP_PAUSED');}const encoded=Buffer.byteLength(image.base64,'ascii');if((usage.imageBytes||0)+encoded>128*1024*1024){execution.status='paused';execution.reason='budget-imageBytes';throw fail('批次图像传输量达到 128 MiB，请缩小范围建立新批次',413,'COMPLIANCE_STEP_PAUSED');}usage.imageBytes=(usage.imageBytes||0)+encoded;usage.modelCalls++;await this.checkpoint(batch);});
                    for(const field of output.fields){const prior=batch.fields.find(f=>f.documentId===field.documentId&&f.key===field.key);if(!prior)batch.fields.push(field);else{prior.candidates||=[{raw:prior.raw,location:prior.location}];prior.candidates.push({raw:field.raw,location:field.location});if(prior.raw!==field.raw){prior.status='conflict';prior.value=null;}else if(field.status!=='known'){prior.status='unknown';prior.value=null;}}} usage.inputTokens=output.usage.inputTokens===null?null:(usage.inputTokens||0)+output.usage.inputTokens;usage.outputTokens=output.usage.outputTokens===null?null:(usage.outputTokens||0)+output.usage.outputTokens;
                    if(output.usage.cost.estimate!==null){usage.cost.estimate=(usage.cost.estimate||0)+output.usage.cost.estimate;usage.cost.basis='partial-model-catalog-estimate';}
                    doc.processing=execution.steps.some(s=>s!==step&&s.documentId===doc.id&&s.status!=='completed')?{status:'unreadable',reason:'其余扫描页面尚未完成'}:{status:'completed',reason:'扫描字段候选已提取，结论仍待人工复核'};
                }
                step.status='completed';step.completedAt=new Date().toISOString();
            } catch(error) {
                step.status=error.code==='COMPLIANCE_STEP_PAUSED'?'pending':error.code==='COMPLIANCE_MODEL_UNCERTAIN'?'uncertain':'failed';step.reason=String(error.message).slice(0,500);step.code=error.code||'COMPLIANCE_PARSE_FAILED';
                doc.processing={status:['COMPLIANCE_MODEL_UNAVAILABLE','COMPLIANCE_STEP_PAUSED'].includes(error.code)?'unreadable':'failed',reason:step.reason,code:step.code};
            }
            elapsed();await this.checkpoint(batch);
        }
        elapsed();
        if(execution.status==='running') {
            execution.status=execution.steps.some(s=>s.status==='uncertain')?'needs-review':batch.documents.some(d=>d.processing?.status==='failed')?'failed':'completed';
            if(execution.status==='needs-review')execution.reason='uncertain';
        }
        if(worker&&!this.service.closed)await this.service.authorizeWorker(worker).catch(()=>{execution.reason||='worker-changed';});
        batch.results=evaluate(batch);
        await this.checkpoint(batch,current=>{
            delete current.checkOperations[input.requestId];
            ledger.record(current,kind,input,{ok:true,batch:structuredClone(batch)});
        });
        return (await ledger.snapshot()).receipts[input.requestId].result;
    }
    async list(projectId) { await this.ready(); const state = await this.service.ledger.snapshot(); this.service.materials.project(state, projectId); return { revision: state.revision, batches: (state.batches || []).filter(b => b.projectId === projectId).map(b => ({ id: b.id, revision: b.revision, createdAt: b.createdAt, execution: (({steps,...summary})=>({...summary,pendingSteps:steps?.filter(s=>s.status==='pending').length||0,uncertainSteps:steps?.filter(s=>s.status==='uncertain').length||0}))(b.execution), review: b.review })) }; }
    async get(batchId) { await this.ready(); const state = await this.service.ledger.snapshot(), batch = (state.batches || []).find(b => b.id === batchId); if (!batch) throw fail('检查批次不存在', 404); return { revision: state.revision, batch }; }
    async evidence(batchId, fieldId) { const { revision, batch } = await this.get(batchId), field = batch.fields.find(f => f.id === fieldId); if (!field) throw fail('证据不存在', 404); const doc = batch.documents.find(d => d.id === field.documentId); return { revision, batchRevision: batch.revision, field, document: { id: doc.id, name: doc.name, hash: doc.hash, size: doc.size } }; }
}
module.exports = { ComplianceChecks, ROLES };
