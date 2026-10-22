const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { getSdk } = require('./pi-session-store');
const { safeFile } = require('./pi-native-service');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const { replaceFileSync } = require('./pi-win32-native');
const privateFiles = require('./pi-private-files');
const { acquireStorageOwnership } = require('./pi-installation-lock');
const { readProfileBinding } = require('./pi-profile-state');

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ID = /^[a-f0-9-]{36}$/;
const MAX_REGISTRY = 2 * 1024 * 1024;
const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const changed = () => fail('Profile registry changed during read or save', 409);
const MEMORY_LIMITS = Object.freeze({ memoryCharLimit: [16000, 256, 65536], userCharLimit: [8000, 256, 32768] });
function normalizedMemory(memory) {
    if (!object(memory)) throw fail('Invalid profile memory');
    const limits = {};
    for (const [key, [fallback, min, max]] of Object.entries(MEMORY_LIMITS)) {
        const value = memory[key] ?? fallback;
        if (!Number.isSafeInteger(value) || value < min || value > max) throw fail(`Invalid ${key}`);
        limits[key] = value;
    }
    return limits;
}
function validAvatar(avatar) {
    return avatar === null || object(avatar) && Object.keys(avatar).every(key => ['kind', 'value', 'version'].includes(key))
        && (avatar.kind === 'emoji' && typeof avatar.value === 'string' && avatar.value.trim() === avatar.value
            && avatar.value.length > 0 && avatar.value.length <= 16 && Buffer.byteLength(avatar.value) <= 64 && !/[\x00-\x1f\x7f<>]/.test(avatar.value)
            && avatar.version === undefined
            || avatar.kind === 'image' && /^[a-f0-9]{64}$/.test(avatar.version) && avatar.value === undefined);
}

function validTrash(profile) {
    if (profile.trashedAt === undefined && profile.trashedEnabled === undefined) return true;
    return typeof profile.trashedAt === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(profile.trashedAt)
        && Number.isFinite(Date.parse(profile.trashedAt))
        && new Date(profile.trashedAt.slice(0, 10)).toISOString().slice(0, 10) === profile.trashedAt.slice(0, 10)
        && typeof profile.trashedEnabled === 'boolean' && profile.enabled === false;
}

