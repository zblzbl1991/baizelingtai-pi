(() => {
    const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = window.PiI18n?.t?.(text) || text; if (cls) el.className = cls; return el; };
    const button = (text, action, id) => { const el = node('button', text, 'settings-secondary-button'); el.type = 'button'; el.onclick = action; if (id) el.id = id; return el; };
    function mount({ root, batch, apiFetch, context, valid }) {
        const section = node('section', undefined, 'compliance-reports'), controls = node('fieldset'), status = node('p', '', 'settings-help'), list = node('div'), preview = node('section');
        status.id = 'compliance-report-status'; status.setAttribute('role', 'status'); preview.hidden = true; let alive = true, busy = false, revision, reports = [];
        const current = () => alive && section.isConnected && valid();
        section.append(node('h4', '批次报告'), node('p', '报告固定本批次修订，保留未完成项与复核状态。生成后可交付到当前聊天，再明确保存到成果中心。', 'settings-help'), controls, status, list, preview); root.append(section);
        async function mutation(path, body, artifact = false) {
            const prefix = artifact ? '/api/pi/artifacts' : '/api/pi/compliance', key = 'pivane.compliance.report-operation:' + path;
            let pending; try { pending = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch {}
            if (pending) {
                const result = await apiFetch(prefix + '/operations/' + encodeURIComponent(pending.requestId));
                if (result.noReplay || result.pending || result.status === 'publishing' || result.status === 'published') throw new Error('原操作仍待核对，系统未重发。');
                sessionStorage.removeItem(key); if (JSON.stringify(body) !== pending.payload) throw new Error('原操作已核对，请查看原结果后再提交新操作。'); return result;
            }
            const input = { requestId: window.PiCompliance.randomId(), ...(!artifact ? { expectedRevision: revision } : {}), ...body };
            sessionStorage.setItem(key, JSON.stringify({ requestId: input.requestId, payload: JSON.stringify(body) }));
            try { const result = await apiFetch(prefix + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); if (result.noReplay || result.pending) throw new Error('原操作仍待核对，系统未重发。'); sessionStorage.removeItem(key); return result; }
            catch (error) { if (error.status && error.status < 500 && error.status !== 404 && error.data?.code !== 'COMPLIANCE_BUSY') sessionStorage.removeItem(key); throw error; }
        }
        async function act(action) {
            if (busy || !current()) return; busy = true; controls.disabled = true; list.querySelectorAll('button').forEach(b => b.disabled = true); status.textContent = '正在处理…';
            try { await action(); if (current()) { await load(); status.textContent = '操作结果已核对。'; } }
            catch (error) { if (current()) { status.textContent = error.status === 404 ? '原操作结果未知，系统未重发。请核对回执。' : error.message; const state = await apiFetch('/api/pi/compliance').catch(() => null); if (current() && state) revision = state.revision; } }
            finally { busy = false; if (controls.isConnected) controls.disabled = false; if (list.isConnected) list.querySelectorAll('button').forEach(b => b.disabled = false); }
        }
        controls.append(button('生成 HTML 与 Excel', () => act(() => mutation('/batches/' + batch.id + '/reports', { batchRevision: batch.revision })), 'compliance-report-generate'), button('核对报告状态', () => act(load)));
        async function load() {
            const data = await apiFetch('/api/pi/compliance/batches/' + batch.id + '/reports'); if (!current()) return; revision = data.revision; reports = data.reports; render();
        }
        async function file(report, index, display) {
            const data = await apiFetch('/api/pi/compliance/reports/' + report.id + '/files/' + index); if (!current()) return;
            if (display) {
                const frame = node('iframe'); frame.title = '合规报告隔离预览'; frame.setAttribute('sandbox', ''); frame.setAttribute('credentialless', ''); frame.referrerPolicy = 'no-referrer';
                frame.srcdoc = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'">' + data.content;
                preview.replaceChildren(button('收起报告预览', () => { preview.replaceChildren(); preview.hidden = true; }), frame); preview.hidden = false;
            } else {
                const bytes = data.encoding === 'utf8' ? data.content : Uint8Array.from(atob(data.base64), c => c.charCodeAt(0)), url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })), link = node('a');
                link.href = url; link.download = report.files[index].name; section.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
            }
        }
        function render() {
            list.replaceChildren(); if (!reports.length) list.append(node('p', '尚未生成报告。生成不会更改任何检查结论。', 'settings-help'));
            for (const report of [...reports].reverse()) {
                const row = node('div', undefined, 'compliance-report-row'); row.dataset.complianceReport = report.id;
                const complete = report.savedFiles?.length === report.files.length && report.savedFiles.every(Boolean), state = complete ? '已保存到成果中心' : report.status === 'delivered' ? '已交付 · 待独立保存' : report.status === 'published' ? '快照已发布 · 原生登记待核对' : '已生成 · 尚未交付';
                const review = { unreviewed: '未人工复核', confirmed: '已人工确认', reviewed: '已人工复核', partial: '部分人工复核' }[report.review?.status] || report.review?.status || '未知';
                row.append(node('strong', '修订 ' + report.batchRevision + ' · ' + state), node('p', report.generatedAt + ' · 规则 ' + report.ruleVersion + ' · ' + review, 'settings-help'));
                row.append(button('预览 HTML 报告', () => act(() => file(report, 0, true))), button('下载 HTML', () => act(() => file(report, 0, false))), button('下载 Excel', () => act(() => file(report, 1, false))));
                if (report.status !== 'delivered') row.append(button('交付到当前聊天', () => act(() => { const c = context(); return mutation('/reports/' + report.id + '/delivery', { cwd: c.cwd, sessionId: c.sessionId }); })));
                if (report.status === 'delivered' && !complete) row.append(button('保存到成果中心', () => act(async () => {
                    const delivery = report.delivery, sources = await apiFetch('/api/pi/artifacts?' + new URLSearchParams({ cwd: delivery.cwd, sessionId: delivery.sessionId })); if (!current()) return;
                    const files = report.files.map(file => sources.items.flatMap(g => g.files).find(f => f.name === file.name && f.size === file.size));
                    if (files.some(f => !f)) throw new Error('原生交付来源当前不可验证，请在成果中心核对来源。');
                    const result = await mutation('/batch', { action: 'save', files: files.map(f => ({ key: f.key })) }, true);
                    if (result.results?.some(r => !r.ok) || !result.results?.length) throw new Error(result.results?.filter(r => !r.ok).map(r => r.error).join('；') || result.error || '保存结果待核对');
                })));
                if (complete) row.append(button('在成果中心查看', () => { location.hash = '#/artifacts'; })); list.append(row);
            }
        }
        load().catch(error => { if (current()) status.textContent = error.message; });
        return { dispose() { alive = false; preview.replaceChildren(); } };
    }
    window.PiComplianceReports = { mount };
})();
