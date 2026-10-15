'use strict';
// Mounted only behind the workspace authentication + Origin middleware.
function mountStaffingRoutes(router, service, { resolveSource } = {}) {
    const route = action => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            if (!['open', 'cookie', 'token'].includes(req.workspaceIdentity?.kind)) throw Object.assign(new Error('Staffing confirmation requires the workspace page'), { status: 403 });
            res.json(await action(req));
        } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
    };
    router.get('/staffing/status', route(() => service.status()));
    router.get('/staffing/ledger', route(() => service.ledger()));
    router.get('/staffing/operations/:requestId', route(req => service.operation(req.params.requestId)));
    router.post('/staffing/enable', route(req => service.enable(req.body)));
    router.post('/staffing/initialize', route(req => service.initialize(req.body)));
    router.post('/staffing/confirm-initial', route(req => service.confirmInitial(req.body)));
    router.post('/staffing/disable', route(req => service.disable(req.body)));
    const sourceForPage = async req => {
        if (!resolveSource) throw Object.assign(new Error('Staffing source resolution unavailable'), { status: 503 });
        return resolveSource(req.method === 'GET' ? req.query : req.body.source);
    };
    const pageInput = req => {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new Error('Invalid staffing page request');
        const { source: _source, ...input } = req.body; return input;
    };
    router.get('/staffing/plans/:planId', route(async req => service.plan(req.params.planId, await sourceForPage(req))));
    router.post('/staffing/revise', route(async req => service.revisePlan(pageInput(req), await sourceForPage(req))));
    router.post('/staffing/commit', route(async req => service.commitPlan(pageInput(req), await sourceForPage(req))));
    for (const action of ['query', 'prepare', 'operation']) router.post('/staffing/agent/' + action, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const worker = req.workspaceIdentity?.kind === 'agent-thread' && req.workspaceIdentity.worker;
            if (!worker || !resolveSource) throw Object.assign(new Error('Private staffing worker authentication required'), { status: 403 });
            const source = await resolveSource({ cwd: worker.cwd, sessionId: worker.sessionId }, worker);
            if (action === 'operation') {
                if (!req.body || Object.keys(req.body).some(key => key !== 'requestId')) throw new Error('Invalid staffing operation query');
                res.json(await service.operationForSource(req.body.requestId, source));
            } else res.json(await service[action === 'prepare' ? 'prepareChange' : 'query'](req.body, source));
        } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
    });
}
module.exports = { mountStaffingRoutes };
