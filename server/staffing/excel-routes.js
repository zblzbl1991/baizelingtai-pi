'use strict';
const express = require('express');
const { fail, keys } = require('./validation');
function mountStaffingExcelRoutes(router, excel, { resolveSource } = {}) {
    const route = (action, agent = false) => async (req, res) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        try {
            let source;
            if (agent) {
                const worker = req.workspaceIdentity?.kind === 'agent-thread' && req.workspaceIdentity.worker;
                if (!worker || !resolveSource) fail('Private staffing worker authentication required', 403);
                source = await resolveSource({ cwd: worker.cwd, sessionId: worker.sessionId }, worker);
            } else {
                if (!['open', 'cookie', 'token'].includes(req.workspaceIdentity?.kind)) fail('Staffing Excel requires the workspace page', 403);
                source = await excel.staffing.pageSource({ phase: 'initial' });
            }
            await action(req, res, source);
        } catch (error) { if (!res.headersSent) res.status(error.status || 500).json({ error: error.status ? error.message : 'Staffing Excel outcome requires review', code: error.code }); }
    };
    router.get('/staffing/excel/template', route(async (_req, res) => {
        const data = { people: [{ id: 'P001', name: '示例直签人员', department: '示例事业部', direct: true }, { id: 'P002', name: '示例人员', department: '示例事业部', direct: false }],
            projects: [{ id: 'J001', name: '示例项目', department: '示例事业部', owner: '示例负责人', start: '2026-11-01', end: '2026-11-05', minimum: 2 }],
            occupancies: [{ id: 'A001', personId: 'P001', projectId: 'J001', kind: 'project', state: 'reserved', start: '2026-11-01', end: '2026-11-05' }, { id: 'L001', personId: 'P002', kind: 'training', state: 'confirmed', start: '2026-10-21', end: '2026-10-21', reason: '示例培训' }], historyComplete: false };
        res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="staffing-template.xlsx"' }); res.send(excel.workbook(data, { revision: 0 }));
    }));
    router.post('/staffing/excel/uploads', route(async (req, res, source) => {
        keys(req.query, ['requestId']); const release = excel.beginReceive();
        try {
            if (!req.is('application/octet-stream')) fail('Excel upload requires application/octet-stream', 415);
            await new Promise((resolve, reject) => express.raw({ type: 'application/octet-stream', limit: '20mb', inflate: false })(req, res, error => error ? reject(error) : resolve()));
            if (!Buffer.isBuffer(req.body)) fail('Excel upload is empty'); res.json(await excel.upload(req.body, req.query, source));
        } finally { release(); }
    }));
    router.post('/staffing/excel/import', route(async (req, res, source) => res.json(await excel.staffing.prepareImport(req.body, source))));
    router.get('/staffing/excel/uploads/:requestId', route(async (req, res, source) => res.json(await excel.uploadStatus(req.params.requestId, source))));
    router.post('/staffing/excel/export', route(async (req, res, source) => res.json(await excel.export(req.body, source))));
    router.get('/staffing/excel/operations/:requestId', route(async (req, res, source) => res.json(await excel.operation(req.params.requestId, source))));
    router.get('/staffing/excel/exports/:exportId', route(async (req, res) => {
        const record = await excel.record(req.params.exportId), source = await excel.source({ exportId: record.exportId, revision: record.sha256 });
        res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${record.name}"`, 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' }); res.send(source.bytes);
    }));
    router.post('/staffing/agent/export', route(async (req, res, source) => res.json(await excel.export(req.body, source)), true));
    router.post('/staffing/agent/export-status', route(async (req, res, source) => { keys(req.body, ['requestId']); res.json(await excel.operation(req.body.requestId, source)); }, true));
    router.post('/staffing/agent/ledger-status', route(async (req, res, source) => {
        keys(req.body, []); const state = await excel.staffing.requireSource(source);
        res.json({ revision: state.revision, historyComplete: state.historyComplete, counts: { people: state.people.length, projects: state.projects.length, occupancies: state.occupancies.length } });
    }, true));
    router.post('/staffing/agent/import', route(async (req, res, source) => {
        excel.staffing.validateRequest(req.body, ['attachmentId']);
        if (!excel.documents) fail('Document source is unavailable', 503);
        const input = { cwd: source.cwd, sessionId: source.sessionId, id: req.body.attachmentId }, object = await excel.documents.authorized(input);
        if (object.reference.format !== 'xlsx') fail('A standard Excel attachment is required');
        const uploaded = await excel.upload(object.bytes, { requestId: req.body.requestId }, source);
        await excel.documents.checkCurrent(input, object);
        res.json(await excel.staffing.prepareImport({ requestId: req.body.requestId, expectedRevision: req.body.expectedRevision, uploadId: uploaded.id }, source));
    }, true));
}
module.exports = { mountStaffingExcelRoutes };
