const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { validateOfficeFormat } = require('../server/pi-office-format');
const { zip, docxFiles, xlsxFiles, pptxFiles } = require('./document-fixtures.cjs');
test('Office content type and signature must match the extension before conversion', () => {
    assert.deepEqual(validateOfficeFormat(zip(docxFiles()), 'docx'), { format: 'docx' });
    assert.deepEqual(validateOfficeFormat(zip(xlsxFiles()), 'xlsx'), { format: 'xlsx' });
    assert.deepEqual(validateOfficeFormat(zip(pptxFiles()), 'pptx'), { format: 'pptx' });
    assert.throws(() => validateOfficeFormat(zip(docxFiles()), 'xlsx'), { code: 'OFFICE_INVALID' });
    assert.throws(() => validateOfficeFormat(Buffer.from('d0cf11e0a1b11ae1', 'hex'), 'doc'), { code: 'OFFICE_INVALID' });
});
test('conversion container validation rejects external relationships, entity declarations and CRC corruption', () => {
    const files = docxFiles(); files['word/_rels/document.xml.rels'] = '<Relationships><Relationship Id="x" TargetMode="External" Target="https://example.invalid/a"/></Relationships>';
    assert.throws(() => validateOfficeFormat(zip(files), 'docx'), { code: 'OFFICE_INVALID' });
    files['word/_rels/document.xml.rels'] = '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///private">]><Relationships/>';
    assert.throws(() => validateOfficeFormat(zip(files), 'docx'), { code: 'OFFICE_INVALID' });
    const damaged = zip(docxFiles(), { compress: false }); damaged[60] ^= 1;
    assert.throws(() => validateOfficeFormat(damaged, 'docx'), { code: 'OFFICE_INVALID' });
});
test('legacy DOC XLS and PPT containers prove their internal stream type and reject renamed files', () => {
    const { legacy } = require('./office-legacy-fixtures.cjs');
    for (const format of ['doc', 'xls', 'ppt']) {
        assert.deepEqual(validateOfficeFormat(legacy(format), format), { format });
        assert.throws(() => validateOfficeFormat(legacy(format), format === 'doc' ? 'ppt' : 'doc'), { code: 'OFFICE_INVALID' });
    }
});
test('conversion archive configuration enforces entry and expanded-byte admission', () => {
    assert.throws(() => validateOfficeFormat(zip(docxFiles()), 'docx', { maxArchiveEntries: 1 }), { code: 'OFFICE_LIMIT' });
    assert.throws(() => validateOfficeFormat(zip(docxFiles()), 'docx', { maxUncompressedBytes: 10 }), { code: 'OFFICE_LIMIT' });
});
test('content types and relationship namespace impersonation is rejected', () => {
    const files = docxFiles(); files['[Content_Types].xml'] = files['[Content_Types].xml'].replace('http://schemas.openxmlformats.org/package/2006/content-types', 'urn:imposter');
    assert.throws(() => validateOfficeFormat(zip(files), 'docx'), { code: 'OFFICE_INVALID' });
});
test('a valid package content-type cannot impersonate the main document namespace', () => {
    const files = docxFiles(); files['word/document.xml'] = files['word/document.xml'].replace('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'urn:imposter');
    assert.throws(() => validateOfficeFormat(zip(files), 'docx'), { code: 'OFFICE_INVALID' });
});
