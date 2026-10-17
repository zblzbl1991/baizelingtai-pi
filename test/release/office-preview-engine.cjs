const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const { createOfficePreviewEngine } = require('../../server/office-preview/engine');
const { privateDir } = require('../../server/pi-maintenance-files');
const { assertPrivateFile } = require('../private-file-helper.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
async function main() {
    const root = privateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-office-native-')));
    const engine = createOfficePreviewEngine({ tempRoot: root });
    const inventorySha256 = hash(fs.readFileSync(path.join(__dirname, '../../config/office-preview-assets.json')));
    const report = { inventorySha256, node: process.version, platform: process.platform, arch: process.arch, documents: [] };
    try {
        const health = engine.status();
        for (const directory of fs.readdirSync(root)) assertPrivateFile(path.join(root, directory, 'source.docx'));
        assert.equal((await health).available, true, 'exact engine must pass its real isolated health conversion');
        const { Document, Packer, Paragraph } = require('docx');
        const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Isolated native Office conversion 中文 2026')] }] }));
        const originalSha256 = hash(bytes);
        const started = Date.now(), pdf = await engine.convert(bytes, 'docx');
        assert.equal(pdf.bytes.subarray(0,5).toString(), '%PDF-');
        assert.equal(hash(bytes), originalSha256, 'source bytes stay unchanged');
        report.documents.push({ format: 'docx', sourceSha256: hash(bytes), pdfSha256: hash(pdf.bytes), sourceBytes: bytes.length, pdfBytes: pdf.bytes.length, milliseconds: Date.now() - started, missingFonts: pdf.missingFonts });
        const controller = new AbortController();
        const pending = engine.convert(bytes, 'docx', { signal: controller.signal });
        for (let attempt = 0; attempt < 100 && !fs.readdirSync(root).length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(fs.readdirSync(root).length, 'cancel a live isolated conversion');
        controller.abort();
        await assert.rejects(pending, {code:'office_cancelled'});
        assert.deepEqual(fs.readdirSync(root), [], 'actual process exit and private scratch cleanup precede cancellation result');
        const previous = engine.generation;
        assert.equal((await engine.status({refresh:true})).available, true);
        assert.notEqual(engine.generation, previous);
        report.privateDacl = true; report.cancelCleanup = true; report.refresh = true;
        const constrained = createOfficePreviewEngine({ tempRoot: root, limits: {maxOutputBytes:20000} });
        try {
            assert.equal((await constrained.status()).available, true);
            const large = await Packer.toBuffer(new Document({sections:[{children:Array.from({length:1500},(_,i)=>new Paragraph('Native bounded output page content '+i))}]}));
            await assert.rejects(constrained.convert(large, 'docx'), {code:'office_output_limit'});
            report.outputBudget = true;
        } finally { await constrained.dispose(); }
        assert.deepEqual(fs.readdirSync(root), []);
        console.log(JSON.stringify(report, null, 2));
    } finally { await engine.dispose(); fs.rmSync(root, {recursive:true,force:true}); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
