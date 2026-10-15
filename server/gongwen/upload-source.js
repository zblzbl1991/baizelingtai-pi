// The official-document tool retains its DOCX-only contract.
const { uploadedSource } = require('../pi-document-source');
module.exports = { uploadedSource: (id, context, signal) => uploadedSource(id, context, signal, ['docx']) };
