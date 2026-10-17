'use strict';
const { parseWorkbook } = require('./parse');
self.onmessage = event => {
    const { id, bytes, format } = event.data || {};
    try { self.postMessage({ id, ok: true, workbook: parseWorkbook(bytes, format) }); }
    catch (error) { self.postMessage({ id, ok: false, error: { code: error.code || 'OFFICE_WORKBOOK_INVALID', message: error.code?.startsWith('OFFICE_WORKBOOK_') ? error.message : '工作簿无法预览，请下载原件。' } }); }
};
