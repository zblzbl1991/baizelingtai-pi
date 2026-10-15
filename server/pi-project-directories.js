const fs = require('node:fs');
const path = require('node:path');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const { fileScope, fail } = require('./pi-file-scope');
const { windowsPath } = require('./pi-platform-path');
const policy = require('../public/pi-file-policy');
const stamp = stat => ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key])).join(':');
const identityStamp = stat => ['dev', 'ino', 'mode'].map(key => String(stat[key])).join(':');
const changed = () => fail('目录已变化，请重新浏览后再创建', 409, 'DIRECTORY_CHANGED');

class PiProjectDirectories {
    constructor({ store, isSuspended = () => false }) { Object.assign(this, { store, isSuspended }); this.jobs = new Map(); this.stopping = false; }
    async dispose() { this.stopping = true; await Promise.all([...this.jobs.values()]); }
    async create(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['parent', 'name'].includes(key))
            || typeof input.parent !== 'string' || input.parent.length > 4096 || !path.isAbsolute(input.parent)
            || /[\x00-\x1f\x7f]/.test(input.parent)
            || typeof input.name !== 'string' || !input.name.trim() || Buffer.byteLength(input.name) > 255
            || /[\\/\x00-\x1f\x7f]/.test(input.name) || ['.', '..'].includes(input.name)) {
            throw fail('请输入有效的单个文件夹名称，不要包含路径分隔符', 400, 'DIRECTORY_NAME');
        }
        let parent;
        try { parent = windowsPath(input.parent); windowsPath(input.name); }
        catch { throw fail('文件夹名称或父目录路径无效', 400, 'DIRECTORY_NAME'); }
        if (policy.restricted(parent) || policy.restricted(input.name)) throw fail('此位置不允许通过网页新建文件夹', 403, 'DIRECTORY_PRIVATE');
        if (this.stopping || this.isSuspended() || this.jobs.size) throw fail('正在处理目录或实例维护，请稍后核对', 409, 'DIRECTORY_BUSY');
        // Reserve before private-root resolution yields. Disconnects do not cancel a write.
        let settle;
        this.jobs.set('create', new Promise(resolve => { settle = resolve; }));
        let parentFd, childFd, created = false;
        try {
            const scope = await fileScope(this.store, parent);
            if (this.stopping || this.isSuspended()) throw fail('实例正在维护，请稍后再创建', 409, 'DIRECTORY_BUSY');
            const current = scope.cwd, target = path.join(current, input.name);
            scope.check(target, true);
            if (target.length > 4096) throw fail('文件夹路径过长，请缩短名称', 400, 'DIRECTORY_NAME');
            const before = fs.lstatSync(current, { bigint: true });
            parentFd = io.openReadSync(current);
            const held = fs.fstatSync(parentFd, { bigint: true }), identity = io.identity(parentFd);
            const verifyParent = () => {
                const actual = descriptorPathSync(parentFd); scope.check(actual);
                if (actual !== current || fs.realpathSync.native(parent) !== current
                    || !io.sameIdentityAtPath(current, identity)
                    || !held.isDirectory() || identityStamp(held) !== identityStamp(fs.lstatSync(current, { bigint: true }))
                    || identityStamp(held) !== identityStamp(fs.fstatSync(parentFd, { bigint: true }))) throw changed();
            };
            verifyParent();
            if (stamp(before) !== stamp(held) || stamp(held) !== stamp(fs.fstatSync(parentFd, { bigint: true }))) throw changed();
            fs.accessSync(current, fs.constants.W_OK | fs.constants.X_OK);
            // Keep verification and the single non-recursive write in the same turn.
            const kernelParent = process.platform === 'linux' ? `/proc/self/fd/${parentFd}` : descriptorPathSync(parentFd);
            verifyParent();
            fs.mkdirSync(path.join(kernelParent, input.name));
            created = true;
            verifyParent();
            const listed = fs.lstatSync(target, { bigint: true });
            childFd = io.openReadSync(target);
            const child = fs.fstatSync(childFd, { bigint: true }), childIdentity = io.identity(childFd);
            const actual = descriptorPathSync(childFd); scope.check(actual);
            if (!child.isDirectory() || listed.isSymbolicLink() || stamp(listed) !== stamp(child)
                || actual !== target || this.store.resolveProject(target) !== target
                || !io.sameIdentityAtPath(target, childIdentity)
                || stamp(child) !== stamp(fs.lstatSync(target, { bigint: true }))
                || stamp(child) !== stamp(fs.fstatSync(childFd, { bigint: true }))) throw changed();
            verifyParent();
            return { parent: current, path: actual, name: input.name };
        } catch (error) {
            if (created) throw fail('文件夹可能已创建，但位置校验未完成。请重新浏览目录核对，不要重复提交', 409, 'DIRECTORY_UNCERTAIN');
            if (error.status) throw error;
            if (error.code === 'EEXIST') throw fail('已存在同名文件或文件夹，请修改名称', 409, 'DIRECTORY_EXISTS');
            if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw fail('当前目录没有创建权限，请选择其他目录', 403, 'DIRECTORY_DENIED');
            if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw changed();
            if (['ENAMETOOLONG', 'EINVAL'].includes(error.code)) throw fail('文件夹名称或路径无效，请修改后重试', 400, 'DIRECTORY_NAME');
            throw fail('暂时无法创建文件夹，请核对目录后重试', 500, 'DIRECTORY_CREATE');
        } finally {
            try { if (childFd !== undefined) fs.closeSync(childFd); }
            finally { try { if (parentFd !== undefined) fs.closeSync(parentFd); } finally { this.jobs.delete('create'); settle(); } }
        }
    }
}
function mountProjectDirectories(router, service) {
    router.post('/directories', async (req, res) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        try { res.status(201).json(await service.create(req.body)); }
        catch (error) { res.status(error.status || 500).json({ error: error.message, code: error.code }); }
    });
}
module.exports = { PiProjectDirectories, mountProjectDirectories };
