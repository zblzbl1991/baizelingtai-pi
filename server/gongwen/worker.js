const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validate } = require('./input');
async function generate(raw, checkpoint = () => {}, implementations = {}) {
    require('./inventory').verify();
    const { render } = require('./render'), { inspect, correct } = require('./checks'), { finish } = require('./report');
    let input = validate(raw);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-gongwen-'));
    require('../pi-private-files').privateDirectory(directory);
    try {
        const corrections = []; let rounds = 0;
        for (;;) {
            const result = await (implementations.render || render)(input, directory);
            await checkpoint({ bytes: result.bytes, input, corrections, rounds });
            const checks = await (implementations.inspect || inspect)(result.file, input);
            if (checks.errors.length && !checks.faults.length && rounds < 2) {
                const revised = correct(input);
                if (revised.changes.length) { input = revised.input; corrections.push(...revised.changes); rounds++; continue; }
            }
            return { bytes: result.bytes, input, corrections, report: finish(input, checks, corrections, rounds) };
        }
    } finally {
        const actual = fs.realpathSync.native(directory), parent = fs.realpathSync.native(os.tmpdir());
        if (actual === directory && path.dirname(actual) === parent && path.basename(actual).startsWith('pivane-gongwen-')) fs.rmSync(actual, { recursive: true, force: true });
    }
}
async function reviseUploaded(raw, bytes, checkpoint) {
    require('./inventory').verify();
    const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-gongwen-')));
    require('../pi-private-files').privateDirectory(directory);
    try { return await require('./revise').revise(raw, bytes, directory, checkpoint); }
    finally {
        const actual = fs.realpathSync.native(directory), parent = fs.realpathSync.native(os.tmpdir());
        if (actual === directory && path.dirname(actual) === parent && path.basename(actual).startsWith('pivane-gongwen-')) fs.rmSync(actual, { recursive: true, force: true });
    }
}
if (require.main === module) {
    process.once('message', async message => {
        try {
            const checkpoint = value => new Promise((resolve, reject) => process.send({ phase: 'document', ...value }, error => error ? reject(error) : resolve()));
            const result = message.operation === 'revise' ? await reviseUploaded(message.input, message.bytes, checkpoint) : await generate(message.input, checkpoint);
            if (Buffer.byteLength(JSON.stringify(result.report)) > 256 * 1024) throw Error('检查报告超过输出预算');
            process.send({ phase: 'complete', ...result }, error => { if (error) process.exitCode = 1; process.disconnect(); });
        } catch (error) {
            const known = ['GONGWEN_NAMESPACE', 'GONGWEN_SIGNED', 'GONGWEN_LIMIT'].includes(error.code);
            process.send({ phase: 'error', code: known ? error.code : 'GONGWEN_GENERATION', message: known ? error.message : '公文生成或结构校验未完成' }, () => { process.exitCode = 1; process.disconnect(); });
        }
    });
    process.once('disconnect', () => process.exit(process.exitCode || 0));
}
module.exports = { generate };
