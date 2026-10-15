// Manual native-platform verification. Never opens user documents or reuses an
// existing Office instance. Run: node test/release/gongwen-office.cjs --out <new directory>
const fs = require('node:fs'), path = require('node:path'), { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { prepare, KINDS } = require('../../server/gongwen/input');
const { GongwenProcess } = require('../../server/gongwen/process');
const { privateDirectory } = require('../../server/pi-private-files');
const run = promisify(execFile);
async function main(args) {
    if (process.platform !== 'win32' || args.length !== 2 || args[0] !== '--out' || !path.isAbsolute(args[1])) throw Error('Windows only: --out must name a new absolute directory');
    const out = path.resolve(args[1]); fs.mkdirSync(out); privateDirectory(out);
    const pool = new GongwenProcess(), generated = [];
    try {
        for (const kind of KINDS) {
            const input = prepare({ requestId: kind + '-office', kind, title: ({ notice: '关于开展培训工作的通知', report: '关于培训工作情况的报告',
                request: '关于开展培训工作的请示', letter: '关于协商培训安排的函', minutes: '培训工作会议纪要', rules: '培训工作管理办法', enterprise: '培训工作情况报告' })[kind],
                unit: '示例单位', recipient: '各部门', date: '2026年10月15日', redhead: ['request', 'letter', 'minutes'].includes(kind),
                agency: '示例单位', docNo: '示发〔2026〕1号', signers: ['示例人员'], mark: '培训工作会议纪要', issue: '〔2026〕第1期',
                attendees: kind === 'minutes' ? [['出席', '示例人员甲、示例人员乙']] : undefined,
                body: [{ type: 'paragraph', text: '本文件用于公文生成与版式验证，单位和人员均为虚构测试素材。' },
                    { type: 'heading', level: 1, text: kind === 'rules' ? '总则' : '有关安排' },
                    { type: 'heading', level: 2, text: kind === 'rules' ? '各部门应当按计划组织培训并核对实际参训人数。' : '组织实施' },
                    { type: 'paragraph', text: '各部门按确认后的时间和地点组织实施，完成后报送实际参训情况。' },
                    { type: 'table', caption: '表1　参训人员安排', head: ['部门', '人数（人）'], rows: [['部门甲', '20'], ['部门乙', '30'], ['合计', '50']],
                        widths: [5844, 3000], numeric: [{ column: 2, kind: 'integer' }] },
                    { type: 'heading', level: 1, text: kind === 'rules' ? '落实要求' : '有关要求' },
                    { type: 'paragraph', text: '请各部门核对安排，具体内容以确认后的材料为准。' }],
                attachments: [{ title: '培训安排', body: [{ type: 'paragraph', text: '具体时间与地点按已确认安排执行。' }] }],
                copyTo: ['示例管理部门'], issuer: '示例单位', printDate: '2026年10月15日' });
            const result = await pool.run(input);
            if (!result.bytes || result.report.machineChecks !== 'passed') throw Error(kind + ': ' + JSON.stringify(result.report));
            fs.writeFileSync(path.join(out, kind + '.docx'), result.bytes, { flag: 'wx' });
            generated.push({ kind, report: result.report });
        }
    } finally { await pool.dispose(); }
    const powershell = process.env.POWERSHELL_BIN || path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const script = path.resolve(__dirname, '../../scripts/gongwen-office-render.ps1'), renders = [];
    for (const office of ['word', 'wps']) {
        try {
            const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
                '-InputDirectory', out, '-Office', office], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
                env: require('../../scripts/run-tests.cjs').testEnvironment(process.env) });
            renders.push(...[].concat(JSON.parse(stdout)));
        } catch (error) { renders.push({ office, error: String(error.stderr || error.message).slice(0, 3000), verified: false }); }
    }
    fs.writeFileSync(path.join(out, 'render-evidence.json'), JSON.stringify({ node: process.version, generated, renders }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ out, generated: generated.length, renders }, null, 2));
    if (renders.some(item => item.error) || renders.length !== KINDS.length * 2) process.exitCode = 1;
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
