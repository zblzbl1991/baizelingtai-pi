// Manual native Office verification: synthetic originals only, isolated hidden
// application, immutable files. Run with --out <new absolute directory>.
const fs = require('node:fs'), path = require('node:path'), { execFile } = require('node:child_process');
const { promisify } = require('node:util'), { GongwenProcess } = require('../../server/gongwen/process');
const run = promisify(execFile);
async function main(args) {
    if (process.platform !== 'win32' || args.length !== 2 || args[0] !== '--out' || !path.isAbsolute(args[1])) throw Error('Windows only: --out must name a new absolute directory');
    const out = path.resolve(args[1]); fs.mkdirSync(out); require('../../server/pi-private-files').privateDirectory(out);
    const original = path.join(out, 'original.docx'); await require('../../vendor/gongwen-kit/tests/messy-docx').build(original);
    const bytes = fs.readFileSync(original), pool = new GongwenProcess(), expectations = {}, generated = [];
    try {
        for (const [name, options] of [['normalized', { action: 'revise', layout: true }], ['preserved', { action: 'revise', layout: false }], ['inspected', { action: 'inspect', layout: false }]]) {
            const result = await pool.run({ requestId: name, id: 'a'.repeat(64), title: '公文修订验证', ...options }, undefined, { bytes });
            if (!result.bytes || result.report.editing !== 'complete') throw Error(JSON.stringify(result.report));
            const filename = name + '.docx'; fs.writeFileSync(path.join(out, filename), result.bytes, { flag: 'wx' });
            if (options.action === 'revise') expectations[filename] = { source: 'original.docx', author: result.report.revisionAuthor };
            generated.push({ name, report: result.report });
        }
    } finally { await pool.dispose(); }
    fs.writeFileSync(path.join(out, 'revision-expectations.json'), JSON.stringify(expectations, null, 2), { flag: 'wx' });
    const renders = [], powershell = process.env.POWERSHELL_BIN || path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    for (const office of ['word', 'wps']) {
        try {
            const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(__dirname, '../../scripts/gongwen-office-render.ps1'),
                '-InputDirectory', out, '-Office', office, '-VerifyRevisions'], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
                env: require('../../scripts/run-tests.cjs').testEnvironment(process.env) });
            renders.push(...[].concat(JSON.parse(stdout)));
        } catch (error) { renders.push({ office, error: String(error.stderr || error.message).slice(0, 3000), verified: false }); }
    }
    fs.writeFileSync(path.join(out, 'render-evidence.json'), JSON.stringify({ node: process.version, generated, renders }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ out, generated: generated.length, renders }, null, 2));
    if (!renders.some(item => item.review?.rejectRestoresOriginal)) process.exitCode = 1;
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
