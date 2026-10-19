// Shared argument/child boundary for the accurate-package acceptance runner.
const assert = require('node:assert/strict');
const path = require('node:path');
const { target } = require('../browser/targets.cjs');
function options(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const equal = argv[i].indexOf('='), key = equal < 0 ? argv[i] : argv[i].slice(0, equal);
        assert.ok(['--archive', '--sha256', '--previous-archive', '--previous-sha256', '--browser', '--playwright', '--video', '--output', '--target'].includes(key), 'unknown acceptance option');
        assert.ok(equal < 0 || key === '--target', 'only target accepts inline syntax');
        const value = equal < 0 ? argv[++i] : argv[i].slice(equal + 1);
        assert.ok(value && !value.startsWith('--') && !args[key], 'option needs one value'); args[key] = value;
    }
    for (const key of ['--archive', '--sha256', '--browser', '--playwright', '--output']) assert.ok(args[key], `${key} required`);
    assert.equal(Boolean(args['--previous-archive']), Boolean(args['--previous-sha256']));
    args['--target'] = target(args['--target'] || 'all');
    return args;
}
function browserInvocation(app, file, args, selected, environment) {
    return { args: ['--require', path.join(app, 'test/browser/target-guard.cjs'), file, ...args],
        env: { ...environment, PIVANE_BROWSER_TARGET: target(selected) } };
}
module.exports = { options, browserInvocation };
