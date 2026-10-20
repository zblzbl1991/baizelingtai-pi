// Executed explicitly by the selected package's bundled Node, never imported by
// the lightweight test runner. Native SessionManager owns JSONL construction.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
async function main([operation, programRoot, file]) {
    if (!['seed', 'inspect'].includes(operation) || !path.isAbsolute(programRoot)) throw Error('Invalid native session acceptance operation');
    const entry = createRequire(path.join(programRoot, 'package.json')).resolve('@earendil-works/pi-coding-agent');
    const { SessionManager } = await import(pathToFileURL(entry).href);
    let session;
    if (operation === 'seed') {
        session = SessionManager.create(process.env.PI_PROJECT_ROOTS, process.env.PI_CODING_AGENT_SESSION_DIR);
        const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 2,
            api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'stop',
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
        const first = session.appendMessage({ role: 'user', content: 'Synthetic native launcher acceptance', timestamp: 1 });
        session.appendMessage(assistant('Original branch')); session.branch(first);
        const leaf = session.appendMessage(assistant('Preserved selected branch'));
        session.appendLabelChange(leaf, 'native upgrade QA bookmark'); session.appendSessionInfo('Synthetic native upgrade QA');
    } else {
        if (!path.isAbsolute(file) || !file.startsWith(process.env.PI_CODING_AGENT_SESSION_DIR + path.sep)) throw Error('Session is outside the isolated native scope');
        session = SessionManager.open(file);
    }
    const result = { file: session.getSessionFile(), id: session.getSessionId(), entries: session.getEntries() };
    if (typeof session.getLeafId === 'function') result.leafId = session.getLeafId();
    // Force native reads before returning a proof, without sending model requests.
    fs.statSync(result.file);
    return result;
}
if (require.main === module) main(process.argv.slice(2)).then(value => process.stdout.write(JSON.stringify(value) + '\n'))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
