// Synthetic PDF with real Unicode text mapping and page rotation; no provider/OCR.
function labeledPdf(lines, rotation = 0) {
    const hex = value => [...value].map(c => c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
    const codes = [...new Set(lines.flatMap(line => [...line.text]))].map(c => c.charCodeAt(0).toString(16).padStart(4,'0'));
    const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Fixture def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange ${codes.length} beginbfchar\n${codes.map(code => `<${code}> <${code}>`).join('\n')}\nendbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
    const stream = lines.map(line => `BT /F1 12 Tf ${line.x ?? 40} ${line.y ?? 760} Td <${hex(line.text)}> Tj ET`).join('\n');
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Rotate ${rotation} /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>`,
        '<< /Type /Font /Subtype /Type0 /BaseFont /Fixture /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>',
        '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Fixture /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 /FontDescriptor 8 0 R /CIDToGIDMap /Identity >>',
        `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        '<< /Type /FontDescriptor /FontName /Fixture /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>'];
    let text = '%PDF-1.4\n'; const offsets = [];
    objects.forEach((object,i) => { offsets.push(Buffer.byteLength(text)); text += `${i+1} 0 obj\n${object}\nendobj\n`; });
    const xref = Buffer.byteLength(text); text += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n` + offsets.map(offset => `${String(offset).padStart(10,'0')} 00000 n \n`).join('');
    return Buffer.from(text + `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
module.exports = { labeledPdf };
// Small image-only page: independent of the recognizer and text parser.
module.exports.scannedPdf = () => {
    const pixels = Buffer.alloc(100 * 80 * 3, 240);
    for (let y=10;y<25;y++) for (let x=5;x<75;x++) for(let c=0;c<3;c++) pixels[(y*100+x)*3+c]=20;
    const image = require('node:zlib').deflateSync(pixels), content = Buffer.from('q 100 0 0 80 0 0 cm /I Do Q');
    const objects = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 80] /Resources << /XObject << /I 5 0 R >> >> /Contents 4 0 R >>'),Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`),content,Buffer.from('\nendstream')]),Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 100 /Height 80 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`),image,Buffer.from('\nendstream')])];
    const chunks=[Buffer.from('%PDF-1.7\n')], offsets=[0];let length=chunks[0].length;
    objects.forEach((obj,i)=>{offsets.push(length);const chunk=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),obj,Buffer.from('\nendobj\n')]);chunks.push(chunk);length+=chunk.length;});
    chunks.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${length}\n%%EOF`));
    return Buffer.concat(chunks);
};
