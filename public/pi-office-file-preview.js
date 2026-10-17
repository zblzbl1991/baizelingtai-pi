/* A derived reading copy never replaces the caller's original file bytes. */
(() => {
    'use strict';
    const tr = (zh, en) => globalThis.PiI18n?.locale?.startsWith('en') ? en : zh;
    const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
    const supports = name => /\.(?:docx?|xlsx?|pptx?)$/i.test(name || '');
    function render(body, data, context = {}) {
        const root = node('section', undefined, 'pi-office-file-preview'), status = node('p', tr('正在准备办公文件预览…', 'Preparing Office preview…'), 'pi-office-preview-notice');
        status.setAttribute('role', 'status'); root.append(status); body.append(root);
        const controller = new AbortController(), urls = new Set(); let disposed = false, child, view;
        const current = () => !disposed && !controller.signal.aborted && context.isCurrent?.() !== false;
        const cleanup = () => { if (disposed) return; disposed = true; controller.abort(); clearInterval(watch); context.signal?.removeEventListener('abort', cleanup); child?.(); for (const url of urls) URL.revokeObjectURL(url); urls.clear(); root.remove(); };
        cleanup.captureView = () => child?.captureView?.() || view;
        cleanup.resize = state => { view = state; child?.resize?.(state); };
        // Callers expose their existing thread/draft/socket generation, including
        // changes that happen while a converter or dynamic PDF import is pending.
        const stale = () => { cleanup(); context.onStale?.(); };
        const watch = context.isCurrent ? setInterval(() => { if (!current()) stale(); }, 100) : undefined;
        if (context.signal?.aborted) { cleanup(); return cleanup; }
        context.signal?.addEventListener('abort', cleanup, { once: true });
        const failure = error => {
            if (!current()) { stale(); return; }
            const code = error?.data?.code || error?.code;
            const message = /BUSY/.test(code || '') ? tr('预览繁忙，请稍后刷新。', 'Preview is busy. Refresh again later.')
                : /TIMEOUT/.test(code || '') ? tr('预览超时，请刷新重试。', 'Preview timed out. Refresh to retry.')
                : /LIMIT/.test(code || '') ? tr('文件超过预览预算。', 'This file exceeds the preview budget.')
                : /UNAVAILABLE|FONT|ENGINE/.test(code || '') ? tr('预览组件或所需字体不可用。', 'The preview engine or required fonts are unavailable.')
                    : /SOURCE|SCOPE|MISSING|ACCESS|FORBIDDEN|REVISION/.test(code || '') ? tr('原件已变化或当前没有访问权限。', 'The original has changed or access is unavailable.')
                        : tr('此文件无法预览，可能损坏、加密或包含不支持的内容。', 'This file cannot be previewed. It may be damaged, encrypted or contain unsupported content.');
            status.textContent = message + tr(' 可下载原件并用办公软件打开。', ' Download the original and open it in an Office app.'); status.setAttribute('role', 'alert');
            const retry = node('button', tr('刷新预览', 'Refresh preview')); retry.type = 'button';
            retry.addEventListener('click', () => { cleanup(); context.retry?.(); }); if (context.retry) root.append(retry);
        };
        Promise.resolve().then(() => {
            if (!current()) return;
            return context.api('/api/pi/office/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
                body: JSON.stringify({ source: data.source, ...(data.revision ? { expectedRevision: data.revision } : {}), ...(context.refresh ? { refresh: true } : {}) }) });
        }).then(result => {
            if (!current()) { stale(); return; }
            const preview = result?.preview;
            if (!preview || !['pdf', 'workbook'].includes(preview.kind) || preview.encoding !== 'base64' || typeof preview.base64 !== 'string'
                || preview.base64.length > 46 * 1024 * 1024 || preview.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(preview.base64)) throw new Error('Invalid derived preview');
            const bytes = Uint8Array.from(atob(preview.base64), c => c.charCodeAt(0));
            if (bytes.length !== preview.size) throw new Error('Invalid derived size');
            status.textContent = tr('近似预览 · 原件未修改；字体、排版和已保存的公式结果可能与办公软件不同。', 'Approximate preview · Original unchanged. Fonts, layout and saved formula results may differ in Office apps.');
            for (const warning of result.warnings || []) {
                // Translate known warning categories; font names remain safe DOM text.
                if (typeof warning === 'string' && warning.startsWith('缺少字体：')) root.append(node('p', tr('缺少字体；可安装字体后刷新预览。', 'Fonts are missing. Install them and refresh the preview.') + ' ' + warning.slice(5), 'pi-office-preview-notice'));
            }
            const stage = node('div', undefined, 'pi-office-preview-stage'); root.append(stage);
            const options = { ...context, signal: controller.signal, name: data.name, state: context.state || {}, bytes: () => bytes,
                blob(value, mime) { const url = URL.createObjectURL(new Blob([value], { type: mime })); urls.add(url); return url; } };
            child = preview.kind === 'pdf' ? globalThis.PiFilePreviews.render(stage, { kind: 'pdf', mime: 'application/pdf' }, options)
                : globalThis.PiOfficeTablePreview.render(stage, { format: result.source.format }, options);
            if (view) child?.resize?.(view);
        }).catch(error => { if (error.name !== 'AbortError') failure(error); });
        return cleanup;
    }
    globalThis.PiOfficeFilePreview = { supports, render };
})();
