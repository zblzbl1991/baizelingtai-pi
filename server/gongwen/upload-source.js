const { createHash } = require('node:crypto');
const { references, marker } = require('../../public/pi-document-references');
const { fail } = require('../pi-file-scope');
const { MAX_FILE } = require('./limits');
async function uploadedSource(id, context, signal) {
    const origin = process.env.PI_WORKSPACE_INTERNAL_ORIGIN, url = new URL('/api/pi/uploads/read', origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Invalid document service origin');
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.PI_WEB_NAVIGATION_TOKEN}` },
        body: JSON.stringify({ id, action: 'source' }) });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > Math.ceil(MAX_FILE / 3) * 4 + 8192) throw fail('公文原件传输超过预算', 413, 'GONGWEN_LIMIT');
        chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok) throw fail(result.error || '无法读取公文原件', response.status, result.code || 'DOCUMENT_SCOPE');
    const bytes = Buffer.from(result.base64 || '', 'base64'), ref = result.reference;
    if (!ref || ref.id !== id || ref.format !== 'docx' || result.encoding !== 'base64' || !bytes.length || bytes.length > MAX_FILE
        || bytes.length !== ref.size || bytes.toString('base64') !== result.base64
        || createHash('sha256').update(bytes).digest('hex') !== ref.revision) throw fail('公文原件传输校验失败', 409, 'DOCUMENT_CHANGED');
    const check = () => {
        if (!references(context.sessionManager.getBranch()).some(item => marker(item) === marker(ref))) throw fail('公文原件不属于当前会话分支', 403, 'DOCUMENT_SCOPE');
    };
    check(); return { bytes, reference: ref, check };
}
module.exports = { uploadedSource };
