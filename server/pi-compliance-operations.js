const { fail } = require('./pi-compliance-ledger');
// Own actual material I/O, independently of short ledger mutations. A timeout,
// HTTP disconnect or disabled switch never releases an accepted operation.
class ComplianceOperations {
    constructor(service) { this.service = service; this.jobs = new Map(); this.stopping = false; }
    run(key, action) {
        if (this.stopping || this.service.closed || this.service.closing || this.service.isSuspended() || this.jobs.has(key) || this.jobs.size >= 4)
            throw fail('资料正在处理或工作台维护中', 409, 'COMPLIANCE_BUSY');
        const operation = { key, stopped: false }; this.jobs.set(key, operation);
        operation.promise = Promise.resolve().then(() => action(operation)).finally(() => this.jobs.delete(key));
        return operation.promise;
    }
    stopImports() { for (const operation of this.jobs.values()) if (operation.key.startsWith('import:')) operation.stopped = true; }
    check(operation) {
        if (operation.stopped || this.stopping || this.service.closed || this.service.isSuspended())
            throw fail('资料导入已按停用或维护请求停止，未发布本次选择的资料', 409, 'COMPLIANCE_STOPPED');
    }
    async dispose() { this.stopping = true; this.stopImports(); await Promise.allSettled([...this.jobs.values()].map(job => job.promise)); }
}
module.exports = { ComplianceOperations };
