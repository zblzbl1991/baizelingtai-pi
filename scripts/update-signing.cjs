// Offline publisher tools. No network access, no ambient key/password variables.
const fs = require('node:fs'), path = require('node:path');
const { generateKeyPairSync, timingSafeEqual, createPrivateKey, sign, createHash } = require('node:crypto');
const { Writable } = require('node:stream');
const readline = require('node:readline');
const { openPrivateFileSync } = require('../server/pi-private-files');
const { readSafe, hashFileSafe, atomicJson } = require('../server/pi-maintenance-files');
const io = require('../server/pi-file-io');
const { descriptorPathSync } = require('../server/pi-file-descriptor');

const allowed = { keygen: ['private-key', 'trust-file', 'key-id', 'passphrase-stdin'],
    sign: ['private-key', 'key-id', 'trust-root', 'manifest', 'archive', 'feed', 'output', 'passphrase-stdin'],
    'rotation-sign': ['private-key', 'key-id', 'installation-root', 'next-trust', 'output', 'passphrase-stdin'],
    'rotation-apply': ['installation-root', 'rotation'] };
const signatures = require('../server/pi-update-signatures');
function options(argv) {
    const command = argv.shift(), result = {};
    if (!allowed[command]) throw Error('Invalid command');
    while (argv.length) {
        const name = argv.shift();
        if (!name.startsWith('--') || !allowed[command].includes(name.slice(2)) || Object.hasOwn(result, name.slice(2))) throw Error('Invalid option');
        const key = name.slice(2); result[key] = key === 'passphrase-stdin' ? true : argv.shift();
        if (!result[key] || typeof result[key] === 'string' && result[key].startsWith('--')) throw Error('Missing value');
    }
    for (const key of allowed[command].filter(key => key !== 'passphrase-stdin')) if (!result[key]) throw Error('Missing option');
    return { command, args: result };
}
function destination(file) {
    const absolute = path.resolve(file), parent = path.dirname(absolute);
    if (fs.realpathSync.native(parent) !== parent) throw Error('Output parent must be canonical');
    try { fs.lstatSync(absolute); throw Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return absolute;
}
function removeOwned(file, identity, stat) {
    try {
        const actual = fs.lstatSync(file, { bigint: true });
        if (actual.isFile() && actual.dev === stat.dev && actual.ino === stat.ino && io.sameIdentityAtPath(file, identity)) fs.unlinkSync(file);
    } catch { /* Unknown output is preserved; never delete another object to hide a failure. */ }
}
function writeNew(file, bytes) {
    file = destination(file);
    const fd = openPrivateFileSync(file), identity = io.identity(fd), stat = fs.fstatSync(fd, { bigint: true });
    let succeeded = false;
    try {
        if (descriptorPathSync(fd) !== file || !stat.isFile()) throw Error('Unsafe output');
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
        if (!readSafe(file, Math.max(bytes.length, 1)).equals(bytes)) throw Error('Output changed');
        succeeded = true;
    } finally {
        fs.closeSync(fd);
        if (!succeeded) removeOwned(file, identity, stat);
    }
    return () => removeOwned(file, identity, stat);
}
async function hiddenLine(prompt) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw Error('Interactive terminal required');
    process.stderr.write(prompt);
    const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const reader = readline.createInterface({ input: process.stdin, output: silent, terminal: true, historySize: 0 });
    try {
        return await new Promise((resolve, reject) => {
            reader.once('SIGINT', () => reject(Error('Cancelled')));
            reader.once('close', () => reject(Error('Input closed')));
            reader.question('', value => resolve(Buffer.from(value, 'utf8')));
        });
    } finally { reader.close(); process.stderr.write('\n'); }
}
async function passphrase(args, confirmation) {
    let value;
    if (args['passphrase-stdin']) {
        process.stderr.write('等待标准输入口令（以 EOF 结束）。\n');
        const chunks = []; let size = 0;
        for await (const chunk of process.stdin) { size += chunk.length; if (size > 4096) throw Error('Passphrase budget'); chunks.push(chunk); }
        value = Buffer.concat(chunks);
        if (value.at(-1) === 10) value = value.subarray(0, value.length - 1);
        if (value.at(-1) === 13) value = value.subarray(0, value.length - 1);
        if (value.includes(10) || value.includes(13)) throw Error('One passphrase required');
    } else {
        value = await hiddenLine('输入签名私钥口令（不会显示）：');
        if (confirmation) {
            const repeated = await hiddenLine('再次输入口令：');
            const matches = value.length === repeated.length && timingSafeEqual(value, repeated); repeated.fill(0);
            if (!matches) { value.fill(0); throw Error('Passphrases differ'); }
        }
    }
    if (!value.length || confirmation && Array.from(value.toString('utf8')).length < 12) { value.fill(0); throw Error('Passphrase too short'); }
    return value;
}
function validKeyId(value) { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value || '')) throw Error('Invalid key ID'); return value; }
function loadKey(file, password) {
    const pem = readSafe(path.resolve(file), 16 * 1024);
    try {
        if (!pem.toString('utf8').startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----')) throw Error('Encrypted PKCS8 required');
        const key = createPrivateKey({ key: pem, format: 'pem', passphrase: password });
        if (key.asymmetricKeyType !== 'ed25519') throw Error('Ed25519 required');
        return key;
    } finally { pem.fill(0); }
}
function envelope(keyId, payload, key) {
    return { algorithm: 'ed25519', keyId: validKeyId(keyId), value: sign(null, payload, key).toString('base64') };
}
function currentBytes(file, expected, maxBytes) {
    if (!readSafe(file, maxBytes).equals(expected)) throw Error('Signing input changed');
}
function manifestShape(data, source) {
    // parseFeed uses only self-comparison to validate SemVer syntax here.
    const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
    const self = (a, b) => {
        const match = typeof a === 'string' && a.length <= 100 && pattern.exec(a);
        return a === b && match && !(match[4] || '').split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0') ? 0 : null;
    };
    return require('../server/pi-update-feed').parseFeed(data, { source, platform: 'win32', arch: 'x64', channel: 'preview', compareVersions: self });
}
async function main(argv) {
    const { command, args } = options([...argv]);
    if (command === 'rotation-sign') {
        const output = destination(args.output), root = fs.realpathSync.native(args['installation-root']);
        const nextFile = path.resolve(args['next-trust']), nextBytes = readSafe(nextFile, 64 * 1024), next = JSON.parse(nextBytes);
        if (next.schemaVersion !== 1) throw Error('Invalid next trust');
        const trustFile = path.join(root, 'config/update-trust.json'), current = readSafe(trustFile, 64 * 1024);
        const rotation = { schemaVersion: 1, previousTrustSha256: createHash('sha256').update(current).digest('hex'), keys: next.keys };
        const payload = signatures.trustRotationPayload(rotation), password = await passphrase(args, false);
        try {
            rotation.signature = envelope(args['key-id'], payload, loadKey(args['private-key'], password));
            signatures.verifyTrustRotation(rotation, root);
            currentBytes(nextFile, nextBytes, 64 * 1024); currentBytes(trustFile, current, 64 * 1024);
            writeNew(output, Buffer.from(JSON.stringify(rotation, null, 2) + '\n'));
        } finally { password.fill(0); }
        process.stdout.write('已签署授权换钥提案；尚未改变安装信任。\n');
        return;
    }
    if (command === 'rotation-apply') {
        const root = fs.realpathSync.native(args['installation-root']), rotationFile = path.resolve(args.rotation);
        const lock = await require('../server/pi-installation-lock').acquireInstallationLock(root);
        try {
            const original = readSafe(rotationFile, 64 * 1024), rotation = JSON.parse(original);
            signatures.verifyTrustRotation(rotation, root);
            currentBytes(rotationFile, original, 64 * 1024);
            // Final verification under the same OS installation lock binds the
            // current trust bytes; only this explicitly invoked command replaces it.
            const next = signatures.verifyTrustRotation(rotation, root);
            atomicJson(path.join(root, 'config/update-trust.json'), next);
        } finally { await lock.close(); }
        process.stdout.write('授权换钥已在安装锁保护下应用。\n');
        return;
    }
    if (command === 'sign') {
        const output = destination(args.output), source = require('../server/pi-update-feed').feedUrl(args.feed);
        const input = path.resolve(args.manifest), archive = path.resolve(args.archive), trustRoot = fs.realpathSync.native(args['trust-root']);
        const original = readSafe(input, 64 * 1024), data = JSON.parse(original);
        if (data.signature !== undefined || !manifestShape(data, source) || data.bytes > 1024 ** 3 || !archive.toLowerCase().endsWith('.zip')) throw Error('Invalid unsigned manifest');
        const verifyArchive = () => {
            const proof = hashFileSafe(archive, 1024 ** 3);
            if (proof.bytes !== data.bytes || proof.sha256 !== data.sha256) throw Error('Archive mismatch');
        };
        verifyArchive();
        const password = await passphrase(args, false);
        try {
            data.signature = envelope(args['key-id'], signatures.releaseSignaturePayload(data), loadKey(args['private-key'], password));
            signatures.verifyFeedSignature(data, trustRoot);
            verifyArchive(); currentBytes(input, original, 64 * 1024);
            signatures.verifyFeedSignature(data, trustRoot);
            writeNew(output, Buffer.from(JSON.stringify(data, null, 2) + '\n'));
        } finally { password.fill(0); }
        process.stdout.write('准确归档与清单已核对，签名清单已写入新文件。\n');
        return;
    }
    if (command === 'keygen') {
        const privateFile = destination(args['private-key']), trustFile = destination(args['trust-file']), keyId = validKeyId(args['key-id']);
        if (privateFile === trustFile) throw Error('Outputs must be separate');
        const codeRoot = path.resolve(__dirname, '..'), relative = path.relative(codeRoot, privateFile);
        if (!relative || !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw Error('Keep private keys outside application source');
        const password = await passphrase(args, true); let privateKey;
        try {
            const keys = generateKeyPairSync('ed25519');
            privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: password });
            const trust = { schemaVersion: 1, keys: [{ keyId, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) }] };
            const rollback = writeNew(privateFile, Buffer.from(privateKey));
            try { writeNew(trustFile, Buffer.from(JSON.stringify(trust, null, 2) + '\n')); } catch (error) { rollback(); throw error; }
        } finally { password.fill(0); privateKey = null; }
        process.stdout.write('已生成加密私钥及独立公钥信任文件。\n');
    }
}
if (require.main === module) main(process.argv.slice(2)).catch(() => {
    // Never print OpenSSL errors, stack traces, input arguments, key material or passwords.
    process.stderr.write('签名工具操作失败；请核对输入、口令、信任配置及输出文件状态。\n'); process.exitCode = 1;
});
