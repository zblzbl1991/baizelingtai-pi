(() => {
    const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = String(text); if (cls) el.className = cls; return el; };
    const button = (text, action, id) => { const el = node('button', text, 'settings-secondary-button'); el.type = 'button'; el.onclick = action; if (id) el.id = id; return el; };
    const label = (text, field) => { const el = node('label', text); el.append(field); return el; };
    const fields = { projectName: '项目名称', projectNumber: '项目编号', organization: '单位', year: '年度', phase: '期次', date: '日期', documentNumber: '文号' };
    const rules = { 'documents-identity': '资料缺失与归属', 'feasibility-numbers': '可研评审及批复文号', 'contract-deadline': '合同签订期限', 'feasibility-order': '可研与评审时序' };
    const conclusions = { passed: '通过', issue: '发现候选问题', insufficient: '证据不足', 'not-applicable': '不适用' };
    const original = field => field ? field.raw ?? '原始提取未知' : '原始提取没有此字段';
    const place = location => !location ? '没有原始定位' : location.page ? `第 ${location.page} 页，${location.region === 'upper' ? '上方' : '正文'}` : `${location.sheet} 第 ${location.row} 行，第 ${location.column} 列`;
    function mount({ root, batch, apiFetch, context, valid, onChanged }) {
        const section = node('section', undefined, 'compliance-review'), form = node('fieldset'), status = node('p', '', 'settings-help'), cardRoot = node('div'), list = node('details');
        section.append(node('h4', '人工复核'), node('p', '先核对原件，再准备确认卡。智能体只能提出方案。人工输入与原始提取分别保留。', 'settings-help'), form, status, cardRoot, list); root.append(section);
        form.id = 'compliance-review-form'; status.id = 'compliance-review-status'; status.setAttribute('role', 'status'); list.append(node('summary', '已准备的确认卡'));
        let alive = true, busy = false, card = null, lastPendingKey = null, revision;
        const current = () => alive && section.isConnected && valid();
        const select = (id, options) => { const el = node('select'); el.id = id; for (const [value, title] of options) el.append(new Option(title, value)); return el; };
        const input = (id, value = '') => { const el = node('input'); el.id = id; el.value = value; return el; };
        const kind = select('compliance-review-kind', [['field', '修正字段'], ['conclusion', '确认人工结论']]);
        const doc = select('compliance-review-document', batch.documents.map(d => [d.id, d.name])), key = select('compliance-review-key', Object.entries(fields)), raw = input('compliance-review-value');
        const rule = select('compliance-review-rule', batch.results.map(r => [r.id, rules[r.id] || r.id])), conclusion = select('compliance-review-conclusion', Object.entries(conclusions));
        const locationFields = node('div', undefined, 'compliance-review-location'), fieldForm = node('div', undefined, 'compliance-review-fields'), conclusionForm = node('div', undefined, 'compliance-review-fields');
        const sheet = input('compliance-review-sheet', 'CSV'), row = input('compliance-review-row', '2'), column = input('compliance-review-column', '2'), page = input('compliance-review-page', '1'), region = select('compliance-review-region', [['body', '正文'], ['upper', '首页上方']]), excerpt = input('compliance-review-excerpt');
        const reason = node('textarea'); reason.id = 'compliance-review-reason'; reason.rows = 3; reason.maxLength = 1000; raw.maxLength = 300; excerpt.maxLength = 2000;
        const absent = input('compliance-review-number-absent'); absent.type = 'checkbox'; const absentLabel = label('已核对首页上方，确认文号缺失', absent);
        for (const number of [row, column, page]) { number.type = 'number'; number.min = '1'; }
        fieldForm.append(label('资料', doc), label('字段', key), label('人工输入值（日期可写 YYYY-MM）', raw), absentLabel, locationFields, label('原件定位与原文说明', excerpt));
        conclusionForm.append(label('检查规则', rule), label('人工结论', conclusion));
        form.append(label('操作', kind), fieldForm, conclusionForm, label('人工核对理由', reason));
        function location() {
            const source = batch.documents.find(d => d.id === doc.value); locationFields.replaceChildren();
            absentLabel.hidden = key.value !== 'documentNumber' || !source || ['csv', 'xlsx'].includes(source.format); if (absentLabel.hidden) absent.checked = false; raw.disabled = absent.checked;
            if (source && ['csv', 'xlsx'].includes(source.format)) locationFields.append(label('工作表', sheet), label('行', row), label('列', column));
            else locationFields.append(label('页码', page), label('区域', region));
        }
        function mode() { fieldForm.hidden = kind.value !== 'field'; conclusionForm.hidden = kind.value !== 'conclusion'; location(); }
        kind.onchange = mode; doc.onchange = location; key.onchange = location; absent.onchange = () => { raw.disabled = absent.checked; }; key.value = 'date'; mode();
        const storagePrefix = () => 'pivane.compliance.review:' + batch.id + ':' + context().sessionId + ':';
        function pending(key) { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; } }
        async function consume(result) {
            if (!current()) return;
            if (result.proposal) { card = result.proposal; renderCard(); }
            if (result.batch) onChanged(result.batch, result.revision);
        }
        async function receipt() {
            if (!lastPendingKey) { try { lastPendingKey = Object.keys(sessionStorage).find(key => key.startsWith(storagePrefix()) && pending(key)); } catch {} }
            const saved = lastPendingKey && pending(lastPendingKey); if (!saved) throw new Error('当前没有待核对操作。');
            const result = await apiFetch('/api/pi/compliance/operations/' + encodeURIComponent(saved.requestId));
            if (result.status === 'pending') throw new Error('原操作仍待核对，系统未重发。');
            sessionStorage.removeItem(lastPendingKey); lastPendingKey = null; await consume(result); return result;
        }
        async function mutate(path, body, slot) {
            const storageKey = storagePrefix() + slot; lastPendingKey = storageKey;
            if (pending(storageKey)) return receipt();
            const latest = await apiFetch('/api/pi/compliance'); if (!current()) return;
            revision = latest.revision; const requestId = window.PiCompliance.randomId();
            sessionStorage.setItem(storageKey, JSON.stringify({ requestId }));
            try {
                const result = await apiFetch('/api/pi/compliance' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, expectedRevision: revision, ...body }) });
                sessionStorage.removeItem(storageKey); lastPendingKey = null; await consume(result); return result;
            } catch (error) { if (error.status && error.status < 500 && error.status !== 404) { sessionStorage.removeItem(storageKey); lastPendingKey = null; } throw error; }
        }
        async function act(action) {
            if (busy || !current()) return; busy = true; form.disabled = true; cardRoot.querySelectorAll('button').forEach(b => b.disabled = true); status.textContent = '正在处理…';
            try { await action(); if (current()) { status.textContent = '操作结果已核对。'; await load(); } }
            catch (error) { if (current()) status.textContent = error.status === 404 ? '原操作结果未知，系统未重发。请核对原回执。' : error.message; }
            finally { busy = false; if (current()) { form.disabled = batch.execution.status === 'running'; renderCard(); } }
        }
        async function prepare() {
            const source = batch.documents.find(d => d.id === doc.value), loc = source && ['csv', 'xlsx'].includes(source.format) ? { sheet: sheet.value, row: Number(row.value), column: Number(column.value) } : { page: Number(page.value), region: region.value };
            const change = kind.value === 'field' ? { kind: 'field', documentId: doc.value, key: key.value, raw: absent.checked ? null : raw.value, ...(absent.checked ? { absent: true } : {}), location: { ...loc, excerpt: excerpt.value }, reason: reason.value } : { kind: 'conclusion', resultId: rule.value, conclusion: conclusion.value, reason: reason.value };
            const c = context(); await mutate('/batches/' + batch.id + '/review-proposals', { cwd: c.cwd, sessionId: c.sessionId, batchRevision: batch.revision, change }, 'prepare');
            if (current() && card) { cardRoot.scrollIntoView({ block: 'nearest' }); cardRoot.tabIndex = -1; cardRoot.focus(); }
        }
        form.append(button('准备确认卡', () => act(prepare), 'compliance-review-prepare'));
        section.append(button('查询原操作回执', () => act(receipt), 'compliance-review-receipt'), button('重新载入批次', () => act(async () => { const value = await apiFetch('/api/pi/compliance/batches/' + batch.id); if (current()) onChanged(value.batch, value.revision); }), 'compliance-review-refresh'));
        function renderCard() {
            cardRoot.replaceChildren(); if (!card) return;
            const panel = node('section', undefined, 'compliance-review-card'); panel.id = 'compliance-review-card';
            panel.append(node('h4', '审查确认卡'), node('p', card.projectName + ' · 工程 ID ' + card.projectId), node('p', '批次 ' + card.batchId + ' · 修订 ' + card.batchRevision + ' · 规则 ' + card.ruleVersion, 'settings-help'));
            if (card.change.kind === 'field') {
                const source = batch.documents.find(d => d.id === card.change.documentId);
                panel.append(node('strong', source?.name + ' · ' + fields[card.change.key]), node('p', '原始提取：' + original(card.before)), node('p', '原始出处：' + place(card.before?.location)));
                if (card.before?.humanValue) panel.append(node('p', '此前人工值：' + card.before.humanValue.raw));
                panel.append(node('p', '本次人工值：' + (card.change.absent ? '已人工确认文号缺失' : card.change.raw) + (card.change.precision === 'month' ? '（精度：月，不补造日）' : '')), node('p', '人工定位：' + place(card.change.location)), node('pre', card.change.location.excerpt));
            } else panel.append(node('strong', rules[card.change.resultId] || card.change.resultId), node('p', '系统建议：' + conclusions[card.before.conclusion]), node('p', card.before.reason), node('p', '人工结论：' + conclusions[card.change.conclusion]));
            panel.append(node('p', '核对理由：' + card.change.reason));
            const proof = node('details'); proof.append(node('summary', '资料快照、来源与内容校验'), node('p', '来源聊天：' + card.origin.sessionId), node('p', '确认内容：' + card.contentHash), node('p', '规则内容：' + card.ruleHash));
            for (const source of card.sources) proof.append(node('p', source.documentId + ' · SHA256 ' + source.hash)); panel.append(proof);
            const c = context(), sameOrigin = c.cwd === card.origin.cwd && c.sessionId === card.origin.sessionId;
            const confirm = button('确认并提交', () => act(async () => {
                const latest = await apiFetch('/api/pi/compliance/review-proposals/' + card.id); if (!current()) return; card = latest.proposal;
                if (card.status !== 'ready') throw new Error('确认卡已失效，请重新载入批次并准备新卡。');
                const origin = context(); await mutate('/review-proposals/' + card.id + '/confirm', { contentHash: card.contentHash, cwd: origin.cwd, sessionId: origin.sessionId }, 'confirm:' + card.id);
            }), 'compliance-review-confirm');
            confirm.disabled = busy || card.status !== 'ready' || !sameOrigin || batch.execution.status === 'running';
            panel.append(node('p', card.status === 'applied' ? '此卡已提交，后续操作须重新准备。' : card.status !== 'ready' ? '此卡已失效，请重新载入批次。' : !sameOrigin ? '来源聊天不同，请在当前聊天重新准备。' : '请逐项核对后提交。'), confirm); cardRoot.append(panel);
        }
        async function load() {
            const value = await apiFetch('/api/pi/compliance/batches/' + batch.id + '/review-proposals'); if (!current()) return;
            list.replaceChildren(node('summary', '已准备的确认卡（' + value.proposals.length + '）'));
            for (const proposal of [...value.proposals].reverse()) list.append(button((proposal.change.kind === 'field' ? '字段修正' : '人工结论') + ' · 修订 ' + proposal.batchRevision + ' · ' + ({ ready: '待确认', stale: '已失效', applied: '已提交' }[proposal.status] || proposal.status), () => act(async () => { const value = await apiFetch('/api/pi/compliance/review-proposals/' + proposal.id); if (current()) { card = value.proposal; renderCard(); } })));
        }
        form.disabled = batch.execution.status === 'running'; load().catch(error => { if (current()) status.textContent = error.message; });
        return { editField(documentId, fieldKey) { if (!current()) return; kind.value = 'field'; doc.value = documentId; key.value = fieldKey; const field = batch.fields.find(f => f.documentId === documentId && f.key === fieldKey); raw.value = field?.humanValue?.raw || field?.raw || ''; const loc = field?.humanValue?.location || field?.location; if (loc) { sheet.value = loc.sheet || 'CSV'; row.value = loc.row || 2; column.value = loc.column || 2; page.value = loc.page || 1; region.value = loc.region || 'body'; excerpt.value = loc.excerpt || ''; } mode(); form.scrollIntoView({ block: 'nearest' }); raw.focus(); }, dispose() { alive = false; } };
    }
    window.PiComplianceReview = { mount };
})();
