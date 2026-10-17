'use strict';
const { fail } = require('./model');
// Allocation preflight for CFB and BIFF. SheetJS remains the actual XLS decoder.
// Every chain and declared stream size is checked before copying its bytes.
function preflightXls(bytes, limits) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), EOC = 0xfffffffe, FREE = 0xffffffff;
    const u16 = p => { if (p < 0 || p + 2 > bytes.length) fail('XLS 容器边界无效'); return v.getUint16(p, true); };
    const u32 = p => { if (p < 0 || p + 4 > bytes.length) fail('XLS 容器边界无效'); return v.getUint32(p, true); };
    if (![3, 4].includes(u16(26)) || u16(28) !== 0xfffe || u16(30) !== (u16(26) === 3 ? 9 : 12) || u16(32) !== 6 || u32(56) !== 4096) fail('不支持的 XLS CFB 容器');
    const sectorSize = 2 ** u16(30), sectorCount = bytes.length / sectorSize - 1;
    if (!Number.isInteger(sectorCount) || sectorCount < 2) fail('XLS 扇区边界无效');
    const sector = id => { if (!Number.isInteger(id) || id < 0 || id >= sectorCount) fail('XLS 扇区越界'); return (id + 1) * sectorSize; };
    const fatCount = u32(44), difatCount = u32(72), fatSectors = [], allocated = new Set();
    if (!fatCount || fatCount > sectorCount || difatCount > sectorCount || u32(64) > sectorCount) fail('XLS 分配表超过预算', 'OFFICE_WORKBOOK_LIMIT');
    const addFat = id => { if (id === FREE) return; sector(id); if (allocated.has(id) || fatSectors.length >= fatCount) fail('XLS FAT 重复'); allocated.add(id); fatSectors.push(id); };
    for (let i = 0; i < 109; i++) addFat(u32(76 + i * 4));
    let difat = u32(68); const difatSeen = new Set();
    for (let i = 0; i < difatCount; i++) {
        if (difatSeen.has(difat)) fail('XLS DIFAT 循环'); difatSeen.add(difat);
        const p = sector(difat); for (let j = 0; j < sectorSize / 4 - 1; j++) addFat(u32(p + j * 4)); difat = u32(p + sectorSize - 4);
    }
    if (fatSectors.length !== fatCount || difatCount && difat !== EOC) fail('XLS FAT 不完整');
    const next = id => { const table = fatSectors[Math.floor(id / (sectorSize / 4))]; if (table === undefined) fail('XLS FAT 缺失'); return u32(sector(table) + (id % (sectorSize / 4)) * 4); };
    const usedSectors = new Set();
    function chain(start, maxBytes, exact) {
        const result = [], seen = new Set(); let id = start;
        while (id !== EOC) {
            if (seen.has(id) || usedSectors.has(id) || allocated.has(id) || difatSeen.has(id)) fail('XLS 扇区链循环或重叠');
            sector(id); seen.add(id);
            if ((result.length + 1) * sectorSize > maxBytes + sectorSize - 1) fail('XLS 流超过预览预算', 'OFFICE_WORKBOOK_LIMIT');
            result.push(id); usedSectors.add(id); id = next(id);
        }
        if (exact !== undefined && result.length !== Math.ceil(exact / sectorSize)) fail('XLS 流长度不一致');
        return result;
    }
    function copy(sectors, size) {
        if (size > limits.maxPartBytes || size > bytes.length) fail('XLS 流超过预览预算', 'OFFICE_WORKBOOK_LIMIT');
        const out = new Uint8Array(size); let p = 0;
        for (const id of sectors) { const n = Math.min(sectorSize, size - p); if (n <= 0) break; out.set(bytes.subarray(sector(id), sector(id) + n), p); p += n; } return out;
    }
    const directorySectors = chain(u32(48), Math.min(limits.maxArchiveEntries * 128, limits.maxPartBytes));
    const entries = [], names = new Set(); let root;
    for (const id of directorySectors) for (let p = sector(id); p < sector(id) + sectorSize; p += 128) {
        const type = bytes[p + 66]; if (!type) continue;
        if (entries.length >= limits.maxArchiveEntries || ![1, 2, 5].includes(type)) fail('XLS 目录超过预算或无效', 'OFFICE_WORKBOOK_LIMIT');
        const length = u16(p + 64); if (length < 2 || length > 64 || length % 2) fail('XLS 目录名称无效');
        const name = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(p, p + length - 2));
        const size = u32(p + 120), high = u32(p + 124), start = u32(p + 116);
        if (high || size > limits.maxInputBytes || size > bytes.length) fail('XLS 流声明超过预览预算', 'OFFICE_WORKBOOK_LIMIT');
        const entry = { name, size, start, type }; entries.push(entry);
        if (type === 5) { if (root) fail('XLS 根目录重复'); root = entry; }
        if (/^(?:EncryptionInfo|EncryptedPackage)$/i.test(name)) fail('不支持加密的 XLS');
        if (/^(?:Workbook|Book)$/i.test(name)) { if (names.has('book')) fail('XLS 工作簿流重复'); names.add('book'); }
    }
    if (!root) fail('XLS 根目录缺失');
    const book = entries.find(e => e.type === 2 && /^(?:Workbook|Book)$/i.test(e.name)); if (!book) fail('XLS 工作簿流缺失');
    if (book.size > limits.maxPartBytes) fail('XLS 工作簿流超过预览预算', 'OFFICE_WORKBOOK_LIMIT');
    const streamChains = new Map();
    for (const entry of entries) if (entry.type === 5 || entry.type === 2 && entry.size >= 4096) streamChains.set(entry, chain(entry.start, limits.maxInputBytes, entry.size));
    const miniFatSectors = chain(u32(60), limits.maxPartBytes, u32(64) * sectorSize);
    const miniFat = copy(miniFatSectors, u32(64) * sectorSize), miniView = new DataView(miniFat.buffer), miniUsed = new Set();
    for (const entry of entries) if (entry.type === 2 && entry.size < 4096) {
        const seen = new Set(); let id = entry.start, count = 0;
        while (id !== EOC) { if (seen.has(id) || miniUsed.has(id) || id * 64 + 64 > root.size || id * 4 + 4 > miniFat.length || ++count > Math.ceil(entry.size / 64)) fail('XLS 小扇区链循环或越界'); seen.add(id); miniUsed.add(id); id = miniView.getUint32(id * 4, true); }
        if (count !== Math.ceil(entry.size / 64)) fail('XLS 小扇区流长度不一致');
    }
    let stream;
    if (book.size >= 4096) stream = copy(streamChains.get(book), book.size);
    else {
        const miniRoot = copy(streamChains.get(root), root.size);
        stream = new Uint8Array(book.size); const seen = new Set(); let id = book.start, offset = 0;
        while (id !== EOC) { if (seen.has(id) || id * 64 + 64 > miniRoot.length || id * 4 + 4 > miniFat.length || offset >= book.size) fail('XLS 小扇区链无效'); seen.add(id); const n = Math.min(64, book.size - offset); stream.set(miniRoot.subarray(id * 64, id * 64 + n), offset); offset += n; id = miniView.getUint32(id * 4, true); }
        if (offset !== book.size) fail('XLS 小扇区流不完整');
    }
    const data = new DataView(stream.buffer), word = p => data.getUint16(p, true), dword = p => data.getUint32(p, true);
    let biff = 8, current, area = 0, sheetCount = 0, cellCount = 0, styleCount = 0, events = 0;
    const finish = () => { if (current) { area += current.rows * current.columns; if (area > limits.maxCells) fail('XLS 矩形范围超过预览预算', 'OFFICE_WORKBOOK_LIMIT'); current = null; } };
    const grow = (rows, columns) => { if (!current) return; current.rows = Math.max(current.rows, rows); current.columns = Math.max(current.columns, columns); if (current.rows > limits.maxRows || current.columns > limits.maxColumns || area + current.rows * current.columns > limits.maxCells) fail('XLS 矩形范围超过预览预算', 'OFFICE_WORKBOOK_LIMIT'); };
    for (let p = 0; p + 4 <= stream.length;) {
        const id = word(p), size = word(p + 2), start = p + 4, end = start + size;
        if (!id && !size) break;
        if (end > stream.length || ++events > limits.maxXmlEvents) fail('XLS BIFF 记录边界无效');
        if (id === 0x0809) { if (size < 4) fail('XLS BOF 无效'); const version = word(start); if (![0x500, 0x600].includes(version)) fail('仅支持 BIFF5/8 XLS 工作簿'); biff = version === 0x600 ? 8 : 5; if (word(start + 2) === 0x10) { finish(); current = { rows: 1, columns: 1 }; } }
        if (id === 0xa) finish();
        if (id === 0x2f) fail('不支持加密 XLS');
        if (id === 0x85 && ++sheetCount > limits.maxSheets) fail('XLS 工作表数量超过预览预算', 'OFFICE_WORKBOOK_LIMIT');
        if ([0x31, 0xe0, 0x41e].includes(id) && ++styleCount > limits.maxStyles) fail('XLS 样式超过预览预算', 'OFFICE_WORKBOOK_LIMIT');
        if (id === 0xfc) { if (size < 8 || dword(start + 4) > limits.maxCells) fail('XLS 字符串数量超过预览预算', 'OFFICE_WORKBOOK_LIMIT'); }
        if (id === 0x200) { if (size < (biff === 8 ? 14 : 10)) fail('XLS 维度无效'); grow(biff === 8 ? dword(start + 4) : word(start + 2), word(start + (biff === 8 ? 10 : 6))); }
        if (current && [0x6, 0x203, 0x204, 0x205, 0x201, 0xfd, 0x27e, 0xd6].includes(id)) { if (size < 6) fail('XLS 单元格记录无效'); grow(word(start) + 1, word(start + 2) + 1); if (++cellCount > limits.maxCells) fail('XLS 单元格超过预览预算', 'OFFICE_WORKBOOK_LIMIT'); }
        if (id === 0x7d) { if (size < 12) fail('XLS 列信息无效'); grow(1, word(start + 2) + 1); }
        if (id === 0x208) { if (size < 16) fail('XLS 行信息无效'); grow(word(start) + 1, word(start + 4)); }
        if (id === 0xe5) { if (size < 2 || word(start) > limits.maxMerges || size !== 2 + word(start) * 8) fail('XLS 合并区域超过预算或无效', 'OFFICE_WORKBOOK_LIMIT'); for (let q = start + 2; q < end; q += 8) grow(word(q + 2) + 1, word(q + 6) + 1); }
        p = end;
    }
    finish(); if (!sheetCount) fail('XLS 没有工作表');
}
module.exports = { preflightXls };
