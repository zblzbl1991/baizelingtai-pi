(() => {
    'use strict';
    const title = document.getElementById('startup-title');
    const detail = document.getElementById('startup-detail');
    const hint = document.getElementById('startup-hint');
    const began = Date.now();
    function showError(heading, message) {
        document.body.dataset.state = 'error';
        document.title = heading + ' · 白泽灵台';
        title.textContent = heading;
        detail.textContent = message;
        hint.textContent = '请从系统托盘查看本次日志；修复后重新启动白泽灵台。';
    }
    async function update() {
        try {
            const response = await fetch('/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
            if (!response.ok) throw Error();
            const status = await response.json();
            if (status.state === 'ready') {
                const url = new URL(status.url);
                if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error();
                title.textContent = '启动完成';
                detail.textContent = '正在进入工作台…';
                window.location.replace(url.href);
                return;
            }
            if (status.state === 'error') {
                showError('启动失败', typeof status.message === 'string' ? status.message : '请查看本次启动日志。');
                return;
            }
            if (status.state !== 'starting') throw Error();
            if (Date.now() - began > 10000) hint.textContent = '启动仍在进行，请保持页面打开。';
        } catch {
            showError('启动连接已断开', '无法继续获取启动状态，请查看本次日志。');
            return;
        }
        setTimeout(update, 400);
    }
    void update();
})();
