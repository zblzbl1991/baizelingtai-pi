// Private identity-wide ledger. Publish ledger, audit and receipts in one replacement.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getSdk } = require('../pi-session-store');
const { safeFile } = require('../pi-native-service');
const io = require('../pi-file-io');
const { descriptorPathSync } = require('../pi-file-descriptor');
const { replaceFileSync } = require('../pi-win32-native');
const privateFiles = require('../pi-private-files');
const { emptyLedger, validateLedger, fail, MAX_LEDGER } = require('./validation');
const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const changed = () => fail('Staffing ledger changed during read or save', 409);
function readLedger(file) {
    let fd, existed = false;
    try {
        const before = fs.lstatSync(file, { bigint: true });
        existed = true;
        if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_LEDGER)) throw fail('Invalid staffing ledger file');
        fd = io.openReadSync(file);
        const opened = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
        if (!opened.isFile() || stamp(before) !== stamp(opened) || descriptorPathSync(fd) !== file) throw changed();
        const bytes = Buffer.alloc(MAX_LEDGER + 1);
        let size = 0, n;
        while (size < bytes.length && (n = fs.readSync(fd, bytes, size, bytes.length - size, size))) size += n;
        if (size > MAX_LEDGER) throw fail('Staffing ledger is too large');
        if (size !== Number(opened.size) || stamp(opened) !== stamp(fs.fstatSync(fd, { bigint: true }))
            || stamp(opened) !== stamp(fs.lstatSync(file, { bigint: true }))
            || descriptorPathSync(fd) !== file || !io.sameIdentityAtPath(file, identity)) throw changed();
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
        const state = JSON.parse(raw);
        validateLedger(state);
        return { raw, state };
    } catch (error) {
        if (error.code === 'ENOENT') {
            if (!existed) return { raw: null, state: emptyLedger() };
            throw changed();
        }
        if (error instanceof SyntaxError) throw fail('Staffing ledger contains invalid JSON');
        throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

class StaffingStore {
    async paths(create = false) {
        const { getAgentDir } = await getSdk();
        const file = safeFile(getAgentDir(), ['pivane-staffing', 'ledger.json'], create);
        const root = path.dirname(file);
        if (create) { privateFiles.privateDirectory(root); if (process.platform !== 'win32') fs.chmodSync(root, 0o700); }
        return { root, file };
    }
    async snapshot() { return readLedger((await this.paths()).file).state; }
    async mutate(expectedRevision, update) {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw fail('Expected revision is required');
        const { file, root } = await this.paths(true);
        const lock = path.join(root, 'ledger.lock');
        let directoryFd;
        try {
            directoryFd = io.openReadSync(root);
            const parent = fs.fstatSync(directoryFd, { bigint: true }), identity = io.identity(directoryFd);
            const checkParent = () => {
                try {
                    const current = fs.lstatSync(root, { bigint: true });
                    const openedNow = fs.fstatSync(directoryFd, { bigint: true });
                    if (!parent.isDirectory() || !current.isDirectory() || current.isSymbolicLink()
                        || stamp(current) !== stamp(openedNow)
                        || parent.dev !== current.dev || parent.ino !== current.ino || parent.mode !== current.mode
                        || descriptorPathSync(directoryFd) !== root || fs.realpathSync.native(root) !== root
                        || !io.sameIdentityAtPath(root, identity)) throw changed();
                } catch (error) {
                    if (error.status) throw error;
                    throw changed();
                }
            };
            checkParent();
            try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw fail('Staffing ledger is being saved', 409); }
            try {
                checkParent();
                const { state, raw } = readLedger(file);
                if (state.revision !== expectedRevision) throw fail('Staffing ledger changed; reload before saving', 409);
                const result = update(state);
                state.revision++;
                validateLedger(state);
                const text = JSON.stringify(state, null, 2) + '\n';
                if (Buffer.byteLength(text) > MAX_LEDGER) throw fail('Staffing ledger is too large');
                const tmp = `${file}.${randomUUID()}.tmp`;
                try {
                    privateFiles.writePrivateFileSync(tmp, text, true);
                    checkParent();
                    if (readLedger(file).raw !== raw) throw changed();
                    replaceFileSync(tmp, file);
                    privateFiles.privateFileMode(file);
                    checkParent();
                    if (readLedger(file).raw !== text) throw changed();
                    if (process.platform !== 'win32') fs.fsyncSync(directoryFd);
                } finally { try { fs.unlinkSync(tmp); } catch {} }
                return result;
            } finally {
                // A moved parent may no longer own this pathname. Never remove a lock
                // from an unverified replacement directory.
                checkParent();
                fs.rmdirSync(lock);
            }
        } finally { if (directoryFd !== undefined) fs.closeSync(directoryFd); }
    }

}
module.exports = { StaffingStore };
