const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const io = require('../pi-file-io');
const { descriptorPathSync } = require('../pi-file-descriptor');
const { openPrivateFileSync, privateDirectory } = require('../pi-private-files');
const { readVerifiedFile } = require('../pi-file-bytes');
const { fail } = require('../pi-file-scope');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const changed = () => fail('公文输出位置或身份已变化，请核对已有结果；未重放', 409, 'GONGWEN_CHANGED');
const sameDirectory = (a, b) => b.isDirectory() && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
function openDirectory(parent, check) {
    check(parent, true);
    if (fs.realpathSync.native(parent) !== parent) throw changed();
    const before = fs.lstatSync(parent, { bigint: true }); if (!before.isDirectory() || before.isSymbolicLink()) throw changed();
    const fd = io.openReadSync(parent), identity = io.identity(fd);
    const verify = () => {
        check(descriptorPathSync(fd));
        if (descriptorPathSync(fd) !== parent || !io.sameIdentityAtPath(parent, identity)
            || fs.realpathSync.native(parent) !== parent || !sameDirectory(before, fs.fstatSync(fd, { bigint: true }))
            || !sameDirectory(before, fs.lstatSync(parent, { bigint: true }))) throw changed();
    };
    try { verify(); } catch (error) { fs.closeSync(fd); throw error; }
    return { verify, close: () => fs.closeSync(fd) };
}
function directory(parent, check, action) {
    const proof = openDirectory(parent, check);
    try { const result = action(proof.verify); proof.verify(); return result; } finally { proof.close(); }
}
function ensureRoot(cwd, check, name = '.pivane-gongwen') {
    if (!['.pivane-gongwen', '.pivane-office'].includes(name)) throw changed();
    const root = path.join(cwd, name);
    directory(cwd, check, () => {
        try { fs.mkdirSync(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink() || fs.realpathSync.native(root) !== root) throw changed();
        privateDirectory(root);
    });
    return root;
}
function createDirectory(parent, name, check) {
    const target = path.join(parent, name); check(target, true);
    directory(parent, check, () => { fs.mkdirSync(target, { mode: 0o700 }); if (fs.realpathSync.native(target) !== target) throw changed(); privateDirectory(target); });
    return target;
}
function writeNew(parent, name, bytes, check) {
    if (!Buffer.isBuffer(bytes) || bytes.length > 16 * 1024 * 1024) throw fail('公文输出超过预算', 413, 'GONGWEN_LIMIT');
    const target = path.join(parent, name); check(target, true);
    return directory(parent, check, verifyParent => {
        const fd = openPrivateFileSync(target), identity = io.identity(fd), before = fs.fstatSync(fd, { bigint: true });
        try {
            if (!before.isFile() || descriptorPathSync(fd) !== target) throw changed(); check(descriptorPathSync(fd)); verifyParent();
            fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
            const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(target, { bigint: true });
            if (descriptorPathSync(fd) !== target || !io.sameIdentityAtPath(target, identity) || !after.isFile() || !named.isFile()
                || before.dev !== after.dev || before.ino !== after.ino || after.size !== BigInt(bytes.length)
                || ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].some(key => after[key] !== named[key])) throw changed();
            verifyParent();
            return { name, path: target, size: bytes.length, revision: digest(bytes) };
        } finally { fs.closeSync(fd); }
    });
}
async function read(parent, name, check, limit = 256 * 1024) {
    return readVerifiedFile(path.join(parent, name), { check, maxBytes: limit });
}
module.exports = { digest, ensureRoot, createDirectory, writeNew, read, directory, openDirectory };
