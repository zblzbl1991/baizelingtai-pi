// One isolated, bounded parser process per request. Never open a caller-supplied path.
const { parseDocument } = require('./pi-document-parser');
process.once('message', async ({ bytes, format, input, validateOnly, render, mode }) => {
    try { process.send({ result: render ? await require('./pi-compliance-render').render(bytes, format, input) : mode === 'staffing-xlsx' ? require('./staffing/excel-parser').parseWorkbook(bytes) : await parseDocument(bytes, format, input, validateOnly) }, () => process.disconnect()); }
    catch (error) { process.send({ error: error.message, status: error.status || 415, code: error.code || 'DOCUMENT_FORMAT' }, () => process.disconnect()); }
});
