'use strict';
// Mounted only behind the workspace authentication + Origin middleware.
function mountStaffingRoutes(router, service) {
    const route = action => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            if (req.workspaceIdentity?.kind === 'agent-thread') throw Object.assign(new Error('Staffing setup requires the workspace page'), { status: 403 });
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
}
module.exports = { mountStaffingRoutes };
