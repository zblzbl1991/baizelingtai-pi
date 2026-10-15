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
        let alive = true, revision, batch, busy = false;
        const current = () => alive && section.isConnected && valid();
        section.append(node('h4','资料与检查'), node('p','每份资料不超过 20 MiB。工程最多 32 份、256 MiB，全部原件最多 2 GiB。文本仅按明确标签和固定表头提取；扫描件待识别。','settings-help'), stateText, controls, list, results, evidence); root.append(section);
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
            if (busy || !current()) return; busy = true; controls.disabled = true; list.querySelectorAll('fieldset').forEach(el => el.disabled = true); stateText.textContent = t('正在处理…');
            try { await action(); if (current()) { await load(); if (success) stateText.textContent = t(success); } }
            catch (error) { if (current()) { stateText.textContent = error.status === 404 ? t('原操作结果未知，未重发。请核对原资料与操作回执。') : error.message; const fresh = await apiFetch('/api/pi/compliance').catch(() => null); if (current() && fresh) revision = fresh.revision; } }
            finally { busy = false; controls.disabled = false; list.querySelectorAll('fieldset').forEach(el => el.disabled = false); }
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
        controls.append(button('按已核对资料创建检查批次', () => act(async () => { const value = await mutate('/projects/' + project.id + '/batches', {}); if (current()) { batch = value.batch; showResults(); } }, '已完成本次文本检查，结论仍待人工复核。'), 'compliance-run-check'), button('刷新资料和批次', () => act(async () => {}, '已刷新。')));
        function showResults() {
            results.replaceChildren(); if (!batch) return;
            results.append(node('h4','检查结果'), node('p','批次：' + batch.id + ' · 规则 ' + batch.rulePackage.version + ' · 未人工复核','settings-help'));
            for (const result of batch.results) {
                const row = node('div', undefined, 'compliance-result'); row.append(node('strong', names[result.id] + '：' + (result.execution === 'failed' ? '执行失败' : conclusions[result.conclusion])), node('p',result.reason));
                for (const fieldId of result.evidence) row.append(button('查看证据', async () => {
                    const requestedBatch = batch.id;
                    try { const data = await apiFetch('/api/pi/compliance/batches/' + requestedBatch + '/evidence/' + fieldId); if (!current() || batch.id !== requestedBatch) return; const f = data.field;
                        evidence.replaceChildren(node('h4','原文证据'), node('p',data.document.name + ' · ' + (f.location.page ? '第 ' + f.location.page + ' 页 ' + (f.location.region === 'upper' ? '上方' : '') : f.location.sheet + ' 第 ' + f.location.row + ' 行')),
                            node('p',f.raw), node('p','日期精度：' + (f.precision === 'month' ? '月' : f.precision === 'day' ? '日' : '不适用')), node('pre',f.location.excerpt || f.raw), button('收起证据', () => { evidence.hidden = true; })); evidence.hidden = false; evidence.tabIndex = -1; evidence.focus();
                    } catch(error) { if (current()) stateText.textContent = error.message; }
                }));
                results.append(row);
            }
            for (const doc of batch.documents.filter(d => d.processing?.status !== 'completed')) results.append(node('p',doc.name + '：' + doc.processing.reason,'settings-help'));
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
        return { dispose() { alive = false; } };
    }
    window.PiComplianceMaterials = { mount };
})();
