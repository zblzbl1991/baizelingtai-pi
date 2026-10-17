'use strict';
const { OfficePreviewSources } = require('./pi-office-preview-sources');
const { OfficePreviewService } = require('./pi-office-previews');
const ERRORS = {
    OFFICE_SOURCE_CHANGED: [409, '原件或来源资格已变化，请重新打开'], OFFICE_LIMIT: [413, '办公文件超过预览限制，请下载原件'],
    OFFICE_INVALID: [415, '办公文件损坏、加密或内容与扩展名不符'], OFFICE_BUSY: [429, '办公文件预览繁忙，请稍后重试'],
    OFFICE_UNAVAILABLE: [503, '办公文件预览组件暂不可用，请稍后重试'], OFFICE_TIMEOUT: [504, '办公文件预览超时，请重试'],
    OFFICE_SCOPE: [403, '无权访问此办公文件来源'], OFFICE_MISSING: [404, '办公文件来源不存在或链接已失效']
};
function projectError(error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { status: 404, code: 'OFFICE_MISSING', message: ERRORS.OFFICE_MISSING[1] };
    if (['EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return { status: 403, code: 'OFFICE_SCOPE', message: ERRORS.OFFICE_SCOPE[1] };
    let code = error.code;
    if (!Object.hasOwn(ERRORS, code)) code = error.status === 403 ? 'OFFICE_SCOPE' : error.status === 404 ? 'OFFICE_MISSING'
        : error.status === 409 ? 'OFFICE_SOURCE_CHANGED' : error.status === 413 ? 'OFFICE_LIMIT'
            : [400, 415].includes(error.status) ? 'OFFICE_INVALID' : error.status === 429 ? 'OFFICE_BUSY' : error.status === 504 ? 'OFFICE_TIMEOUT' : 'OFFICE_UNAVAILABLE';
    const [status, message] = ERRORS[code]; return { status, code, message };
}
function mountOfficePreviews(router, options) {
    const service = options.service || new OfficePreviewService({ sources: new OfficePreviewSources({ ...options, limits: require('../config/office-preview.json').conversion }),
        engine: options.engine || require('./office-preview/engine').createOfficePreviewEngine(), isSuspended: options.isSuspended });
    router.post('/office/preview', async (req, res) => {
        const controller = new AbortController(), cancel = () => { if (!res.writableFinished) controller.abort(); };
        res.once('close', cancel);
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' });
        try { const data = await service.preview(req.body, controller.signal); if (!controller.signal.aborted) res.json(data); }
        catch (e) { if (!controller.signal.aborted) { const error = projectError(e); res.status(error.status).json({ error: error.message, code: error.code }); } }
        finally { res.removeListener('close', cancel); }
    });
    return service;
}
module.exports = { mountOfficePreviews, projectError };
