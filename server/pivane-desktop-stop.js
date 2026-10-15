const { randomUUID } = require('node:crypto');
const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });

// A reconstruction of owners' state, never a second task store. Reads are
// synchronous so the final reservation and eligibility check cannot interleave.
class DesktopStop {
    constructor({ maintenance, sources, scheduled = () => ({ futureCount: 0, latestCount: 0 }), now = Date.now, ttlMs = 60000 }) {
        Object.assign(this, { maintenance, sources, scheduled, now, ttlMs });
        this.generation = randomUUID(); this.tickets = new Map(); this.accepted = null;
    }
    snapshot(ownReservation = false) {
        let complete = Array.isArray(this.sources) && this.sources.length > 0;
        const blockers = [];
        for (const source of this.sources) {
            try {
                const value = source.read();
                const rows = Array.isArray(value) ? value : [{ count: value }];
                for (const row of rows) {
                    if (!Number.isSafeInteger(row.count) || row.count < 0) throw new Error('Unknown readiness');
                    if (!row.count) continue;
                    const item = { type: source.type, count: Math.min(100000, row.count), label: source.label };
                    if (typeof row.cwd === 'string' && row.cwd.length <= 2048 && !/[\u0000-\u001f]/.test(row.cwd)) item.cwd = row.cwd;
                    if (typeof row.sessionId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(row.sessionId)) item.sessionId = row.sessionId;
                    blockers.push(item);
                }
            } catch {
                complete = false;
                blockers.push({ type: 'unknown', count: 1, label: `${source.label}状态无法确认` });
            }
        }
        if (this.maintenance.activeMutations) blockers.push({ type: 'requests', count: this.maintenance.activeMutations, label: '工作台操作' });
        if ((this.maintenance.maintenanceLocked || this.maintenance.desktopStopping && !ownReservation) && !this.accepted) blockers.push({ type: 'maintenance', count: 1, label: '维护或启动检查' });
        let scheduled;
        try {
            scheduled = this.scheduled();
            if (!['futureCount', 'latestCount'].every(key => Number.isSafeInteger(scheduled?.[key]) && scheduled[key] >= 0 && scheduled[key] <= 100000)) throw new Error('Unknown schedule');
            scheduled = { futureCount: scheduled.futureCount, latestCount: scheduled.latestCount };
        } catch { complete = false; scheduled = { futureCount: 0, latestCount: 0 }; }
        if (blockers.length > 64) {
            const omitted = blockers.splice(63).reduce((sum, row) => sum + row.count, 0);
            blockers.push({ type: 'additional', count: Math.min(100000, omitted), label: '其他停机阻碍项' });
        }
        return { complete, revision: `${this.generation}:${this.maintenance.activityRevision}`, blockers, scheduled,
            ...(this.accepted ? { accepted: true, operationId: this.accepted.operationId } : {}) };
    }
    idle() { const state = this.snapshot(); return state.complete && !state.blockers.length; }
    review(input) {
        if (!['stop', 'exit'].includes(input?.action)) throw fail('DESKTOP_ACTION_INVALID', '停机操作无效');
        const state = this.snapshot();
        if (this.accepted || !state.complete || state.blockers.length) return state;
        for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= this.now()) this.tickets.delete(id);
        if (this.tickets.size >= 16) this.tickets.delete(this.tickets.keys().next().value);
        const ticket = randomUUID(), expiresAt = this.now() + this.ttlMs;
        this.tickets.set(ticket, { revision: state.revision, expiresAt, action: input.action });
        return { ...state, ticket, expiresAt };
    }
    execute(input) {
        if (input?.draftsSaved !== true || input.externalWritersStopped !== true
            || Object.keys(input).some(key => !['ticket', 'draftsSaved', 'externalWritersStopped'].includes(key)))
            throw fail('DESKTOP_CONFIRMATION_REQUIRED', '请确认已保存草稿并停止同一身份的外部写入');
        if (this.accepted) {
            if (input.ticket === this.accepted.ticket) return { accepted: true, operationId: this.accepted.operationId };
            throw fail('DESKTOP_ALREADY_STOPPING', '当前停机已经接受，请查询状态');
        }
        const ticket = this.tickets.get(input.ticket);
        if (!ticket || ticket.expiresAt <= this.now()) throw fail('DESKTOP_REVIEW_STALE', '停机确认已失效，请重新检查');
        if (this.maintenance.locked) { this.tickets.delete(input.ticket); throw fail('DESKTOP_BLOCKED', '实例正在维护，请稍后重新检查'); }
        // Reserve before calling any owner, with no await anywhere in this
        // transaction. Rejected reservations release only the desktop gate.
        this.maintenance.desktopStopping = true;
        try {
            const state = this.snapshot(true);
            if (ticket.revision !== state.revision) throw fail('DESKTOP_REVIEW_STALE', '工作状态已经变化，请重新检查');
            if (!state.complete || state.blockers.length) throw fail('DESKTOP_BLOCKED', '仍有工作或未知状态，请处理后重新检查');
            this.accepted = { ticket: input.ticket, operationId: randomUUID(), action: ticket.action };
            this.tickets.clear();
            return { accepted: true, operationId: this.accepted.operationId };
        } catch (error) {
            this.maintenance.desktopStopping = false; this.tickets.delete(input.ticket); throw error;
        }
    }
}
function receiveDesktopRequest({ message, maintenance, stop, send }) {
    if (!maintenance.managed || message?.nonce !== maintenance.nonce || message.type !== 'desktop-request') return false;
    if (typeof message.id !== 'string' || !message.id || message.id.length > 128) return true;
    const reply = { type: 'desktop-response', nonce: maintenance.nonce, id: message.id };
    try {
        if (!['snapshot', 'review', 'execute'].includes(message.method) || !message.input || typeof message.input !== 'object' || Array.isArray(message.input))
            throw fail('DESKTOP_REQUEST_INVALID', '桌面请求无效');
        reply.result = message.method === 'snapshot' ? stop.snapshot() : stop[message.method](message.input);
    } catch (error) {
        reply.error = /^DESKTOP_[A-Z_]+$/.test(error.code || '')
            ? { code: error.code, message: error.message.slice(0, 200) }
            : { code: 'DESKTOP_STATE_UNKNOWN', message: '无法确认服务状态，请重新检查' };
    }
    // A failed send does not undo an accepted stop. The caller can query its
    // operation identity instead of replaying a mutation.
    try { send(reply); } catch { /* The private transport is uncertain. */ }
    return true;
}
module.exports = { DesktopStop, receiveDesktopRequest };
