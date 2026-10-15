// Typed server plans own identity and state. This renderer never constructs a business write from model HTML.
(() => {
    const tr = text => globalThis.PiI18n?.t(text) || text;
    const node = (tag, text, attrs = {}) => {
        const element = document.createElement(tag); if (text !== undefined) element.textContent = text;
        for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value); return element;
    };
    function create({ fetch: request, context = () => null }) {
        const states = new Map();
        window.addEventListener('workspace:staffing-changed', () => { for (const entry of states.values()) if (entry.card?.isConnected && !entry.busy) void entry.refresh?.(); });
        window.addEventListener('workspace:access-locked', () => { for (const entry of states.values()) { entry.unavailable = true; entry.redraw?.(); } });
        const sourceOf = plan => plan.source.kind === 'page' ? { kind: 'page' } : { cwd: plan.source.cwd, sessionId: plan.source.sessionId };
        const pendingKey = id => 'pivane.staffing.pending:' + id;
        function render(message) {
            const preview = message?.details?.pivaneStaffing;
            if (message?.role === 'toolResult' && !message.isError && ['staffing_prepare_change', 'staffing_operation_status'].includes(message.toolName) && preview?.version === 2) {
                const ref = preview.reference;
                if (!['assign', 'absence', 'formalize', 'adjust', 'release'].includes(ref?.kind) || !/^[a-f0-9-]{36}$/.test(ref.id || '') || !Number.isSafeInteger(ref.revision) || ref.revision < 1
                    || typeof ref.source?.cwd !== 'string' || !ref.source.cwd || typeof ref.source.sessionId !== 'string' || !ref.source.sessionId || ref.source.kind !== undefined) return null;
                return renderPlan({ ...ref, personIds: [] });
            }
            if (message?.role !== 'toolResult' || message.isError || message.toolName !== 'staffing_prepare_change' || preview?.version !== 1
                || !/^[a-f0-9-]{36}$/.test(preview.plan?.id || '') || !preview.plan.source
                || typeof preview.plan.source.cwd !== 'string' || typeof preview.plan.source.sessionId !== 'string'
                || preview.plan.kind === 'assign' && (!preview.plan.project || ['name', 'department', 'start', 'end'].some(key => typeof preview.plan.project[key] !== 'string'))
                || !Number.isSafeInteger(preview.plan.revision) || !Array.isArray(preview.plan.personIds)) return null;
            return renderPlan(preview.plan);
        }
        function renderPlan(initial) {
            const id = initial.id, card = node('section', undefined, { class: 'staffing-plan-card', 'data-staffing-plan': id, 'aria-label': tr('人员安排方案') });
            let entry = states.get(id);
            if (!entry) { let pending = null; try { pending = sessionStorage.getItem(pendingKey(id)); } catch { /* Storage may be unavailable. */ }
                entry = { plan: initial, busy: false, pending, notice: '' }; states.set(id, entry); }
            if (entry.card) {
                entry.card.querySelectorAll('button,input').forEach(element => { element.disabled = true; });
                const notice = entry.card.querySelector('[role="status"]');
                if (notice) notice.textContent = tr('此方案已有后续卡片。请使用最新卡片。');
            }
            entry.card = card; entry.loading = true; let viewGeneration = 0;
            const owns = () => entry.card === card;
            const current = () => { const scope = context(); return owns() && (entry.plan.source.kind === 'page' ? card.isConnected : scope && scope.cwd === entry.plan.source.cwd && scope.sessionId === entry.plan.source.sessionId); };
            const clearPending = () => { entry.pending = null; try { sessionStorage.removeItem(pendingKey(id)); } catch { /* UI preference only. */ } };
            const post = (path, body) => request('/api/pi/staffing/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            async function load() {
                if (!owns()) return;
                try { const plan = await request('/api/pi/staffing/plans/' + encodeURIComponent(id) + '?' + new URLSearchParams(sourceOf(entry.plan)));
                    if (!owns()) return; entry.plan = plan; entry.unavailable = false; if (plan.outcome) clearPending();
                } catch (error) { if (!owns()) return; entry.unavailable = true; entry.notice = error.message; }
                entry.loading = false; draw();
            }
            async function write(action, extra = {}, displayed) {
                if (entry.busy || entry.pending || !current() || !displayed || displayed.generation !== viewGeneration
                    || displayed.planId !== entry.plan.id || displayed.revision !== entry.plan.revision) return;
                entry.busy = true; const requestId = crypto.randomUUID();
                const bound = { planId: displayed.planId, expectedRevision: displayed.revision, source: sourceOf(entry.plan) }; let changed = false;
                // Save receipt before awaiting. A reload must not invent a replacement write.
                entry.pending = requestId; try { sessionStorage.setItem(pendingKey(id), requestId); } catch { /* Server plan remains authoritative. */ }
                draw();
                try {
                    const input = { requestId, ...bound, ...extra };
                    const result = await post(action === 'revise' ? 'revise' : 'commit', action === 'revise' ? input : { ...input, action });
                    clearPending(); entry.notice = tr('已保存。');
                    if (action === 'revise') entry.plan = result; else entry.plan.outcome = result;
                    changed = true;
                } catch (error) {
                    if (error.status && error.status < 500) { clearPending(); entry.unavailable = true; entry.notice = error.message; }
                    else entry.notice = tr('提交结果待核对。请查询原操作，不要重新提交。');
                } finally { entry.busy = false; entry.redraw?.(); if (changed) window.dispatchEvent(new Event('workspace:staffing-changed')); }
            }
            async function lookup(generation) {
                if (!entry.pending || entry.busy || !current() || generation !== viewGeneration) return; entry.busy = true; draw();
                try { const receipt = await request('/api/pi/staffing/operations/' + encodeURIComponent(entry.pending));
                    if (receipt.state === 'completed') { clearPending(); await load(); }
                    else entry.notice = tr('结果尚未确定。请继续核对状态，不要重复提交。');
                } catch (error) { entry.notice = error.message; }
                finally { entry.busy = false; entry.redraw?.(); }
            }
            function draw() {
                if (!owns()) return; const plan = entry.plan, generation = ++viewGeneration;
                const displayed = { generation, planId: plan.id, revision: plan.revision }; card.replaceChildren();
                card.append(node('h3', tr(plan.kind === 'assign' ? '人员安排方案' : '人员安排变更')), node('p', tr('台账版本：{0}').replace('{0}', plan.revision)));
                if (plan.project) card.append(node('p', plan.project.name + ' · ' + plan.project.department), node('p', plan.project.start + ' 至 ' + plan.project.end));
                if (plan.kind === 'assign' && plan.project) card.append(node('p', tr('最低人数') + '：' + plan.project.minimum + ' · '
                    + tr(plan.existingTeam?.length ? '本次新增人数' : '本次选中人数') + '：' + plan.personIds.length));
                const status = node('p', entry.notice || plan.warning || '', { role: 'status', 'aria-live': 'polite' }); card.append(status);
                if (entry.loading) { status.textContent = tr('正在读取方案…'); return; }
                const coverage = plan.coverage;
                if (coverage) for (const segment of coverage.segments) card.append(node('p', `${segment.start} — ${segment.end} · ${tr('还缺人数')} ${segment.missing} · ${tr(segment.missingDirect ? '缺直签' : '直签已满足')}`));
                for (const affected of plan.affectedProjects || []) { card.append(node('p', affected.name)); for (const segment of affected.coverage.segments) card.append(node('p', `${segment.start} 至 ${segment.end} · ${tr('还缺人数')} ${segment.missing} · ${tr(segment.missingDirect ? '缺直签' : '直签已满足')}`)); }
                if (plan.lastRequiredDate) card.append(node('p', tr('最后用人日') + '：' + plan.lastRequiredDate + ' · ' + tr('释放开始日') + '：' + plan.change.effectiveDate));
                if (plan.diff) {
                    const diff = node('div', undefined, { class: 'staffing-plan-diff' });
                    const labels = { project: '项目', leave: '请假', training: '培训', unavailable: '不可用', reserved: '预占', confirmed: '正式确认', cancelled: '已释放', active: '进行中', ended: '提前结束' };
                    const names = new Map((plan.people || []).map(person => [person.id, person.name]));
                    const describe = row => row ? (row.personId ? (names.get(row.personId) || row.personId) + ' (' + row.personId + ')' : row.name || row.id) + ' · ' + tr(labels[row.kind] || '') + ' · ' + row.start + ' 至 ' + row.end + ' · ' + tr(labels[row.state || row.lifecycle?.state] || '') : tr('新增');
                    for (const field of ['projects', 'occupancies']) for (const item of plan.diff[field]) diff.append(node('p', describe(item.before) + ' → ' + describe(item.after)));
                    card.append(diff);
                }
                if (plan.outcome) {
                    card.append(node('p', tr(plan.outcome.action === 'reserve' ? '已预占' : '已保存确认'), { 'data-staffing-outcome': 'completed' }),
                        node('p', plan.outcome.coverage ? tr(plan.outcome.coverage.allConfirmed ? '全部人员已正式确认' : '尚未全部正式确认') : ''));
                    for (const person of plan.people || []) card.append(node('p', person.name + ' · ' + person.id + ' · ' + person.department)); return;
                }
                if (entry.pending) { const check = node('button', tr('查询原操作结果'), { type: 'button', 'data-staffing-action': 'lookup' });
                    check.disabled = entry.busy; check.addEventListener('click', () => void lookup(generation)); card.append(check); return; }
                if (entry.unavailable || plan.stale || !current()) { card.append(node('p', tr('方案已失效或能力不可用。请查询并准备新方案。'))); return; }
                if (plan.kind !== 'assign') {
                    const apply = node('button', tr('确认以上变更'), { type: 'button', 'data-staffing-action': 'apply' });
                    apply.disabled = entry.busy; apply.addEventListener('click', () => void write('apply', {}, displayed)); card.append(apply); return;
                }
                if (plan.existingTeam?.length) card.append(node('p', tr('已安排人数') + '：' + new Set(plan.existingTeam.map(row => row.personId)).size));
                const list = node('fieldset'); list.append(node('legend', tr('选择人员')));
                const selected = new Set(plan.personIds), inputs = [];
                const allCandidates = new Map([...(plan.candidates || []), ...(plan.people || [])].map(person => [person.id, person]));
                for (const person of allCandidates.values()) {
                    const label = node('label', undefined, { class: 'staffing-person-choice' }), input = node('input', undefined, { type: 'checkbox', 'data-staffing-person': person.id });
                    input.checked = selected.has(person.id); input.disabled = entry.busy; inputs.push(input);
                    label.append(input, node('span', person.name + ' · ' + person.id + ' · ' + person.department + ' · ' + tr(person.direct ? '直签' : '非直签'))); list.append(label);
                }
                card.append(list);
                if (plan.candidates?.length === 200) card.append(node('p', tr('此卡片最多显示 200 名候选人员。')));
                const permission = node('label', undefined, { class: 'staffing-person-choice' }), cross = node('input', undefined, { type: 'checkbox', 'data-staffing-cross': '' });
                cross.checked = plan.crossDepartment; cross.disabled = entry.busy;
                permission.append(cross, node('span', tr('仅此方案允许跨事业部查询和借人'))); card.append(permission);
                const actions = node('div', undefined, { class: 'staffing-actions' });
                const revise = node('button', tr('检查调整后的名单'), { type: 'button', 'data-staffing-action': 'revise' });
                revise.disabled = entry.busy; revise.addEventListener('click', () => void write('revise', { personIds: inputs.filter(input => input.checked).map(input => input.dataset.staffingPerson), allowCrossDepartment: cross.checked }, displayed)); actions.append(revise);
                const confirms = [];
                for (const [action, label] of [['reserve', '预占'], ['confirm', '正式确认']]) { const button = node('button', tr(label), { type: 'button', 'data-staffing-action': action });
                    button.disabled = entry.busy; button.addEventListener('click', () => void write(action, {}, displayed)); confirms.push(button); actions.append(button); }
                for (const input of [...inputs, cross]) input.addEventListener('change', () => { confirms.forEach(button => { button.disabled = true; }); status.textContent = tr('名单已修改。请先检查调整后的名单。'); });
                card.append(actions);
            }
            entry.refresh = load; entry.redraw = draw;
            draw(); void load(); return card;
        }
        return { render, renderPage: plan => plan?.source?.kind === 'page' && /^[a-f0-9-]{36}$/.test(plan.id || '') ? renderPlan(plan) : null };
    }
    globalThis.PiStaffingCards = { create };
})();
