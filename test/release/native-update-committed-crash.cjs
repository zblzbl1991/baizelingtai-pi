// Real exact-package scenario. No process is started by importing this module.
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { hashFileSafe } = require('../../server/pi-maintenance-files');
const { writePrivateFileSync } = require('../../server/pi-private-files');
const processes = require('./native-update-processes.cjs');

async function assertPortAvailable(url) {
    const address = new URL(url), server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(address.port), address.hostname, resolve); });
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return { host: address.hostname, port: Number(address.port), boundAndReleased: true };
}

async function committedCrash({ root, paths, env, observer, current, shortcut, report, persist, repair }) {
    const state = observer.state(), owner = state.desktopOwner;
    assert.equal(state.activation.phase, 'committed'); assert.equal(state.desktopOwnerProtocol, 1);
    assert.equal(owner?.root, root); assert.equal(owner?.releaseId, state.active);
    assert.match(owner?.serviceGeneration || '', /^[a-f0-9-]{36}$/);
    const live = await observer.until(value => value.receipts.find(receipt => receipt.point === 'service-live'
        && receipt.details.programRoot === current.programRoot && receipt.pid !== report.initialService.pid), 'committed candidate actual service identity', 15000);
    const witness = await processes.witnessServiceExit(live, env, { controlled: true });
    const newest = path.join(paths.PI_CODING_AGENT_DIR, 'newest-after-committed-crash.txt');
    writePrivateFileSync(newest, 'Newest synthetic committed data: ' + observer.runId + '\n', true);
    const newestProof = hashFileSafe(newest), stateFile = path.join(root, '.pivane-runtime/state.json');
    const beforeState = hashFileSafe(stateFile), serviceIds = [...observer.receipts.values()].filter(value => value.point === 'service-live').map(value => value.receiptId).sort();
    const command = observer.arm('service-cleanup-pending', 'pause');
    report.committedCrash = { newest, newestProof, stateBefore: beforeState, ownerBefore: owner, service: live, command,
        boundary: 'Actual old service HANDLE and new service-owner admission; no actual RPC worker HANDLE was created or held' };
    const result = report.committedCrash;
    let gate, resumed = false;
    try {
        result.crash = await processes.crashCommittedParents(current, env); persist();
        gate = await observer.until(value => value.receipts.find(receipt => receipt.point === 'service-cleanup-pending'
            && receipt.commandId === command.commandId && receipt.state === 'paused'), 'real committed parent-disconnect cleanup gate', 30000);
        assert.equal(gate.pid, live.pid); assert.equal(gate.creationTime, live.creationTime);
        assert.equal(gate.details.trigger, 'parent-disconnect'); assert.equal(gate.details.outcome, 'committed');
        assert.equal(gate.details.generation, owner.serviceGeneration); assert.equal(gate.details.httpListening, false);
        result.gate = gate; result.liveDuringGate = await witness.assertAlive();
        result.portAvailable = await assertPortAvailable(current.url);
        assert.deepEqual(observer.state(), state); assert.deepEqual(hashFileSafe(newest), newestProof);
        const previousReceipts = new Set(observer.receipts.keys());
        await processes.openShortcut(root, shortcut, env);
        const refusal = await observer.until(value => value.receipts.find(receipt => !previousReceipts.has(receipt.receiptId)
            && receipt.point === 'owner-refused' && receipt.details.outcome === 'DESKTOP_OWNER_UNPROVEN'),
        'explicit persistent owner refusal from original shortcut, independent of port availability', 30000);
        assert.match(refusal.details.generation || '', /^[a-f0-9-]{36}$/);
        assert.notEqual(refusal.details.generation, current.generation);
        const rejectedGeneration = refusal.details.generation;
        const finalized = await observer.until(value => {
            const events = value.receipts.filter(receipt => receipt.point === 'tray-event' && receipt.event?.generation === rejectedGeneration);
            const error = events.find(receipt => receipt.event.type === 'error' && receipt.event.code === 'DESKTOP_OWNER_UNPROVEN'
                && /Previous desktop service cleanup is unproven/.test(receipt.event.message));
            const exit = events.find(receipt => receipt.event.type === 'exited' && receipt.event.exitCode !== 0);
            const final = events.find(receipt => receipt.event.type === 'tray-finalized');
            return error && exit && final && { error, exit, final };
        }, 'new native tray reports the owner rejection and actually finalizes', 30000);
        observer.poll();
        assert.equal(observer.events(rejectedGeneration, 'ready').length, 0, 'rejected runner never admitted a business service');
        assert.deepEqual([...observer.receipts.values()].filter(value => value.point === 'service-live').map(value => value.receiptId).sort(), serviceIds,
            'no additional actual service generation appeared while the old service remained live');
        assert.deepEqual(hashFileSafe(stateFile), beforeState); assert.deepEqual(observer.state(), state);
        assert.deepEqual(hashFileSafe(newest), newestProof);
        result.refusal = refusal; result.rejectedTray = finalized; result.oldServiceStillLiveAfterRefusal = await witness.assertAlive(); persist();
        observer.resume(gate); resumed = true;
        result.serviceExit = await witness.waitForExit();
        const diagnosis = await repair(root, 'diagnose', env); assert.equal(diagnosis.code, 0);
        const diagnosed = JSON.parse(diagnosis.stdout); assert.equal(diagnosed.status, 'manual-recovery');
        assert.equal(diagnosed.code, 'DESKTOP_OWNER_UNPROVEN');
        result.repairDiagnosis = diagnosed;
        assert.deepEqual(hashFileSafe(stateFile), beforeState, 'child absence and independent repair do not clear the unproven owner');
        assert.deepEqual(hashFileSafe(newest), newestProof, 'committed latest data never rolls back');
        assert.deepEqual(observer.state(), state);
        report.cleanup = { status: 'retained-unproven-owner-after-actual-service-exit', productCleanProof: false,
            liveService: false, root, scope: observer.scope };
        report.layers.committedParentCrashServiceOwnerAdmission = true;
        return result;
    } finally {
        // Release only this actual receipt nonce so the real service can finish
        // its original disposal. Failure never fabricates an ack or kills it.
        if (gate && !resumed) { try { observer.resume(gate); result.failureGateReleased = true; } catch (error) { result.gateReleaseError = error.message; } }
        if (gate && !result.serviceExit) { try { result.failureServiceExit = await witness.waitForExit(); } catch (error) { result.unknownServiceExit = error.message; } }
        if (!gate) { witness.waitForExit().catch(error => { result.unknownServiceExit = error.message; }); }
        persist();
    }
}
module.exports = { committedCrash };
