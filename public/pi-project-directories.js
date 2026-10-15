(() => {
    const t = (text, ...values) => globalThis.PiI18n?.t(text, ...values) ?? text;
    function create({ apiFetch, browse, opened }) {
        const $ = id => document.getElementById(id);
        const button = $('pi-directory-create'), form = $('pi-directory-create-form'), name = $('pi-directory-name');
        const submit = $('pi-directory-create-submit'), cancel = $('pi-directory-create-cancel'), error = $('pi-directory-create-error');
        const destination = $('pi-directory-create-parent');
        let enabled = false, parent = null, epoch = 0, pending = null, uncertain = false;
        const update = () => {
            button.hidden = !enabled; button.disabled = !parent || Boolean(pending);
            submit.disabled = !parent || Boolean(pending) || uncertain;
            name.disabled = cancel.disabled = Boolean(pending);
            submit.textContent = t(pending ? '创建中…' : '创建');
            form.setAttribute('aria-busy', String(Boolean(pending)));
            $('pi-project-input').disabled = Boolean(pending);
            $('pi-project-form').querySelector('[type="submit"]').disabled = Boolean(pending);
            $('pi-directory-up').disabled = !parent || Boolean(pending);
            for (const row of $('pi-directory-list').querySelectorAll('button')) row.disabled = Boolean(pending);
        };
        const hide = () => { form.hidden = true; name.value = ''; error.textContent = ''; error.hidden = true; };
        button.addEventListener('click', () => {
            if (!parent || pending) return;
            form.hidden = false; destination.textContent = t('创建位置：{0}', parent);
            name.focus();
        });
        cancel.addEventListener('click', () => { if (!pending) { hide(); button.focus(); } });
        form.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || event.isComposing) return;
            event.preventDefault(); event.stopPropagation();
            if (!pending) { hide(); button.focus(); }
        });
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (!enabled || !parent || pending || uncertain) return;
            const value = name.value;
            if (!value.trim() || ['.', '..'].includes(value) || /[\\/\x00-\x1f\x7f]/.test(value) || new TextEncoder().encode(value).length > 255) {
                error.textContent = t('请输入有效的单个文件夹名称，不要包含路径分隔符'); error.hidden = false; name.focus(); return;
            }
            const generation = epoch, current = parent, request = {};
            pending = request; error.hidden = true; update();
            try {
                const data = await apiFetch('/api/pi/directories', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ parent: current, name: value }), signal: AbortSignal.timeout(20000) });
                if (!data || typeof data.path !== 'string' || !data.path) throw new Error('Invalid directory response');
                if (generation !== epoch) return;
                hide(); pending = null;
                await browse(data.path);
                if (generation + 1 === epoch && opened()) $('pi-project-form').querySelector('[type="submit"]').focus();
            } catch (failure) {
                if (generation !== epoch) return;
                uncertain = !failure.status || failure.status >= 500 || failure.data?.code === 'DIRECTORY_UNCERTAIN';
                error.textContent = uncertain ? t('创建结果尚未确认，请重新浏览目录核对，不要重复提交。') : failure.message;
                error.hidden = false;
            } finally {
                if (pending === request) pending = null;
                update();
                if (generation === epoch && !form.hidden && !uncertain) name.focus();
            }
        });
        return {
            get busy() { return Boolean(pending); },
            setEnabled(value) { enabled = value; update(); },
            close() { epoch++; parent = null; hide(); update(); },
            browseStart() { epoch++; parent = null; hide(); update(); },
            browsed(value) { parent = value; uncertain = false; update(); }
        };
    }
    window.PiProjectDirectories = { create };
})();
