const { fail } = require('./pi-file-scope');
const { classify } = require('./pi-file-types');
const MAX_BYTES = 4 * 1024 * 1024, MAX_PIXELS = 4 * 1024 * 1024;
// Runs only in the credential-free shared document subprocess. Rasterization
// has its own result budget; ordinary document text output stays at 256 KiB.
async function render(bytes, format, input) {
    if (!Buffer.isBuffer(bytes) || bytes.length > 20 * 1024 * 1024) throw fail('扫描原件超过 20 MiB', 413);
    let canvas;
    try { canvas = require('@napi-rs/canvas'); } catch { throw fail('当前安装缺少原生页面渲染能力；文本检查仍可使用', 503, 'COMPLIANCE_RENDER_UNAVAILABLE'); }
    if (format === 'pdf') return pdf(bytes, input, canvas);
    const kind = classify(bytes, 'scan.' + format);
    if (kind.kind !== 'image' || !['image/png', 'image/jpeg', 'image/webp'].includes(kind.mime)) throw fail('扫描图像签名或像素预算无效', 415, 'COMPLIANCE_IMAGE');
    let animated=kind.mime==='image/webp'&&bytes.toString('ascii',12,16)==='VP8X'&&Boolean(bytes[20]&2);
    if(kind.mime==='image/png')for(let at=8;at+12<=bytes.length;){const length=bytes.readUInt32BE(at);if(length>bytes.length-at-12)throw fail('PNG 数据块超出原件范围',415,'COMPLIANCE_IMAGE');if(bytes.toString('ascii',at+4,at+8)==='acTL')animated=true;at+=12+length;}
    if (animated)
        throw fail('扫描识别仅支持静态图片，请转换为独立页面',415,'COMPLIANCE_IMAGE');
    let image; try { image = await canvas.loadImage(bytes); } catch { throw fail('扫描图像无法解码', 415, 'COMPLIANCE_IMAGE'); }
    if (!(image.width===kind.width&&image.height===kind.height || image.width===kind.height&&image.height===kind.width)) throw fail('扫描图像尺寸已变化', 415, 'COMPLIANCE_IMAGE');
    const scale = Math.min(1, 2048 / image.width, 2048 / image.height), width = Math.max(1, Math.floor(image.width * scale)), height = Math.max(1, Math.floor(image.height * scale));
    const output = canvas.createCanvas(width, height); output.getContext('2d').drawImage(image, 0, 0, width, height);
    const png = output.toBuffer('image/png');
    if (png.length > MAX_BYTES || width * height > MAX_PIXELS) throw fail('扫描图像超过传输预算，请缩小页面', 413, 'COMPLIANCE_IMAGE_LIMIT');
    return { base64: png.toString('base64'), mimeType: 'image/png', width, height, page: 1, total: 1 };
}
async function pdf(bytes, input, canvas) {
    if (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > 2000 || !bytes.subarray(0,1024).includes(Buffer.from('%PDF-'))) throw fail('扫描 PDF 页范围无效',415,'COMPLIANCE_IMAGE');
    globalThis.fetch = async () => { throw new Error('Document network access is disabled'); };
    const warnings=[];
    // PDF.js can omit over-budget or unsupported images without rejecting render.
    // This isolated one-job process must reject such a partial page explicitly.
    const log=console.log,warn=console.warn;
    console.log=console.warn=(...parts)=>{warnings.push(parts.join(' ').slice(0,1000));};
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'), path = require('node:path');
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const task = getDocument({ data:Uint8Array.from(bytes), isEvalSupported:false, enableXfa:false, useWorkerFetch:false, useSystemFonts:false,
        disableFontFace:true, stopAtErrors:true, verbosity:1, maxImageSize:32*1024*1024,
        standardFontDataUrl:path.join(assets,'standard_fonts').replaceAll('\\','/')+'/', cMapUrl:path.join(assets,'cmaps').replaceAll('\\','/')+'/', cMapPacked:true, wasmUrl:path.join(assets,'wasm').replaceAll('\\','/')+'/' });
    try {
        const doc = await task.promise;
        if (doc.numPages > 2000 || input.page > doc.numPages) throw fail('扫描 PDF 超出页数预算',413,'COMPLIANCE_IMAGE_LIMIT');
        const page = await doc.getPage(input.page), base = page.getViewport({scale:1});
        if (![base.width,base.height].every(v=>Number.isFinite(v)&&v>0&&v<100000)) throw fail('PDF 页面尺寸无效',415);
        const scale = Math.min(2,2048/base.width,2048/base.height), viewport=page.getViewport({scale}), width=Math.ceil(viewport.width),height=Math.ceil(viewport.height);
        if(width*height>MAX_PIXELS)throw fail('扫描页面超过像素预算',413,'COMPLIANCE_IMAGE_LIMIT');
        const output=canvas.createCanvas(width,height), ctx=output.getContext('2d');
        await page.render({canvasContext:ctx,viewport}).promise;
        if(warnings.some(w=>/image|decode|font|unsupported|jpeg|jpx/i.test(w)))throw fail('页面包含未完整解码的图像或字体，未执行识别',415,'COMPLIANCE_RENDER_PARTIAL');
        const rgba=ctx.getImageData(0,0,width,height).data;let minimum=255,maximum=0;
        for(let i=0;i<rgba.length;i+=4){minimum=Math.min(minimum,rgba[i],rgba[i+1],rgba[i+2]);maximum=Math.max(maximum,rgba[i],rgba[i+1],rgba[i+2]);}
        if(maximum-minimum<3)throw fail('页面空白或内容无法完整渲染，未声明识别成功',415,'COMPLIANCE_RENDER_EMPTY');
        const png=output.toBuffer('image/png');if(png.length>MAX_BYTES)throw fail('扫描页面超过传输预算',413,'COMPLIANCE_IMAGE_LIMIT');
        return {base64:png.toString('base64'),mimeType:'image/png',width,height,page:input.page,total:doc.numPages};
    } catch(error) { if(error.status)throw error;throw fail('扫描 PDF 无法完整渲染；请转换页面后重试',415,'COMPLIANCE_RENDER_FAILED'); }
    finally {await task.destroy();console.log=log;console.warn=warn;}
}
module.exports = { render, MAX_BYTES, MAX_PIXELS };
