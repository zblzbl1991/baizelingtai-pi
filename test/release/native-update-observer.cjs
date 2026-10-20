const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { readSafe, atomicJson, privateDir } = require('../../server/pi-maintenance-files');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function selectGeneration(value, { root, runId }) {
    return value && value.root === root && value.runId === runId && UUID.test(value.instance || '') && UUID.test(value.generation || '') ? value : null;
}
function readJson(file) {
    try { return JSON.parse(readSafe(file, 2 * 1024 * 1024)); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
class NativeObserver {
    constructor({ root, scope, runId, environment = process.env }) {
        this.root = root; this.scope = scope; this.runId = runId;
        this.environment = environment; this.assertAuthority();
        this.evidence = privateDir(path.join(scope, 'evidence'));
        this.receipts = new Map(); this.stamps = new Map(); this.states = new Map();
        this.stateRevision = ''; this.currentRevision = '';
    }
    assertAuthority() {
        const env = require('../../server/pi-launcher-qa-context').continuationEnvironment(this.root, this.environment);
        if (env.PIVANE_NATIVE_QA !== '1' || env.PIVANE_NATIVE_QA_SCOPE !== this.scope || env.PIVANE_NATIVE_QA_RUN_ID !== this.runId) throw Error('A verified explicit native QA context is required for observation/control');
    }
    current() {
        const value = readJson(path.join(this.root, '.pivane-runtime/desktop/smoke-state.json'));
        return selectGeneration(value, this);
    }
    state() { return readJson(path.join(this.root, '.pivane-runtime/state.json')); }
    poll() {
        const directory = path.join(this.scope, 'receipts'), names = fs.readdirSync(directory);
        if (names.length > 4096) throw Error('QA receipt budget exceeded');
        for (const name of names) {
            if (!/^(?:tray-)?[a-f0-9-]{36}\.json$/.test(name)) continue;
            const file = path.join(directory, name), stat = fs.lstatSync(file, { bigint: true });
            const stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
            if (this.stamps.get(name) === stamp) continue;
            const receipt = readJson(file);
            if (!receipt || receipt.schemaVersion !== 1 || receipt.runId !== this.runId || receipt.root !== this.root || !UUID.test(receipt.receiptId || '')) throw Error('QA receipt is stale or belongs to another installation');
            this.receipts.set(receipt.receiptId, receipt); this.stamps.set(name, stamp);
            const revision = createHash('sha256').update(JSON.stringify(receipt)).digest('hex').slice(0, 16);
            atomicJson(path.join(this.evidence, receipt.receiptId + '-' + revision + '.json'), receipt);
        }
        const current = this.current();
        if (current) {
            const key = current.instance + '/' + current.generation;
            this.states.set(key, current);
            const directory = privateDir(path.join(this.evidence, current.instance + '-' + current.generation));
            const revision = JSON.stringify(current);
            if (revision !== this.currentRevision) { atomicJson(path.join(directory, 'latest.json'), current); this.currentRevision = revision; }
        }
        const state = this.state();
        if (state && JSON.stringify(state) !== this.stateRevision) { atomicJson(path.join(this.evidence, 'latest-installation-state.json'), state); this.stateRevision = JSON.stringify(state); }
        return { current, state, receipts: [...this.receipts.values()] };
    }
    async until(predicate, description, timeoutMs = 180000) {
        const until = Date.now() + timeoutMs;
        do {
            const value = this.poll(), result = predicate(value);
            if (result) return result;
            await sleep(100);
        } while (Date.now() < until);
        throw Error('Native acceptance observation timed out: ' + description);
    }
    command(current, action) {
        this.assertAuthority();
        if (current?.runId !== this.runId || !UUID.test(current.instance || '') || !UUID.test(current.generation || '')
            || !['show', 'hide', 'minimize', 'open', 'start', 'stop', 'exit', 'updates', 'confirm', 'capture'].includes(action)) throw Error('A fresh exact tray generation is required for this QA command');
        const command = { schemaVersion: 1, id: randomUUID(), runId: this.runId, instance: current.instance, generation: current.generation, action };
        atomicJson(path.join(this.root, '.pivane-launcher-command.json'), command); return command;
    }
    arm(point, action) {
        this.assertAuthority();
        const command = { schemaVersion: 1, runId: this.runId, root: this.root, point, commandId: randomUUID(), action };
        atomicJson(path.join(this.scope, 'checkpoints', point + '.json'), command); return command;
    }
    resume(receipt) {
        this.assertAuthority();
        if (receipt?.runId !== this.runId || receipt.root !== this.root || receipt.state !== 'paused' || !UUID.test(receipt.receiptId || '')) throw Error('A fresh paused QA checkpoint is required');
        atomicJson(path.join(this.scope, 'checkpoints', receipt.receiptId + '.resume.json'),
            { schemaVersion: 1, runId: this.runId, root: this.root, receiptId: receipt.receiptId, action: 'resume' });
    }
    events(generation, type) {
        return [...this.receipts.values()].filter(receipt => receipt.point === 'tray-event' && receipt.event?.generation === generation && (!type || receipt.event.type === type));
    }
    async stop(current) {
        if (!Array.isArray(current.components?.processes) || current.components.processes.length !== 2) throw Error('Actual runner/tray identities are required before stopping');
        const exited = require('../../server/pi-launcher-processes').awaitExactProcesses(current.components.processes, () => this.command(current, 'exit'));
        exited.catch(() => {}); let confirmed = false;
        await this.until(({ current: live, receipts }) => {
            if (!confirmed && live?.generation === current.generation && live.instance === current.instance && live.confirm && !live.pending) {
                this.command(live, 'confirm'); confirmed = true;
            }
            const events = receipts.filter(value => value.point === 'tray-event' && value.event?.generation === current.generation && value.event.instance === current.instance);
            return events.some(value => value.event.type === 'stopped' && value.event.clean === true)
                && events.some(value => value.event.type === 'exited' && value.event.exitCode === 0)
                && events.some(value => value.event.type === 'tray-finalized');
        }, 'normal tray review/confirm, trusted clean completion and exact generation exit', 180000);
        return { confirmed, generation: current.generation, instance: current.instance, processProof: await exited };
    }
}
module.exports = { NativeObserver, selectGeneration, readJson, sleep };
