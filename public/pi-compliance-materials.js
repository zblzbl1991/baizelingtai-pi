(() => {
    const t = text => window.PiI18n?.t?.(text) || text;
    const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = t(text); if (cls) el.className = cls; return el; };
    const button = (text, action, id) => { const el = node('button', text, 'settings-secondary-button'); el.type = 'button'; el.onclick = action; if (id) el.id = id; return el; };
    const label = (text, field) => { const el = node('label', text); el.append(field); return el; };
    const roles = [['unknown','尚未确认'],['award-notice','中标通知书'],['contract','合同'],['feasibility-report','可研报告'],['feasibility-review','可研评审'],['feasibility-approval','可研批复'],['register','项目台账']];
    const names = { 'documents-identity': '资料缺失与归属', 'feasibility-numbers': '可研评审及批复文号', 'contract-deadline': '合同签订期限', 'feasibility-order': '可研与评审时序' };
    const conclusions = { passed:'通过', issue:'发现候选问题', insufficient:'证据不足', 'not-applicable':'不适用' };
    function mount({ root, project, apiFetch, context, valid }) {
        const section = node('section', undefined, 'compliance-materials'), stateText = node('p', '', 'settings-help'); stateText.id = 'compliance-material-status'; stateText.setAttribute('role','status');
        const controls = node('fieldset'), list = node('div'), results = node('div'), evidence = node('section', undefined, 'compliance-evidence'); results.id = 'compliance-results'; evidence.id = 'compliance-evidence'; evidence.hidden = true;
        let alive = true, revision, batch, busy = false, watching = false, watchGeneration = 0, evidenceEpoch = 0, evidenceOwner = null, reportView, reviewView;
        const current = () => alive && section.isConnected && valid();
        section.append(node('h4','资料与检查'), node('p','每份资料不超过 20 MiB。工程最多 32 份、256 MiB，全部原件最多 2 GiB。扫描件使用本批次固定的识别模型。','settings-help'), stateText, controls, list, results, evidence); root.append(section);
        async function mutate(path, body, method = 'POST') {
            const key = 'pivane.compliance.operation:' + project.id + ':' + path;
            const fingerprint = crypto.subtle?.digest ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body))))].map(byte => byte.toString(16).padStart(2,'0')).join('') : null;
            let pending; try { pending = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch {}
            if (pending) {
                const result = await apiFetch('/api/pi/compliance/operations/' + encodeURIComponent(pending.requestId));
                sessionStorage.removeItem(key); revision = result.revision;
                if (!fingerprint || pending.fingerprint !== fingerprint) throw new Error(t('原操作已核对，请查看保存结果后重新提交新内容。'));
                return result;
            }
            const input = { requestId: window.PiCompliance.randomId(), expectedRevision: revision, ...body };
            // Keep only the operation identifier, never large/private file bytes in browser storage.
            sessionStorage.setItem(key, JSON.stringify({ requestId: input.requestId, fingerprint }));
            try {
                const result = await apiFetch('/api/pi/compliance' + path, { method, headers: { 'Content-Type':'application/json' }, body: JSON.stringify(input) });
                sessionStorage.removeItem(key); revision = result.revision; return result;
            } catch (error) {
                if (error.status && error.status < 500 && error.status !== 404 && error.data?.code !== 'COMPLIANCE_BUSY') sessionStorage.removeItem(key);
                throw error;
            }
        }
        async function act(action, success) {
            if (busy || !current()) return; busy = true; controls.disabled = true; list.querySelectorAll('fieldset,select').forEach(el => el.disabled = true); stateText.textContent = t('正在处理…');
            try { await action(); if (current()) { await load(); if (success) stateText.textContent = t(success); } }
            catch (error) { if (current()) { stateText.textContent = error.status === 404 ? t('原操作结果未知，未重发。请核对原资料与操作回执。') : error.message; const fresh = await apiFetch('/api/pi/compliance').catch(() => null); if (current() && fresh) revision = fresh.revision; } }
            finally { busy = false; controls.disabled = false; list.querySelectorAll('fieldset,select').forEach(el => el.disabled = false); }
        }
        const upload = node('input'); upload.id = 'compliance-upload'; upload.type = 'file'; upload.multiple = true; upload.accept = '.pdf,.png,.jpg,.jpeg,.webp,.xlsx,.csv';
        controls.append(button('下载 CSV 字段模板', () => {
            const blob = new Blob(['\ufeff项目名称,项目编号,单位,年度,期次,日期,文号\r\n'], {type:'text/csv;charset=utf-8'}), url = URL.createObjectURL(blob), link = node('a');
            link.href = url; link.download = '合规资料字段模板.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url),0);
        }));
        controls.append(label('选择本机资料', upload), button('导入所选资料', () => act(async () => {
            const files = [...upload.files]; if (!files.length || files.length > 32 || files.some(file => !file.size || file.size > 20 * 1024 ** 2) || files.reduce((n,file) => n + file.size, 0) > 256 * 1024 ** 2) throw new Error(t('请选择 1 至 32 份资料，每份不超过 20 MiB，合计不超过 256 MiB。'));
            for (const file of files) {
                if (!current()) return;
                const base64 = await new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error(t('本机文件读取失败'))); reader.readAsDataURL(file); });
                if (!current()) return; await mutate('/projects/' + project.id + '/documents', { sources:[{ kind:'upload', name:file.name, base64 }] });
            }
            upload.value = '';
        }, '所选原件已保存为不可变快照，请逐份核对。'), 'compliance-import-upload'));
        const paths = node('textarea'); paths.id = 'compliance-import-paths'; paths.rows = 3; paths.placeholder = t('每行一个相对路径，例如：资料/合同.pdf');
        controls.append(label('当前授权工作目录中的文件', paths), button('导入明确路径', () => act(async () => {
            const sources = paths.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(path => ({kind:'file',path}));
            await mutate('/projects/' + project.id + '/documents', { cwd:context().cwd, sources }); paths.value = '';
        }, '目录资料快照已保存。')));
        const attachment = node('select'); attachment.id = 'compliance-attachment'; attachment.append(new Option(t('读取当前聊天附件'), ''));
        controls.append(label('当前聊天附件', attachment), button('刷新聊天附件', async () => {
            const c = context(); try { const data = await apiFetch('/api/pi/uploads?' + new URLSearchParams({cwd:c.cwd,sessionId:c.sessionId})); if (!current()) return; attachment.replaceChildren(new Option(t('请选择附件'),'')); for (const item of data.items || []) attachment.append(new Option(item.name,item.id)); } catch(error) { if (current()) stateText.textContent = error.message; }
        }), button('导入聊天附件', () => act(async () => {
            if (!attachment.value) throw new Error(t('请选择当前聊天附件')); const c = context();
            await mutate('/projects/' + project.id + '/documents', { cwd:c.cwd,sessionId:c.sessionId,sources:[{kind:'attachment',id:attachment.value}] });
        }, '附件快照已保存。')));
        const budgetFields = node('div',undefined,'compliance-fields');
        const budgetInput = (key,title,value,max) => { const input=node('input');input.type='number';input.min='1';input.max=String(max);input.value=String(value);input.id='compliance-budget-'+key;budgetFields.append(label(title,input));return input; };
        const pages=budgetInput('pages','页面处理量',200,2000),calls=budgetInput('calls','模型调用次数',20,200),minutes=budgetInput('minutes','运行分钟',10,60);
        const budget=()=>({pages:Number(pages.value),modelCalls:Number(calls.value),runMs:Number(minutes.value)*60000});
        controls.append(node('p','预算限制下一步准入，当前步骤实际结束后保存；PDF 文字读取和页面识别分别计入处理量。','settings-help'),budgetFields);
        async function refreshExecution(generation=watchGeneration) {
            let id=batch?.id;
            if(!id){const data=await apiFetch('/api/pi/compliance/projects/'+project.id+'/batches');id=data.batches.at(-1)?.id;}
            if(!id||!current())return;
            const value=await apiFetch('/api/pi/compliance/batches/'+id);
            if(!current()||generation!==watchGeneration||(batch&&(batch.id!==id||batch.revision>value.batch.revision)))return;batch=value.batch;revision=value.revision;showResults();
        }
        async function watch(generation) { if(!watching||generation!==watchGeneration||!current())return;try{await refreshExecution(generation);}catch{}if(watching&&generation===watchGeneration&&current())setTimeout(()=>watch(generation),1000); }
        async function run(action) { const generation=++watchGeneration;watching=true;setTimeout(()=>watch(generation),1000);try{await action();}finally{if(generation===watchGeneration){watching=false;watchGeneration++;}} }
        controls.append(button('按已核对资料创建检查批次', () => act(()=>run(async()=>{batch=null;showResults();const value=await mutate('/projects/'+project.id+'/batches',{budget:budget()});if(current()){batch=value.batch;showResults();}}),'已保存检查进度，结论仍待人工复核。'), 'compliance-run-check'), button('刷新资料和批次', () => act(async () => {await refreshExecution();}, '已刷新。')));
        function showResults() {
            const owner=batch?batch.id+':'+batch.revision:null;
            if(evidenceOwner&&evidenceOwner!==owner){evidenceEpoch++;evidenceOwner=null;evidence.replaceChildren();evidence.hidden=true;}
            reportView?.dispose();
            reviewView?.dispose();
            results.replaceChildren(); if (!batch) return;
            results.append(node('h4','检查结果'), node('p','批次：' + batch.id + ' · 修订 ' + batch.revision + ' · 规则 ' + batch.rulePackage.version + ' · ' + ({confirmed:'全部已人工确认',partial:'部分人工确认',unreviewed:'未人工复核'}[batch.review.status] || batch.review.status),'settings-help'));
            const e=batch.execution,u=e.usage||{}, reasons={'budget-pages':'页数预算已用完','budget-modelCalls':'模型调用预算已用完','budget-time':'运行时间预算已用完','budget-imageBytes':'图像传输量达到上限，请缩小范围建立新批次',disabled:'已按停用请求暂停，进度已保存',requested:'已按请求暂停',shutdown:'服务关闭，进度已保存',maintenance:'工作台维护，进度已保存',restart:'服务中断，请求结果待核对，未自动重发',uncertain:'请求结果不确定，未自动重发'};
            const states={running:'正在执行',completed:'执行完成',failed:'执行失败',paused:'已暂停','needs-review':'请求待核对'};
            const execution=node('section',undefined,'compliance-execution');execution.id='compliance-execution';execution.setAttribute('aria-live','polite');
            execution.append(node('strong',(states[e.status]||e.status)+(e.reason?'：'+(reasons[e.reason]||e.reason):'')),node('p',`已处理 ${u.pages||0} / ${e.budget?.pages||200} 页，模型调用 ${u.modelCalls||0} / ${e.budget?.modelCalls||20}，运行 ${Math.ceil((u.elapsedMs||0)/1000)} 秒。实际费用未知${u.cost?.estimate!=null?'；模型目录估算 '+u.cost.estimate+' USD':''}。`));
            if(e.status==='paused'||e.status==='needs-review')execution.append(button('追加当前预算，继续未启动步骤',()=>act(()=>run(async()=>{const fresh=await apiFetch('/api/pi/compliance/batches/'+batch.id);revision=fresh.revision;const value=await mutate('/batches/'+batch.id+'/continue',{budget:budget()});if(current()){batch=value.batch;showResults();}}),'已保存继续执行的进度。'),'compliance-continue'));
            if(e.status==='running')execution.append(button('当前步骤结束后暂停',async()=>{try{const fresh=await apiFetch('/api/pi/compliance/batches/'+batch.id);revision=fresh.revision;await mutate('/batches/'+batch.id+'/pause',{});if(current())stateText.textContent=t('暂停请求已保存，等待当前步骤实际结束。');}catch(error){if(current())stateText.textContent=error.message;}},'compliance-pause'),button('核对当前进度',()=>refreshExecution().catch(error=>{if(current())stateText.textContent=error.message;})));
            for(const step of (e.steps||[]).filter(s=>s.status==='uncertain'))execution.append(node('p','请求待核对：'+batch.documents.find(d=>d.id===step.documentId)?.name+' 第 '+step.page+' 页。继续只处理尚未启动的步骤，不重发此请求。','settings-help'));
            results.append(execution);
            for (const result of batch.results) {
                const row = node('div', undefined, 'compliance-result'); row.append(node('strong', names[result.id] + '：' + (result.execution === 'failed' ? '执行失败' : conclusions[result.conclusion])), node('p',result.reason));
                if(result.humanDecision)row.append(node('p','人工结论：'+(conclusions[result.humanDecision.conclusion]||result.humanDecision.conclusion)+'。'+result.humanDecision.reason));
                for (const fieldId of result.evidence) row.append(button('查看证据', async () => {
                    const requestedBatch = batch.id, requestedRevision = batch.revision, request = ++evidenceEpoch;
                    evidenceOwner=requestedBatch+':'+requestedRevision;
                    evidence.replaceChildren(node('p','正在读取证据…'));evidence.hidden=false;
                    try { const data = await apiFetch('/api/pi/compliance/batches/' + requestedBatch + '/evidence/' + fieldId); if (!current() || request !== evidenceEpoch || batch?.id !== requestedBatch || batch.revision !== requestedRevision || data.batchRevision !== undefined && data.batchRevision !== requestedRevision) return; const f = data.field;
                        const loc=f.location;
                        evidence.replaceChildren(node('h4','原文证据'), node('p',data.document.name + ' · ' + (!loc?'原始提取没有定位':loc.page ? '第 ' + loc.page + ' 页 ' + (loc.region === 'upper' ? '上方' : '') : loc.sheet + ' 第 ' + loc.row + ' 行')),
                            node('p',f.raw??'原始提取没有此字段'), node('p','原始日期精度：' + (f.precision === 'month' ? '月' : f.precision === 'day' ? '日' : '不适用')), node('pre',loc?.excerpt || f.raw || '未知'));
                        if(f.humanValue)evidence.append(node('p','人工核对值（非原件）：'+(f.humanValue.status==='absent'?'已确认文号缺失':f.humanValue.raw)),node('p','人工理由：'+f.humanValue.reason));
                        evidence.append(button('根据此证据修正字段',()=>reviewView?.editField(f.documentId,f.key)),button('收起证据', () => { evidenceEpoch++;evidenceOwner=null;evidence.hidden = true; })); evidence.hidden = false; evidence.tabIndex = -1; evidence.focus();
                    } catch(error) { if (current()) stateText.textContent = error.message; }
                }));
                results.append(row);
            }
            for (const doc of batch.documents.filter(d => d.processing?.status !== 'completed')) results.append(node('p',doc.name + '：' + (doc.processing?.reason||'尚未完成'),'settings-help'));
            const selectedBatch = batch;
            reviewView = window.PiComplianceReview?.mount({ root: results, batch, apiFetch, context, valid: () => current() && batch === selectedBatch, onChanged(next, ledgerRevision) { if(!current()||batch!==selectedBatch)return;batch=next;revision=ledgerRevision;showResults(); } });
            reportView = window.PiComplianceReports?.mount({ root: results, batch, apiFetch, context, valid: () => current() && batch === selectedBatch });
        }
        async function load() {
            const [docs,batches] = await Promise.all([apiFetch('/api/pi/compliance/projects/' + project.id + '/documents'),apiFetch('/api/pi/compliance/projects/' + project.id + '/batches')]); if (!current()) return;
            // A newer unrelated response must not authorize an older document form.
            revision = docs.revision; list.replaceChildren(node('h4','原件清单与选用版本'));
            if (!docs.documents.length) list.append(node('p','导入后逐份确认资料角色、归属和本次选用版本。','settings-help'));
            for (const doc of docs.documents) {
                const row = node('fieldset',undefined,'compliance-material-row'); row.dataset.complianceDocument = doc.id;
                row.append(node('legend',doc.name),node('p',doc.format.toUpperCase() + ' · ' + doc.size + ' bytes · ' + doc.hash.slice(0,12),'settings-help'));
                const role = node('select'); for (const [key,name] of roles) role.append(new Option(t(name),key)); role.value = doc.assignment?.role || 'unknown';
                const confirmed = node('input'); confirmed.type = 'checkbox'; confirmed.checked = doc.assignment?.identityConfirmed === true;
                const selected = node('input'); selected.type = 'checkbox'; selected.checked = doc.assignment?.selected === true;
                const absent = node('input'); absent.type = 'checkbox'; absent.checked = doc.assignment?.numberAbsentConfirmed === true;
                row.append(label('资料角色',role),label('归属已核对',confirmed),label('选用于新批次',selected),label('已查看发文首页并确认文号缺失',absent),button('保存资料核对',() => act(() => mutate('/documents/' + doc.id + '/assignment',{role:role.value,identityConfirmed:confirmed.checked,selected:selected.checked,numberAbsentConfirmed:absent.checked},'PUT'),'已保存资料核对。'))); list.append(row);
            }
            if (!batch && batches.batches.length) { const saved = await apiFetch('/api/pi/compliance/batches/' + batches.batches.at(-1).id); if (!current()) return; batch = saved.batch; showResults(); }
            if (batches.batches.length) { const history = node('select'); history.append(new Option(t('选择历史检查批次'),'')); for (const b of batches.batches) history.append(new Option(b.createdAt + ' · ' + b.id.slice(0,8),b.id)); history.onchange = async () => { if (!history.value) return; const saved = await apiFetch('/api/pi/compliance/batches/' + history.value).catch(error => { if(current()) stateText.textContent = error.message; }); if (saved && current()) { batch = saved.batch; showResults(); } }; list.append(label('历史批次',history)); }
        }
        load().catch(error => { if (current()) stateText.textContent = error.message; });
        return { dispose() { alive = false; watching = false; watchGeneration++; reportView?.dispose(); reviewView?.dispose(); } };
    }
    window.PiComplianceMaterials = { mount };
})();
