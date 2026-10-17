/* Read-only Excel preview. Source bytes and original downloads remain with the caller. */
(() => {
    'use strict';
    const node = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
    const button = (text, action) => { const n = node('button', text); n.type = 'button'; n.addEventListener('click', action); return n; };
    function column(index) { let name = ''; for (index++; index; index = Math.floor((index - 1) / 26)) name = String.fromCharCode(65 + (index - 1) % 26) + name; return name; }
    function applyStyle(element, style = {}) {
        const css = element.style;
        if (style.fontFamily) css.fontFamily = style.fontFamily;
        if (style.fontSize) css.fontSize = `${style.fontSize}pt`;
        if (style.bold) css.fontWeight = '700'; if (style.italic) css.fontStyle = 'italic';
        if (style.color) css.color = style.color; if (style.backgroundColor) css.backgroundColor = style.backgroundColor;
        if (style.horizontal) css.textAlign = style.horizontal;
        if (style.vertical) css.verticalAlign = style.vertical === 'center' ? 'middle' : style.vertical;
        if (style.wrap) css.whiteSpace = 'pre-wrap';
        for (const edge of ['Top', 'Right', 'Bottom', 'Left']) if (style['border' + edge]) css['border' + edge] = `1px solid ${style['border' + edge]}`;
    }
    function render(body, data, context = {}) {
        const root = node('section', undefined, 'pi-office-table-preview'), status = node('p', '正在解析工作簿…'); status.setAttribute('role', 'status'); root.append(status); body.append(root);
        let disposed = false, worker, timer, model, selected = null, generation = 0;
        let state = { sheet: 0, rowPage: 0, columnPage: 0, scrollTop: 0, scrollLeft: 0, ...(context.state?.officeTable || {}) };
        selected = typeof state.selected === 'string' ? state.selected : null;
        const cleanupWorker = () => { clearTimeout(timer); timer = undefined; if (worker) { worker.onmessage = worker.onerror = worker.onmessageerror = null; worker.terminate(); worker = null; } };
        const cleanup = () => { if (disposed) return; disposed = true; generation++; cleanupWorker(); context.signal?.removeEventListener('abort', cleanup); root.remove(); };
        cleanup.captureView = () => ({ ...state });
        cleanup.resize = view => { if (view && typeof view === 'object') { state = { ...state, ...view }; selected = typeof state.selected === 'string' ? state.selected : null; } if (model && !disposed) draw(); };
        if (context.signal?.aborted) { cleanup(); return cleanup; }
        context.signal?.addEventListener('abort', cleanup, { once: true });
        const error = message => { if (disposed) return; cleanupWorker(); status.textContent = `${message} 可下载原件并用办公软件打开。`; status.setAttribute('role', 'alert'); };
        const save = () => { if (context.state) context.state.officeTable = { ...state }; };
        let toolbar, warnings, selection, viewport, selector, rowLabel, colLabel, previous, next, left, right;
        function mounted() {
            status.remove(); toolbar = node('div', undefined, 'pi-office-table-toolbar'); selector = node('select'); selector.setAttribute('aria-label', '工作表');
            model.sheets.forEach((sheet, i) => { if (sheet.hidden === 'visible') { const option = node('option', sheet.name); option.value = String(i); selector.append(option); } });
            selector.addEventListener('change', () => { state.sheet = Number(selector.value); state.rowPage = state.columnPage = 0; selected = state.selected = null; draw(); });
            rowLabel = node('span'); colLabel = node('span');
            previous = button('上一页', () => { state.rowPage--; draw(); }); next = button('下一页', () => { state.rowPage++; draw(); });
            left = button('前列', () => { state.columnPage--; draw(); }); right = button('后列', () => { state.columnPage++; draw(); });
            toolbar.append(selector, previous, rowLabel, next, left, colLabel, right);
            warnings = node('div', undefined, 'pi-office-table-warnings');
            for (const warning of model.warnings) warnings.append(node('p', warning));
            const count = model.sheets.filter(s => s.hidden !== 'visible').length; if (count) warnings.append(node('p', `已省略 ${count} 张隐藏工作表。`));
            selection = node('div', '选择单元格查看原式与已保存值', 'pi-office-table-selection'); selection.setAttribute('aria-live', 'polite');
            viewport = node('div', undefined, 'pi-office-table-scroll'); viewport.tabIndex = 0;
            viewport.addEventListener('scroll', () => { state.scrollTop = viewport.scrollTop; state.scrollLeft = viewport.scrollLeft; save(); });
            root.append(toolbar, warnings, selection, viewport); draw();
        }
        function draw() {
            if (!viewport) return;
            const limits = globalThis.PiOfficeWorkbookModel.limitsFor();
            const rowsPerPage = Math.min(50, limits.pageRows), columnsPerPage = Math.min(100, limits.pageColumns, Math.floor((5000 - rowsPerPage - 1) / (rowsPerPage + 1)));
            if (!Number.isSafeInteger(state.sheet) || model.sheets[state.sheet]?.hidden !== 'visible') state.sheet = model.sheets.findIndex(s => s.hidden === 'visible');
            const sheet = model.sheets[state.sheet]; selector.value = String(state.sheet);
            if (!selected) selection.textContent = '选择单元格查看原式与已保存值';
            state.rowPage = Math.max(0, Math.min(Math.floor((sheet.rows - 1) / rowsPerPage), Number.isSafeInteger(state.rowPage) ? state.rowPage : 0));
            state.columnPage = Math.max(0, Math.min(Math.floor((sheet.columns - 1) / columnsPerPage), Number.isSafeInteger(state.columnPage) ? state.columnPage : 0));
            const rs = state.rowPage * rowsPerPage, re = Math.min(sheet.rows, rs + rowsPerPage), cs = state.columnPage * columnsPerPage, ce = Math.min(sheet.columns, cs + columnsPerPage);
            const rows = [], columns = [], rowInfo = new Map(sheet.rowHeights.map(x => [x.index, x])), colInfo = new Map(sheet.columnWidths.map(x => [x.index, x]));
            for (let r = rs; r < re; r++) if (!rowInfo.get(r)?.hidden) rows.push(r);
            for (let c = cs; c < ce; c++) if (!colInfo.get(c)?.hidden) columns.push(c);
            const cells = new Map(sheet.cells.map(cell => [`${cell.r}:${cell.c}`, cell])), visibleMerges = new Map(), table = node('table'), head = node('tr'), thead = node('thead'), tbody = node('tbody');
            for (const merge of sheet.merges) {
                if (merge.r >= re || merge.r + merge.rows <= rs || merge.c >= ce || merge.c + merge.columns <= cs) continue;
                const mr = rows.filter(i => i >= merge.r && i < merge.r + merge.rows), mc = columns.filter(i => i >= merge.c && i < merge.c + merge.columns);
                for (const r of mr) for (const c of mc) if (!visibleMerges.has(`${r}:${c}`)) visibleMerges.set(`${r}:${c}`, { merge, firstRow: mr[0], firstColumn: mc[0], rowSpan: mr.length, colSpan: mc.length });
            }
            table.setAttribute('aria-label', sheet.name); head.append(node('th', ''));
            columns.forEach(c => { const th = node('th', column(c)); th.scope = 'col'; head.append(th); }); thead.append(head); table.append(thead, tbody);
            for (const r of rows) {
                const tr = node('tr'), rowHeader = node('th', String(r + 1)); rowHeader.scope = 'row'; tr.append(rowHeader);
                const height = rowInfo.get(r)?.size; if (height) tr.style.height = `${Math.min(height, 200)}pt`;
                for (const c of columns) {
                    const windowMerge = visibleMerges.get(`${r}:${c}`), merge = windowMerge?.merge;
                    if (merge) {
                        if (r !== windowMerge.firstRow || c !== windowMerge.firstColumn) continue;
                    }
                    const cell = cells.get(`${merge ? merge.r : r}:${merge ? merge.c : c}`), td = node('td', cell?.text || ''); td.tabIndex = 0; td.dataset.address = `${column(c)}${r + 1}`;
                    const width = colInfo.get(c)?.size; if (width) td.style.width = `${Math.min(width * 7 + 5, 600)}px`;
                    applyStyle(td, cell?.style);
                    if (merge) {
                        td.rowSpan = windowMerge.rowSpan; td.colSpan = windowMerge.colSpan;
                        if (merge.r < rs || merge.c < cs || merge.r + merge.rows > re || merge.c + merge.columns > ce) { td.append(node('span', ' ↔ 合并延续', 'pi-office-table-continued')); td.title = '合并区域跨越当前行页或列窗口'; }
                    }
                    const choose = () => {
                        selected = td.dataset.address;
                        state.selected = selected;
                        const saved = cell && Object.hasOwn(cell, 'value') ? JSON.stringify(cell.value) : '无已保存结果';
                        const formula = cell?.formula || (cell?.formulaSource ? `共享主原式：${cell.formulaSource}（从属原式未展开）` : '无');
                        selection.textContent = `${selected} · 原式：${formula}${cell?.formulaRange ? ` · 范围：${cell.formulaRange}` : ''} · 已保存值：${saved}`;
                        for (const old of table.querySelectorAll('[aria-selected]')) old.removeAttribute('aria-selected'); td.setAttribute('aria-selected', 'true');
                        save();
                    };
                    td.addEventListener('click', choose); td.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } });
                    if (selected === td.dataset.address) choose();
                    tr.append(td);
                }
                tbody.append(tr);
            }
            viewport.replaceChildren(table); viewport.scrollTop = Math.max(0, Number(state.scrollTop) || 0); viewport.scrollLeft = Math.max(0, Number(state.scrollLeft) || 0);
            rowLabel.textContent = `${rs + 1}–${re} / ${sheet.rows} 行`; colLabel.textContent = `${column(cs)}–${column(ce - 1)} / ${sheet.columns} 列`;
            previous.disabled = rs === 0; next.disabled = re >= sheet.rows; left.disabled = cs === 0; right.disabled = ce >= sheet.columns;
            save();
        }
        const ticket = ++generation;
        Promise.resolve().then(() => context.bytes()).then(bytes => {
            if (disposed || ticket !== generation) return;
            const api = globalThis.PiOfficeWorkbookModel; if (!api) throw new Error('表格预览组件不可用');
            const limits = api.limitsFor(); if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > limits.maxInputBytes) throw new Error('Excel 原件超过预览预算');
            worker = new Worker('/vendor/office-preview/workbook-worker.js');
            worker.onmessage = event => {
                if (disposed || ticket !== generation || event.data?.id !== ticket) return;
                cleanupWorker();
                try { if (!event.data.ok) throw new Error(event.data.error?.message || '工作簿无法预览'); model = api.validateWorkbook(event.data.workbook); mounted(); } catch (failure) { error(failure.message); }
            };
            worker.onerror = event => { event.preventDefault(); error('工作簿解析失败'); };
            worker.onmessageerror = () => error('工作簿解析结果无效');
            timer = setTimeout(() => error('工作簿解析超时'), limits.timeoutMs);
            const copy = new Uint8Array(bytes); worker.postMessage({ id: ticket, format: data.format, bytes: copy }, [copy.buffer]);
        }).catch(failure => error(failure.message));
        return cleanup;
    }
    globalThis.PiOfficeTablePreview = { render };
})();
