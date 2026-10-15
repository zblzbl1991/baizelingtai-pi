(() => {
    'use strict';
    const title = document.getElementById('startup-title');
    const detail = document.getElementById('startup-detail');
    const hint = document.getElementById('startup-hint');
    let began = Date.now(), failures = 0, generation, verifiedAt, verifiedState;
    const instance = document.querySelector('meta[name="startup-instance"]')?.content;
    function show(state, heading, message, guidance) {
        document.body.dataset.state = state;
        document.title = heading + ' · 白泽灵台';
        title.textContent = heading;
        detail.textContent = message;
        hint.textContent = guidance;
    }
    async function update() {
        try {
            const response = await fetch('/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
            if (!response.ok) throw Error();
            const status = await response.json();
            if (!instance || status.instance !== instance || typeof status.generation !== 'string' || !status.generation) throw Error();
            if (!['starting', 'ready', 'error', 'stopped', 'stopping', 'unknown'].includes(status.state)) throw Error();
            if (generation !== status.generation) { generation = status.generation; began = Date.now(); }
            if (status.state === 'ready') {
                const url = new URL(status.url);
                if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error();
                title.textContent = '启动完成';
                detail.textContent = '正在进入工作台…';
                window.location.replace(url.href);
                return;
            }
            failures = 0; verifiedAt = new Date().toLocaleTimeString();
            verifiedState = { starting: '正在启动', error: '启动失败', stopped: '服务已停止', stopping: '正在停止服务', unknown: '无法确认当前状态' }[status.state];
            if (status.state === 'error') {
                show('error', '启动失败', typeof status.message === 'string' ? status.message.slice(0, 2048) : '请查看本次启动日志。', '请从系统托盘查看日志并处理问题；手动重新启动后，此页面会自动跟进。');
            } else if (status.state === 'stopped') {
                show('stopped', '服务已停止', '请从系统托盘手动启动服务。', '保持页面打开，新一轮启动就绪后会自动进入工作台。');
            } else if (status.state === 'stopping') {
                show('stopping', '正在停止服务', '正在等待服务和工作进程完成清理。', '请保持页面打开，不要重复启动。');
            } else if (status.state === 'unknown') {
                show('unknown', '无法确认当前状态', '请从系统托盘查看服务状态和日志。', '状态查询会继续，不会自动重启服务。');
            } else {
                show('starting', '正在启动', '就绪后会自动进入工作台，请稍候。', Date.now() - began > 10000 ? '启动耗时较长，仍在等待同一次启动，请保持页面打开。' : '这个页面会自动更新。');
            }
        } catch {
            failures++;
            show('reconnecting', '正在重新连接', '暂时无法确认服务状态，正在重试只读查询。', (verifiedAt ? '上次确认：' + verifiedState + '（' + verifiedAt + '）。' : '') + '若托盘已退出，请双击白泽灵台或从当前托盘重新打开入口。');
        }
        setTimeout(update, failures ? Math.min(10000, 500 * 2 ** Math.min(failures - 1, 5)) : 400);
    }
    void update();
})();
