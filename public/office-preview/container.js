'use strict';
const { Inflate } = require('fflate');
const sax = require('sax');
const { fail } = require('./model');
const decoder = new TextDecoder('utf-8', { fatal: true });
function partPath(name) {
    if (typeof name !== 'string' || !name || name.length > 1024 || /[\\\x00-\x20?#%:]/.test(name) || name.startsWith('/')) fail('无效的 OPC 部件路径');
    const parts = [];
    for (const piece of name.split('/')) {
        if (piece === '..') { if (!parts.length) fail('OPC 关系越界'); parts.pop(); }
        else if (piece !== '.' && piece !== '') parts.push(piece);
        else if (piece === '') fail('无效的 OPC 部件路径');
    }
    if (!parts.length) fail('无效的 OPC 部件路径');
    return parts.join('/');
}
function crcUpdate(crc, bytes) {
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    return crc >>> 0;
}
function archive(bytes, limits) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), length = bytes.length;
    const u16 = offset => { if (offset < 0 || offset + 2 > length) fail('ZIP 边界无效'); return view.getUint16(offset, true); };
    const u32 = offset => { if (offset < 0 || offset + 4 > length) fail('ZIP 边界无效'); return view.getUint32(offset, true); };
    let end = length - 22;
    while (end >= Math.max(0, length - 65557) && (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== length)) end--;
    if (end < Math.max(0, length - 65557)) fail('不是有效的 XLSX ZIP 容器');
    const count = u16(end + 10), central = u32(end + 16), centralSize = u32(end + 12);
    if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count || count === 65535 || central === 0xffffffff || centralSize === 0xffffffff) fail('不支持 ZIP64 或多卷 ZIP');
    if (!count || count > limits.maxArchiveEntries || central + centralSize !== end) fail('ZIP 条目或目录超过预览限制', 'OFFICE_WORKBOOK_LIMIT');
    const entries = new Map(), intervals = []; let offset = central, declared = 0, actual = 0;
    for (let i = 0; i < count; i++) {
        if (u32(offset) !== 0x02014b50 || offset + 46 > end) fail('ZIP 目录损坏');
        const flags = u16(offset + 8), method = u16(offset + 10), crc = u32(offset + 16), packed = u32(offset + 20), size = u32(offset + 24), nl = u16(offset + 28), el = u16(offset + 30), cl = u16(offset + 32), local = u32(offset + 42);
        const next = offset + 46 + nl + el + cl;
        if (next > end || !nl || u16(offset + 34) || flags & 0x2041 || ![0, 8].includes(method) || packed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) fail('不支持加密或异常 ZIP 条目');
        let extra = offset + 46 + nl;
        while (extra < offset + 46 + nl + el) { const tag = u16(extra), n = u16(extra + 2); if (tag === 1 || extra + 4 + n > offset + 46 + nl + el) fail('不支持 ZIP64 或损坏扩展字段'); extra += 4 + n; }
        const rawName = bytes.subarray(offset + 46, offset + 46 + nl), decoded = decoder.decode(rawName);
        const directory = decoded.endsWith('/'), name = partPath(directory ? decoded.slice(0, -1) : decoded);
        if (directory && (size || packed)) fail('ZIP 目录包含异常数据');
        if (entries.has(name)) fail('ZIP 包含重复部件');
        if (size > limits.maxPartBytes || (declared += size) > limits.maxExpandedBytes) fail('ZIP 声明展开量超过预览预算', 'OFFICE_WORKBOOK_LIMIT');
        if (u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method || u16(local + 26) !== nl) fail('ZIP 本地条目不一致');
        const start = local + 30 + nl + u16(local + 28), stop = start + packed;
        let localExtra = local + 30 + nl;
        while (localExtra < start) { const tag = u16(localExtra), n = u16(localExtra + 2); if (tag === 1 || localExtra + 4 + n > start) fail('不支持 ZIP64 或损坏本地扩展字段'); localExtra += 4 + n; }
        if (stop > central || start < local || local >= central || decoder.decode(bytes.subarray(local + 30, local + 30 + nl)) !== decoded) fail('ZIP 本地条目越界');
        if (!(flags & 8) && (u32(local + 14) !== crc || u32(local + 18) !== packed || u32(local + 22) !== size)) fail('ZIP 本地大小或 CRC 不一致');
        let entryEnd = stop;
        if (flags & 8) { const descriptor = u32(stop) === 0x08074b50 ? stop + 4 : stop; if (descriptor + 12 > central || u32(descriptor) !== crc || u32(descriptor + 4) !== packed || u32(descriptor + 8) !== size) fail('ZIP 数据描述符不一致'); entryEnd = descriptor + 12; }
        intervals.push([local, entryEnd]); entries.set(name, { start, stop, method, crc, size, used: false, directory }); offset = next;
    }
    if (offset !== end) fail('ZIP 目录长度不一致');
    intervals.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < intervals.length; i++) if (intervals[i][0] < intervals[i - 1][1]) fail('ZIP 条目重叠');
    function read(name, consume) {
        const entry = entries.get(name); if (!entry || entry.directory || entry.used) fail('OPC 部件缺失或重复读取');
        entry.used = true; let size = 0, crc = 0xffffffff;
        const output = chunk => {
            if ((size += chunk.length) > limits.maxPartBytes || size > entry.size || (actual += chunk.length) > limits.maxExpandedBytes) fail('ZIP 实际展开量超过预览预算', 'OFFICE_WORKBOOK_LIMIT');
            crc = crcUpdate(crc, chunk); consume?.(chunk);
        };
        if (entry.method === 0) {
            for (let p = entry.start; p < entry.stop; p += 1024) output(bytes.subarray(p, Math.min(entry.stop, p + 1024)));
        } else {
            // Small compressed chunks bound fflate's transient output before our callback.
            const inflate = new Inflate(output);
            if (entry.start === entry.stop) inflate.push(new Uint8Array(), true);
            for (let p = entry.start; p < entry.stop; p += 128) inflate.push(bytes.subarray(p, Math.min(entry.stop, p + 128)), p + 128 >= entry.stop);
        }
        if (size !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail('ZIP CRC 或实际大小不一致');
    }
    return { entries, read, finish() { for (const [name, entry] of entries) if (!entry.used && !entry.directory) read(name); } };
}
function xmlReader(zip, limits) {
    let events = 0;
    return function xml(name, namespace, handlers = {}) {
        const parser = sax.parser(true, { xmlns: true, trim: false, normalize: false, strictEntities: true });
        let depth = 0, root = false, decoder, prefix = new Uint8Array(), textLength = 0;
        const event = () => { if (++events > limits.maxXmlEvents) fail('XML 事件超过预览预算', 'OFFICE_WORKBOOK_LIMIT'); };
        parser.ondoctype = parser.onsgmldeclaration = () => fail('不支持 DTD 或实体声明');
        parser.onerror = () => fail('Office XML 无效');
        parser.onopentag = tag => {
            event(); if (++depth > limits.maxDepth || Object.keys(tag.attributes).length > 64) fail('XML 深度或属性超过预览预算', 'OFFICE_WORKBOOK_LIMIT');
            if (!root) { root = true; if (!namespace.includes(tag.uri)) fail('未知的 Office XML 命名空间'); handlers.root?.(tag); }
            if (!namespace.includes(tag.uri)) fail('未知的 Office XML 命名空间');
            const attrs = Object.create(null);
            for (const a of Object.values(tag.attributes)) { if (a.value.length > limits.maxTextLength) fail('XML 属性超过预算', 'OFFICE_WORKBOOK_LIMIT'); attrs[a.name] = a.value; if (!a.prefix) attrs[a.local] = a.value; }
            handlers.open?.(tag.local, attrs, tag); textLength = 0;
        };
        const ontext = text => { event(); if ((textLength += text.length) > limits.maxTextLength) fail('XML 文字超过预算', 'OFFICE_WORKBOOK_LIMIT'); handlers.text?.(text); };
        parser.ontext = parser.oncdata = ontext;
        parser.onclosetag = () => { event(); handlers.close?.(); depth--; textLength = 0; };
        zip.read(name, chunk => {
            if (!decoder) {
                const combined = new Uint8Array(prefix.length + chunk.length); combined.set(prefix); combined.set(chunk, prefix.length); prefix = combined;
                if (prefix.length < 4) return;
                const encoding = prefix[0] === 0xff && prefix[1] === 0xfe || prefix[0] === 0x3c && prefix[1] === 0 ? 'utf-16le' : prefix[0] === 0xfe && prefix[1] === 0xff || prefix[0] === 0 && prefix[1] === 0x3c ? 'utf-16be' : 'utf-8';
                decoder = new TextDecoder(encoding, { fatal: true }); parser.write(decoder.decode(prefix, { stream: true })); prefix = null;
            } else parser.write(decoder.decode(chunk, { stream: true }));
        });
        if (!decoder) fail('Office XML 为空');
        parser.write(decoder.decode()).close(); if (!root || depth) fail('Office XML 不完整');
    };
}
module.exports = { archive, xmlReader, partPath };
