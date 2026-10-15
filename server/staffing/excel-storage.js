'use strict';
// One held native directory proof covers every import/export publication,
// including receipt repairs after asynchronous artifact operations.
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const io = require('../pi-file-io');
const { descriptorPathSync } = require('../pi-file-descriptor');
const { openPrivateFileSync } = require('../pi-private-files');
const { replaceFileSync, getWindowsNative } = require('../pi-win32-native');
const fields = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'];
const same = (a, b) => fields.every(key => a[key] === b[key]);
function unknown(cause) {
    return Object.assign(new Error('Staffing Excel storage or publication changed; outcome is unknown. Query the original operation; do not replay.'),
        { status: 503, code: 'STAFFING_EXCEL_OUTCOME_UNKNOWN', outcomeUnknown: true, noReplay: true, cause });
}
function holdDirectory(root) {
    const directoryFd = io.openReadSync(root); let before, identity;
    try { before = fs.fstatSync(directoryFd, { bigint: true }); identity = io.identity(directoryFd); }
    catch (error) { fs.closeSync(directoryFd); throw error; }
    const check = () => {
        try {
            const named = fs.lstatSync(root, { bigint: true }), opened = fs.fstatSync(directoryFd, { bigint: true });
            if (!before.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || !same(named, opened)
                || ['dev', 'ino', 'mode'].some(key => before[key] !== opened[key]) || io.identity(directoryFd) !== identity
                || descriptorPathSync(directoryFd) !== root || fs.realpathSync.native(root) !== root || !io.sameIdentityAtPath(root, identity)) throw new Error('Publication parent changed');
        } catch (error) { throw unknown(error); }
    };
    try { check(); } catch (error) { fs.closeSync(directoryFd); throw error; }
    function publish(name, bytes, maxBytes, replace = false) {
        if (path.basename(name) !== name || !name || bytes.length > maxBytes) throw Object.assign(new Error('Invalid Excel publication or byte budget'), { status: 413 });
        check();
        const destination = path.join(root, name), temporary = replace ? destination + '.' + randomUUID() + '.tmp' : destination;
        let fd, touched = false;
        try {
            // CREATE_NEW supplies private POSIX mode / Windows protected DACL
            // before any bytes. The actual opened object is proved before write.
            fd = openPrivateFileSync(temporary); touched = true;
            const original = fs.fstatSync(fd, { bigint: true }), fileIdentity = io.identity(fd);
            const fileCheck = (filename, size) => {
                check(); const opened = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(filename, { bigint: true });
                if (!original.isFile() || !opened.isFile() || !named.isFile() || named.isSymbolicLink() || !same(opened, named)
                    || ['dev', 'ino', 'mode'].some(key => original[key] !== opened[key]) || opened.size !== BigInt(size)
                    || io.identity(fd) !== fileIdentity || descriptorPathSync(fd) !== filename || !io.sameIdentityAtPath(filename, fileIdentity)) throw unknown(new Error('Publication file changed'));
            };
            fileCheck(temporary, 0);
            fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fileCheck(temporary, bytes.length);
            if (replace) {
                try { const target = fs.lstatSync(destination); if (!target.isFile() || target.isSymbolicLink() || target.size > maxBytes) throw new Error('Invalid receipt destination'); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
                fileCheck(temporary, bytes.length); replaceFileSync(temporary, destination); fileCheck(destination, bytes.length);
            }
            if (process.platform !== 'win32') fs.fsyncSync(directoryFd);
            check();
        } catch (error) { if (touched && !error.outcomeUnknown) throw unknown(error); throw error; }
        finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    return { root, check, close: () => fs.closeSync(directoryFd),
        secure() {
            check();
            if (process.platform === 'win32') getWindowsNative().securePrivate(path.toNamespacedPath(root));
            else { fs.fchmodSync(directoryFd, 0o700); before = { ...before, mode: (before.mode & ~0o777n) | 0o700n }; }
            check();
        },
        writeFile: (name, bytes, maxBytes) => publish(name, bytes, maxBytes),
        writeJson: (name, value, maxBytes) => publish(name, Buffer.from(JSON.stringify(value, null, 2) + '\n'), maxBytes, true) };
}
function privateChild(parent, name) {
    parent.check(); const root = path.join(parent.root, name);
    try { const stat = fs.lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw unknown(new Error('Linked or invalid storage ancestor')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; fs.mkdirSync(root, { mode: 0o700 }); }
    parent.check(); const child = holdDirectory(root);
    try { parent.check(); child.secure(); parent.check(); child.check(); return child; }
    catch (error) { child.close(); throw error; }
}
function prepareStorage(base, parts) {
    const held = [holdDirectory(base)];
    try {
        for (const name of parts) held.push(privateChild(held.at(-1), name));
        const leaf = held.at(-1), check = () => { for (const directory of held) directory.check(); };
        check();
        return { root: leaf.root, check, close: () => { for (const directory of [...held].reverse()) directory.close(); },
            writeFile(...args) { check(); leaf.writeFile(...args); check(); },
            writeJson(...args) { check(); leaf.writeJson(...args); check(); } };
    } catch (error) { for (const directory of held.reverse()) directory.close(); throw error; }
}
module.exports = { prepareStorage, privateChild };
