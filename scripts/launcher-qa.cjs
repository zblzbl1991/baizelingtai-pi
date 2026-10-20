#!/usr/bin/env node
// Internal, opt-in native QA validation. This entry never starts the product.
try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== 'validate') throw Error('Usage: launcher-qa validate <root>');
    const { continuationEnvironment } = require('../server/pi-launcher-qa-context');
    process.stdout.write(JSON.stringify(continuationEnvironment(args[1])) + '\n');
} catch (error) {
    process.stderr.write(String(error.message).slice(0, 1024) + '\n');
    process.exitCode = 1;
}
