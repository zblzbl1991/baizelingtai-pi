/* Staffing setup owns UI state only. The private service owns the ledger. */
(() => {
    const tr = text => globalThis.PiI18n?.t(text) || text;
    const node = (tag, text, attrs = {}) => {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
        return element;
    };
    const sample = { people: [{ id: 'P001', name: '示例人员', department: '示例事业部', direct: true }],
        projects: [], occupancies: [], historyComplete: false };
    async function api(path, options = {}) {
        const response = await fetch('/api/pi/staffing' + path, { credentials: 'same-origin', cache: 'no-store', ...options });
        const data = await response.json();
        if (!response.ok) throw Object.assign(new Error(data.error || tr('人员调配暂时无法读取')), { status: response.status });
        return data;
    }
    document.addEventListener('DOMContentLoaded', () => {
        const root = document.getElementById('staffing-tab');
        if (!root) return;
        document.querySelectorAll('[data-staffing-label]').forEach(element => { element.textContent = tr('人员调配'); });
        let active = false, generation = 0, status = null, busy = false, draft = '', pending = null, editingInitial = false;
        const header = node('header', undefined, { class: 'staffing-header' });
        header.append(node('h1', tr('人员调配')), node('p', tr('先核对台账，再安排人员。')));
        const feedback = node('p', '', { class: 'staffing-feedback', role: 'status', 'aria-live': 'polite' });
        const panel = node('section', undefined, { class: 'staffing-panel', 'aria-label': tr('人员调配初始化') });
        root.append(header, feedback, panel);
        function button(label, id, action, secondary = false) {
            const element = node('button', tr(label), { type: 'button', id, class: secondary ? 'settings-secondary-button' : 'settings-primary-button' });
            element.disabled = busy || Boolean(pending); element.addEventListener('click', action); return element;
        }
        const navigation = data => document.querySelectorAll('[data-staffing-nav]').forEach(element => { element.hidden = !data?.enabled; });
        function showPeople(data) {
            const list = node('div', undefined, { class: 'staffing-people' });
            for (const person of data.people.slice(0, 100)) {
                const item = node('p');
                item.append(node('strong', person.name), document.createTextNode(' · ' + person.department + ' · ' + tr(person.direct ? '直签' : '非直签'))); list.append(item);
            }
            if (data.people.length > 100) list.append(node('p', tr('此处显示前 100 人。请核对完整导入内容。')));
            return list;
        }
        async function load() {
            const ticket = ++generation;
            try {
                const data = await api('/status');
                if (ticket !== generation) return;
                navigation(data); status = data;
                if (!active) return;
                const ledger = data.enabled && !['initializing', 'awaiting-import'].includes(data.state) ? await api('/ledger') : null;
                if (ticket !== generation || !active) return;
                if (ledger) status = ledger;
                render(ledger);
            } catch (error) { if (ticket === generation && active) feedback.textContent = error.message; }
        }
        async function lookup() {
            if (!pending || busy) return;
            busy = true;
            try {
                const result = await api('/operations/' + encodeURIComponent(pending.requestId));
                if (result.state === 'completed') {
                    if (pending.action === 'enable') window.dispatchEvent(new Event('workspace:agent-profiles-changed'));
                    pending = null; feedback.textContent = tr('已核对操作结果。');
                }
                else feedback.textContent = tr('结果尚未确定。请继续核对状态，不要重复提交。');
            } catch (error) { feedback.textContent = error.message; }
            finally { busy = false; await load(); }
        }
        async function write(action, extra = {}, resume = null) {
            if (busy || pending || !status) return;
            busy = true;
            const input = resume || { requestId: crypto.randomUUID(), expectedRevision: status.revision, ...extra };
            const ticket = generation;
            panel.querySelectorAll('button,input,textarea').forEach(element => { element.disabled = true; });
            feedback.textContent = tr('正在保存…');
            try {
                await api('/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
                editingInitial = false;
                if (ticket === generation && active) feedback.textContent = tr('已保存。');
                window.dispatchEvent(new Event('workspace:staffing-changed'));
                if (action === 'enable') window.dispatchEvent(new Event('workspace:agent-profiles-changed'));
            } catch (error) {
                // A lost/failed response is not cancellation. Retain receipt and only query it.
                if (!error.status || error.status >= 500) pending = { requestId: input.requestId, action };
                if (ticket === generation && active) feedback.textContent = pending ? tr('提交结果待核对。请查询原操作，不要重新提交。') : error.message;
            } finally { busy = false; await load(); }
        }
        function render(ledger) {
            panel.replaceChildren(); panel.dataset.staffingState = status.state;
            const labels = { disabled: '已停用，数据保留', initializing: '正在建立专用智能体', 'awaiting-import': '导入初始台账', 'awaiting-review': '等待核对初始台账', ready: '台账已就绪' };
            panel.append(node('h2', tr(status.state === 'disabled' && !status.revision ? '尚未启用' : labels[status.state])),
                node('p', tr('台账版本：{0}').replace('{0}', status.revision)));
            if (pending) {
                const check = button('查询原操作结果', 'staffing-check-operation', () => void lookup()); check.disabled = busy;
                panel.append(node('p', tr('提交结果待核对。请查询原操作，不要重新提交。')), check); return;
            }
            if (!status.enabled) {
                panel.append(node('p', tr('启用后建立专用智能体。普通聊天保持原有配置。停用后保留台账和历史。')),
                    button(status.profileId ? '重新启用' : '启用人员调配', 'staffing-enable', () => void write('enable'))); return;
            }
            const steps = node('ol', undefined, { class: 'staffing-steps' });
            for (const label of ['建立专用智能体', '导入人员及占用', '核对并开始使用']) steps.append(node('li', tr(label)));
            panel.append(steps);
            if (status.state === 'initializing') {
                panel.append(node('p', tr('初始化可以恢复。已创建的智能体不会重复创建。')),
                    button('继续初始化', 'staffing-resume', () => void write('enable', {}, status.initialization)));
            } else if (status.state === 'awaiting-import' || editingInitial && status.state === 'awaiting-review') {
                panel.append(node('p', tr('导入人员、当前和已知未来的项目、预占、请假与培训。日期使用 YYYY-MM-DD。')));
                globalThis.PiStaffingExcel?.mount(panel, { request: api, status, refresh: load });
                const advanced = node('details', undefined, { 'data-staffing-advanced': '' });
                advanced.append(node('summary', tr('高级台账输入')));
                const help = node('details'); help.append(node('summary', tr('查看 JSON 字段示例')), node('pre', JSON.stringify(sample, null, 2)));
                const label = node('label', tr('初始台账 JSON'), { for: 'staffing-initial-json' });
                const input = node('textarea', undefined, { id: 'staffing-initial-json', rows: '12', spellcheck: 'false' });
                input.value = draft; input.addEventListener('input', () => { draft = input.value; });
                const fileLabel = node('label', tr('从 JSON 文件读取'), { for: 'staffing-initial-file' });
                const file = node('input', undefined, { type: 'file', id: 'staffing-initial-file', accept: '.json,application/json' });
                file.addEventListener('change', async () => {
                    const selected = file.files[0], ticket = generation;
                    if (!selected || selected.size > 8 * 1024 * 1024) { feedback.textContent = tr('文件不得超过 8 MiB。'); return; }
                    try { const content = await selected.text(); if (active && ticket === generation && !busy) { draft = content; input.value = content; } }
                    catch (error) { if (active && ticket === generation) feedback.textContent = error.message; }
                });
                advanced.append(help, label, input, fileLabel, file,
                    button('导入并检查', 'staffing-import', () => { try { const data = JSON.parse(input.value); void write('initialize', data); } catch { feedback.textContent = tr('JSON 格式无效，请检查后再导入。'); } }));
                panel.append(advanced);
                if (editingInitial) advanced.open = true;
                if (editingInitial) panel.append(button('返回核对', 'staffing-return-review', () => { editingInitial = false; void load(); }, true));
            } else {
                panel.append(node('p', tr('人员 {0} · 项目 {1} · 占用 {2}').replace('{0}', status.counts.people).replace('{1}', status.counts.projects).replace('{2}', status.counts.occupancies)),
                    node('p', tr(status.historyComplete ? '已登记完整项目历史。' : '项目历史不完整。后续推荐将按已录入记录排序。')));
                if (ledger && status.state !== 'ready') panel.append(showPeople(ledger));
                if (ledger && status.state === 'awaiting-review') {
                    const detail = node('details');
                    detail.append(node('summary', tr('查看完整台账记录')), node('pre', JSON.stringify({ people: ledger.people, projects: ledger.projects, occupancies: ledger.occupancies }, null, 2)));
                    panel.append(detail);
                }
                if (status.state === 'awaiting-review') {
                    const review = node('label', undefined, { class: 'staffing-review' });
                    const checkbox = node('input', undefined, { type: 'checkbox', id: 'staffing-reviewed' });
                    review.append(checkbox, node('span', tr('我已核对人员及当前和已知未来占用。')));
                    const confirm = button('核对完成，开始使用', 'staffing-confirm-initial', () => void write('confirm-initial', { reviewed: true }));
                    confirm.disabled = true; checkbox.addEventListener('change', () => { confirm.disabled = !checkbox.checked || busy; }); panel.append(review, confirm);
                    panel.append(button('高级修改初始台账', 'staffing-edit-initial', () => {
                        draft = JSON.stringify({ people: ledger.people, projects: ledger.projects, occupancies: ledger.occupancies, historyComplete: ledger.historyComplete }, null, 2);
                        editingInitial = true; render(ledger);
                    }, true));
                } else {
                    const link = node('a', tr('打开人员调配智能体'), { href: '#/assistant?profileId=' + encodeURIComponent(status.profileId), class: 'settings-primary-button' }); panel.append(link);
                }
            }
            const actions = node('div', undefined, { class: 'staffing-actions' });
            actions.append(button('刷新状态', 'staffing-refresh', () => void load(), true));
            if (status.state !== 'initializing') actions.append(button('停用并保留数据', 'staffing-disable', () => void write('disable'), true));
            panel.append(actions);
            if (!(status.state === 'awaiting-import' || editingInitial && status.state === 'awaiting-review')) globalThis.PiStaffingExcel?.mount(panel, { request: api, status, refresh: load });
            if (status.state === 'ready') globalThis.PiStaffingViews?.mount(panel, { request: api, status, refresh: load });
        }
        function route(detail) { active = detail?.tab === 'staffing'; generation++; if (active) void load(); }
        window.addEventListener('workspace:tabchanged', event => route(event.detail));
        window.addEventListener('workspace:access-ready', () => void load());
        window.addEventListener('workspace:access-locked', () => { generation++; status = null; panel.replaceChildren(); navigation(null); });
        window.addEventListener('workspace:staffing-changed', () => { if (!busy && !pending) void load(); });
        window.addEventListener('pagehide', () => { active = false; generation++; });
        route(window.PiWorkspaceRoute?.current());
        Promise.resolve(window.WorkspaceAccess?.ready).then(() => { if (!active) void load(); });
    });
})();
