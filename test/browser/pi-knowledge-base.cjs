const { selectBrowserTargets } = require('./targets.cjs');
const assert = require('node:assert/strict'), http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../../public');
const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="en"><meta charset="utf-8"><style>:root{--text-main:#293b32;--text-muted:#53665c;--surface-1:#f9fbfa;--surface-2:#eaf0ec;--accent:#35694c}body{margin:0;font:16px system-ui;background:var(--surface-1)}.workspace-settings-content{max-width:1100px;margin:auto}.settings-panel-header{display:flex;gap:16px}body.dark{--text-main:#e0eae3;--text-muted:#b2c6b9;--surface-1:#1c2921;--surface-2:#293c30}</style><link rel="stylesheet" href="/pi-knowledge-base.css"><div id="pi-composer-add-menu"></div><main class="workspace-settings-content"></main><script src="/pi-knowledge-base.js"></script></html>'); return; }
    if (['/pi-knowledge-base.js', '/pi-knowledge-base.css'].includes(req.url)) { res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(path.join(root, req.url))); return; }
    res.writeHead(404).end();
});
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true });
    try {
        for (const width of selectBrowserTargets([1440, 1000])) {
            const page = await browser.newPage({ viewport: { width, height: 1000 } }), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(`http://127.0.0.1:${server.address().port}`);
            await page.evaluate(() => {
                window.PiI18n = { locale: 'en' }; window.calls = []; window.selected = null; window.revision = 'a'.repeat(64); window.drafts = []; window.blockDraft = false;
                window.PiChatNavigation = { openSession: async input => { if (window.blockDraft) throw Error('retained draft'); window.drafts.push(input); } };
                const ops = { bases: 'mcp__weknora__list_knowledge_bases', documents: 'mcp__weknora__list_documents', search: 'mcp__weknora__search_knowledge', read: 'mcp__weknora__read_document', chunks: 'mcp__weknora__list_chunks' };
                const host = { currentCwd: () => '/fixture/project', currentSession: () => window.selected, apiFetch: async (url, options) => {
                    const input = options && JSON.parse(options.body); window.calls.push(input || url);
                    if (!input) return { servers: url.includes('scope=global') ? [{ name: 'weknora', enabled: true, valid: true }] : [{ name: 'untrusted-only', enabled: true, valid: true }], trust: { effective: false } };
                    if (window.failRead && input.action === 'knowledge-read') throw { data: { code: 'MCP_KNOWLEDGE_READ_FAILED' }, message: 'private-transport-secret' };
                    if (input.action === 'knowledge-catalog') return { revision: window.revision, servers: [{ name: 'weknora', searchRequiresBase: !!window.bridge, operations: { ...ops, ...(window.bridge ? { chunks: null } : {}) } }] };
                    if (input.action === 'reconnect') return { servers: [{ name: 'weknora', state: 'connected' }] };
                    if (window.holdRead) await new Promise(resolve => { window.releaseRead = resolve; });
                    if (window.bridge) return { value: input.operation === 'bases' ? { knowledge_bases: [{ id: input.page === 2 ? 'kb-2' : 'kb-1', name: input.page === 2 ? '第二知识库' : '第一知识库' }], next_page: input.page === 2 ? null : 2 }
                        : input.operation === 'documents' ? { documents: [{ id: 'doc-1', title: '分页原文' }], page: input.page, next_page: input.page === 2 ? null : 2, total: 1 }
                            : input.operation === 'read' ? { document: { title: '分页原文' }, page: input.page || 1, page_size: 20, next_page: input.page === 2 ? null : 2,
                                chunks: input.page === 2 ? [{ id: 'chunk-3', chunk_type: 'text', content: '第二页内容' }] : [
                                    { id: 'chunk-1', chunk_type: 'text', content: input.contentOffset === 2 ? '续读甲尾' : '甲😀', content_offset: input.contentOffset || 0, content_truncated: !input.contentOffset, next_content_offset: input.contentOffset ? null : 2 },
                                    { id: 'chunk-2', chunk_type: 'text', content: input.contentOffset ? '' : '完整乙段', content_truncated: false }
                                ] } : { results: [] } };
                    const value = input.operation === 'bases' ? { knowledge_bases: [{ id: 'kb-1', name: '工程资料<script>' }] }
                        : input.operation === 'documents' ? { documents: [{ id: 'doc-1', title: '工程规程' }], total: 21 }
                            : input.operation === 'read' ? { title: '工程规程', chunks: [{ content: '<img src=x onerror=alert(1)>核对原始记录。' }], next_offset: 20 }
                                : { results: [{ knowledge_id: 'doc-1', title: '<script>Title</script>', content: '<img src=x onerror=alert(1)>核对原始记录。', source_url: 'https://example.invalid/document/doc-1' }] };
                    return { value, operation: input.operation, runtimeId: input.runtimeId };
                } };
                window.panel = PiKnowledgeBase.create(host); document.querySelector('main').append(panel.root); panel.open();
            });
            await page.getByRole('status').filter({ hasText: 'Open a saved conversation' }).waitFor();
            assert.equal(await page.evaluate(() => calls.filter(c => typeof c === 'object').length), 0);
            assert.equal(await page.getByRole('button', { name: 'Connect selected server', exact: true }).isDisabled(), true);
            assert.equal(await page.getByRole('option', { name: 'untrusted-only' }).count(), 0);
            await page.evaluate(() => { window.selected = { cwd: '/fixture/project', id: 'session-1', runtimeId: 'runtime-1' }; });
            await page.getByRole('button', { name: 'Refresh configuration and tools' }).click();
            await page.getByRole('status').filter({ hasText: 'Tools are ready' }).waitFor();
            assert.equal(await page.evaluate(() => calls.filter(c => c.action === 'knowledge-read').length), 0);
            await page.getByRole('button', { name: 'Load knowledge bases' }).click();
            await page.getByRole('combobox', { name: 'Select knowledge base' }).selectOption('kb-1');
            await page.getByRole('button', { name: 'Browse documents' }).click();
            await page.getByRole('heading', { name: '工程规程', exact: true }).waitFor();
            await page.getByRole('button', { name: 'Next page', exact: true }).click();
            await page.getByText('Page 2', { exact: true }).waitFor();
            assert.equal(await page.evaluate(() => calls.filter(c => c.operation === 'documents').at(-1).page), 2);
            await page.getByRole('button', { name: 'Read document', exact: true }).click();
            await page.getByRole('heading', { name: 'Document content' }).waitFor();
            assert.equal(await page.locator('.knowledge-detail img').count(), 0);
            await page.getByRole('button', { name: 'Read next section' }).click();
            await page.waitForFunction(() => calls.filter(c => c.operation === 'read').at(-1).offset === 20);
            await page.getByRole('searchbox', { name: 'Question or keywords', exact: true }).fill('验收要求');
            await page.getByRole('button', { name: 'Search knowledge base', exact: true }).click();
            await page.getByRole('heading', { name: '<script>Title</script>', exact: true }).waitFor();
            assert.equal(await page.locator('.knowledge-results script, .knowledge-results img').count(), 0);
            assert.equal(await page.getByRole('link', { name: 'Open source' }).getAttribute('href'), 'https://example.invalid/document/doc-1');
            if (process.env.PIVANE_TEST_SCREENSHOT_DIR) {
                fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true });
                await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, `knowledge-results-${width}.png`), fullPage: true });
            }
            await page.getByRole('button', { name: 'Cite in chat' }).click();
            assert.match(await page.evaluate(() => drafts[0].draft), /doc-1/); assert.match(await page.evaluate(() => drafts[0].draft), /验收要求/);
            await page.evaluate(() => { window.blockDraft = true; });
            await page.getByRole('button', { name: 'Ask in chat' }).click();
            await page.getByRole('status').filter({ hasText: 'No chat draft was inserted' }).waitFor(); assert.equal(await page.evaluate(() => drafts.length), 1);
            await page.evaluate(() => { window.failRead = true; });
            await page.getByRole('button', { name: 'Search knowledge base', exact: true }).click();
            await page.getByRole('status').filter({ hasText: 'will not retry automatically' }).waitFor(); assert.ok(!(await page.locator('body').innerText()).includes('private-transport-secret'));
            await page.evaluate(() => { window.failRead = false; window.holdRead = true; });
            await page.getByRole('button', { name: 'Search knowledge base', exact: true }).click();
            await page.waitForFunction(() => !!window.releaseRead);
            await page.evaluate(() => { window.panel.close(); window.releaseRead(); });
            assert.equal(await page.locator('.knowledge-results').innerText(), '');
            await page.evaluate(() => { window.holdRead = false; window.panel.open(); });
            await page.getByRole('status').filter({ hasText: 'Tools are ready' }).waitFor();
            await page.getByRole('button', { name: 'Load knowledge bases' }).click();
            await page.getByRole('combobox', { name: 'Select knowledge base' }).selectOption('kb-1');
            await page.getByRole('searchbox', { name: 'Question or keywords', exact: true }).fill('验收要求');
            await page.evaluate(() => { window.selected = { cwd: '/fixture/project', id: 'session-2', runtimeId: 'runtime-2' }; });
            const prior = await page.evaluate(() => calls.length);
            await page.getByRole('button', { name: 'Search knowledge base', exact: true }).click();
            assert.equal(await page.evaluate(() => calls.length), prior, 'stale session may not receive a read');
            await page.evaluate(() => { window.bridge = true; });
            await page.getByRole('button', { name: 'Refresh configuration and tools' }).click();
            await page.getByRole('status').filter({ hasText: 'Tools are ready' }).waitFor();
            assert.equal(await page.getByRole('button', { name: 'Search knowledge base', exact: true }).isDisabled(), true);
            await page.getByRole('button', { name: 'Load knowledge bases' }).click();
            await page.getByRole('combobox', { name: 'Select knowledge base' }).selectOption('kb-1');
            await page.getByRole('button', { name: 'More knowledge bases' }).click();
            await page.getByRole('option', { name: '第二知识库' }).waitFor({ state: 'attached' });
            assert.equal(await page.getByRole('combobox', { name: 'Select knowledge base' }).inputValue(), 'kb-1');
            assert.equal(await page.getByRole('button', { name: 'More knowledge bases' }).isHidden(), true);
            await page.getByRole('button', { name: 'Browse documents' }).click();
            assert.equal(await page.getByRole('button', { name: 'Next page', exact: true }).isEnabled(), true);
            await page.getByRole('button', { name: 'Read document', exact: true }).click();
            await page.getByText('完整乙段', { exact: true }).waitFor();
            await page.getByRole('button', { name: 'Continue this chunk' }).click();
            await page.getByText('甲😀续读甲尾', { exact: true }).waitFor();
            assert.equal(await page.getByText('完整乙段', { exact: true }).count(), 1);
            assert.equal(await page.evaluate(() => calls.filter(c => c.operation === 'read').at(-1).contentOffset), 2);
            assert.equal(await page.evaluate(() => calls.filter(c => c.operation === 'read').at(-1).chunkKey), undefined);
            await page.getByRole('button', { name: 'Next source page' }).click();
            await page.getByText('第二页内容', { exact: true }).waitFor();
            assert.equal(await page.getByText('完整乙段', { exact: true }).count(), 0);
            assert.equal(await page.getByRole('button', { name: 'Next source page' }).count(), 0);
            await page.getByRole('button', { name: 'Previous source page' }).click();
            await page.getByText('完整乙段', { exact: true }).waitFor();
            for (const theme of ['', 'dark']) {
                await page.evaluate(theme => document.body.className = theme, theme);
                assert.ok(await page.evaluate(() => [...document.querySelectorAll('.knowledge-base button,.knowledge-base input,.knowledge-base select')].filter(n => n.getClientRects().length).every(n => n.getBoundingClientRect().right <= innerWidth + 1)));
            }
            assert.deepEqual(errors, []);
            if (process.env.PIVANE_TEST_SCREENSHOT_DIR) { fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, `knowledge-${width}.png`), fullPage: true }); }
            await page.close(); console.log(`knowledge base ${width}: PASS`);
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
