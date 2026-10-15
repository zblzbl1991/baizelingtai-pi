const test = require('node:test');
const assert = require('node:assert/strict');
const { MaintenanceClient } = require('../server/pi-maintenance-client');
const { DesktopStop } = require('../server/pivane-desktop-stop');

function fixture(options = {}) {
    const maintenance = new MaintenanceClient({ managed: true, nonce: 'synthetic' });
    maintenance.receive({ type: 'maintenance-activate', nonce: 'synthetic' });
    const stop = new DesktopStop({ maintenance, sources: [{ type: 'tasks', label: '任务', read: () => 0 }], ...options });
    return { maintenance, stop };
}
const confirmation = ticket => ({ ticket, draftsSaved: true, externalWritersStopped: true });

test('desktop stop review remains usable, detects work that completed, and accepts only one operation', () => {
    const { maintenance, stop } = fixture();
    const first = stop.review({ action: 'stop' });
    assert.ok(first.ticket);
    const leave = maintenance.enter(); leave();
    assert.throws(() => stop.execute(confirmation(first.ticket)), { code: 'DESKTOP_REVIEW_STALE' });
    assert.equal(maintenance.locked, false);
    const next = stop.review({ action: 'exit' });
    const accepted = stop.execute(confirmation(next.ticket));
    assert.equal(accepted.accepted, true);
    assert.equal(maintenance.locked, true);
    assert.deepEqual(stop.execute(confirmation(next.ticket)), accepted);
    assert.equal(stop.snapshot().operationId, accepted.operationId);
    maintenance.receive({ type: 'maintenance-activate', nonce: 'synthetic' });
    assert.throws(() => maintenance.enter(), /维护/);
});

test('final stop check reserves ingress synchronously and releases only its own rejected reservation', () => {
    let checking = false, entered = false, busy = false;
    const { maintenance, stop } = fixture({ sources: [{ type: 'jobs', label: '任务', read() {
        if (checking) {
            assert.throws(() => maintenance.enter(), /维护/);
            entered = true;
        }
        return busy ? 1 : 0;
    } }] });
    const review = stop.review({ action: 'stop' });
    checking = true; busy = true;
    assert.throws(() => stop.execute(confirmation(review.ticket)), { code: 'DESKTOP_BLOCKED' });
    assert.equal(entered, true); assert.equal(maintenance.locked, false);
    checking = false; busy = false;
    maintenance.locked = true;
    assert.equal(stop.review({ action: 'stop' }).ticket, undefined);
    assert.equal(maintenance.locked, true);
});

test('unknown readiness and expired tickets never authorize stop or expose owner errors', () => {
    const bad = fixture({ sources: [{ type: 'media', label: '媒体任务', read() { throw Error('private synthetic body'); } }] });
    const state = bad.stop.review({ action: 'stop' });
    assert.equal(state.complete, false); assert.equal(state.ticket, undefined);
    assert.equal(JSON.stringify(state).includes('private synthetic'), false);
    const missing = fixture({ sources: [] });
    assert.equal(missing.stop.snapshot().complete, false);
    let now = 100;
    const { maintenance, stop } = fixture({ now: () => now, ttlMs: 1000 });
    const review = stop.review({ action: 'stop' }); now = 1100;
    assert.throws(() => stop.execute(confirmation(review.ticket)), { code: 'DESKTOP_REVIEW_STALE' });
    assert.equal(maintenance.locked, false);
});

test('private desktop IPC ignores another owner and returns bounded errors without stopping', () => {
    const { receiveDesktopRequest } = require('../server/pivane-desktop-stop');
    const { maintenance, stop } = fixture(), replies = [];
    const receive = message => receiveDesktopRequest({ message, maintenance, stop, send: reply => replies.push(reply) });
    receive({ type: 'desktop-request', nonce: 'another', id: 'one', method: 'review', input: { action: 'stop' } });
    assert.equal(replies.length, 0);
    receive({ type: 'desktop-request', nonce: 'synthetic', id: 'one', method: 'review', input: { action: 'stop' } });
    const ticket = replies[0].result.ticket;
    receive({ type: 'desktop-request', nonce: 'synthetic', id: 'two', method: 'execute', input: confirmation(ticket) });
    assert.equal(replies[1].result.accepted, true);
    assert.equal(maintenance.locked, true);
    receive({ type: 'desktop-request', nonce: 'synthetic', id: 'three', method: 'invalid', input: {} });
    assert.equal(replies[2].error.code, 'DESKTOP_REQUEST_INVALID');
    assert.equal(replies[2].nonce, 'synthetic');
});

test('readiness output is bounded and exposes only safe locators, while reads do not invalidate review', () => {
    const { stop } = fixture({ sources: [{ type: 'worker', label: '会话', read: () => Array.from({ length: 100 }, () => ({
        count: 2, cwd: 'C:\\synthetic', sessionId: 'session-one', body: 'Synthetic private body', label: 'Private excerpt'
    })) }] });
    const snapshot = stop.snapshot();
    assert.equal(snapshot.blockers.length, 64);
    assert.equal(snapshot.blockers[0].sessionId, 'session-one');
    assert.equal(snapshot.blockers.at(-1).type, 'additional');
    assert.equal(JSON.stringify(snapshot).includes('Private'), false);
    const idle = fixture();
    const review = idle.stop.review({ action: 'stop' });
    for (let i = 0; i < 10; i++) assert.equal(idle.stop.snapshot().revision, review.revision);
    assert.equal(idle.stop.execute(confirmation(review.ticket)).accepted, true);
});
