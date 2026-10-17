const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { GongwenProcess } = require('../server/gongwen/process');
const { prepare } = require('../server/gongwen/input');
const { officeZip, xml } = require('../server/pi-document-parser');
const children = (node, name) => node.children.filter(child => typeof child !== 'string' && child.name === name);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-gongwen-format-'));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
const input = changes => prepare({ requestId: 'format-generation', kind: 'notice', title: '关于开展培训的通知',
    recipient: '各部门', unit: '示例单位', date: '2026年10月17日',
    body: [{ type: 'heading', level: 1, text: '培训安排' }, { type: 'paragraph', text: '请各部门组织参加培训。' }], ...changes });
async function generated(changes) {
    const process = new GongwenProcess();
    try { const result = await process.run(input(changes)); assert.ok(result.bytes, JSON.stringify(result.report)); return result; }
    finally { await process.dispose(); }
}
function office(args) {
    const executable = require('../server/officecli/inventory').verify().path;
    const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30000, windowsHide: true,
        env: require('../server/officecli/mcp-host').environment(process.env), maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr + result.stdout); return result.stdout;
}
test('generated notice has one unambiguous style per ID and passes independent Open XML validation', async () => {
    const { bytes } = await generated();
    const zip = officeZip(bytes), styles = xml(zip.read('word/styles.xml'));
    const ids = children(styles, 'style').map(style => style.attrs['w:styleId']);
    assert.equal(ids.length, new Set(ids).size, 'generated styles must not conflict');
    const file = path.join(directory, 'notice.docx'); fs.writeFileSync(file, bytes);
    const result = JSON.parse(office(['validate', file, '--json']));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(result.warnings || [], []);
});
test('real HTML preview preserves the notice title and body font size, face, color and alignment', async () => {
    const { bytes } = await generated();
    const file = path.join(directory, 'preview.docx'); fs.writeFileSync(file, bytes);
    const html = office(['view', file, 'html']);
    const { document } = require('linkedom').parseHTML(html);
    const paragraph = text => [...document.querySelectorAll('[data-path]')].find(node => node.textContent === text);
    const title = paragraph('关于开展培训的通知'), body = paragraph('请各部门组织参加培训。');
    assert.ok(title, 'title is present'); assert.ok(body, 'body is present');
    assert.match(title.getAttribute('style') || '', /text-align:\s*center/);
    assert.match(title.innerHTML, /font-size:\s*22pt/);
    assert.match(title.innerHTML, /font-family:[^;]*方正小标宋简体/);
    assert.match(body.innerHTML, /font-size:\s*16pt/);
    assert.match(document.querySelector('style').textContent, /body\s*\{[^}]*font-family:\s*'FangSong'/);
    assert.match(body.innerHTML, /color:\s*#000000/);
    assert.doesNotMatch(html, /#2E74B5/i);
});
test('all generated kinds retain their special formatting and validate with independent OfficeCLI', { timeout: 60000 }, async () => {
    for (const kind of require('../server/gongwen/input').KINDS) {
        const { bytes } = await generated({ requestId: 'special-' + kind, kind, redhead: ['request', 'letter', 'minutes'].includes(kind),
            agency: '示例单位', docNo: '示发〔2026〕1号', signers: ['示例人员'], mark: '培训会议纪要', issue: '〔2026〕第1期',
            attendees: kind === 'minutes' ? [['出席', '示例人员']] : undefined,
            body: [{ type: 'heading', level: 1, text: '第一层内容' }, { type: 'heading', level: 2, text: '第二层内容' },
                { type: 'heading', level: 3, text: '第三层内容' }, { type: 'heading', level: 4, text: '第四层内容' },
                { type: 'paragraph', text: '请各部门组织参加培训。' },
                { type: 'table', head: ['部门', '人数'], rows: [['部门甲', '20']], caption: '参训安排' }],
            attachments: [{ title: '培训安排', body: [{ type: 'paragraph', text: '请按确认时间参加。' }] }],
            issuer: '示例单位', copyTo: ['示例管理部门'] });
        const file = path.join(directory, kind + '.docx'); fs.writeFileSync(file, bytes);
        const validation = JSON.parse(office(['validate', file, '--json']));
        assert.equal(validation.success, true, kind + JSON.stringify(validation));
        const zip = officeZip(bytes), document = xml(zip.read('word/document.xml'));
        const descendants = (node, name) => children(node, name).concat(node.children.filter(item => typeof item !== 'string').flatMap(item => descendants(item, name)));
        const text = node => descendants(node, 't').map(item => item.children.join('')).join('');
        const paragraphs = descendants(document, 'p');
        function runProperties(label) {
            const paragraph = paragraphs.find(item => text(item) === label); assert.ok(paragraph, kind + ': ' + label);
            return children(children(paragraph, 'r')[0], 'rPr')[0];
        }
        const properties = label => Object.fromEntries(runProperties(label).children.filter(item => typeof item !== 'string').map(item => [item.name, item.attrs]));
        assert.equal(properties('关于开展培训的通知').sz['w:val'], '44');
        assert.equal(properties('请各部门组织参加培训。').rFonts['w:eastAsia'], 'FangSong');
        assert.equal(properties('请各部门组织参加培训。').sz['w:val'], '32');
        assert.equal(properties('第一层内容').rFonts['w:eastAsia'], kind === 'rules' ? '方正小标宋简体' : 'SimHei');
        assert.equal(properties('第二层内容').rFonts['w:eastAsia'], kind === 'rules' ? 'FangSong' : 'KaiTi');
        assert.equal(properties('第三层内容').rFonts['w:eastAsia'], 'FangSong');
        assert.equal(properties('第四层内容').rFonts['w:eastAsia'], 'FangSong');
        assert.equal(properties('参训安排').sz['w:val'], '28', 'table caption retains its deliberate size');
        assert.equal(properties('参训安排').rFonts['w:eastAsia'], 'SimHei');
        assert.equal(properties('抄送：示例管理部门。').sz['w:val'], '28', kind + ': banji retains its 14pt type');
        const footers = zip.names.filter(name => /^word\/footer\d+\.xml$/.test(name)); assert.ok(footers.length);
        for (const name of footers) {
            const footer = xml(zip.read(name));
            if (!descendants(footer, 'instrText').length) continue; // letter format deliberately omits the first-page number
            assert.ok(descendants(footer, 'rFonts').some(font => font.attrs['w:eastAsia'] === 'SimSun'));
            assert.ok(descendants(footer, 'sz').some(size => size.attrs['w:val'] === '28'));
        }
        if (kind === 'request') assert.ok(descendants(document, 'color').some(color => color.attrs['w:val'] === 'FF0000'), 'redhead retains red');
    }
});
