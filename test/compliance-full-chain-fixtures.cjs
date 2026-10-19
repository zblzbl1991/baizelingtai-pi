// Deterministic synthetic documents for the complete compliance browser chain.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const fx = require('./compliance-fixtures.cjs');
const EXPECTED = Object.freeze({
    "conflict-p002.pdf": "45dbbe6ff5de809db9c5e0f40b005a1c7a8372cfc5f7e54dcf2e83a130c65e3a",
    "contract-0228.pdf": "c34db4ad29420c0efd46d7a6408013003867fab9378fe22c1aa5136e1e51f7bd",
    "contract-0301.pdf": "97200cf8a96a0fc2d20c9522032dbf209da5f8fe7d1fd19693d158018c157121",
    "contract-0331.pdf": "748189295263589350e72da9d2c1c9fec5c8797f52b16bde13f637c15d049e61",
    "contract-0401.pdf": "c838e3387676e8ec2e782dd4760fade63600e8dac95d9e2f25cd470e7d813504",
    "contract-month-03.pdf": "5a49e04efb4d75f00225d474f60215aa6ebd3911d270be4a050a56d583b8aa0f",
    "kexing-0110.pdf": "f21f05cfab66d42db941e157957e6f770de3bf73ba57a66889de80c353df3075",
    "kexing-0201.pdf": "da08d1e6d259b2d1a7845e4fdf7b0fcda4a47c5a04b539e892eb3487802af6e8",
    "kexing-0301.pdf": "bd60647e14658d90136e4e124c09f8eca4b29e731130304a3244f826d7196f21",
    "ledger-full.csv": "5f06665db0511984e84a8e5d892975d196487b5fc591abf3980a1e5d84b9f949",
    "ledger-na-unknown.csv": "7db10d7d2362c22a3438df419b6d0ced3e72dd338752b33087bf12df44cbbab9",
    "notice-0225.pdf": "3b768c95f010ade871f4f8d559be653166d9cbc006a4a639ba347a13ba962257",
    "notice-0301.pdf": "e9d353ee292010c9b1e9ddfd04827f6dbd7bc01b122244f9a5bf52edf887c977",
    "review-0201.pdf": "314464b16819d36fa2d9e6aaa7a1076635c9d0ec04cb9cb480ddcc93eb5afc38",
    "scanned-page.pdf": "bb68e8734ec6dfc34ce4e37c7a8ac7f6486a49cb54d0f0b59ee1c5135038527a",
    "wenhao-missing.pdf": "1213e060de914cb0b30673226a8c13d640141ae7c31e72c2b2690748c5e2633e",
    "wenhao-present.pdf": "330910a9163fca2696432fcaa5decec1463f05ae735f45f33014835f557b06cc"
});
function writeSamples(out) {
    fs.mkdirSync(out, { recursive: true });
    const lines = pairs => pairs.map(([text, y]) => ({ text, y: y ?? 700 }));
    const write = (name, buffer) => fs.writeFileSync(path.join(out, name), buffer);

    // —— 台账 CSV（表头固定，COMPLIANCE.md 模板；UTF-8 无 BOM，CRLF）——
    const header = '项目名称,项目编号,单位,年度,期次,项目类型,阶段,本次规则适用清单,日期,文号\r\n';
    write('ledger-full.csv', Buffer.from(header +
      '示例工程甲,P-001,示例单位,2026,一期,市政工程,可研,"资料缺失与归属=适用,可研评审及批复文号=适用,合同签订期限=适用,可研报告与评审时序=适用",2026-03-01,\r\n', 'utf8'));
    write('ledger-na-unknown.csv', Buffer.from(header +
      '示例工程丙,P-003,, ,一期,市政工程,可研,"资料缺失与归属=适用,可研评审及批复文号=适用,合同签订期限=适用,可研报告与评审时序=不适用",,\r\n', 'utf8'));

    // —— 合同/时序/文号/月精度/归属冲突 PDF ——
    const P = '项目名称：示例工程甲';
    write('notice-0301.pdf', fx.labeledPdf(lines([[P], ['项目编号：P-001', 670], ['中标通知书', 640], ['日期：2026-03-01', 610]])));
    write('notice-0225.pdf', fx.labeledPdf(lines([[P], ['项目编号：P-001', 670], ['中标通知书', 640], ['日期：2026-02-25', 610]])));
    for (const [name, date] of [['contract-0228', '2026-02-28'], ['contract-0301', '2026-03-01'], ['contract-0331', '2026-03-31'], ['contract-0401', '2026-04-01'], ['contract-month-03', '2026-03']]) {
      write(`${name}.pdf`, fx.labeledPdf(lines([[P], ['合同', 670], [`签订日期：${date}`, 640]])));
    }
    write('review-0201.pdf', fx.labeledPdf(lines([[P], ['评审意见', 670], ['评审日期：2026-02-01', 640]])));
    for (const [name, date] of [['kexing-0110', '2026-01-10'], ['kexing-0201', '2026-02-01'], ['kexing-0301', '2026-03-01']]) {
      write(`${name}.pdf`, fx.labeledPdf(lines([[P], ['可研报告', 670], [`日期：${date}`, 640]])));
    }
    write('wenhao-present.pdf', fx.labeledPdf(lines([['A发改批〔2026〕12号', 780], [P, 740], ['批复', 710], ['日期：2026-03-05', 680]])));
    write('wenhao-missing.pdf', fx.labeledPdf(lines([[P, 780], ['批复', 740], ['日期：2026-03-05', 710]])));
    write('conflict-p002.pdf', fx.labeledPdf(lines([['项目名称：示例工程乙'], ['项目编号：P-002', 670], ['中标通知书', 640], ['日期：2026-03-01', 610]])));
    write('scanned-page.pdf', fx.scannedPdf());

    for (const [name, expected] of Object.entries(EXPECTED)) {
        const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex');
        assert.equal(actual, expected, 'synthetic compliance sample: ' + name);
    }
    fs.writeFileSync(path.join(out, 'MANIFEST.sha256'), Object.entries(EXPECTED).map(([name, hash]) => hash + '  ' + name).join('\n') + '\n');
    return out;

}
module.exports = { writeSamples };