function readRegistry(file) {
    let fd, existed = false;
    try {
        const before = fs.lstatSync(file, { bigint: true });
        existed = true;
        if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_REGISTRY)) throw fail('Invalid profile registry file');
        fd = io.openReadSync(file);
        const opened = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
        if (!opened.isFile() || stamp(before) !== stamp(opened) || descriptorPathSync(fd) !== file) throw changed();
        const bytes = Buffer.alloc(MAX_REGISTRY + 1);
        let size = 0, n;
        while (size < bytes.length && (n = fs.readSync(fd, bytes, size, bytes.length - size, size))) size += n;
        if (size > MAX_REGISTRY) throw fail('Profile registry is too large');
        if (size !== Number(opened.size) || stamp(opened) !== stamp(fs.fstatSync(fd, { bigint: true }))
            || stamp(opened) !== stamp(fs.lstatSync(file, { bigint: true }))
            || descriptorPathSync(fd) !== file || !io.sameIdentityAtPath(file, identity)) throw changed();
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
        const state = JSON.parse(raw);
        if (!object(state) || state.version !== 1 || !Array.isArray(state.profiles) || state.profiles.length > 50
            || !object(state.defaults) || state.defaultAssistantId !== undefined && (!ID.test(state.defaultAssistantId)
                || !state.profiles.some(profile => profile.id === state.defaultAssistantId && profile.enabled === true && profile.trashedAt === undefined))
            || state.managedProfiles !== undefined && (!object(state.managedProfiles)
                || Object.entries(state.managedProfiles).some(([key, id]) => key !== 'pivane-staffing:v1' || !ID.test(id)
                    || !state.profiles.some(profile => profile.id === id)))
            || new Set(state.profiles.map(p => p?.id)).size !== state.profiles.length
            || state.profiles.some(p => !object(p) || !ID.test(p.id)
                || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80
                || typeof p.description !== 'string' || p.description.length > 500
                || typeof p.soul !== 'string' || Buffer.byteLength(p.soul, 'utf8') > 32 * 1024
                || typeof p.enabled !== 'boolean' || !validTrash(p) || !object(p.memory) || !object(p.skills)
                || typeof p.memory.enabled !== 'boolean' || typeof p.memory.autoLearn !== 'boolean'
                || typeof p.skills.learnedEnabled !== 'boolean' || p.avatar !== undefined && !validAvatar(p.avatar)
                || (() => { try { normalizedMemory(p.memory); return false; } catch { return true; } })())) throw fail('Profile registry is invalid');
        return { raw, state };
    } catch (error) {
        if (error.code === 'ENOENT') {
            if (!existed) return { raw: null, state: { version: 1, profiles: [], defaults: {} } };
            throw changed();
        }
        if (error instanceof SyntaxError) throw fail('Profile registry contains invalid JSON');
        throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function validateProfile(input, previous) {
    const memory = input?.memory ?? previous?.memory ?? {};
    const skills = input?.skills ?? previous?.skills ?? {};
    if (!object(input) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80
        || typeof input.description !== 'string' || input.description.length > 500
        || typeof input.soul !== 'string' || Buffer.byteLength(input.soul, 'utf8') > 32 * 1024
        || typeof input.enabled !== 'boolean' || !object(memory) || !object(skills)
        || memory.enabled !== undefined && typeof memory.enabled !== 'boolean'
        || memory.autoLearn !== undefined && typeof memory.autoLearn !== 'boolean'
        || skills.learnedEnabled !== undefined && typeof skills.learnedEnabled !== 'boolean'
        || input.id !== undefined && (typeof input.id !== 'string' || !ID.test(input.id))) throw fail('Invalid profile');
    normalizedMemory(memory);
    const avatar = input.avatar === undefined ? previous?.avatar ?? null : input.avatar;
    if (!validAvatar(avatar)) throw fail('Invalid avatar');
    return { name: input.name.trim(), description: input.description, soul: input.soul, enabled: input.enabled,
        ...(avatar !== null || input.avatar !== undefined || previous?.avatar !== undefined ? { avatar } : {}),
        memory: { ...previous?.memory, ...memory, enabled: memory.enabled ?? false, autoLearn: memory.autoLearn ?? false },
        skills: { learnedEnabled: skills.learnedEnabled ?? true } };
}

function profileRevision(profile) {
    return profile ? createHash('sha256').update(JSON.stringify(profile)).digest('hex') : null;
}

class PiProfileRegistry {
    constructor(store) { this.store = store; this.busy = false; this.stopping = false; this.pending = null; }

    // Shared with settings/login mutation gates. Reserve synchronously, before SDK/path awaits.
    reserve(action) {
        if (this.busy || this.stopping || this.maintenance?.locked || this.nativeService?.busy
            || this.settingsService?.mutating || this.settingsService?.loginService?.busy) throw fail('Settings are being saved or workspace is stopping', 409);
        this.busy = true;
        if (this.nativeService) this.nativeService.busy = true;
        const pending = Promise.resolve().then(action);
        this.pending = pending;
        return pending.finally(() => {
            if (this.pending === pending) this.pending = null;
            if (this.nativeService) this.nativeService.busy = false;
            this.busy = false;
        });
    }

    async dispose() { this.stopping = true; if (this.pending) await this.pending.catch(() => {}); }

    async paths(create = false) {
        const { getAgentDir } = await getSdk();
        const agentDir = getAgentDir();
        const file = safeFile(agentDir, ['pivane-profiles', 'profiles.json'], create);
        const root = path.dirname(file);
        if (create) { privateFiles.privateDirectory(root); if (process.platform !== 'win32') fs.chmodSync(root, 0o700); }
        return { agentDir, root, file };
    }

    revision(raw) { return createHash('sha256').update(raw ?? '').digest('hex'); }

    async state() {
        const { file } = await this.paths();
        const data = readRegistry(file);
        return { ...data, revision: this.revision(data.raw) };
    }

    async getProfile(id) {
        if (typeof id !== 'string' || !ID.test(id)) return null;
        return (await this.state()).state.profiles.find(profile => profile.id === id) ?? null;
    }

    async list(cwdInput) {
        const cwd = cwdInput === undefined ? null : this.store.resolveProject(cwdInput);
        let current = await this.state();
        if (!current.state.defaultAssistantId) {
            await this.ensureInitialProfile();
            current = await this.state();
        }
        const { state, revision } = current;
        return { version: 1, revision, profiles: state.profiles.filter(profile => profile.trashedAt === undefined),
            trash: state.profiles.filter(profile => profile.trashedAt !== undefined)
                .sort((a, b) => Date.parse(b.trashedAt) - Date.parse(a.trashedAt))
                .map(({ id, name, description, avatar, trashedAt }) => ({ id, name, description, avatar: avatar ?? null, trashedAt })),
            profileRevisions: Object.fromEntries(state.profiles.map(profile => [profile.id, profileRevision(profile)])),
            cwd, defaultAssistantId: state.defaultAssistantId, defaultProfileId: cwd ? state.defaults[cwd] ?? null : null };
    }

    // The default assistant has a durable binding independent of editable names.
    // No existing profile is adopted by name or re-enabled during initialization.
    ensureInitialProfile() {
        if (this.initialProfilePending) return this.initialProfilePending;
        const pending = this.reserve(async () => {
            const current = await this.state();
            if (current.state.defaultAssistantId) return;
            if (this.maintenance?.referenceLocked) throw fail('Workspace references are locked', 409);
            try {
                await this.mutate(current.revision, state => {
                    if (state.profiles.length >= 50) throw fail('Profile limit reached');
                    const now = new Date().toISOString();
                    state.profiles.push({ ...validateProfile({ name: '小白', description: '', soul: '', enabled: true,
                        memory: { enabled: true, autoLearn: false }, skills: { learnedEnabled: true } }),
                        id: randomUUID(), createdAt: now, updatedAt: now });
                    state.defaultAssistantId = state.profiles.at(-1).id;
                    return { ok: true };
                });
            } catch (error) {
                // Another registry owner may have initialized first. Read the
                // winner after a CAS conflict; never replay an uncertain save.
                if (error.status !== 409 || !(await this.state()).state.defaultAssistantId) throw error;
            }
        });
        this.initialProfilePending = pending;
        const clear = () => { if (this.initialProfilePending === pending) this.initialProfilePending = null; };
        pending.then(clear, clear);
        return pending;
    }

    // Acquire crash-released OS ownership before comparing the revision. The
    // comparison through replacement stays synchronous; old lock writers must stop.
    async mutate(expectedRevision, update) {
        if (typeof expectedRevision !== 'string') throw fail('Expected revision is required');
        const { file, root } = await this.paths(true);
        let directoryFd, owner, publicationStarted = false;
        try {
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
                owner = await acquireStorageOwnership(root, 'profiles.lock');
                checkParent(); // Revalidate the held parent after asynchronous ownership acquisition.
                const { state, raw } = readRegistry(file);
                if (this.revision(raw) !== expectedRevision) throw fail('Profiles changed; reload before saving', 409);
                const result = update(state);
                const text = JSON.stringify(state, null, 2) + '\n';
                if (Buffer.byteLength(text) > MAX_REGISTRY) throw fail('Profile registry is too large');
                const tmp = `${file}.${randomUUID()}.tmp`;
                try {
                    privateFiles.writePrivateFileSync(tmp, text, true);
                    checkParent();
                    if (readRegistry(file).raw !== raw) throw changed();
                    // From this point an exception cannot prove that publication did not occur.
                    publicationStarted = true;
                    replaceFileSync(tmp, file);
                    privateFiles.privateFileMode(file);
                    checkParent();
                    if (readRegistry(file).raw !== text) throw changed();
                    if (process.platform !== 'win32') fs.fsyncSync(directoryFd);
                } finally { try { fs.unlinkSync(tmp); } catch {} }
                return { ...result, revision: this.revision(text) };
            } finally {
                try { if (owner) await owner.close(); }
                finally { if (directoryFd !== undefined) fs.closeSync(directoryFd); }
            }
        } catch (error) {
            if (publicationStarted) throw Object.assign(new Error('Profile save outcome is unknown; reload the registry or query the original initialization request before continuing'), {
                status: 503, code: 'PROFILE_OUTCOME_UNKNOWN', outcomeUnknown: true, cause: error
            });
            throw error;
        }
    }

    save(input) {
        return this.reserve(() => this.mutate(input?.expectedRevision, state => {
            if (!object(input?.profile)) throw fail('Invalid profile');
            const existingId = input.profile.id;
            const index = existingId === undefined ? -1 : state.profiles.findIndex(p => p.id === existingId);
            const previous = state.profiles[index];
            if (previous?.trashedAt !== undefined) throw fail('Profile is in trash; restore it before saving', 409);
            const profile = validateProfile(input.profile, previous);
            if (existingId === state.defaultAssistantId && !profile.enabled) throw Object.assign(new Error('Default assistant must remain enabled'), {
                status: 409, code: 'DEFAULT_ASSISTANT_PROTECTED'
            });
            // Image references can only retain an asset already owned by this record.
            if (profile.avatar?.kind === 'image' && (previous?.avatar?.kind !== 'image'
                || previous.avatar.version !== profile.avatar.version)) throw fail('Image avatar must be uploaded');
            if (existingId !== undefined && index < 0) throw fail('Profile not found');
            if (index < 0 && state.profiles.length >= 50) throw fail('Profile limit reached');
            const now = new Date().toISOString();
            const record = { ...previous, ...profile, id: previous?.id || randomUUID(),
                createdAt: previous?.createdAt || now, updatedAt: now };
            if (index < 0) state.profiles.push(record); else state.profiles[index] = record;
            return { ok: true, profile: record, requiresReload: true };
        }));
    }

    // Internal business binding; never infer identity from editable display names.
    ensureManagedProfile(bindingKey, template) {
        if (bindingKey !== 'pivane-staffing:v1') throw fail('Unknown managed profile binding');
        return this.reserve(async () => {
            const current = await this.state();
            const existingId = current.state.managedProfiles?.[bindingKey];
            if (existingId) return { profile: current.state.profiles.find(profile => profile.id === existingId), revision: current.revision };
            return this.mutate(current.revision, state => {
                if (state.profiles.length >= 50) throw fail('Profile limit reached');
                const now = new Date().toISOString();
                const record = { ...validateProfile(template), id: randomUUID(), createdAt: now, updatedAt: now };
                state.profiles.push(record);
                state.managedProfiles = { ...state.managedProfiles, [bindingKey]: record.id };
                return { profile: record, requiresReload: true };
            });
        });
    }

    trash(id, input) {
        return this.reserve(() => this.mutate(input?.expectedRevision, state => {
            const profile = state.profiles.find(record => record.id === id);
            if (!profile) throw fail('Profile not found', 404);
            if (id === state.defaultAssistantId) throw Object.assign(new Error('Default assistant cannot be moved to trash'), {
                status: 409, code: 'DEFAULT_ASSISTANT_PROTECTED'
            });
            if (profile.trashedAt !== undefined) throw fail('Profile is already in trash', 409);
            const now = new Date().toISOString();
            profile.trashedAt = now;
            profile.trashedEnabled = profile.enabled;
            profile.enabled = false;
            profile.updatedAt = now;
            for (const [cwd, profileId] of Object.entries(state.defaults)) {
                if (profileId === id) delete state.defaults[cwd];
            }
            return { ok: true, profile };
        }));
    }

    restore(id, input) {
        return this.reserve(() => this.mutate(input?.expectedRevision, state => {
            const profile = state.profiles.find(record => record.id === id);
            if (!profile) throw fail('Profile not found', 404);
            if (profile.trashedAt === undefined) throw fail('Profile is not in trash', 409);
            profile.enabled = profile.trashedEnabled;
            delete profile.trashedAt;
            delete profile.trashedEnabled;
            profile.updatedAt = new Date().toISOString();
            return { ok: true, profile };
        }));
    }

    saveAvatar(id, expectedRevision, version, prepareAsset) {
        return this.reserve(async () => {
            const installAsset = await prepareAsset();
            return this.mutate(expectedRevision, state => {
                const index = state.profiles.findIndex(profile => profile.id === id);
                if (index < 0) throw fail('Profile not found', 404);
                installAsset();
                const record = { ...state.profiles[index], avatar: { kind: 'image', version }, updatedAt: new Date().toISOString() };
                state.profiles[index] = record;
                return { ok: true, profile: record };
            });
        });
    }

    saveDefault(input) {
        return this.reserve(() => {
            const cwd = this.store.resolveProject(input?.cwd);
            if (input.profileId !== null && (typeof input.profileId !== 'string' || !ID.test(input.profileId))) throw fail('Invalid profile ID');
            return this.mutate(input.expectedRevision, state => {
                if (input.profileId !== null && !state.profiles.some(p => p.id === input.profileId && p.enabled)) throw fail('Profile is not available');
                if (input.profileId === null) delete state.defaults[cwd]; else state.defaults[cwd] = input.profileId;
                return { ok: true, cwd, defaultProfileId: input.profileId };
            });
        });
    }

    async select(cwd, requested) {
        if (requested !== undefined && requested !== null && (typeof requested !== 'string' || !ID.test(requested))) throw fail('Invalid profile ID');
        const { state } = await this.state();
        const id = requested === undefined ? state.defaults[cwd] ?? null : requested;
        if (id !== null && !state.profiles.some(p => p.id === id && p.enabled)) throw fail('Profile is not available');
        return id;
    }

    async describe(manager, knownState) {
        const binding = readProfileBinding(manager);
        if (!binding?.profileId) return null;
        const state = knownState ?? (await this.state()).state;
        const profile = state.profiles.find(p => p.id === binding.profileId);
        return { id: binding.profileId, name: profile?.name || '', enabled: Boolean(profile?.enabled), available: Boolean(profile?.enabled) };
    }

    async context(manager, cwd) {
        const binding = readProfileBinding(manager);
        if (!binding?.profileId || manager.getCwd() !== cwd || !manager.getSessionFile()) return null;
        const { state } = await this.state();
        const profile = state.profiles.find(p => p.id === binding.profileId && p.enabled);
        if (!profile) return null;
        const { root, agentDir } = await this.paths(true);
        const profileRoot = path.join(root, 'data', profile.id);
        safeFile(agentDir, ['pivane-profiles', 'data', profile.id, '.profile-root'], true);
        privateFiles.privateDirectory(profileRoot);
        if (process.platform !== 'win32') fs.chmodSync(profileRoot, 0o700);
        return { version: 1, profileId: profile.id, sessionId: binding.sessionId, cwd,
            sessionPath: fs.realpathSync.native(manager.getSessionFile()),
            profileRoot, sessionsRoot: path.join(fs.realpathSync.native(agentDir), 'sessions'),
            memory: { enabled: profile.memory.enabled, autoLearn: profile.memory.autoLearn, ...normalizedMemory(profile.memory) },
            skills: { learnedEnabled: profile.skills.learnedEnabled } };
    }
}

module.exports = { PiProfileRegistry, readRegistry, profileRevision, normalizedMemory };
