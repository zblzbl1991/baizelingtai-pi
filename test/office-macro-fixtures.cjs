// Independent harmless Word97 / MS-OVBA fixture authoring for security tests.
// This module performs no file writes and invokes no Office software or macros.
const path = require('node:path');

function createAutoOpenDoc(originalDoc, { markerPath, canaryRoot, CFB }) {
    if (!Buffer.isBuffer(originalDoc) || originalDoc.length > 1024 * 1024 || !CFB?.utils?.cfb_add) throw Error('A bounded synthetic DOC and CFB serializer are required');
    const root = path.resolve(canaryRoot), marker = path.resolve(markerPath);
    if (path.dirname(marker).toLowerCase() !== root.toLowerCase() || /[\x00-\x1f\x7f"]/.test(marker) || !/^[a-zA-Z0-9-]+\.txt$/.test(path.basename(marker))) throw Error('Marker must be an ASCII .txt filename in the caller-owned private canary directory');
    const forwardPath = marker.replaceAll('\\', '/');
    let markerExpression = '"' + forwardPath + '"';
    if (/[^\x20-\x7e]/.test(forwardPath)) {
        // Keep the MS-OVBA codepage1252 source ASCII. ChrW receives UTF16 code
        // units (including surrogate pairs) instead of silently replacing them.
        const terms = []; let literal = '';
        for (let index = 0; index < forwardPath.length; index++) {
            const unit = forwardPath.charCodeAt(index);
            if (unit <= 0x7e) literal += forwardPath[index];
            else { if (literal) { terms.push('"' + literal + '"'); literal = ''; } terms.push('ChrW(' + (unit > 0x7fff ? unit - 0x10000 : unit) + ')'); }
        }
        if (literal) terms.push('"' + literal + '"');
        markerExpression = '(' + terms.join(' & ') + ')';
    }
    const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
    const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
    const record = (id, data) => Buffer.concat([u16(id), u32(data.length), data]);
    const dual = (id, reserved, text) => Buffer.concat([record(id, Buffer.from(text, 'ascii')), record(reserved, Buffer.from(text, 'utf16le'))]);
    function compressedContainer(bytes) {
        // MS-OVBA2.4.1: one bounded compressed chunk, all-literal token sequences.
        if (bytes.length > 3000) throw Error('Only small synthetic macro sources are supported');
        const tokens = [];
        for (let n = 0; n < bytes.length; n += 8) tokens.push(Buffer.from([0]), bytes.subarray(n, n + 8));
        const chunk = Buffer.concat(tokens);
        return Buffer.concat([Buffer.from([1]), u16(0xb000 | (chunk.length - 1)), chunk]);
    }
    const source = `Attribute VB_Name = "Module1"\r\nOption Explicit\r\nPublic Sub AutoOpen()\r\n Dim handle As Integer\r\n handle = FreeFile\r\n Open ${markerExpression} For Output As #handle\r\n Print #handle, "PIVANE-SYNTHETIC-VBA-AUTOOPEN"\r\n Close #handle\r\nEnd Sub\r\n`;
    function moduleRecord(name, type) {
        return Buffer.concat([record(0x19, Buffer.from(name)), record(0x47, Buffer.from(name, 'utf16le')), dual(0x1a, 0x32, name), dual(0x1c, 0x48, ''), record(0x31, u32(0)), record(0x1e, u32(0)), record(0x2c, u16(0xffff)), record(type, Buffer.alloc(0)), record(0x2b, Buffer.alloc(0))]);
    }
    const information = Buffer.concat([record(1, u32(1)), record(2, u32(0x409)), record(0x14, u32(0x409)), record(3, u16(1252)), record(4, Buffer.from('PivaneMacroControl')), dual(5, 0x40, ''), dual(6, 0x3d, ''), record(7, u32(0)), record(8, u32(0)), u16(9), u32(4), u32(1), u16(0), dual(0xc, 0x3c, '')]);
    const directory = Buffer.concat([information, record(0xf, u16(2)), record(0x13, u16(0xffff)), moduleRecord('Module1', 0x21), moduleRecord('ThisDocument', 0x22), record(0x10, Buffer.alloc(0))]);
    const project = 'ID="{00000000-0000-4000-8000-000000000001}"\r\nModule=Module1\r\nDocument=ThisDocument/&H00000000\r\nName="PivaneMacroControl"\r\nHelpContextID="0"\r\nVersionCompatible32="393222000"\r\n[Host Extender Info]\r\n&H00000001={3832D640-CF90-11CF-8E43-00A0C911005A};VBE;&H00000000\r\n[Workspace]\r\nModule1=0, 0, 0, 0, C\r\n';
    const ole = CFB.read(originalDoc, { type: 'buffer' });
    if (ole.FullPaths.some(name => /\/VBA\/|\/Macros\//i.test(name))) throw Error('Input must be the known macro-free synthetic DOC');
    const streams = [
        ['PROJECT', Buffer.from(project)],
        ['PROJECTwm', Buffer.concat([Buffer.from('Module1\0'), Buffer.from('Module1\0', 'utf16le'), Buffer.from([0, 0])])],
        ['VBA/dir', compressedContainer(directory)],
        ['VBA/_VBA_PROJECT', Buffer.concat([u16(0x61cc), u16(0xffff), Buffer.alloc(3)])],
        ['VBA/Module1', compressedContainer(Buffer.from(source, 'ascii'))],
        ['VBA/ThisDocument', compressedContainer(Buffer.from('Attribute VB_Name = "ThisDocument"\r\nOption Explicit\r\n', 'ascii'))]
    ];
    for (const [name, bytes] of streams) CFB.utils.cfb_add(ole, 'Macros/' + name, bytes);
    return { bytes: CFB.write(ole, { type: 'buffer' }), source, markerPath: marker };
}
module.exports = { createAutoOpenDoc };
