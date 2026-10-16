/* Bundled capabilities and curated discovery. Setup uses the extension assistant. */
(() => {
    const text = (zh, en) => globalThis.PiI18n?.locale === 'en' ? en : zh;
    const node = (tag, content, attrs = {}) => {
        const el = document.createElement(tag);
        if (content != null) el.textContent = content;
        for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
        return el;
    };
    const entries = [
        { id: 'guizang-ppt', name: 'guizang-ppt', bundledName: 'pivane-presentations', author: '归藏', kind: ['内置 · 技能工作流', 'Built-in · Skill workflow'], icon: 'fa-file-powerpoint',
            url: '',
            title: ['制作演示文稿', 'Create presentations'],
            description: ['把资料整理成杂志风或瑞士风网页演示文稿，支持横向翻页。', 'Create magazine or Swiss-style HTML presentations with horizontal navigation.'],
            requirement: ['随应用提供，无需安装；主要输出 HTML，模板中的外链字体和脚本需联网或另行准备。', 'Included with the app. Produces HTML; external template fonts and scripts need network access or separate preparation.'],
            example: ['把这份项目资料做成一份十页汇报 PPT。', 'Turn these project notes into a ten-slide presentation.'] },
        { id: 'pi-native-mcp', name: "MCP", author: 'Earendil Works', kind: ["内置 · MCP", 'Built-in · MCP'], icon: 'fa-plug',
            url: 'https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/mcp.md',
            title: ['连接外部工具', 'Connect external tools'],
            description: ['连接 MCP 服务，让 Agent 使用你需要的数据和工具。', 'Connect MCP servers so your agent can use the data and tools you need.'],
            requirement: ['Pi 0.99.1 原生能力，无需安装适配器；配置 mcp.json，部分服务需 OAuth 授权。', 'Native to Pi 0.99.1; no adapter installation needed. Configure mcp.json; some servers require OAuth authorization.'],
            example: ['帮我接入一个 MCP 服务，并检查有哪些可用工具。', 'Help me connect an MCP server and check its available tools.'] },
        { id: 'pi-web-access', name: 'pi-web-access', author: 'nicobailon', kind: ['内置 · 检索', 'Built-in · Research'], icon: 'fa-globe',
            url: 'https://pi.dev/packages/pi-web-access', source: 'npm:pi-web-access',
            title: ['搜索与阅读网页', 'Search and read the web'],
            description: ['搜索网页、提取页面内容，把网络资料带入任务。', 'Search the web and extract page content for your tasks.'],
            requirement: ['随应用提供，无需安装；需要网络，部分搜索服务需配置。搜索后可继续读取完整网页。', 'Included with the app. Requires network access; some search services need configuration. Read full pages after searching.'],
            example: ['查找这个技术问题的最新资料，并附上来源链接。', 'Find current information about this technical question and include source links.'] },
        { id: 'pi-computer-use', name: 'pi-computer-use', bundledName: '@injaneity/pi-computer-use', author: 'injaneity', kind: ['内置 · 桌面', 'Built-in · Desktop'], icon: 'fa-desktop',
            url: 'https://github.com/injaneity/pi-computer-use', source: 'npm:@injaneity/pi-computer-use',
            title: ['操作桌面应用', 'Use desktop applications'],
            description: ['让 Agent 查看窗口、点击和输入，协助完成桌面任务。', 'Let your agent inspect windows, click, and type to help with desktop tasks.'],
            requirement: ['随应用提供，无需安装；操作部署端桌面，首次使用需图形会话及系统权限，Linux/Wayland 功能有限。', 'Included with the app. Controls the deployment machine’s desktop; first use requires a graphical session and OS permissions. Linux/Wayland features are limited.'],
            example: ['先检查这台机器的桌面环境是否支持，再给出配置方案。', 'Check whether this machine’s desktop is supported, then propose a setup.'] },
        { id: 'pi-subagents', name: 'pi-subagents', author: 'nicobailon', kind: ['扩展包 · 协作', 'Package · Collaboration'], icon: 'fa-people-group',
            url: 'https://pi.dev/packages/pi-subagents', source: 'npm:pi-subagents',
            title: ['让多个 Agent 协作', 'Work with multiple agents'],
            description: ['把调研、实现与审查交给专门的子 Agent，支持并行任务与工作流。', 'Delegate research, implementation and review to focused agents, with parallel tasks and workflows.'],
            requirement: ['需要可用的模型认证；子任务会产生模型用量。已有安装先核对版本与配置。', 'Requires model authentication; child tasks consume model usage. Check the version and configuration of any existing installation first.'],
            example: ['请让 reviewer 检查这次修改，并汇总需要修复的问题。', 'Ask reviewer to inspect this change and summarize the issues to fix.'] },
        { id: 'pi-hermes-memory', name: 'pi-hermes-memory', author: 'chandra447', kind: ['扩展包 · 记忆', 'Package · Memory'], icon: 'fa-brain',
            url: 'https://pi.dev/packages/pi-hermes-memory?name=memory', source: 'npm:pi-hermes-memory',
            title: ['记住偏好与项目经验', 'Remember preferences and project knowledge'],
            description: ['跨会话保存偏好与经验，并搜索以前的对话和记忆。', 'Save preferences and lessons across sessions, and search past conversations and memories.'],
            requirement: ['会在部署端持久保存记忆与搜索索引；SQLite 原生依赖须兼容当前 Node，安装前核对记录范围和自动学习设置。', 'Persists memories and search indexes on the deployment machine. Its native SQLite dependency must match Node; review storage scope and automatic learning before setup.'],
            example: ['先说明会保存哪些内容，以及如何查看、修改和删除记忆，再给出配置方案。', 'Explain what is stored and how to inspect, edit and remove memories, then propose a setup.'] }
    ];
    const open = () => window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail: { tab: 'extensions' } }));
    const button = (label, action, attrs = {}) => {
        const el = node('button', label, { type: 'button', ...attrs });
        el.addEventListener('click', action); return el;
    };
    let mcpPanel;
    let enabled = false, host, generation = 0, view = '', inventory = null, inventoryState = 'unknown', renderCards = () => {}, subnav = null;
    const repositories = { 'pi-web-access': 'nicobailon/pi-web-access', 'pi-computer-use': 'injaneity/pi-computer-use', 'pi-subagents': 'nicobailon/pi-subagents', 'pi-hermes-memory': 'chandra447/pi-hermes-memory' };
    function skillHubSource() {
        const config = inventory?.skillhub;
        if (!config || typeof config.registry !== 'string' || !['namespace', 'slug'].every(key => typeof config[key] === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config[key]) && config[key].length <= 64)) return '';
        try {
            const url = new URL(config.registry);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
            return `${url.href.replace(/\/+$/, '')}/space/${config.namespace}/${config.slug}`;
        } catch { return ''; }
    }
    function identity(source) {
        if (typeof source !== 'string') return '';
        const npm = /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@[^/]+)?$/.exec(source);
        if (npm) return `npm:${npm[1]}`;
        const git = /^(?:git:github\.com\/|(?:git\+)?https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/#@]+?)(?:\.git)?(?:[@#][^\s]+)?\/?$/.exec(source);
        return git ? `github:${git[1].toLowerCase()}` : '';
    }
    function installation(entry) {
        if (inventoryState !== 'ready') return { state: inventoryState, label: inventoryState === 'loading' ? text('正在核对…', 'Checking…') : text('状态待核对', 'Status unknown') };
        if (entry.id === 'pi-native-mcp') {
            const builtin = inventory.resources?.find(item => item.path === 'builtin:mcp');
            return builtin ? { state: builtin.enabled ? 'installed' : 'configured', label: text(builtin.enabled ? "引擎内置" : "内置 · 已停用", builtin.enabled ? 'Engine built-in' : 'Built-in · disabled') }
                : { state: 'unknown', label: text("需核对引擎版本", 'Check engine version') };
        }
        if (entry.id === 'pi-hermes-memory' && inventory.profileMemoryInstalled) return { state: 'installed', label: text('档案适配已安装', 'Profile adapter installed') };
        const bundled = inventory.packages.find(item => item.managedBy === 'pivane' && item.name === (entry.bundledName || entry.id) && item.installed);
        if (bundled) {
            const resources = inventory.resources?.filter(item => item.source === bundled.source) || [];
            const active = resources.some(item => item.enabled);
            return { state: resources.length && !active ? 'configured' : 'installed', label: text('白泽灵台内置', 'Bundled with 白泽灵台')
                + ' · ' + bundled.version + (resources.length && !active ? text(' · 已停用', ' · disabled') : '') };
        }
        if (entry.id === 'guizang-ppt') {
            if (!skillHubSource()) return { state: 'unknown', label: text('需助手核对 SkillHub', 'Check SkillHub with assistant') };
            const skills = Array.isArray(inventory.featuredSkills) ? inventory.featuredSkills.filter(item => item.id === entry.id) : [];
            if (skills.length) {
                const global = skills.some(item => item.scope === 'user');
                const project = skills.some(item => item.scope === 'project');
                const location = global && project ? text('全局与项目', 'Global & project') : project ? text('当前项目', 'Project') : text('所有项目', 'Global');
                const enabled = skills.some(item => item.enabled);
                return { state: enabled ? 'installed' : 'configured', label: text(enabled ? '已发现技能' : '已发现 · 已停用', enabled ? 'Skill found' : 'Found · disabled') + ' · ' + location };
            }
        }
        const matches = inventory.packages.filter(item => identity(item.source) === entry.source || identity(item.source) === `github:${repositories[entry.id]}`);
        const installed = matches.filter(item => item.installed === true);
        if (installed.length) {
            const global = installed.some(item => item.scope === 'user' || item.scope === 'global');
            const project = installed.some(item => item.scope === 'project');
            return { state: 'installed', label: text('已安装', 'Installed') + ' · ' + (global && project ? text('全局与项目', 'Global & project') : project ? text('当前项目', 'Project') : text('所有项目', 'Global')) };
        }
        if (matches.length) return { state: 'configured', label: text('已配置 · 文件未就绪', 'Configured · files unavailable') };
        if (inventory.scope === 'project' && !inventory.trust?.effective || !entry.source && (!Array.isArray(inventory.featuredSkills) || inventory.featuredSkillNeedsReview)) return { state: 'unknown', label: text('需助手核对', 'Check with assistant') };
        if (!entry.source) return { state: 'missing', label: text('未发现技能', 'Skill not found') };
        return { state: 'missing', label: text('未安装', 'Not installed') };
    }
    async function refreshInventory() {
        if (!host || view !== 'extensions') return;
        const ticket = ++generation, selected = host.currentCwd();
        const selector = document.getElementById('extensions-scope');
        const scope = selected && selector.value === 'project' ? 'project' : 'global';
        selector.querySelector('[value="project"]').hidden = !selected; selector.value = scope;
        inventory = null; inventoryState = 'loading'; renderCards();
        const feedback = document.getElementById('extensions-inventory-status');
        feedback.textContent = text('正在读取安装清单…', 'Reading installation inventory…');
        if (window.PiSkeleton) feedback.innerHTML = window.PiSkeleton.html('lines', { rows: 3, label: text('正在读取安装清单…', 'Reading installation inventory…') });
        const valid = () => ticket === generation && view === 'extensions' && selected === host.currentCwd();
        try {
            const status = await host.apiFetch('/api/pi/status');
            if (!valid()) return;
            const cwd = selected || status.defaultProject;
            if (!status.nativeResources || !cwd) throw new Error(text('当前服务无法提供安装清单。', 'Installation inventory is unavailable on this server.'));
            const result = await host.apiFetch(`/api/pi/settings/native/resources?cwd=${encodeURIComponent(cwd)}&scope=${scope}`);
            if (!valid()) return;
            if (!Array.isArray(result?.packages) || result.scope !== scope || !result.packages.every(item => typeof item.source === 'string' && typeof item.installed === 'boolean')
                || result.featuredSkills !== undefined && (!Array.isArray(result.featuredSkills) || !result.featuredSkills.every(item => ['ppt-master', 'guizang-ppt'].includes(item.id) && ['user', 'project'].includes(item.scope) && typeof item.enabled === 'boolean'))) throw new Error(text('安装清单格式无效。', 'Invalid installation inventory.'));
            inventory = { ...result, profileMemoryInstalled: status.profileMemory?.installed === true }; inventoryState = 'ready';
            feedback.textContent = scope === 'project' && !result.trust?.effective
                ? text('项目尚未受信任，仅能确认全局安装；其他项需进一步核对。', 'The project is not trusted. Only global installations can be confirmed; other items need checking.')
                : text('按所选范围的登记来源和技能声明核对；发现技能不代表依赖就绪或当前会话已加载。无法证明来源的本地技能需助手核对。', 'Checked registered sources and skill declarations in the selected scope. A found skill does not mean dependencies are ready or it is loaded in this session. Local skills with unverified provenance need an assistant check.');
        } catch (error) {
            if (!valid()) return;
            inventory = null; inventoryState = 'unknown';
            feedback.textContent = text('安装状态读取失败，可点击刷新重试：', 'Could not read installation status. Refresh to retry: ') + error.message;
        } finally { if (valid()) renderCards(); }
    }
    function assistant(entry) {
        let need = entry ? text(
            `我想了解并配置 ${entry.name}。来源：${entry.url}${entry.source ? `，Pi 包来源：${entry.source}` : ''}。用途：${text(...entry.description)} 示例：${text(...entry.example)} 请先只读检查已有安装、当前版本、许可、依赖和平台兼容性，说明安装范围与方案，等我确认后再安装；不要重复安装已有能力。安装后分别核对文件、依赖与当前会话加载状态。`,
            `I want to learn about and configure ${entry.name}. Source: ${entry.url}${entry.source ? `; Pi package source: ${entry.source}` : ''}. Purpose: ${text(...entry.description)} Example: ${text(...entry.example)} First inspect existing installations, versions, licenses, dependencies and platform compatibility read-only. Explain the scope and plan, then wait for my confirmation before installing. Avoid duplicate installations. After installation, check files, dependencies and current-session loading separately.`) : '';
        if (entry?.id === 'guizang-ppt') need = text(
            `请帮我配置 guizang-ppt。来源：${skillHubSource() || '服务端配置的 SkillHub（先用 extensions_inventory 核对地址与命名空间）'}。先读取该仓库的 /registry/skill.md，核对精确技能、发布者、版本、许可、依赖与已有安装；说明所选范围的实际路径与方案，等我确认后使用官方 @astron-team/skillhub CLI 从同一 SkillHub 安装。显式指定 --registry 和 --dir，不使用默认身份目录，不静默改用外网来源，不移除已有 PPT Master。分别核对文件、依赖、原生资源发现与会话加载状态。`,
            `Help configure guizang-ppt. Source: ${skillHubSource() || 'the server-configured SkillHub (check registry and namespace with extensions_inventory first)'}. Read /registry/skill.md from that registry and inspect the exact skill, publisher, version, license, dependencies and existing installation. Explain the actual path and plan for the selected scope, then wait for my confirmation and install from the same SkillHub using the first-party @astron-team/skillhub CLI with explicit --registry and --dir. Do not use a default identity directory, silently switch to an external source, or remove existing PPT Master. Verify files, dependencies, native discovery and session loading separately.`);
        if (entry?.id === 'pi-native-mcp') need = text(
            '请帮我配置 Pi 0.99.1 原生 MCP。先检查全局或受信项目的 mcp.json、连接和工具暴露策略；不要安装 pi-mcp-adapter，不要展示凭据。使用 Pi 原生 MCP/Codemode 接口，写配置和授权前说明方案并等我确认。',
            'Help configure native Pi 0.99.1 MCP. Inspect global or trusted-project mcp.json, connections and tool exposure. Do not install pi-mcp-adapter or display credentials. Use native MCP/Codemode; explain the plan and wait for confirmation before configuration changes or sign-in.');
        if (entry && (['pi-subagents', 'pi-hermes-memory'].includes(entry.id)
            || inventory?.packages.some(item => item.managedBy === 'pivane' && item.name === (entry.bundledName || entry.id) && item.installed))) need = text(
            `请帮我配置白泽灵台内置的 ${entry.name}。该组件随白泽灵台安装和更新，请先检查当前版本、资源开关、身份与会话加载状态，再调整配置，不要另行安装或修改上游源码。`,
            `Help me configure ${entry.name}, bundled with 白泽灵台. Check its version, resource toggles, profile and actual session loading before adjusting settings. It updates with 白泽灵台; do not install another copy or modify upstream source.`);
        if (entry?.id === 'pi-hermes-memory' && inventory?.profileMemoryInstalled) need += text(
            '\n白泽灵台已安装独立的档案记忆适配组件。请先检查助手身份和实际加载状态；不要另行全局启用上游默认扩展，以免扩大历史索引范围。',
            '\n白泽灵台 already has the separate profile memory adapter installed. Inspect assistant profiles and actual loading first; do not additionally enable the upstream default extension globally, which would broaden history indexing.');
        window.dispatchEvent(new CustomEvent('pi:extension-assistant', { detail: { need, scope: document.getElementById('extensions-scope')?.value || 'global' } }));
    }
    function mountExplore(root) {
        if (!root || root.querySelector('.extensions-explore')) return;
        const section = node('section', null, { class: 'extensions-explore', 'aria-label': text('探索技能', 'Explore skills') });
        const header = node('div', null, { class: 'extensions-explore-heading' });
        const openFeatured = () => open();
        header.append(node('strong', text('探索技能', 'Explore skills')), button(text('查看全部', 'View all'), openFeatured));
        const choices = node('div', null, { class: 'extensions-explore-choices' });
        for (const item of entries.slice(0, 3)) choices.append(button(text(...item.title), () => {
            openFeatured();
            const search = document.getElementById('extensions-search');
            if (search?.value) { search.value = ''; search.dispatchEvent(new Event('input')); }
            const card = document.getElementById(`extension-${item.id}`);
            card?.scrollIntoView({ block: 'nearest' }); card?.focus({ preventScroll: true });
        }));
        section.append(header, choices); root.append(section);
    }
    const extensionTabLabels = {
        extensions: ['发现', 'Discover'],
        installed: ['已安装', 'Installed'],
        mcp: ['原生 MCP', 'Native MCP']
    };
    function mountSubnav() {
        const dialog = document.getElementById('workspace-settings-dialog');
        const header = dialog?.querySelector('.workspace-settings-header');
        if (!dialog || !header || document.getElementById('extensions-nav')) return;
        subnav = node('nav', null, { class: 'extensions-nav', id: 'extensions-nav', 'aria-label': text('扩展分类', 'Extension categories'), hidden: '' });
        const tabs = node('div', null, { class: 'extensions-nav-tabs' });
        for (const [tab, label] of Object.entries(extensionTabLabels)) {
            const item = button(text(...label), () => {
                window.PiWorkspaceRoute?.navigate('extensions', { tab });
                if (tab === 'mcp') window.PiExtensions.setView('extensions', 'mcp');
            }, { 'data-extensions-tab': tab, type: 'button' });
            item.classList.add('extensions-nav-tab');
            tabs.append(item);
        }
        const actions = node('div', null, { class: 'extensions-nav-actions' });
        const install = button(text('安装扩展包', 'Install package'), () => window.dispatchEvent(new CustomEvent('pi:extensions-install')), { id: 'extensions-install', type: 'button' });
        install.className = 'settings-primary-button';
        install.prepend(node('i', '', { class: 'fa-solid fa-plus', 'aria-hidden': 'true' }));
        actions.append(install);
        subnav.append(tabs, actions);
        header.after(subnav);
    }
    window.PiExtensions = {
        connect(value) {
            host = value;
            mcpPanel?.close(); mcpPanel?.root.remove();
            if (window.PiMcpSettings) {
                mcpPanel = window.PiMcpSettings.create(value);
                document.querySelector('.workspace-settings-content')?.append(mcpPanel.root);
            }
        },
        mountExplore,
        setAssistantEnabled(value) {
            enabled = Boolean(value);
            document.querySelectorAll('[data-extension-configure]').forEach(el => { el.disabled = !enabled; });
            const hint = document.getElementById('extensions-assistant-unavailable'); if (hint) hint.hidden = enabled;
        },
        setView(nextView, tab) {
            const extensionView = nextView === 'extensions';
            view = extensionView ? (extensionTabLabels[tab] ? tab : 'extensions') : nextView;
            generation++;
            const dialog = document.getElementById('workspace-settings-dialog');
            dialog?.classList.toggle('extensions-view', extensionView);
            if (subnav) {
                subnav.hidden = !extensionView;
                subnav.querySelectorAll('[data-extensions-tab]').forEach(item => {
                    const active = extensionView && item.dataset.extensionsTab === view;
                    item.classList.toggle('active', active);
                    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
                });
            }
            if (view === 'mcp') {
                document.querySelectorAll('[data-settings-panel]').forEach(panel => panel.classList.remove('active'));
                mcpPanel?.open();
            } else mcpPanel?.close();
            if (view === 'extensions') void refreshInventory();
            const close = document.getElementById('workspace-settings-close');
            if (close) close.title = close.ariaLabel = extensionView ? text('关闭扩展', 'Close extensions') : text('关闭设置', 'Close settings');
            document.querySelector('.workspace-settings-nav')?.setAttribute('aria-label', extensionView ? text('扩展分类', 'Extension categories') : text('设置分类', 'Settings categories'));
        }
    };
    document.addEventListener('DOMContentLoaded', () => {
        mountSubnav();
        const panel = node('section', null, { class: 'workspace-settings-panel', 'data-settings-panel': 'extensions' });
        const featured = node('section', null, { id: 'extensions-featured' });
        const intro = node('div', null, { class: 'extensions-intro' });
        intro.append(node('h3', text('为你的工作添一种能力', 'Add a capability to your work')), node('p', text('发现适合你的工具与技能，按需配置到白泽灵台。', 'Discover tools and skills for your work, and configure them when you need them.')),
            button(text('添加自定义', 'Add custom'), () => assistant(), { class: 'settings-primary-button', 'data-extension-configure': '', disabled: '' }));
        const search = node('input', null, { type: 'search', id: 'extensions-search', placeholder: text('搜索名称、用途或作者', 'Search names, uses, or authors'), 'aria-label': text('搜索精选扩展', 'Search featured extensions') });
        const toolbar = node('div', null, { class: 'extensions-inventory-toolbar' });
        const scope = node('select', null, { id: 'extensions-scope', 'aria-label': text('核对安装范围', 'Installation scope') });
        scope.append(node('option', text('所有项目', 'Global'), { value: 'global' }), node('option', text('当前项目（含全局）', 'Current project (including global)'), { value: 'project' }));
        scope.addEventListener('change', () => void refreshInventory());
        toolbar.append(scope, button(text('刷新安装状态', 'Refresh installation status'), () => void refreshInventory(), { class: 'settings-secondary-button', id: 'extensions-refresh' }));
        const feedback = node('p', '', { id: 'extensions-inventory-status', class: 'extensions-note', role: 'status' });
        const grid = node('div', null, { class: 'extensions-grid' });
        const empty = node('p', text('没有匹配的精选扩展。', 'No matching featured extensions.'), { hidden: '', role: 'status' });
        const render = () => {
            const query = search.value.trim().toLowerCase();
            grid.replaceChildren();
            for (const entry of entries.filter(item => [item.name, item.author, ...item.title, ...item.kind, ...item.description].join(' ').toLowerCase().includes(query))) {
                const card = node('article', null, { class: 'extensions-card', id: `extension-${entry.id}`, tabindex: '-1' });
                const heading = node('div', null, { class: 'extensions-card-heading' });
                heading.append(node('i', '', { class: `fa-solid ${entry.icon}`, 'aria-hidden': 'true' }), node('h4', text(...entry.title)));
                const details = node('details'); details.append(node('summary', text('使用前提与示例', 'Requirements & example')), node('p', text(...entry.requirement)), node('p', text(...entry.example)));
                const actions = node('div', null, { class: 'extensions-card-actions' });
                const configure = button(text('了解与配置', 'Learn & set up'), () => assistant(entry), { 'data-extension-configure': '', class: 'settings-secondary-button' }); configure.disabled = !enabled;
                actions.append(node('a', text('查看来源', 'View source'), { ...(entry.url ? { href: entry.url } : {}), 'data-extension-source': entry.id, target: '_blank', rel: 'noopener noreferrer' }), configure);
                const installed = installation(entry);
                const badge = node('span', installed.label, { class: 'extensions-installation', 'data-installation': installed.state });
                card.append(heading, badge, node('small', `${entry.name} · ${entry.author}`), node('p', text(...entry.description)), node('span', text(...entry.kind), { class: 'extensions-kind' }), details, actions); grid.append(card);
            }
            empty.hidden = grid.childElementCount > 0;
            renderCards();
        };
        renderCards = () => {
            const source = document.querySelector('[data-extension-source="guizang-ppt"]');
            if (source) {
                const isBundled = inventory?.packages.some(item => item.managedBy === 'pivane' && item.name === 'pivane-presentations' && item.installed);
                const url = isBundled ? 'https://github.com/op7418/guizang-ppt-skill/tree/c91369c449d34755d320a8b81d0734000d99d1ab' : skillHubSource();
                source.textContent = isBundled ? text('查看作者源码', 'View upstream source') : url ? text('查看 SkillHub', 'View SkillHub') : text('来源待核对', 'Source pending');
                if (url) { source.href = url; source.removeAttribute('aria-disabled'); }
                else { source.removeAttribute('href'); source.setAttribute('aria-disabled', 'true'); }
            }
            for (const entry of entries) {
                const badge = document.querySelector(`#extension-${entry.id} .extensions-installation`);
                if (!badge) continue;
                const result = installation(entry); badge.textContent = result.label; badge.dataset.installation = result.state;
            }
        };
        search.addEventListener('input', render); render();
        const unavailable = node('p', text('当前服务未提供扩展助手。可查看来源，或在已安装页面管理资源。', 'The extension assistant is unavailable on this server. View the sources or manage resources in the installed tabs.'), { id: 'extensions-assistant-unavailable', role: 'status' });
        featured.append(intro, search, toolbar, feedback, unavailable, grid, empty);
        panel.append(featured);
        const invalidate = () => { generation++; view = ''; inventory = null; inventoryState = 'unknown'; renderCards(); };
        window.addEventListener('workspace:settings-closed', invalidate);
        window.addEventListener('workspace:access-locked', invalidate);
        window.addEventListener('storage', event => { if (event.key === 'pi.web.cwd' || event.key === null) void refreshInventory(); });
        document.querySelector('.workspace-settings-content').prepend(panel);
        mountExplore(document.querySelector('.pi-empty-state'));
    });
})();
