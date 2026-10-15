const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateRevision } = require('./revision-input');
const { structure } = require('./render');
const { officeZip, xml, parseDocument } = require('../pi-document-parser');
const { inspectTables } = require('./revision-tables');
const { inspect } = require('./checks');
const { finish } = require('./report');
const { MAX_SOURCE } = require('./limits');
const { fail } = require('../pi-file-scope');
const { parseParagraph, applyEdits, unitalic, elementAt } = require('../../vendor/gongwen-kit/lib/fix/runs');
const { editsFor } = require('../../vendor/gongwen-kit/lib/fix/text-rules');
const { fixStyles, fixDocument, redStyleIds } = require('../../vendor/gongwen-kit/lib/fix/layout');
const { addComments, paragraphsOf } = require('../../vendor/gongwen-kit/lib/fix/comments');
const { rejectAll } = require('../../vendor/gongwen-kit/lib/fix/revisions');
const PARAGRAPH = /<w:p(?:\s[^>]*)?>(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g;
const existingRevision = /<w:(?:ins|del|moveFrom|moveTo|rPrChange|pPrChange|sectPrChange)\b/;
const read = async (zip, name) => zip.file(name) ? zip.file(name).async('string') : '';
const visibleParagraphs = document => paragraphsOf(document).map(p => p.text);
function ranges(document, names) {
    const result = [];
    for (const name of names) {
        const pattern = new RegExp(`<${name}(?=[\\s>])`, 'g'); let match;
        while ((match = pattern.exec(document))) { const end = elementAt(document, match.index)[1]; result.push([match.index, end]); pattern.lastIndex = end; }
    }
    return result;
}
function revisionFragments(document) {
    return ranges(document, ['w:ins', 'w:del', 'w:moveFrom', 'w:moveTo', 'w:rPrChange', 'w:pPrChange', 'w:sectPrChange'])
        .map(([start, end]) => document.slice(start, end));
}
function protectProperties(document, names) {
    const saved = [];
    for (const [start, end] of ranges(document, names).sort((a, b) => b[0] - a[0])) {
        const original = document.slice(start, end), name = /^<([\w:]+)/.exec(original)[1], key = `PIVANE${randomUUID().replace(/-/g, '')}`;
        const child = name.replace(/Change$/, '');
        document = document.slice(0, start) + `<${name} w:id="0" w:author="${key}"><${child}/></${name}>` + document.slice(end);
        saved.push({ original, name, key });
    }
    return { document, restore: value => {
        for (const { original, name, key } of saved) {
            const at = value.indexOf(`w:author="${key}"`), start = value.lastIndexOf(`<${name}`, at);
            if (at < 0 || start < 0) throw Error('已有属性修订无法保留');
            const end = elementAt(value, start)[1]; value = value.slice(0, start) + original + value.slice(end);
        }
        return value;
    } };
}
function protectedStyles(styles) {
    const protectedIds = redStyleIds(styles), descendants = new Map();
    for (const match of styles.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
        if (/\bw:themeColor=/.test(match[2])) protectedIds.add(match[1]);
        const parent = /<w:basedOn\b[^>]*w:val="([^"]+)"/.exec(match[2])?.[1];
        if (parent) { if (!descendants.has(parent)) descendants.set(parent, []); descendants.get(parent).push(match[1]); }
    }
    const queue = [...protectedIds];
    for (let i = 0; i < queue.length; i++) for (const child of descendants.get(queue[i]) || []) {
        if (!protectedIds.has(child)) { protectedIds.add(child); queue.push(child); }
    }
    return protectedIds;
}
function normalize(document, styles, headingIds, rev) {
    const protectedRanges = ranges(document, ['w:tbl', 'w:txbxContent']);
    const numberedStyles = new Set([...styles.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)]
        .filter(m => /<w:numPr>/.test(m[2])).map(m => m[1]));
    const redStyles = protectedStyles(styles), corrections = [], spacedDates = /\d\s+年\s+\d/.test(document); let auditBytes = 0, paragraph = 0, skipped = 0;
    const changed = document.replace(PARAGRAPH, (p, at) => {
        paragraph++;
        if (protectedRanges.some(([a, b]) => at >= a && at < b) || existingRevision.test(p)
            || /<w:color\b[^>]*(?:w:val="(?:FF0000|ff0000)"|w:themeColor=)/.test(p)
            || [...p.matchAll(/<w:[pr]Style w:val="([^"]+)"/g)].some(m => redStyles.has(m[1]))) { skipped++; return p; }
        let para;
        try { para = parseParagraph(p); } catch { skipped++; return p; }
        const sid = (p.match(/<w:pStyle w:val="([^"]+)"/) || [])[1];
        const edits = editsFor(para.text, { spacedDates,
            heading: Boolean(headingIds[sid]) || /<w:outlineLvl w:val="[0-3]"/.test(p), numbered: /<w:numPr>/.test(p) || numberedStyles.has(sid) });
        const result = applyEdits(para, edits, rev); skipped += result.skipped.length;
        for (const edit of result.applied) {
            const record = { where: `原稿段落 ${paragraph}`, rules: [edit.rule], before: para.text.slice(edit.start, edit.end), after: edit.text };
            auditBytes += Buffer.byteLength(JSON.stringify(record)) + 32;
            if (auditBytes > MAX_SOURCE - 1024 || corrections.length >= 5000) throw Error('公文修订记录超过预算');
            corrections.push(record);
        }
        let output = result.xml || p;
        if (!para.tokens.some(token => token.kind === 'opaque')) {
            const italic = unitalic(output, rev); output = italic.xml;
            if (italic.n) corrections.push({ where: `原稿段落 ${paragraph}`, rules: ['斜体改正体'], before: '斜体', after: '正体' });
        }
        return output;
    });
    if (corrections.length > 5000 || Buffer.byteLength(JSON.stringify(corrections, null, 2)) > MAX_SOURCE) throw fail('公文修订记录超过预算；原件保留', 413, 'GONGWEN_LIMIT');
    return { document: changed, corrections, skipped };
}
function commentItems(checks) {
    const items = [];
    for (const hit of [...checks.errors, ...checks.hints]) {
        const anchors = hit.anchors || [], groups = anchors.length > 1 ? anchors.slice(0, 20).map(anchor => [anchor]) : [anchors];
        for (const group of groups) items.push({ text: `【${hit.stage}·${hit.rule}】${String(hit.detail || '').slice(0, 1600)}`, anchors: group });
    }
    if (items.length > 500) throw Error('公文批注超过 500 条预算');
    return items;
}
async function revise(raw, bytes, directory, checkpoint = () => {}, implementations = {}) {
    const request = validateRevision(raw), input = { ...request, kind: 'existing', title: request.title || '已有公文', missing: [] };
    await parseDocument(bytes, 'docx', {}, { validateOnly: true }); await structure(bytes);
    await checkpoint({ bytes, input, corrections: [], rounds: 0, original: true });
    const zip = await require('jszip').loadAsync(bytes), original = await read(zip, 'word/document.xml');
    if (!/<w:document\b/.test(original) || !/<w:body\b/.test(original)) throw fail('原稿 XML 命名空间暂不支持规则检查或修订；原件保留', 415, 'GONGWEN_NAMESPACE');
    if (request.action === 'revise' && zip.file(/(?:^|\/)origin\.sigs$|^_xmlsignatures\//i).length) throw fail('带数字签名的公文仅支持检查，不能自动修改；原件保留', 415, 'GONGWEN_SIGNED');
    let document = original, styles = await read(zip, 'word/styles.xml'), rels = await read(zip, 'word/_rels/document.xml.rels'),
        types = await read(zip, '[Content_Types].xml'), settings = await read(zip, 'word/settings.xml');
    const previousRevisions = revisionFragments(document + styles);
    const author = `白泽灵台公文修订-${randomUUID()}`, date = new Date().toISOString(), notes = [], corrections = [];
    let next = 1, headingIds = {}, skipped = 0, layoutApplied = false;
    for (const name of officeZip(bytes).names.filter(name => /\.(?:xml|rels)$/.test(name))) {
        for (const match of (await read(zip, name)).matchAll(/\bw:id="(\d+)"/g)) {
            const value = Number(match[1]); if (!Number.isSafeInteger(value) || value > 2147470000) throw Error('公文已有标记超过修订 ID 预算');
            next = Math.max(next, value + 1);
        }
    }
    if (request.action === 'revise') {
        if (request.layout && styles && settings && !/\bw:themeColor=/.test(document + styles)) {
            // Keep every paragraph containing prior revisions byte-for-byte.
            const protectedParagraphs = new Map();
            document = document.replace(PARAGRAPH, p => {
                if (!existingRevision.test(p)) return p;
                const key = `PIVANE${randomUUID().replace(/-/g, '')}`; protectedParagraphs.set(key, p);
                return `<w:p><w:r><w:t>${key}</w:t></w:r></w:p>`;
            });
            const priorStyles = protectProperties(styles, ['w:rPrChange', 'w:pPrChange']);
            const protectedIds = protectedStyles(styles), preservedStyles = new Map([...styles.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>[\s\S]*?<\/w:style>/g)]
                .filter(match => protectedIds.has(match[1])).map(match => [match[1], match[0]]));
            const result = fixStyles(priorStyles.document, notes); styles = priorStyles.restore(result.xml); headingIds = result.headingIds;
            styles = styles.replace(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>[\s\S]*?<\/w:style>/g, (value, id) => preservedStyles.get(id) || value);
            const priorSections = protectProperties(document, ['w:sectPrChange']); document = priorSections.document;
            document = fixDocument(document, { headingIds, titleFont: '方正小标宋简体', redStyles: protectedStyles(styles) }, notes);
            document = priorSections.restore(document);
            document = document.replace(PARAGRAPH, p => { for (const [key, originalPara] of protectedParagraphs) if (p.includes(key)) return originalPara; return p; });
            ({ document, rels, types, settings } = await require('./revision-layout').layoutPackage(zip, document, { rels, types, settings }, notes)); layoutApplied = true;
        } else if (request.layout) notes.push(styles && settings ? '原稿含主题色，保留版式以保护无法可靠识别的版头' : '原稿缺少样式或排版设置部件，保留原有版式');
        if (!Object.keys(headingIds).length) for (const match of styles.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>[\s\S]*?<w:name w:val="heading ([1-4])"/gi)) headingIds[match[1]] = +match[2];
        const result = normalize(document, styles, headingIds, { nextId: () => next++, author, date });
        document = result.document; corrections.push(...result.corrections); skipped = result.skipped;
        if (layoutApplied) ({ rels, types } = await require('./revision-fonts').titleAlternative(zip, rels, types));
        if (JSON.stringify(visibleParagraphs(rejectAll(document, author))) !== JSON.stringify(visibleParagraphs(original))) throw Error('拒绝本轮修订后与原文不一致，未交付修改稿');
    }
    const put = () => {
        zip.file('word/document.xml', document);
        if (styles) zip.file('word/styles.xml', styles);
        if (rels) zip.file('word/_rels/document.xml.rels', rels);
        if (types) zip.file('[Content_Types].xml', types);
        if (settings) zip.file('word/settings.xml', settings);
    };
    const file = path.join(directory, 'revised.docx'); put();
    const proposed = request.action === 'inspect' ? bytes : await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await structure(proposed); fs.writeFileSync(file, proposed);
    const checks = await (implementations.inspect || inspect)(file, { body: [] });
    const strict = inspectTables(document);
    checks.errors.push(...strict.errors.map(hit => ({ ...hit, stage: '严格数字' })));
    checks.hints.push(...strict.hints.map(hit => ({ ...hit, stage: '严格数字' })));
    if (request.layout && !layoutApplied && request.action === 'revise') checks.hints.push({ stage: '版式', rule: '版式保留', detail: notes[0], anchors: [] });
    if (skipped) checks.hints.push({ stage: '修订', rule: '受保护内容', detail: `${skipped} 处表格、版头、文本框、已有修订或不透明内容保留；检查发现的问题交人工核对`, anchors: [] });
    if (previousRevisions.length) checks.hints.push({ stage: '修订', rule: '原有修订', detail: `保留原稿 ${previousRevisions.length} 处已有修订；其可见建议文本参与检查，仍须由原审阅人确认`, anchors: [] });
    let comments = { placed: 0, unplaced: 0 };
    if (request.action === 'revise') {
        const items = commentItems(checks);
        if (items.length) {
            if (!rels) rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
            const relationships = xml(Buffer.from(rels)).children.filter(c => typeof c === 'object');
            const prior = relationships.filter(c => /\/comments$/.test(c.attrs.Type || ''));
            if (prior.length > 1 || prior[0]?.attrs.TargetMode === 'External') throw Error('原稿批注关系不支持安全修订');
            const part = prior.length ? path.posix.normalize(path.posix.join('word', prior[0].attrs.Target)) : 'word/pivane-comments.xml';
            if (!part.startsWith('word/') || part.includes('..') || prior.length && !zip.file(part)) throw Error('原稿批注部件无效');
            if (!prior.length && zip.file(part)) throw Error('原稿批注部件冲突');
            comments = addComments(document, items, { existing: prior.length ? await read(zip, part) : '', startId: next, author, date });
            document = comments.xml; zip.file(part, comments.comments);
            if (!prior.length) {
                if (!/<\/Relationships>\s*$/.test(rels) || !/<\/Types>\s*$/.test(types)) throw Error('原稿关系命名空间不支持修订');
                rels = rels.replace(/<\/Relationships>/, `<Relationship Id="pivaneComments${randomUUID().replace(/-/g, '')}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="pivane-comments.xml"/></Relationships>`);
                types = types.replace(/<\/Types>/, '<Override PartName="/word/pivane-comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>');
            }
        }
    }
    put(); const output = request.action === 'inspect' ? bytes : await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await structure(output);
    if (previousRevisions.some(fragment => !(document + styles).includes(fragment))) throw Error('原有修订无法完整保留，未交付修改稿');
    if (JSON.stringify(visibleParagraphs(rejectAll(document, author))) !== JSON.stringify(visibleParagraphs(original))) throw Error('最终修订文字回验失败');
    await checkpoint({ bytes: output, input, corrections, rounds: request.action === 'revise' ? 1 : 0, original: request.action === 'inspect' });
    fs.writeFileSync(file, output);
    const finalChecks = await (implementations.inspect || inspect)(file, { body: [] });
    const localHints = checks.hints.filter(hit => ['严格数字', '版式', '修订'].includes(hit.stage));
    checks.errors = [...finalChecks.errors, ...strict.errors.map(hit => ({ ...hit, stage: '严格数字' }))];
    checks.hints = [...finalChecks.hints, ...localHints]; checks.styles = finalChecks.styles;
    checks.faults.push(...finalChecks.faults); checks.stages = finalChecks.stages;
    const report = finish(input, checks, corrections, request.action === 'revise' ? 1 : 0);
    Object.assign(report, { operation: request.action, editing: 'complete', originalSnapshot: request.action === 'inspect', checkView: 'proposed', revisionAuthor: author,
        layoutApplied, layoutNotes: notes, fontScope: layoutApplied ? 'normative' : 'reference-only', comments: { placed: comments.placed, unplaced: comments.unplaced }, reviewPending: corrections.length > 0, previousRevisions: previousRevisions.length });
    if (report.reviewPending && report.status === 'checked') { report.status = 'needs-review'; report.label = '待核对草稿'; }
    report.coverage = ['检查按建议修订后的可见文本执行；Word 审阅中仍须逐条接受或拒绝本轮修订',
        '表格数值、已有修订、版头与不透明元素保留；复杂合并表、未声明表头等覆盖缺口另列提示', ...report.coverage];
    if (Buffer.byteLength(JSON.stringify(corrections, null, 2)) > MAX_SOURCE) throw fail('公文修订记录超过预算；原件保留', 413, 'GONGWEN_LIMIT');
    return { bytes: output, input, corrections, report };
}
module.exports = { revise, normalize, commentItems, revisionFragments };
