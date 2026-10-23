(() => {
    const t = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, i) => values[i] ?? `{${i}}`));
    const refs = globalThis.PiDocumentReferences;
    class PiDocumentAttachments {
        constructor({ context, api, fetchBytes, toast, openPreview, closeFilePreview }) { Object.assign(this, { context, api, fetchBytes, toast, openPreview, closeFilePreview }); this.enabled = false; }
        key(context = this.context()) { return JSON.stringify([context.cwd, context.session?.id, context.generation]); }
        target() {
            const context = this.context();
            if (!this.enabled || !context.connected || !context.session || context.session.ephemeral) throw new Error(t('当前入口尚未启用文档上传，请使用支持此功能的持久线程'));
            return { context, key: this.key(context) };
        }
        async upload(file) {
            const target = this.target(), bytes = crypto.getRandomValues(new Uint8Array(16));
            const requestId = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
            const query = new URLSearchParams({ cwd: target.context.cwd, sessionId: target.context.session.id, name: file.name, requestId });
            // One raw upload, no base64 in chat state or automatic retries. The
            // stable requestId is retained for a status check if delivery is lost.
            try {
                const result = await this.api(`/api/pi/uploads?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
                if (target.key !== this.key()) throw Object.assign(new Error(t('会话已切换，上传结果未加入当前草稿')), { status: 409 });
                return result;
            } catch (error) {
                if (!error.status && target.key === this.key()) {
                    // Read-only reconciliation of the same request, never re-upload.
                    try {
                        const statusQuery = new URLSearchParams({ cwd: target.context.cwd, sessionId: target.context.session.id, requestId });
                        const saved = await this.api(`/api/pi/uploads/status?${statusQuery}`);
                        if (target.key === this.key() && refs.valid(saved?.reference)) return saved;
                    } catch {}
                }
                if (!error.status) error.message = t('上传结果未确认，未自动重试（标识 {0}）', requestId) + '：' + error.message;
                throw error;
            }
        }
        async download(reference) {
            const target = this.target(), query = new URLSearchParams({ cwd: target.context.cwd, sessionId: target.context.session.id, id: reference.id });
            const response = await this.fetchBytes(`/api/pi/uploads?${query}`);
            if (!response.ok) {
                let message; try { message = (await response.json()).error; } catch {}
                throw new Error(t(message || `HTTP ${response.status}`));
            }
            const blob = await response.blob();
            if (target.key !== this.key()) return;
            const url = URL.createObjectURL(blob), link = document.createElement('a');
            link.href = url; link.download = reference.name; link.hidden = true; document.body.append(link); link.click(); link.remove();
            // Allow the browser to acquire the object before releasing it.
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        }
        closePreview(closeFile = true) {
            if (closeFile) this.closeFilePreview?.();
            this.previewCleanup?.(); this.previewCleanup = null;
            if (this.previewDialog?.open) this.previewDialog.close();
        }
        preview(reference, options = {}) {
            let target;
            try { target = this.target(); } catch (error) { this.toast(error.message, 'error'); return; }
            if (this.openPreview && !options.dialog) { this.openPreview(reference, options); return; }
            this.closePreview(false);
            const dialog = document.createElement('dialog'); dialog.className = 'pi-document-preview'; dialog.setAttribute('aria-label', reference.name);
            const header = document.createElement('header'), title = document.createElement('strong'); title.textContent = reference.name;
            const body = document.createElement('div'); body.className = 'pi-document-preview-body';
            const action = (label, run) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', run); return b; };
            const source = { type: 'upload', cwd: target.context.cwd, sessionId: target.context.session.id, id: reference.id }, state = {};
            let cleanup;
            const isCurrent = () => dialog.open && this.context().connected && target.key === this.key() && options.isCurrent?.() !== false;
            const mount = refresh => {
                cleanup?.(); body.replaceChildren();
                cleanup = globalThis.PiOfficeFilePreview.render(body, { source, name: reference.name, revision: reference.revision }, {
                    api: (...args) => this.api(...args), state, refresh, isCurrent,
                    retry: () => mount(true), isFullscreen: () => true, onStale: () => dialog.close()
                });
                this.previewCleanup = cleanup;
            };
            const original = action(t('下载原件'), () => { void this.download(reference).catch(error => this.toast(error.message, 'error')); });
            const refresh = action(t('刷新预览'), () => mount(true));
            const close = action(t('关闭预览'), () => dialog.close());
            header.append(title, original, refresh, close); dialog.append(header, body);
            const origin = document.activeElement;
            dialog.addEventListener('close', () => { cleanup?.(); dialog.remove(); if (this.previewDialog === dialog) { this.previewDialog = null; this.previewCleanup = null; if (origin?.isConnected) origin.focus({ preventScroll: true }); } });
            document.body.append(dialog); this.previewDialog = dialog; dialog.showModal(); mount(false); close.focus({ preventScroll: true });
        }
        card(reference) {
            const card = document.createElement('div'); card.className = 'pi-document-card';
            const icon = document.createElement('i'); icon.className = 'fa-solid fa-file-lines'; icon.setAttribute('aria-hidden', 'true');
            const caption = document.createElement('span'), name = document.createElement('strong'), info = document.createElement('small');
            name.textContent = reference.name; name.title = reference.name;
            info.textContent = `${reference.format.toUpperCase()} · ${Math.ceil(reference.size / 1024)} KiB`;
            caption.append(name, info);
            if (['doc', 'xls', 'ppt'].includes(reference.format)) {
                const limitation = document.createElement('small'); limitation.className = 'pi-document-legacy-note';
                limitation.textContent = t('仅支持预览和下载；Agent 不能读取或编辑旧版 Office 格式，请另存为 DOCX、XLSX 或 PPTX 后交给 Agent 处理。'); caption.append(limitation);
            }
            const download = document.createElement('button'); download.type = 'button'; download.className = 'icon-btn subtle';
            download.title = t('下载原件'); download.setAttribute('aria-label', t('下载 {0}', reference.name));
            download.innerHTML = '<i class="fa-solid fa-download" aria-hidden="true"></i>';
            download.addEventListener('click', async () => {
                const finish = globalThis.PiActionFeedback?.begin(download, t('正在下载…'), { iconOnly: true }); download.disabled = true;
                try { await this.download(reference); } catch (error) { this.toast(error.message, 'error'); }
                finally { finish?.(); download.disabled = false; }
            });
            card.append(icon, caption, download);
            if (globalThis.PiOfficeFilePreview?.supports(reference.name)) {
                const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'icon-btn subtle';
                preview.title = t('预览文档'); preview.setAttribute('aria-label', t('预览文档')); preview.textContent = t('预览');
                preview.addEventListener('click', () => this.preview(reference, { dialog: Boolean(card.closest('dialog')), isCurrent: () => card.isConnected && (!card.closest('dialog') || card.closest('dialog').open) })); card.append(preview);
            }
            return card;
        }
        render(container, text) {
            const parts = refs.split(text || '');
            if (!parts.some(part => part.reference)) { globalThis.PiQuotes.renderUser(container, text); return; }
            for (const part of parts) {
                if (part.reference) container.append(this.card(part.reference));
                else if (part.text.trim()) { const node = document.createElement('div'); globalThis.PiQuotes.renderUser(node, part.text); container.append(node); }
            }
        }
    }
    globalThis.PiDocumentAttachments = PiDocumentAttachments;
})();
