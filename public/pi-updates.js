(() => {
    const t = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const node = (tag, text, attrs = {}) => {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
        return element;
    };
    const link = (text, href, sourceOrigin) => {
        const element = node('a', text, { target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer' });
        try {
            const url = new URL(href);
            const official = url.protocol === 'https:' && !url.port && ['github.com', 'www.npmjs.com'].includes(url.hostname);
            if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && (official || url.origin === sourceOrigin)) element.href = url.href;
        } catch {}
        return element;
    };
    const statuses = {
        unchecked: '尚未检查', available: '发现新版本', current: '已是最新', ahead: '当前版本较新',
        unknown: '版本无法比较', 'no-release': '暂无发布版本', error: '暂时无法检查'
    };
    const agentPrompt = "请用部署机器上的独立 Agent，按本机配置的来源检查白泽灵台更新；内网源读取 latest.json 比较 version，没有新版就结束。有新版按已有授权更新，未授权先确认；步骤见本机 docs/UPDATES.md 和 docs/INSTALL_RECOVERY.md。更新前确认空闲、停机备份，沿用原数据绝对路径和配置，保留旧版；启动后验收，失败回退。不自动重试失败操作，不要停止或重启承载当前对话的服务。";
    function portableAgentPrompt(data) {
        return [
            t("请用部署机器上的独立 Agent 更新白泽灵台 Windows 便携版，安装步骤按本机 docs/UPDATES.md 执行。"),
            t('更新清单：{0}', data.source?.url || t('尚未核实')),
            t("读取 latest.json，按 SemVer 比较 version 与实际运行版本；没有新版就结束。有新版先确认目标，已有授权无需重复确认。按 package 下载同源 ZIP，核对 bytes 和 sha256；仅更新内网整包，不运行 npm 安装，保留本机未发布的修复。"),
            t("确认空闲、暂停预约并保存草稿后，正常停机、备份，解压到新程序目录；沿用原数据绝对路径、.env 和更新源，保留旧版。启动后验收版本与数据，失败回退。清单或下载失败、目标变化、校验不符就停止，不自动重试。不要停止或重启承载当前对话的服务。")
        ].join('\n\n');
    }
    function create({ apiFetch }) {
        const panel = document.getElementById('settings-updates-panel');
        const notifications = window.PiUpdateNotifications.start({ apiFetch });
        let epoch = 0, snapshot, requested = false, ticket, reviewing = false, submitting = false, pendingId, timer, operationMessage = '';
        const terminal = phase => ['succeeded', 'failed', 'interrupted'].includes(phase);
        const phases = { preparing: '正在准备更新…', installing: '正在准备安装…', downloading: '正在下载并校验整包…', extracting: '正在解压并核验文件…',
            verifying: '正在验证候选程序…', stopping: '正在停止旧服务…', 'backing-up': '正在备份数据…', starting: '正在启动新版…',
            succeeded: '更新完成，新版已启动。', failed: '更新失败，已保留旧程序与备份。请查看结果后再决定。', interrupted: '更新被中断，请核对运行版本与备份。' };
        const post = (route, body) => apiFetch('/api/pi/settings/updates/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        function pending(value) { pendingId = value; try { if (value) sessionStorage.setItem('pivane.update.job', value); else sessionStorage.removeItem('pivane.update.job'); } catch {} }
        try { pendingId = sessionStorage.getItem('pivane.update.job'); } catch {}
        const active = n => n === epoch && panel.classList.contains('active') && !document.getElementById('workspace-settings-dialog').classList.contains('hidden');
        function render(data, busy = false, checking = false) {
            const promptOpen = panel.querySelector('#updates-agent-guide')?.open || false;
            const engineOpen = panel.querySelector('#updates-engine-details')?.open || false;
            panel.replaceChildren();
            const header = node('div', undefined, { class: 'updates-header' });
            const heading = node('div');
            heading.append(node('h3', t('版本与更新')),
                node('p', t('查看当前版本与可用新版本。检查不会安装任何内容。')));
            const check = node('button', undefined, { type: 'button', id: 'updates-check', class: 'settings-primary-button' });
            check.append(node('i', undefined, { class: 'fa-solid fa-arrows-rotate', 'aria-hidden': 'true' }), node('span', t(busy ? checking ? '正在检查更新…' : '正在读取版本信息…' : '检查更新')));
            check.disabled = busy || reviewing || submitting || Boolean(pendingId); check.addEventListener('click', () => { ticket = null; void load(true); });
            header.append(heading, check); panel.append(header);
            const custom = data.source?.type === 'manifest';
            if (custom) panel.append(node('p', t('更新源：{0}', data.source.origin), { class: 'updates-note', id: 'updates-source' }),
                node('p', t("显示此更新源发布的 Windows 整包版本，底层引擎随整包更新。"), { class: 'updates-note' }));
            const cards = node('div', undefined, { class: 'updates-cards', 'aria-busy': String(busy) });
            const engine = node('details', undefined, { class: 'updates-engine', id: 'updates-engine-details' }); engine.open = engineOpen;
            engine.append(node('summary', t('引擎与依赖')));
            for (const [key, name, current, info] of [['pivane', '白泽灵台', data.appVersion, data.pivane], ['pi', 'Pi Coding Agent', data.piVersion, data.pi]]) {
                const card = node('article', undefined, { class: 'updates-card', id: 'updates-' + key });
                const top = node('div', undefined, { class: 'updates-card-top' });
                const icon = node('span', undefined, { class: 'updates-card-icon', 'aria-hidden': 'true' });
                icon.append(node('i', undefined, { class: key === 'pi' ? 'fa-solid fa-cube' : 'fa-solid fa-layer-group' }));
                top.append(icon, node('h4', name));
                const status = node('span', t(statuses[info.status] || statuses.unknown), { class: 'updates-status', 'data-state': info.status });
                top.append(status); card.append(top);
                const versions = node('div', undefined, { class: 'updates-versions' });
                for (const [label, value] of [[t('当前版本'), current], [t(custom ? key === 'pi' ? '整包配套版本' : '发布版本' : '最新版本'), info.version || '—']]) {
                    const item = node('div', undefined, { class: 'updates-version' });
                    item.append(node('span', label), node('strong', value)); versions.append(item);
                }
                card.append(versions);
                if (key === 'pi' && !data.dependencyMatches) card.append(node('p', t("当前引擎与发布包配套版本不同。"), { class: 'updates-note' }));
                const links = node('div', undefined, { class: 'updates-links' });
                const releaseLink = link(t(custom ? '查看更新来源' : key === 'pi' ? 'Pi 官方页面' : '白泽灵台发布页面'), info.releasesUrl, data.source?.origin);
                // 暂时隐藏白泽灵台 GitHub 发布页入口。
                releaseLink.hidden = key === 'pivane' && !custom;
                links.append(releaseLink);
                if (custom && key === 'pivane' && info.packageFormat === 'windows-portable-zip' && info.downloadUrl) {
                    links.append(link(t('下载 Windows ZIP'), info.downloadUrl, data.source.origin));
                    card.append(node('p', `SHA256: ${info.sha256}`, { class: 'updates-note', id: 'updates-package-hash' }));
                }
                card.append(links);
                if (key === 'pi') engine.append(card); else cards.append(card);
            }
            panel.append(cards);
            const job = data.maintenance?.job;
            const canInstall = custom && data.maintenance?.portableUpdateSupported;
            if (canInstall && data.pivane.status === 'available' && !ticket) {
                const install = node('button', t(reviewing ? '正在核对安装目标…' : '一键更新'), { type: 'button', id: 'updates-install-pivane', class: 'settings-primary-button' });
                install.disabled = busy || reviewing || submitting || Boolean(pendingId) || data.maintenance.busy;
                install.addEventListener('click', () => void review()); panel.append(install);
            }
            if (ticket) renderConfirmation();
            if (operationMessage || job?.action === 'application') panel.append(node('p', operationMessage || t(phases[job.phase] || '正在更新…'), { id: 'updates-operation', role: 'status', 'aria-live': 'polite', class: 'updates-operation' }));
            if (job?.backup?.directory) panel.append(node('p', t('备份位置：{0}', job.backup.directory), { class: 'updates-note' }));
            panel.append(engine);
            const feedback = node('p', data.checkedAt ? t('上次检查：{0}', new Date(data.checkedAt).toLocaleString(globalThis.PiI18n?.locale || undefined)) : t(custom ? '尚未检查此更新源。' : "尚未手动检查。引擎详情可能显示自动检查的结果。"), { id: 'updates-feedback', role: 'status', 'aria-live': 'polite' });
            panel.append(feedback);
            const guide = node('details', undefined, { class: 'updates-agent-guide', id: 'updates-agent-guide' }); guide.open = promptOpen;
            // 暂时隐藏 Agent 更新引导，保留实现以便后续恢复。
            guide.hidden = true;
            guide.append(node('summary', t('交给独立 Agent 协助更新')));
            const content = node('div', undefined, { class: 'updates-agent-content' });
            content.append(node('p', t('在部署机器上使用独立 Agent；不要让正在被更新的白泽灵台会话重启自身。先让它核对并提出计划，确认后再执行。')));
            const promptText = custom ? portableAgentPrompt(data) : t(agentPrompt);
            const prompt = node('textarea', promptText, { id: 'updates-agent-prompt', readonly: '', 'aria-label': t('更新提示词') });
            const copy = node('button', t('复制提示词'), { type: 'button', class: 'settings-secondary-button', id: 'updates-copy-prompt' });
            const copyFeedback = node('span', '', { role: 'status', 'aria-live': 'polite', class: 'updates-copy-feedback' });
            copy.addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(prompt.value); copyFeedback.textContent = t('已复制'); }
                catch { prompt.focus(); prompt.select(); copyFeedback.textContent = t('无法自动复制，已选中提示词，请手动复制。'); }
            });
            const action = node('div', undefined, { class: 'updates-agent-action' }); action.append(copy, copyFeedback);
            content.append(prompt, action); guide.append(content); panel.append(guide, notifications.element);
        }
        function renderConfirmation() {
            const box = node('section', undefined, { id: 'updates-confirmation', class: 'updates-confirmation', 'aria-labelledby': 'updates-confirm-heading' });
            box.append(node('h4', t('确认更新到 {0}', ticket.version), { id: 'updates-confirm-heading', tabindex: '-1' }),
                node('p', t('将下载完整程序，正常停机、备份数据并启动新版。更新期间请保持此页面打开。')),
                node('p', `SHA256: ${ticket.release.sha256}`, { class: 'updates-note' }));
            const confirm = node('button', t('确认并更新'), { id: 'updates-confirm-install', type: 'button', class: 'settings-primary-button' }); confirm.disabled = true;
            const checks = [];
            for (const [id, text] of [['updates-drafts-saved', '已保存草稿，结束任务并暂停预约'], ['updates-external-stopped', '已停止使用同一数据的其他 Pi 进程']]) {
                const label = node('label', undefined, { class: 'updates-confirm-check' }), input = node('input', undefined, { type: 'checkbox', id });
                checks.push(input); label.append(input, node('span', t(text))); box.append(label);
                input.addEventListener('change', () => { confirm.disabled = submitting || !checks.every(item => item.checked); });
            }
            confirm.addEventListener('click', () => void execute());
            const cancel = node('button', t('取消'), { type: 'button', class: 'settings-secondary-button' });
            cancel.addEventListener('click', () => { ticket = null; render(snapshot); panel.querySelector('#updates-install-pivane')?.focus(); });
            const actions = node('div', undefined, { class: 'updates-agent-action' }); actions.append(confirm, cancel); box.append(actions); panel.append(box);
        }
        async function review() {
            if (reviewing || submitting || pendingId) return;
            reviewing = true; operationMessage = ''; render(snapshot);
            const n = epoch;
            try {
                const reviewed = await post('review', { action: 'application', channel: snapshot.channel });
                if (!active(n)) return;
                ticket = reviewed;
            } catch (error) { if (active(n)) operationMessage = error.message; }
            finally {
                reviewing = false;
                if (active(n)) { render(snapshot); panel.querySelector('#updates-confirm-heading')?.focus(); }
            }
        }
        async function execute() {
            if (!ticket || submitting || pendingId) return;
            if (!panel.querySelector('#updates-drafts-saved')?.checked || !panel.querySelector('#updates-external-stopped')?.checked) return;
            submitting = true;
            const id = ticket.id; pending(id); ticket = null;
            operationMessage = t('正在提交更新…'); render(snapshot);
            try { await post('execute', { ticket: id, confirmed: true, draftsSaved: true, externalWritersStopped: true }); }
            catch (error) {
                // A definite rejection did not execute. A network/5xx outcome is
                // uncertain: read status only, never resend this mutation.
                if (error.status >= 400 && error.status < 500) { pending(null); operationMessage = error.message; }
                else operationMessage = t('提交结果待核对，正在查询状态；不会重复提交。');
            } finally { submitting = false; if (active(epoch)) { render(snapshot); if (pendingId) void poll(epoch); } }
        }
        async function poll(n) {
            clearTimeout(timer);
            if (!active(n) || !pendingId) return;
            try {
                const state = await apiFetch('/api/pi/settings/updates/maintenance');
                if (!active(n)) return;
                if (state.job?.id === pendingId) {
                    snapshot.maintenance = state; operationMessage = t(phases[state.job.phase] || '正在更新…');
                    if (terminal(state.job.phase) && !state.busy) {
                        pending(null); render(snapshot);
                        if (state.job.phase === 'succeeded') {
                            operationMessage = t('更新完成，新版已启动。');
                            await load(true);
                        }
                        return;
                    }
                }
            } catch { if (active(n)) operationMessage = t('服务正在切换，等待重新连接…'); }
            if (active(n)) { render(snapshot); timer = setTimeout(() => void poll(n), 2000); }
        }
        async function load(check) {
            const n = ++epoch;
            if (snapshot) render(snapshot, true, check);
            else {
                panel.replaceChildren(node('p', t('正在读取版本信息…'), { role: 'status' }));
                if (window.PiSkeleton) panel.innerHTML = window.PiSkeleton.html('cards', { rows: 3, label: t('正在读取版本信息…') });
            }
            try {
                const data = await apiFetch(check ? '/api/pi/settings/updates/check' : '/api/pi/settings/updates', check ? {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
                } : {});
                if (!active(n)) return;
                if (!data?.appVersion || !data.pi || !data.pivane) throw new Error('Unsupported update service');
                snapshot = data; render(data); void notifications.refresh();
                if (!pendingId && data.maintenance?.busy && data.maintenance.job?.action === 'application') pending(data.maintenance.job.id);
                if (pendingId) { void poll(n); return; }
                if (!check && !requested && !data.checkedAt) { requested = true; void load(true); }
            } catch {
                if (!active(n)) return;
                if (snapshot) render(snapshot);
                else panel.replaceChildren(node('h3', t('版本与更新')));
                const feedback = panel.querySelector('#updates-feedback');
                const message = t('暂时无法读取版本信息，请稍后再试。');
                if (feedback) feedback.textContent = message;
                else {
                    panel.append(node('p', message, { role: 'status' }));
                    const retry = node('button', t('重试读取'), { type: 'button', class: 'settings-secondary-button' });
                    retry.addEventListener('click', () => void load(false)); panel.append(retry);
                }
            }
        }
        window.addEventListener('workspace:access-locked', () => { epoch++; clearTimeout(timer); ticket = null; snapshot = null; requested = false; });
        window.addEventListener('workspace:access-ready', () => { epoch++; snapshot = null; requested = false; if (active(epoch)) void load(false); });
        return { open() { void load(false); }, close() { epoch++; clearTimeout(timer); ticket = null; } };
    }
    window.PiUpdates = { create };
})();
