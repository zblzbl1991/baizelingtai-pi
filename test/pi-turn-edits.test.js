const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../public/pi-file-policy');
function collect(messages, running = false) {
    const window = { PiFilePolicy: policy, PiToolDiff: { describe: () => null } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/pi-turn-edits.js'), 'utf8'), { window, TextEncoder });
    return JSON.parse(JSON.stringify(window.PiTurnEdits.collect(messages, running)));
}
const user = { role: 'user', content: '生成 Word 和 Markdown', timestamp: 1 };
function generated(id = 'g1', deliveryId = 'a'.repeat(64), names = ['公文.docx', '检查报告.md']) {
    return [
        { role: 'assistant', content: [{ type: 'toolCall', id, name: 'generate_gongwen', arguments: { requestId: id } }] },
        { role: 'toolResult', toolName: 'generate_gongwen', toolCallId: id, isError: false, details: { pivaneGongwen: { delivery: {
            reference: { version: 1, id: deliveryId, manifestRevision: 'b'.repeat(64) }, title: '说明',
            files: names.map((name, index) => ({ name, size: 24, revision: 'c'.repeat(64), href: `#pi-delivery=${deliveryId}/${index}` }))
        } } } }
    ];
}
const written = name => [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'w', name: 'write', arguments: { path: name, content: '# 正文' } }] },
    { role: 'toolResult', toolName: 'write', toolCallId: 'w', isError: false }
];

test('native write and generate_gongwen results collect the actual MD, DOCX and report without inventing writes', () => {
    const round = collect([user, ...written('说明.md'), ...generated()])[0];
    assert.deepEqual(round.files.map(file => file.path), ['说明.md', '公文.docx', '检查报告.md']);
    assert.equal(round.files[0].writes.length, 1);
    assert.equal(round.files[1].deliveryId, 'a'.repeat(64));
    assert.equal(round.files[1].index, 0);
    assert.deepEqual(round.files[1].writes, []);
    assert.deepEqual(round.files[1].edits, []);
    assert.equal(collect([user, ...generated()], true).length, 0, 'running tails remain hidden');
});

test('same-name generations remain separate by delivery identity, and repeated immutable receipts are deduplicated', () => {
    const files = collect([user, ...written('公文.docx'), ...generated(), ...generated('g2', 'd'.repeat(64)), ...generated('reuse')])[0].files;
    assert.equal(files.length, 5);
    assert.equal(files.filter(file => file.path === '公文.docx').length, 3);
    assert.equal(files[3].deliveryId, 'd'.repeat(64));
    assert.equal(files[4].index, 1);
    assert.equal(files[1].deliveryTitle, '说明');
    assert.equal(files[1].generation, 1);
    assert.equal(files[1].latest, false);
    assert.equal(files[3].generation, 2);
    assert.equal(files[3].latest, true);
});

test('report-only generations reflect actual returned files; other tools and reply text do not establish files', () => {
    assert.deepEqual(collect([user, ...generated('report', undefined, ['检查报告.md'])])[0].files.map(file => file.path), ['检查报告.md']);
    const revised = generated(); revised[0].content[0].name = revised[1].toolName = 'revise_gongwen';
    assert.deepEqual(collect([user, ...revised]), []);
    assert.deepEqual(collect([user, { role: 'assistant', content: [{ type: 'text', text: '已生成 [公文.docx](#pi-delivery=' + 'a'.repeat(64) + '/0)' }] }]), []);
});

test('version labels retain authoritative status and title, scope latest by document and do not promote reused old receipts', () => {
    const first = generated(), second = generated('g2', 'd'.repeat(64)), other = generated('other', 'e'.repeat(64), ['另一文档.docx']);
    first[1].details.pivaneGongwen.status = 'needs-review'; second[1].details.pivaneGongwen.status = 'checked';
    other[1].details.pivaneGongwen.delivery.title = '另一文档';
    const files = collect([user, ...first, ...second, ...other, ...generated('reuse')])[0].files;
    assert.deepEqual(files.map(file => [file.generation, file.latest, file.gongwenStatus]), [
        [1, false, 'needs-review'], [1, false, 'needs-review'], [2, true, 'checked'], [2, true, 'checked'], [1, false, null]
    ]);
    const nextTurn = collect([user, ...first, { ...user, timestamp: 2 }, ...second]);
    assert.deepEqual(nextTurn.map(round => round.files[0].generation), [1, 1], 'version numbers are local to a native turn');
    other[1].details.pivaneGongwen.status = '__proto__';
    assert.equal(collect([user, ...other])[0].files[0].gongwenStatus, null);
});

test('only matching unambiguous successful native calls own generated files', () => {
    const pair = generated();
    assert.deepEqual(collect([user, pair[1]]), []);
    assert.deepEqual(collect([user, pair[0], pair[0], pair[1]]), []);
    assert.deepEqual(collect([user, ...pair, { ...pair[1], isError: true }]), []);
    assert.equal(collect([user, ...pair, structuredClone(pair[1])])[0].files.length, 2);
    for (const update of [{ isError: true }, { toolName: 'write' }, { toolCallId: 'unknown' }]) {
        assert.deepEqual(collect([user, pair[0], { ...pair[1], ...update }]), []);
    }
    assert.deepEqual(collect([user, { role: 'compactionSummary' }, ...pair]), []);
});

test('malformed delivery metadata cannot create a generated file record', () => {
    for (const mutate of [
        d => { d.reference.version = 2; }, d => { d.reference.id = '../outside'; }, d => { d.reference.manifestRevision = ''; },
        d => { d.files = []; }, d => { d.files = Array(21).fill(d.files[0]); }, d => { d.files[0].size = -1; },
        d => { d.files[0].revision = ''; }, d => { d.files[0].name = 'bad\nname'; }, d => { d.files[0].href = '#pi-file=outside.docx'; }
    ]) {
        const pair = generated(); mutate(pair[1].details.pivaneGongwen.delivery);
        assert.deepEqual(collect([user, ...pair]), []);
    }
});
