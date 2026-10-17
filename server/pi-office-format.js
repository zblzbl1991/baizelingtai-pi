'use strict';
const { fail } = require('./pi-file-scope');
const { officeZip, xml, xmlNamespace: namespace, officeMainPart } = require('./pi-document-parser');
const invalid = () => fail('办公文件损坏、加密或内容与扩展名不符', 415, 'OFFICE_INVALID');
const children = node => node.children.filter(v => typeof v !== 'string');
function compound(bytes, limits) {
    if (bytes.length < 512 || !bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')) || bytes.readUInt16LE(28) !== 0xfffe) throw invalid();
    const major = bytes.readUInt16LE(26), shift = bytes.readUInt16LE(30), miniShift = bytes.readUInt16LE(32);
    if (!(major === 3 && shift === 9 || major === 4 && shift === 12) || miniShift !== 6) throw invalid();
    const sectorSize = 2 ** shift, sectors = bytes.length / sectorSize - 1, END = 0xfffffffe, FREE = 0xffffffff;
    if (!Number.isInteger(sectors) || sectors < 1 || bytes.readUInt32LE(56) !== 4096) throw invalid();
    const sector = id => { if (!Number.isInteger(id) || id < 0 || id >= sectors) throw invalid(); return bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize); };
    const fatIds = [], occupied = new Set();
    const append = id => { if (id !== FREE) { sector(id); if (occupied.has(id)) throw invalid(); occupied.add(id); fatIds.push(id); } };
    for (let i = 0; i < 109; i++) append(bytes.readUInt32LE(76 + i * 4));
    let difat = bytes.readUInt32LE(68), difatCount = bytes.readUInt32LE(72);
    if (difatCount > sectors) throw invalid();
    for (let i = 0; i < difatCount; i++) { if (occupied.has(difat)) throw invalid(); occupied.add(difat); const data = sector(difat); for (let at = 0; at < sectorSize - 4; at += 4) append(data.readUInt32LE(at)); difat = data.readUInt32LE(sectorSize - 4); }
    if (difatCount && difat !== END || fatIds.length !== bytes.readUInt32LE(44) || !fatIds.length) throw invalid();
    const fat = fatIds.flatMap(id => { const data = sector(id); return Array.from({ length: sectorSize / 4 }, (_, i) => data.readUInt32LE(i * 4)); });
    const chain = (start, table, read, max = sectors) => {
        const list = [], seen = new Set(); let at = start;
        while (at !== END) { if (!Number.isInteger(at) || at < 0 || at >= table.length || seen.has(at) || seen.size >= max) throw invalid(); seen.add(at); list.push(read(at)); at = table[at]; }
        return Buffer.concat(list);
    };
    const directory = chain(bytes.readUInt32LE(48), fat, sector), entries = new Map(); let root;
    if (directory.length / 128 > (limits?.maxArchiveEntries ?? 4096)) throw fail('Office 内部条目超过预算', 413, 'OFFICE_LIMIT');
    for (let at = 0; at < directory.length; at += 128) {
        const type = directory[at + 66]; if (!type) continue;
        const length = directory.readUInt16LE(at + 64); if (![1, 2, 5].includes(type) || length < 2 || length > 64 || length % 2 || directory.readUInt16LE(at + length - 2)) throw invalid();
        const name = directory.toString('utf16le', at, at + length - 2), size = directory.readBigUInt64LE(at + 120);
        if (size > BigInt(bytes.length) || /[\x00-\x1f]/.test(name.replace(/^[\x01-\x06]/, ''))) throw invalid();
        const entry = { name, type, size: Number(size), start: directory.readUInt32LE(at + 116) };
        if (type === 5) { if (root) throw invalid(); root = entry; }
        else if (type === 2) { if (entries.has(name.toLowerCase())) throw invalid(); entries.set(name.toLowerCase(), entry); }
    }
    if (!root) throw invalid();
    const miniCount = bytes.readUInt32LE(64); if (miniCount > sectors) throw invalid();
    const miniBytes = miniCount ? chain(bytes.readUInt32LE(60), fat, sector) : Buffer.alloc(0);
    if (miniBytes.length !== miniCount * sectorSize) throw invalid();
    const miniFat = Array.from({ length: miniBytes.length / 4 }, (_, i) => miniBytes.readUInt32LE(i * 4));
    const rootBytes = root.size ? chain(root.start, fat, sector).subarray(0, root.size) : Buffer.alloc(0);
    const read = name => {
        const entry = entries.get(name.toLowerCase()); if (!entry) throw invalid();
        if (!entry.size) return Buffer.alloc(0);
        const data = entry.size < 4096 ? chain(entry.start, miniFat, id => { const at = id * 64; if (at + 64 > rootBytes.length) throw invalid(); return rootBytes.subarray(at, at + 64); }, Math.ceil(bytes.length / 64)) : chain(entry.start, fat, sector);
        if (data.length < entry.size || data.length >= entry.size + (entry.size < 4096 ? 64 : sectorSize)) throw invalid();
        return data.subarray(0, entry.size);
    };
    return { entries, read };
}
function validateOfficeFormat(bytes, format, limits) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || !['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(format)) throw invalid();
    if (limits && bytes.length > limits.maxSourceBytes) throw fail('办公文件超过预览预算', 413, 'OFFICE_LIMIT');
    try {
        if (format.endsWith('x')) {
            const zip = officeZip(bytes, { ...limits, maxPartBytes: limits?.maxUncompressedBytes });
            officeMainPart(zip, format);
            for (const name of zip.names) {
                if (name.endsWith('/')) continue;
                if (/vbaProject|encryption/i.test(name)) throw invalid();
                const data = zip.read(name); // CRC and actual expanded length, not just directory claims.
                if (/\.(?:xml|rels)$/i.test(name)) {
                    const node = xml(data);
                    if (/\.rels$/i.test(name)) {
                        const ns = namespace(node);
                        if (node.name !== 'Relationships' || ns.uri !== 'http://schemas.openxmlformats.org/package/2006/relationships'
                            || children(node).some(n => n.name !== 'Relationship' || namespace(n, ns.bindings).uri !== ns.uri)) throw invalid();
                        if (format !== 'xlsx' && children(node).some(n => n.attrs.TargetMode === 'External' || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(n.attrs.Target || ''))) throw invalid();
                    }
                }
            }
        } else {
            const cfb = compound(bytes, limits);
            if ([...cfb.entries.keys()].some(n => /encrypt|vba|_vba_project/i.test(n))) throw invalid();
            let expanded = 0;
            for (const entry of cfb.entries.values()) {
                expanded += entry.size;
                if (expanded > (limits?.maxUncompressedBytes ?? bytes.length)) throw fail('Office 内部流超过读取预算', 413, 'OFFICE_LIMIT');
                cfb.read(entry.name);
            }
            const kinds = [cfb.entries.has('worddocument'), cfb.entries.has('workbook') || cfb.entries.has('book'), cfb.entries.has('powerpoint document')];
            if (kinds.filter(Boolean).length !== 1 || !kinds[['doc', 'xls', 'ppt'].indexOf(format)]) throw invalid();
            if (format === 'doc') {
                const data = cfb.read('WordDocument'); if (data.length < 32 || data.readUInt16LE(0) !== 0xa5ec || data.readUInt16LE(10) & 0x8100) throw invalid();
                const table = data.readUInt16LE(10) & 0x200 ? '1Table' : '0Table'; if (!cfb.entries.has(table.toLowerCase())) throw invalid(); cfb.read(table);
            } else if (format === 'xls') {
                const data = cfb.read(cfb.entries.has('workbook') ? 'Workbook' : 'Book');
                if (data.length < 8 || ![0x0009, 0x0209, 0x0409, 0x0809].includes(data.readUInt16LE(0))) throw invalid();
                let at = 0; while (at + 4 <= data.length) { const id = data.readUInt16LE(at), size = data.readUInt16LE(at + 2); if (id === 0x002f || at + 4 + size > data.length) throw invalid(); at += 4 + size; }
                if (at !== data.length) throw invalid();
            } else {
                const data = cfb.read('PowerPoint Document'), user = cfb.read('Current User');
                if (data.length < 8 || user.length < 20 || data.readUInt32LE(4) > data.length - 8 || user.readUInt32LE(12) !== 0xe391c05f) throw invalid();
            }
        }
        return { format };
    } catch (e) { if (e.code === 'OFFICE_LIMIT' || e.status === 413) throw fail('Office 内容超过预览预算', 413, 'OFFICE_LIMIT'); throw invalid(); }
}
module.exports = { validateOfficeFormat };
