// First installation degrades only Office preview. Update/portable candidates
// must pass the same platform policy and, where declared, native health probe
// before being marked complete or activated.
const path = require('node:path');
const { preflightOfficePreview } = require('../server/office-preview/preflight');
async function install({ root = path.resolve(__dirname, '..'), requireAvailable = false, target } = {}) {
    require('./build-office-preview.cjs').build(root);
    const result = await preflightOfficePreview({ root, requireAvailable, target });
    console.log(result.available ? '[pivane] Office preview 0.1.1 integrity and isolated conversion ready.' : '[pivane] Workbench installed; ' + result.message);
    return result;
}
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--require-available')) { console.error('Usage: node scripts/install-office-preview.cjs [--require-available]'); process.exitCode = 1; }
    else install({ requireAvailable: args.includes('--require-available') }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { install };
