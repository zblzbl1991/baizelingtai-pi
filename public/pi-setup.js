// First use operates on the real settings, profile and project services.
// This module owns only presentation progress; credentials stay in Settings.
(() => {
    const KEY = 'pivane.setup.v1';
    const initialHash = location.hash;
    const t = (zh, en) => globalThis.PiI18n?.locale === 'en' ? en : zh;
    const node = (tag, text, className) => {
        const element = document.createElement(tag);
        if (text != null) element.textContent = text;
        if (className) element.className = className;
        return element;
    };
    function create({ apiFetch }) {
        const root = document.getElementById('setup-tab');
        let progress = {};
        try { progress = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* Storage is optional. */ }
        let step = Number.isInteger(progress.step) ? Math.max(0, Math.min(3, progress.step)) : 0;
        let booted = false, supported = false, assistantEnabled = false, busy = false, loading = false, epoch = 0, focusRequested = true, returningFromSetup = false;
        let snapshot = null, profiles = null, projects = null, projectId = '', modelKey = '', notice = '', uncertain = false, modelUncertain = false;
        const active = () => globalThis.PiWorkspaceRoute?.current().tab === 'setup';
        const defaultProfile = () => profiles?.profiles?.find(profile => profile.id === profiles.defaultAssistantId && profile.enabled);
        const models = () => (snapshot?.models || []).filter(model => model.available === true);
        const keyOf = model => JSON.stringify([model.provider, model.id]);
        const groups = () => (projects?.projects || []).filter(project => !project.archived && Array.isArray(project.profileIds) && project.profileIds.includes(profiles.defaultAssistantId));
        const selectedProject = () => groups().find(project => project.id === projectId);
        const store = status => {
            progress = { status, step };
            try { localStorage.setItem(KEY, JSON.stringify(progress)); } catch { /* In-memory progress remains usable. */ }
        };
        const request = (url, body, method = 'POST') => apiFetch(url, {
            method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000)
        });
        const read = url => apiFetch(url, { signal: AbortSignal.timeout(30000) });
        const action = (label, run, primary = false, disabled = false) => {
            const button = node('button', label, primary ? 'settings-primary-button' : 'settings-secondary-button');
            button.type = 'button'; button.disabled = busy || loading || disabled;
            button.addEventListener('click', () => void run());
            return button;
        };
        const returnBar = node('div', null, 'pi-setup-return');
        returnBar.hidden = true;
        returnBar.append(node('span', t('配置完成后，回到引导继续。', 'Return to setup when your changes are saved.')),
            action(t('继续首次设置', 'Continue setup'), () => globalThis.PiWorkspaceRoute.navigate('setup')));
        document.body.append(returnBar);
        const configure = (tab, params = {}) => {
            store('in-progress');
            returningFromSetup = true;
            globalThis.PiWorkspaceRoute.navigate(tab, { ...params, setup: '1' });
        };
        const configureKnowledge = () => {
            if (!assistantEnabled || !selectedProject()) return;
            store('in-progress');
            returningFromSetup = true;
            window.dispatchEvent(new CustomEvent('pi:extension-assistant', { detail: {
                cwd: selectedProject().cwd, scope: 'global', need: globalThis.PiExtensionAssistant.weknoraDraft()
            } }));
        };
        let editor;
        const chooseProject = () => {
            editor ||= globalThis.PiAssistantProjects.createEditor({ apiFetch, initialSetup: true, idPrefix: 'pi-setup',
                profileId: () => profiles?.defaultAssistantId,
                onSaved: project => { projectId = project.id; void refresh(); }
            });
            editor.open(null, projects.revision);
        };
        async function refresh() {
            if (!booted || !active() || busy) return;
            if (!supported) { render(); return; }
            const ticket = ++epoch;
            loading = true; notice = ''; render();
            try {
                const [modelData, profileData] = await Promise.all([read('/api/pi/settings/models'), read('/api/pi/profiles')]);
                if (ticket !== epoch || !active()) return;
                if (!Array.isArray(modelData.models) || !Array.isArray(profileData.profiles)
                    || !profileData.profiles.some(profile => profile.id === profileData.defaultAssistantId && profile.enabled)) {
                    throw new Error(t('设置数据不完整，请刷新重试。', 'Setup data is incomplete. Refresh to try again.'));
                }
                snapshot = modelData; profiles = profileData;
                modelUncertain = false;
                const projectData = await read(`/api/pi/assistant-projects?profileId=${encodeURIComponent(profiles.defaultAssistantId)}`);
                if (ticket !== epoch || !active()) return;
                if (!Array.isArray(projectData.projects) || typeof projectData.revision !== 'string') throw new Error(t('项目数据不可用。', 'Project data is unavailable.'));
                projects = projectData;
                if (!models().some(model => keyOf(model) === modelKey)) {
                    const preferred = models().find(model => model.provider === snapshot.preferences?.defaultProvider && model.id === snapshot.preferences?.defaultModel);
                    modelKey = preferred ? keyOf(preferred) : models()[0] ? keyOf(models()[0]) : '';
                }
                if (!selectedProject()) projectId = groups()[0]?.id || '';
            } catch (error) { if (ticket === epoch && active()) notice = error.message; }
            finally { if (ticket === epoch) { loading = false; render(); } }
        }
        async function next() {
            if (busy || loading || modelUncertain || !snapshot || !defaultProfile()) return;
            const intent = globalThis.PiWorkspaceRoute.revision();
            busy = true; notice = ''; render();
            try {
                if (step === 0) {
                    const model = models().find(item => keyOf(item) === modelKey);
                    if (!model) throw new Error(t('请先连接至少一个模型。', 'Connect at least one model first.'));
                    await request('/api/pi/settings/models/preferences', { defaultProvider: model.provider, defaultModel: model.id });
                    snapshot.preferences = { ...snapshot.preferences, defaultProvider: model.provider, defaultModel: model.id };
                }
                if (active() && intent === globalThis.PiWorkspaceRoute.revision()) { step++; focusRequested = true; store('in-progress'); }
            } catch (error) {
                modelUncertain = !error.status || error.status >= 500;
                notice = !error.status || error.status >= 500
                    ? t('保存结果待核对。请重新读取设置，确认默认模型后继续。', 'Save outcome needs checking. Refresh settings and confirm the default model before continuing.') : error.message;
            } finally { busy = false; render(); }
        }
        async function finish() {
            if (busy || loading || uncertain || !selectedProject()) return;
            const intent = globalThis.PiWorkspaceRoute.revision();
            const project = selectedProject(), profileId = profiles.defaultAssistantId;
            busy = true; notice = ''; render();
            let creating = false;
            try {
                // Re-read readiness; a different browser may have changed configuration.
                const [modelData, profileData, projectData] = await Promise.all([
                    read('/api/pi/settings/models'), read('/api/pi/profiles'),
                    read(`/api/pi/assistant-projects?profileId=${encodeURIComponent(profileId)}`)
                ]);
                if (!modelData.models?.some(model => model.available === true && model.provider === modelData.preferences?.defaultProvider && model.id === modelData.preferences?.defaultModel)) {
                    step = 0; throw new Error(t('请先选择一个可用的默认模型。', 'Choose an available default model first.'));
                }
                if (profileData.defaultAssistantId !== profileId || !profileData.profiles?.some(profile => profile.id === profileId && profile.enabled)
                    || !projectData.projects?.some(item => item.id === project.id && !item.archived && item.cwd === project.cwd && item.profileIds.includes(profileId))) {
                    throw new Error(t('助手或项目已变化，请重新读取设置。', 'The assistant or project has changed. Refresh setup.'));
                }
                if (!active() || intent !== globalThis.PiWorkspaceRoute.revision()) return;
                creating = true;
                const session = await request('/api/pi/sessions', { cwd: project.cwd, profileId, assistantProjectId: project.id });
                if (!session?.id || session.agentProfile?.id !== profileId || session.assistantProject?.id !== project.id) {
                    throw new Error(t('对话创建结果待核对。', 'Conversation creation needs checking.'));
                }
                store('complete');
                returningFromSetup = false;
                if (active() && intent === globalThis.PiWorkspaceRoute.revision()) {
                    globalThis.PiWorkspaceRoute.navigate('assistant', { profileId, projectId: project.id, sessionId: session.id });
                }
            } catch (error) {
                uncertain = creating && (!error.status || error.status >= 500);
                notice = uncertain ? t('创建结果待核对，请到助手对话查看线程列表，不要重复创建。', 'Creation needs checking. Review conversations in Assistant chat before creating another.') : error.message;
            } finally { busy = false; render(); }
        }
        function render() {
            if (!active()) return;
            const shell = node('section', null, 'pi-setup-shell');
            const top = node('header', null, 'pi-setup-header');
            const logo = document.createElement('img'); logo.src = 'brand/logo-app.svg'; logo.alt = ''; logo.width = 48; logo.height = 48;
            const copy = node('div');
            copy.append(node('p', t('白泽灵台 · 首次设置', '白泽灵台 · Setup'), 'pi-setup-eyebrow'));
            const assistantName = defaultProfile()?.name || '小白';
            const title = node('h1', t(`让${assistantName}陪你开始第一项工作`, `Start your first task with ${assistantName}`)); title.id = 'pi-setup-title';
            copy.append(title, node('p', t('连接模型、选好工作目录，再试试用对话配置知识库。', 'Connect a model, choose a working folder, and try configuring a knowledge base through conversation.')));
            top.append(logo, copy); shell.append(top);
            const steps = node('ol', null, 'pi-setup-steps');
            [t('连接模型', 'Connect a model'), t('认识助手', 'Meet your assistant'), t('选择工作目录', 'Choose a working folder'), t('配置知识库', 'Configure knowledge base')].forEach((label, index) => {
                const item = node('li');
                if (index === step) item.setAttribute('aria-current', 'step');
                const button = action(`${index + 1}. ${label}`, () => { step = index; focusRequested = true; store('in-progress'); render(); });
                button.disabled ||= index > step;
                item.append(button); steps.append(item);
            });
            shell.append(steps);
            const body = node('section', null, 'pi-setup-body');
            if (!booted || loading) {
                body.setAttribute('aria-busy', 'true');
                body.append(node('p', t('正在读取当前设置…', 'Reading your settings…')));
            } else if (!supported) {
                body.append(node('h2', t('首次设置暂不可用', 'Setup is unavailable')),
                    node('p', t('当前服务需要支持助手身份、项目分类和模型设置。', 'The service needs assistant profiles, project categories and model settings.')));
            } else if (!snapshot || !projects || !defaultProfile()) {
                body.append(node('h2', t('先读取当前配置', 'Read your current configuration')));
            } else if (step === 0) {
                body.append(node('h2', t('选择助手使用的模型', 'Choose a model for your assistant')),
                    node('p', t('模型提供思考与回答能力。先连接你的模型服务，再选择一个默认模型。', 'Models power reasoning and replies. Connect your model service, then select a default model.')));
                if (models().length) {
                    const label = node('label', t('默认模型', 'Default model')); label.htmlFor = 'pi-setup-model';
                    const select = node('select'); select.id = 'pi-setup-model'; select.disabled = busy;
                    for (const model of models()) { const option = node('option', `${model.name || model.id} · ${model.provider}`); option.value = keyOf(model); select.append(option); }
                    select.value = modelKey; select.addEventListener('change', () => { modelKey = select.value; });
                    body.append(label, select, node('small', t('可用表示配置已就绪，实际连通性以首次请求为准。', 'Available means configured. Connectivity is confirmed by your first request.')));
                } else body.append(node('p', t('还没有可用模型。打开模型服务设置，添加 API Key 或完成登录。', 'No models are available yet. Open model service settings to add an API key or sign in.'), 'pi-setup-empty'));
                const controls = node('div', null, 'pi-setup-actions');
                controls.append(action(t('连接模型服务', 'Connect model service'), () => configure('settings', { tab: 'providers' })),
                    action(t('重新读取配置', 'Refresh configuration'), refresh));
                body.append(controls, node('small', t('凭据保存在服务器。此引导不会发起模型测试或产生模型调用。', 'Credentials are stored on the server. Setup does not run model tests or call a model.')));
            } else if (step === 1) {
                const profile = defaultProfile();
                body.append(node('h2', t('这是你的默认助手', 'Meet your default assistant')), node('h3', profile.name),
                    node('p', t('默认助手会始终保留，你可以调整名称、头像和协作方式。以后也可以创建更多助手。', 'Your default assistant stays available. Customize its name, avatar and working style, or create more assistants later.')));
                const list = node('ul', null, 'pi-setup-facts');
                list.append(node('li', t('默认助手始终启用，不能移入回收站。', 'The default assistant stays enabled and cannot be trashed.')),
                    node('li', profile.memory?.enabled ? t('长期记忆已开启，可在身份设置中关闭或管理。', 'Long-term memory is enabled; manage or disable it in profile settings.') : t('长期记忆已关闭，可在身份设置中开启。', 'Long-term memory is off; enable it in profile settings.')),
                    node('li', t('后台学习可在“学习”中单独开启和调整。', 'Enable and configure background learning separately under Learning.')));
                body.append(list, action(t('调整助手设定（可选）', 'Customize assistant (optional)'), () => configure('profiles', { profileId: profile.id, section: 'persona' })));
            } else if (step === 2) {
                body.append(node('h2', t('给第一项工作选一个目录', 'Choose a folder for your first task')),
                    node('p', t('助手会在这个目录中处理文件。目录位于运行白泽灵台的电脑或服务器上，请选择你希望交给助手处理的位置。', 'The assistant works with files in this folder on the computer or server running 白泽灵台. Choose the location you want it to work in.')));
                if (groups().length) {
                    const label = node('label', t('工作项目', 'Work project')); label.htmlFor = 'pi-setup-project';
                    const select = node('select'); select.id = 'pi-setup-project'; select.disabled = busy;
                    for (const project of groups()) { const option = node('option', project.name); option.value = project.id; select.append(option); }
                    select.value = projectId; select.addEventListener('change', () => { projectId = select.value; render(); });
                    body.append(label, select, node('p', selectedProject()?.cwd || '', 'pi-setup-path'));
                } else body.append(node('p', t('还没有工作项目。选择一个现有目录，并给它取个容易识别的名字。', 'No work project yet. Choose an existing folder and give it a recognizable name.'), 'pi-setup-empty'));
                body.append(action(t('选择目录并创建项目', 'Choose folder and create project'), chooseProject),
                    node('small', t('项目只是目录的分类入口，创建项目不会移动文件。下一步可以体验用对话配置知识库，也可以稍后再配置。', 'A project organizes access to a folder; creating it does not move files. Next, try configuring a knowledge base through conversation, or leave it for later.')));
            } else {
                body.append(node('h2', t('试试用对话配置知识库（可选）', 'Try configuring a knowledge base through conversation (optional)')),
                    node('p', t('用一句话让助手配置已有的 WeKnora 服务，之后即可在对话中检索资料、引用原文。没有服务可以稍后配置。', 'Ask your assistant to configure an existing WeKnora service, then search documents and cite sources in conversation. If you have no service, leave this step for later.')));
                body.append(node('pre', globalThis.PiExtensionAssistant.weknoraDraft(), 'pi-setup-example'));
                const list = node('ol', null, 'pi-setup-facts');
                list.append(node('li', t('点击“让助手配置 WeKnora”，替换 url（含 /api/v1）和 key，选择所有项目或当前项目。', 'Choose “Configure WeKnora with AI”, replace url (including /api/v1) and key, and choose all projects or the current project.')),
                    node('li', t('进入扩展助手后，核对草稿并发送，再确认配置。打开示例不会自动发送消息或保存配置。', 'Enter the extension assistant, review and send the draft, then confirm the configuration. Opening this example does not send a message or save settings.')),
                    node('li', t('保存后，等本轮结束，在空闲会话重载资源或新建会话，再到“扩展 → 知识库”连接并读取。保存成功不代表已连接。', 'After the turn finishes, reload resources in an idle conversation or open a new one. Then connect and load documents under Extensions → Knowledge base. Saving does not confirm connectivity.')));
                body.append(list, action(t('让助手配置 WeKnora', 'Configure WeKnora with AI'), configureKnowledge, false, !assistantEnabled || !selectedProject()),
                    node('small', t('发送的 Key 会交给所选模型并保存在聊天历史中。如不希望凭据进入聊天，请到“扩展 → MCP”的私密字段填写。', 'The key you send goes to the selected model and is saved in chat history. To keep credentials out of chat, enter them in the private fields under Extensions → MCP.')));
                if (!assistantEnabled) body.append(node('p', t('当前服务未提供扩展助手，可以稍后在“扩展 → MCP”配置知识库。', 'The extension assistant is unavailable on this service. Configure the knowledge base later under Extensions → MCP.'), 'pi-setup-empty'));
            }
            const status = node('p', notice, 'pi-setup-notice'); status.setAttribute('role', 'status'); status.hidden = !notice;
            body.append(status); shell.append(body);
            const footer = node('footer', null, 'pi-setup-footer');
            const skip = action(t('暂时跳过', 'Skip for now'), () => { store('skipped'); returningFromSetup = false; globalThis.PiWorkspaceRoute.navigate('assistant'); });
            skip.disabled = busy;
            footer.append(skip);
            const right = node('div', null, 'pi-setup-actions');
            if (step > 0) right.append(action(t('上一步', 'Back'), () => { step--; focusRequested = true; store('in-progress'); render(); }));
            if (supported && snapshot && projects && defaultProfile()) right.append(step < 3
                ? action(t('下一步', 'Next'), next, true, step === 0 && (!models().length || modelUncertain) || step === 2 && !selectedProject())
                : action(busy ? t('正在创建对话…', 'Creating conversation…') : t('开始第一段对话', 'Start first conversation'), finish, true, !selectedProject() || uncertain));
            if (notice) right.append(action(t('重新读取配置', 'Refresh configuration'), refresh));
            footer.append(right); shell.append(footer); root.replaceChildren(shell);
            const heading = body.querySelector('h2');
            if (focusRequested && heading && !loading) {
                heading.tabIndex = -1; heading.focus({ preventScroll: true }); focusRequested = false;
            }
        }
        window.addEventListener('workspace:tabchanged', event => {
            const { tab, params } = event.detail;
            if (params.get('setup') === '1') returningFromSetup = true;
            if (!['settings', 'profiles', 'extensions', 'chat', 'assistant', 'loading'].includes(tab)) returningFromSetup = false;
            returnBar.hidden = !['settings', 'profiles', 'extensions', 'chat', 'assistant'].includes(tab) || !returningFromSetup;
            if (tab !== 'setup') { epoch++; loading = false; }
            else if (booted && !busy) { focusRequested = true; void refresh(); }
            else render();
        });
        document.querySelectorAll('[data-setup-entry]').forEach(button => {
            button.title = t('首次设置', 'Setup'); button.setAttribute('aria-label', button.title);
            button.querySelector('span').textContent = t('引导', 'Setup');
        });
        render();
        return { async boot(status) {
            booted = true;
            assistantEnabled = status.extensionAssistant === true;
            supported = status.agentProfiles === true && status.assistantProjects === true && status.modelCatalog === true;
            if (!initialHash && !location.hash && !['complete', 'skipped'].includes(progress.status) && supported) globalThis.PiWorkspaceRoute.navigate('setup', {}, true);
            else if (active()) await refresh();
        } };
    }
    globalThis.PiSetup = Object.freeze({ create });
})();
