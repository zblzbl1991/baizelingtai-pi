const { inspectActivation, runHandoff } = require('./pi-launcher-activation');
async function main(args) {
    const [command, root, id] = args;
    if (args.length !== 3 || !['inspect', 'handoff', 'rollback-handoff'].includes(command)) throw Error('Usage: helper inspect|handoff|rollback-handoff <installation-root> <transaction-id>');
    if (command === 'inspect') { process.stdout.write(JSON.stringify(inspectActivation(root, id)) + '\n'); return; }
    const line = await new Promise((resolve, reject) => {
        let input = '';
        process.stdin.setEncoding('utf8');
        const data = text => {
            input += text;
            if (input.length > 4096) { process.stdin.off('data', data); process.stdin.pause(); reject(Error('Handoff request exceeds budget')); return; }
            const at = input.indexOf('\n');
            if (at !== -1) { process.stdin.off('data', data); process.stdin.pause(); resolve(input.slice(0, at)); }
        };
        process.stdin.on('data', data); process.stdin.once('end', () => reject(Error('Incomplete handoff request')));
    });
    await runHandoff({ root, id, processes: JSON.parse(line), mode: command === 'handoff' ? 'activate' : 'rollback',
        onReady: () => process.stdout.write(JSON.stringify({ event: 'ready', id }) + '\n') });
}
if (require.main === module) {
    process.stdout.on('error', error => { if (error.code !== 'EPIPE') throw error; });
    main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { main };
