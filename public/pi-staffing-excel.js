/* Excel UI renders typed server plans; it never generates model HTML or writes the ledger. */
(() => {
    const tr = text => globalThis.PiI18n?.t(text) || text;
    const el = (tag, text, attrs = {}) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); return node; };
    const sourceOf = plan => plan.source.kind === 'page' ? { kind: 'page' } : { cwd: plan.source.cwd, sessionId: plan.source.sessionId };
    function card(initial, { request, refresh = () => {}, context = () => null }) {
        const root = el('section', undefined, { class: 'staffing-plan-card staffing-import-card', 'data-staffing-import-plan': initial.id });
        let plan = initial, busy = false, pending = null, notice = '', generation = 0, loading = !initial.import;
        const key = 'pivane.staffing.import:' + initial.id; try { pending = sessionStorage.getItem(key); } catch { /* Optional UI receipt. */ }
        const active = () => plan.source.kind === 'page' || context()?.cwd === plan.source.cwd && context()?.sessionId === plan.source.sessionId;
        const clear = () => { pending = null; try { sessionStorage.removeItem(key); } catch { /* Optional. */ } };
        async function load() {
            const ticket = ++generation;
            try { const loaded = await request('/plans/' + encodeURIComponent(initial.id) + '?' + new URLSearchParams(sourceOf(plan))); if (ticket !== generation || !root.isConnected) return; plan = loaded; if (plan.outcome) clear(); }
            catch (error) { if (ticket !== generation) return; notice = error.message; plan = { ...plan, stale: true }; }
            loading = false; draw();
        }
        async function confirm() {
            if (loading || busy || pending || plan.stale || !active()) return; busy = true; pending = crypto.randomUUID(); try { sessionStorage.setItem(key, pending); } catch { /* Optional. */ } draw();
            try {
                await request('/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: pending, expectedRevision: plan.revision, planId: plan.id, action: 'apply-import', source: sourceOf(plan) }) });
                clear(); notice = tr('导入已保存。'); await load(); await refresh(); window.dispatchEvent(new Event('workspace:staffing-changed'));
            } catch (error) { notice = error.message; if (error.status && error.status < 500) { clear(); plan.stale = true; } }
            finally { busy = false; draw(); }
        }
        async function lookup() {
            if (busy || !pending || !active()) return; busy = true; draw();
            try { const result = await request('/operations/' + encodeURIComponent(pending)); if (result.state === 'completed') { clear(); await load(); await refresh(); } else notice = tr('结果待核对。不要重新提交。'); }
            catch (error) { notice = error.message; } finally { busy = false; draw(); }
        }
        function draw() {
            root.replaceChildren(el('h3', tr('Excel 导入差异')), el('p', tr('台账版本：{0}').replace('{0}', plan.revision)), el('p', notice || plan.warning || '', { role: 'status' }));
            if (loading) { root.append(el('p', tr('正在读取方案…'))); return; }
            root.append(el('p', `${tr('变更记录')} ${plan.totalChanges ?? Object.values(plan.counts || {}).reduce((n, v) => n + v, 0)}`));
            if (plan.historyCompleteChange) root.append(el('p', tr('历史完整性') + '：' + tr(plan.historyCompleteChange.before ? '完整' : '不完整') + ' → ' + tr(plan.historyCompleteChange.after ? '完整' : '不完整')));
            for (const change of plan.changes || []) {
                const detail = el('details'); detail.append(el('summary', change.kind + ' · ' + (change.after?.id || change.before?.id)), el('pre', JSON.stringify({ before: change.before, after: change.after }, null, 2))); root.append(detail);
            }
            if (plan.totalChanges > (plan.changes?.length || 0)) root.append(el('p', tr('此处显示部分差异。请同时核对上传的完整 Excel。')));
            const button = el('button', tr(plan.outcome ? '导入已保存。' : pending ? '查询原操作结果' : '确认导入'), { type: 'button', class: 'settings-primary-button', 'data-staffing-import-confirm': '' });
            button.disabled = busy || Boolean(plan.outcome) || !active() || (!pending && plan.stale); button.addEventListener('click', () => void (pending ? lookup() : confirm())); root.append(button);
            if (plan.stale) root.append(el('p', tr('方案已失效。请重新上传或准备差异。')));
        }
        draw(); queueMicrotask(() => void load()); return root;
    }
    function mount(container, { request, status, refresh }) {
        if (!status?.enabled || !['awaiting-import', 'awaiting-review', 'ready'].includes(status.state)) return;
        const section = el('section', undefined, { class: 'staffing-excel', 'aria-label': tr('Excel 台账与成果') }), message = el('p', '', { role: 'status' });
        section.append(el('h2', tr('Excel 台账与成果')), el('a', tr('下载合成示例模板'), { href: '/api/pi/staffing/excel/template', download: 'staffing-template.xlsx' }));
        const input = el('input', undefined, { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'aria-label': tr('选择 Excel 台账'), 'data-staffing-excel-file': '' });
        const prepare = el('button', tr('检查 Excel 差异'), { type: 'button', class: 'settings-secondary-button', 'data-staffing-excel-import': '' }), preview = el('div'); let busy = false, pending = null;
        const storageKey = 'pivane.staffing.excel.pending:' + status.profileId;
        try { const value = sessionStorage.getItem(storageKey); if (value) pending = JSON.parse(value); } catch { /* Optional. */ }
        const savePending = value => { pending = value; try { value ? sessionStorage.setItem(storageKey, JSON.stringify(value)) : sessionStorage.removeItem(storageKey); } catch { /* Optional. */ } };
        const showReport = result => { message.textContent = `${tr('导出状态')}：${tr({ generated: '已生成', available: '可读取，尚未保存成果', saved: '已保存到成果' }[result.phase] || '结果待核对')} · ${tr('台账版本：{0}').replace('{0}', result.ledgerRevision)}`; if (result.saveError) message.textContent += ' · ' + result.saveError;
            if (result.downloadHref === '/api/pi/staffing/excel/exports/' + result.exportId && /^[a-f0-9]{64}$/.test(result.exportId || '')) message.append(' ', el('a', tr('下载 Excel'), { href: result.downloadHref, download: '' }));
            if (result.artifactKey) { const link = el('a', tr('打开成果中心'), { href: '#/artifacts' }); message.append(' ', link); } };
        const lookup = el('button', tr('查询原操作结果'), { type: 'button', class: 'settings-secondary-button', 'data-staffing-excel-lookup': '' });
        const draw = () => { input.disabled = prepare.disabled = busy || Boolean(pending); if (exportButton) exportButton.disabled = busy || Boolean(pending); lookup.hidden = !pending; lookup.disabled = busy; };
        lookup.addEventListener('click', async () => {
            if (busy || !pending) return; busy = true; draw();
            try {
                const result = await request(pending.kind === 'export' ? '/excel/operations/' + encodeURIComponent(pending.requestId) : pending.kind === 'upload' ? '/excel/uploads/' + encodeURIComponent(pending.requestId) : '/operations/' + encodeURIComponent(pending.requestId));
                if (pending.kind === 'export' && result.phase) { savePending(null); showReport(result); }
                else if (pending.kind === 'upload' && result.id) { savePending(null); message.textContent = tr('文件已上传。请重新选择同一文件并检查差异。'); }
                else if (result.state === 'completed') { savePending(null); if (result.result?.kind === 'import') preview.replaceChildren(card(result.result, { request, refresh })); }
                else message.textContent = tr('结果待核对。不要重新提交。');
            } catch (error) { message.textContent = error.message; } finally { busy = false; draw(); }
        });
        prepare.addEventListener('click', async () => {
            const file = input.files[0]; if (busy || pending || !file) return; if (!file.size || file.size > 20 * 1024 ** 2) { message.textContent = tr('Excel 文件不得超过 20 MiB。'); return; }
            busy = true; draw();
            try {
                const requestId = crypto.randomUUID(); savePending({ kind: 'upload', requestId });
                const uploaded = await request('/excel/uploads?requestId=' + encodeURIComponent(requestId), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
                savePending(null); const requestForPlan = crypto.randomUUID(); savePending({ kind: 'prepare', requestId: requestForPlan });
                const current = await request('/status');
                const plan = await request('/excel/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: requestForPlan, expectedRevision: current.revision, uploadId: uploaded.id }) });
                savePending(null); preview.replaceChildren(card(plan, { request, refresh })); message.textContent = tr('请核对具体差异，再确认导入。');
            } catch (error) { message.textContent = error.message; if (error.status && error.status < 500) savePending(null); }
            finally { busy = false; draw(); }
        });
        let exportButton = null;
        if (status.state === 'ready') {
            exportButton = el('button', tr('导出并保存到成果'), { type: 'button', class: 'settings-primary-button', 'data-staffing-excel-export': '' });
            exportButton.addEventListener('click', async () => { if (busy || pending) return; busy = true; draw();
                try { const current = await request('/status'), requestId = crypto.randomUUID(); savePending({ kind: 'export', requestId });
                    const result = await request('/excel/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, expectedRevision: current.revision }) }); savePending(null); showReport(result);
                } catch (error) { message.textContent = error.message; if (error.status && error.status < 500) savePending(null); } finally { busy = false; draw(); } });
        }
        section.append(input, prepare, lookup); if (exportButton) section.append(exportButton); section.append(message, preview); container.append(section); draw();
    }
    function render(message, options) {
        if (message?.role === 'toolResult' && !message.isError && ['staffing_prepare_import', 'staffing_operation_status'].includes(message.toolName) && message.details?.pivaneStaffing?.version === 2) {
            const reference = message.details.pivaneStaffing.reference;
            if (reference?.kind !== 'import' || !/^[a-f0-9-]{36}$/.test(reference.id || '') || !Number.isSafeInteger(reference.revision) || reference.revision < 1
                || reference.source?.kind !== undefined || typeof reference.source?.cwd !== 'string' || !reference.source.cwd || typeof reference.source.sessionId !== 'string' || !reference.source.sessionId) return null;
            return card({ ...reference, stale: true }, { request: (url, init) => options.fetch('/api/pi/staffing' + url, init), context: options.context });
        }
        if (message?.role !== 'toolResult' || message.toolName !== 'staffing_prepare_import' || message.isError || message.details?.pivaneStaffing?.version !== 1 || message.details.pivaneStaffing.plan?.kind !== 'import') return null;
        const plan = message.details.pivaneStaffing.plan; if (!/^[a-f0-9-]{36}$/.test(plan.id) || !plan.source || !Number.isSafeInteger(plan.revision)) return null;
        return card(plan, { ...options, request: (url, opts) => options.fetch('/api/pi/staffing' + url, opts) });
    }
    globalThis.PiStaffingExcel = { mount, render };
})();
