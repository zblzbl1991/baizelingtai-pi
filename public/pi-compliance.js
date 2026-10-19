(() => {
    const isDefiniteRejection = error => error.status>=400&&error.status<500&&error.status!==404&&error.data?.operationAccepted!==true&&error.data?.operationAccepted!==null
        &&(error.data?.code!=='COMPLIANCE_BUSY'||error.data?.operationAccepted===false);
    const t = (text, ...values) => (window.PiI18n?.t || ((s, ...args) => s.replace(/\{(\d+)\}/g, (_, n) => args[n] ?? '')))(text, ...values);
    const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = t(text); if (className) el.className = className; return el; };
    const button = (text, id, action) => { const el = node('button', text, 'settings-secondary-button'); el.type = 'button'; if (id) el.id = id; el.onclick = action; return el; };
    const label = (text, field) => { const el = node('label', text); el.append(field); return el; };
    const rules = [['documents-identity', '资料缺失与归属'], ['feasibility-numbers', '可研评审及批复文号'], ['contract-deadline', '合同签订期限'], ['feasibility-order', '可研与评审时序']];
    function randomId() {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(byte => byte.toString(16).padStart(2,'0')).join(''); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }
    const modelKey = ref => ref ? ref.provider + '/' + (ref.modelId || ref.id) : '';
    const send = (api, url, input, method = 'PUT') => api('/api/pi/compliance' + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    function createSettings({ apiFetch, currentCwd }) {
        const root = document.getElementById('settings-builtins'); let epoch = 0, data, busy = false;
        async function open() {
            const generation = ++epoch; root.replaceChildren(node('p', '正在读取内置能力…', 'settings-help'));
            const results = await Promise.allSettled([apiFetch('/api/pi/compliance'), apiFetch('/api/pi/profiles'), apiFetch('/api/pi/settings/models')]);
            if (generation !== epoch) return;
            if (results[0].status !== 'fulfilled') { root.replaceChildren(node('p', results[0].reason.message, 'settings-help'), button('刷新状态', '', open)); return; }
            data = results[0].value;
            if (data.pendingSetup?.input && !sessionStorage.getItem('pivane.compliance.settings-operation')) sessionStorage.setItem('pivane.compliance.settings-operation', JSON.stringify(data.pendingSetup.input));
            const profiles = results[1].status === 'fulfilled' ? results[1].value.profiles || [] : [];
            const models = results[2].status === 'fulfilled' ? (results[2].value.models || []).filter(model => model.available) : [];
            render(profiles, models);
        }
        function render(profiles, models) {
            root.replaceChildren();
            const title = node('div', undefined, 'settings-panel-header'); title.append(node('h3', '内置能力'));
            root.append(title, node('p', '按需启用。每项能力独立配置，停用后保留已有资料。', 'settings-help'));
            const section = node('section', undefined, 'compliance-settings'), heading = node('h4', '合规审查');
            const readiness = { 'configuration-insufficient': '配置不足', partial: '部分可用', available: '本地条件可用' }[data.availability?.status] || '可用条件待核对';
            const status = node('p', data.status === 'disabling' ? '停用中，等待当前步骤保存' : data.status === 'configuring' ? '配置待核对' : data.enabled ? '已启用，' + readiness : '已停用', 'compliance-status'); status.id = 'compliance-settings-status'; status.setAttribute('role', 'status');
            const form = node('form'), fields = node('fieldset'), enabled = node('input'); enabled.type = 'checkbox'; enabled.id = 'compliance-enabled'; enabled.checked = data.enabled;
            fields.append(label('启用合规审查', enabled));
            const options = node('div', undefined, 'compliance-fields');
            const profile = node('select'); profile.id = 'compliance-profile'; profile.append(new Option(t('创建专用合规助手'), ''));
            for (const item of profiles.filter(item => item.enabled || item.id === data.profileId)) profile.append(new Option(item.name, item.id));
            if (data.profileId && ![...profile.options].some(item => item.value === data.profileId)) profile.append(new Option(t('已绑定身份'), data.profileId));
            profile.value = data.profileId || ''; profile.disabled = Boolean(data.profileId);
            const modelSelect = (id, selected, images) => {
                const field = node('select'); field.id = id; field.append(new Option(t(images ? '暂不配置扫描识别' : '请选择对话模型'), ''));
                for (const model of models.filter(model => model.input?.includes(images ? 'image' : 'text'))) field.append(new Option((model.name || model.id) + ' · ' + model.provider, modelKey(model)));
                if (selected && ![...field.options].some(option => option.value === modelKey(selected))) field.append(new Option(modelKey(selected), modelKey(selected)));
                field.value = modelKey(selected); return field;
            };
            const main = modelSelect('compliance-main-model', data.mainModel, false), extraction = modelSelect('compliance-extraction-model', data.extractionModel, true);
            options.append(label('专用助手', profile), label('对话模型', main), label('资料识别模型', extraction));
            if (data.profileId) options.append(button('编辑助手名称与行为说明', '', () => window.PiWorkspaceRoute?.navigate('profiles', { profileId: data.profileId })));
            const scan = node('p', data.extractionModel ? '已配置图像模型。启用能力和保存配置不会发起识别。' : '扫描识别未配置。文本资料可继续使用。', 'settings-help');
            options.append(scan); options.hidden = !enabled.checked; enabled.onchange = () => { options.hidden = !enabled.checked; };
            fields.append(options); form.append(fields);
            const save = button('保存设置', 'compliance-save'); save.type = 'submit'; save.classList.add('settings-primary-button'); form.append(save);
            const toRef = value => { if (!value) return null; const i = value.indexOf('/'); return { provider: value.slice(0, i), modelId: value.slice(i + 1) }; };
            let resumePending = false;
            form.onsubmit = async event => {
                event.preventDefault(); if (busy) return;
                busy = true; fields.disabled = true; save.disabled = true;
                const generation = epoch;
                const storageKey = 'pivane.compliance.settings-operation';
                let pending; try { pending = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch {}
                const input = pending || { requestId: randomId(), expectedRevision: data.revision, expectedSettingsRevision: data.settingsRevision, enabled: enabled.checked,
                    ...(enabled.checked ? { mainModel: toRef(main.value), extractionModel: toRef(extraction.value), ...(!data.profileId && profile.value ? { profileId: profile.value } : {}) } : {}) };
                sessionStorage.setItem(storageKey, JSON.stringify(input));
                try {
                    let result;
                    if (pending) {
                        result = await apiFetch('/api/pi/compliance/operations/' + encodeURIComponent(input.requestId));
                        if (result.status === 'pending' && (!result.canResume || !resumePending)) {
                            resumePending = result.canResume === true; save.textContent = t('继续首次配置');
                            status.textContent = t('原操作已登记。核对原配置后，点击继续首次配置。'); return;
                        }
                    }
                    if (!result || result.status === 'pending') result = await send(apiFetch, '/settings', input);
                    sessionStorage.removeItem(storageKey);
                    window.dispatchEvent(new CustomEvent('pi:compliance-config-saved'));
                    if (generation === epoch) await open();
                } catch (error) {
                    if (isDefiniteRejection(error)) sessionStorage.removeItem(storageKey);
                    if (generation === epoch) {
                        if (error.data?.code === 'COMPLIANCE_STALE' || error.data?.code === 'COMPLIANCE_CONFLICT') {
                            const latest = await apiFetch('/api/pi/compliance');
                            if (generation === epoch) data = latest;
                        }
                        status.textContent = t(error.status === 404 ? '原操作状态未知。请刷新并核对，系统没有重发请求。' : error.message);
                    }
                } finally { busy = false; if (fields.isConnected) fields.disabled = false; if (save.isConnected) save.disabled = false; }
            };
            section.append(heading, status);
            if (data.enabled && data.availability?.reasons?.length) section.append(node('p', data.availability.reasons.join('；') + '。', 'settings-help'));
            section.append(node('p', '一个专用助手负责工程资料、四组规则、问题复核与报告。工程项目档案独立保存，可跨聊天继续使用。', 'settings-help'), form);
            const start = button('打开合规对话', 'compliance-open-chat', async () => {
                if (busy) return;
                const cwd = currentCwd(); if (!cwd) { status.textContent = t('请先选择工作目录。'); return; }
                start.disabled = true; window.dispatchEvent(new CustomEvent('pi:compliance-start', { detail: { cwd,
                    complete: () => { if (start.isConnected) start.disabled = false; } } }));
            }); start.hidden = !data.enabled; section.append(start); root.append(section);
        }
        return { open, close() { epoch++; } };
    }
    function createChat({ apiFetch, context }) {
        const trigger = document.getElementById('pi-compliance-open'), drawer = document.getElementById('pi-compliance-drawer');
        let generation = 0, settings, loaded, selected = null, sessionKey = ''; const pending = new Map();
        const key = () => { const value = context(); return value ? JSON.stringify([value.cwd, value.sessionId, value.generation]) : ''; };
        function close() { generation++; drawer.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
        async function update() {
            const expected = key(); if (expected !== sessionKey) { sessionKey = expected; selected = null; close(); }
            const current = context();
            if (!current?.connected || !current.profileId) { trigger.hidden = true; close(); return; }
            const n = ++generation;
            try {
                settings = await apiFetch('/api/pi/compliance');
                if (n !== generation || expected !== key()) return;
                trigger.hidden = !settings.enabled || settings.profileId !== current.profileId;
                if (trigger.hidden) close();
            } catch { if (n === generation) { trigger.hidden = true; close(); } }
        }
        async function open() {
            const n = ++generation, expected = key(); trigger.disabled = true;
            try {
                const current = await apiFetch('/api/pi/compliance');
                if (n !== generation || expected !== key()) return;
                if (!current.enabled || current.profileId !== context()?.profileId) { trigger.hidden = true; return close(); }
                loaded = await apiFetch('/api/pi/compliance/projects');
                if (n !== generation || expected !== key()) return;
                drawer.hidden = false; trigger.setAttribute('aria-expanded', 'true'); render();
            } finally { trigger.disabled = false; }
        }
        function render() {
            drawer.replaceChildren();
            const header = node('div', undefined, 'compliance-drawer-header');
            const title = node('h3', '工程项目档案'); title.id = 'compliance-project-title'; drawer.setAttribute('aria-labelledby', title.id);
            header.append(title, button('关闭', 'pi-compliance-close', () => { close(); trigger.focus(); })); drawer.append(header);
            const list = node('div', undefined, 'compliance-project-list');
            for (const project of loaded.projects) {
                const choose = button('', '', () => { selected = project; render(); }); choose.textContent = project.name + (project.number ? ' · ' + project.number : ''); list.append(choose);
            }
            drawer.append(node('p', '同名工程以编号区分。未知信息留空，适用性由审查人员核对。', 'settings-help'), list,
                button('新建工程项目', 'compliance-project-new', () => { selected = null; render(); }));
            const form = node('form', undefined, 'compliance-project-form'), fields = node('fieldset'), inputs = {};
            for (const [name, caption] of [['name', '工程项目名称'], ['number', '工程项目编号'], ['organization', '单位'], ['year', '年度'], ['phase', '期次'], ['type', '项目类型'], ['stage', '项目阶段']]) {
                const input = node('input'); input.id = 'compliance-project-' + name; input.value = selected?.[name] ?? ''; input.maxLength = 300; input.required = name === 'name'; inputs[name] = input; fields.append(label(caption, input));
            }
            const confirmed = node('input'); confirmed.type = 'checkbox'; confirmed.id = 'compliance-project-confirmed'; confirmed.checked = selected?.identityConfirmed === true;
            fields.append(label('我已核对工程项目身份', confirmed));
            const applicable = {};
            for (const [id, caption] of rules) {
                const select = node('select'); select.append(new Option(t('尚未确认'), ''), new Option(t('适用'), 'yes'), new Option(t('不适用'), 'no'));
                select.id = 'compliance-applicability-' + id; select.setAttribute('aria-label', t(caption));
                select.value = selected?.applicability?.[id] === true ? 'yes' : selected?.applicability?.[id] === false ? 'no' : ''; applicable[id] = select; fields.append(label(caption, select));
            }
            const save = button('保存工程项目', 'compliance-project-save'); save.type = 'submit'; save.classList.add('settings-primary-button');
            const status = node('p', '', 'settings-help'); status.id = 'compliance-project-status'; status.setAttribute('role', 'status');
            if (selected) { const id = node('p', '', 'settings-help'); id.textContent = 'ID: ' + selected.id + ' · ' + (selected.number || t('编号未知')); fields.append(id); }
            form.append(fields, save, status); drawer.append(form);
            if (selected) {
                const expected = key(), n = generation;
                window.PiComplianceMaterials?.mount({ root: drawer, project: selected, apiFetch, context, valid: () => n === generation && expected === key() });
            }
            form.onsubmit = async event => {
                event.preventDefault(); if (save.disabled) return;
                const n = generation, expected = key(); fields.disabled = true; save.disabled = true;
                const project = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value.trim() || null]));
                project.identityConfirmed = confirmed.checked; project.applicability = Object.fromEntries(Object.entries(applicable).map(([id, select]) => [id, select.value === '' ? null : select.value === 'yes']));
                const priorOperation = pending.get(expected);
                const operation = priorOperation || { input: { requestId: randomId(), expectedRevision: loaded.revision, project }, id: selected?.id };
                pending.set(expected, operation);
                try {
                    let result;
                    if (priorOperation) result = await apiFetch('/api/pi/compliance/operations/' + operation.input.requestId);
                    if (!result) result = await send(apiFetch, '/projects' + (operation.id ? '/' + operation.id : ''), operation.input, operation.id ? 'PUT' : 'POST');
                    pending.delete(expected);
                    if (n !== generation || expected !== key()) return;
                    selected = result.project; loaded = await apiFetch('/api/pi/compliance/projects');
                    if (n !== generation || expected !== key()) return;
                    render(); document.getElementById('compliance-project-status').textContent = t('已保存。未填写的字段保留未知。');
                } catch (error) {
                    if (isDefiniteRejection(error)) pending.delete(expected);
                    if (n === generation && expected === key()) {
                        if (error.data?.code === 'COMPLIANCE_STALE') {
                            const latest = await apiFetch('/api/pi/compliance/projects'); if (n === generation && expected === key()) loaded = latest;
                        }
                        status.textContent = error.status === 404 ? t('原操作状态未知。请刷新并核对，系统没有重发请求。') : error.message;
                    }
                } finally { if (fields.isConnected) fields.disabled = false; if (save.isConnected) save.disabled = false; }
            };
        }
        trigger.onclick = () => { if (!drawer.hidden) close(); else open().catch(error => { drawer.hidden = false; drawer.replaceChildren(node('p', error.message), button('关闭', 'pi-compliance-close', close)); }); };
        drawer.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus(); } });
        window.addEventListener('pi:compliance-config-saved', update);
        window.addEventListener('workspace:access-locked', () => { trigger.hidden = true; close(); });
        return { update, close };
    }
    window.PiCompliance = { createSettings, createChat, randomId, isDefiniteRejection };
})();
